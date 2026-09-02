/**
 * PP-OCRv6 text extraction — native Android detector plus WASM fallback/recognizer.
 *
 * Combines PP-OCR detection (text region bounding boxes) and recognition (CTC decode)
 * into a single pipeline that produces RecognizedBlock[] and mergedRegions[].
 *
 * Used by:
 *   - On-device translation pipeline (on-device-service.ts)
 *   - Text-only off-device pipeline (needs mergedRegions for overlay construction)
 *
 * Raw regions (individual text lines) are used for per-line CTC recognition.
 * Results are then spatially mapped onto merged regions (speech-bubble-sized blocks)
 * for overlay display — the block grouping the overlay pipeline expects.
 */

import {
	initDetector,
	detectTextRegionsForRecognition,
	type PPOcrRecognitionDetection
} from '$lib/detection/ppocr-detector.js';
import { initRecognizer, recognizeTextRegions, type RecognitionResult } from '$lib/detection/ppocr-recognizer.js';
import { areOcrModelsReady } from '$lib/detection/ocr-model-manager.js';
import * as m from '$lib/paraglide/messages.js';
import { overrideRecognitionForEval } from '$lib/detection/model-candidate-overrides.js';
import {
	classifyRecognizedTextGroup,
	groupRawTextComponents,
	type PPOcrGroupingDiagnostics,
	type PPOcrTextGroup
} from '$lib/detection/ppocr-grouping.js';
import { analyzeFreeTextGroupFeatures, type FreeTextPixelBuffer } from '$lib/detection/free-text-features.js';
import type { BubbleRegion } from '$lib/detection/bubble-geometry.js';
import type { RecognizedBlock } from './recognized-block.js';
import { suppressRubyLines } from './furigana-filter.js';
import type { DetectedTextRegion } from '$lib/types/index.js';

const CLASSIFICATION_KINDS = [
	'speech',
	'thought',
	'narration',
	'sign',
	'sfx',
	'borderless',
	'unknown'
] as const;

function emptyClassificationCounts(): Record<(typeof CLASSIFICATION_KINDS)[number], number> {
	return Object.fromEntries(CLASSIFICATION_KINDS.map((kind) => [kind, 0])) as Record<
		(typeof CLASSIFICATION_KINDS)[number],
		number
	>;
}

export interface PPOCRExtractionMetrics {
	rawRegions: number;
	mergedRegions: number;
	groupedComponents: number;
	unmappedComponents: number;
	ambiguousBubbleAssignments: number;
	recognizedLines: number;
	unmappedRecognizedLines: number;
	/** Ruby columns withheld from group text by furigana-filter.ts. */
	suppressedRubyLines: number;
	blocks: number;
	reusedDetection: boolean;
	/** Whether free-text semantics used pixels or a recorded geometry fallback. */
	freeTextFeatureMode: 'not-required' | 'visual' | 'geometry-fallback';
	detectorInitializationMs: number;
	detectionMs: number;
	groupingMs: number;
	recognizerInitializationMs: number;
	recognitionMs: number;
	mappingMs: number;
	classificationMs: number;
	totalMs: number;
}

export interface PPOCRExtractionOptions {
	signal?: AbortSignal;
	/**
	 * A page-level caller can provide the detector result it already owns. The
	 * extractor then performs no detector initialization or second inference.
	 */
	detection?: PPOcrRecognitionDetection;
	/**
	 * Supplying bubbles requests bubble-first regrouping of the raw components.
	 * An explicitly empty list still runs the free-text grouping policy.
	 */
	bubbles?: readonly BubbleRegion[];
	locale?: string;
	/**
	 * Page reading direction for box-ID ordering. Only consulted when `bubbles`
	 * requests regrouping — that regrouping is what produces the canonical box
	 * IDs the prompts address. Defaults to manga order.
	 */
	readingDirection?: 'rtl' | 'ltr';
}

export interface PPOCRExtractionResult {
	blocks: RecognizedBlock[];
	/** Canonical groups used to create the returned blocks. */
	mergedRegions: DetectedTextRegion[];
	/** Explicit alias for callers migrating away from the legacy name. */
	groups: DetectedTextRegion[];
	/**
	 * Exact immutable classifier inputs after grouping and before recognized-text
	 * classification mutates `groups`. Formal local replay uses these records to
	 * prove that its independently prepared grouping is the production input.
	 */
	classificationInputGroups: PPOcrTextGroup[];
	groupingDiagnostics?: PPOcrGroupingDiagnostics;
	classificationCounts: Record<(typeof CLASSIFICATION_KINDS)[number], number>;
	metrics: PPOCRExtractionMetrics;
}

function roundedMs(durationMs: number): number {
	return Math.round(durationMs * 100) / 100;
}

function sanitizeExtractionMetrics(metrics: PPOCRExtractionMetrics): PPOCRExtractionMetrics {
	return {
		...metrics,
		detectorInitializationMs: roundedMs(metrics.detectorInitializationMs),
		detectionMs: roundedMs(metrics.detectionMs),
		groupingMs: roundedMs(metrics.groupingMs),
		recognizerInitializationMs: roundedMs(metrics.recognizerInitializationMs),
		recognitionMs: roundedMs(metrics.recognitionMs),
		mappingMs: roundedMs(metrics.mappingMs),
		classificationMs: roundedMs(metrics.classificationMs),
		totalMs: roundedMs(metrics.totalMs)
	};
}

function logExtractionMetrics(metrics: PPOCRExtractionMetrics): void {
	// OCR content and image identifiers are intentionally excluded. These
	// diagnostics are safe to collect from physical-device benchmark logs.
	console.warn(`[ppocr-extract] metrics ${JSON.stringify(metrics)}`);
}

/**
 * Sort raw text lines inside one merged region using manga-aware reading order.
 * Vertical columns run right-to-left (then top-to-bottom within a column),
 * while horizontal lines run top-to-bottom and left-to-right. Detector output
 * is confidence-sorted, so concatenating it directly would scramble bubbles.
 */
export function sortRawRegionsInReadingOrder(
	regions: DetectedTextRegion[]
): DetectedTextRegion[] {
	if (regions.length <= 1) return [...regions];

	const verticalCount = regions.filter((region) => region.height > region.width * 1.5).length;
	const verticalLayout = verticalCount > regions.length / 2;
	const dimensions = regions
		.map((region) => (verticalLayout ? region.width : region.height))
		.sort((a, b) => a - b);
	const medianDimension = dimensions[Math.floor(dimensions.length / 2)];
	const groupTolerance = Math.max(2, medianDimension * (verticalLayout ? 0.75 : 0.5));
	const primaryCenter = (region: DetectedTextRegion) =>
		verticalLayout ? region.x + region.width / 2 : region.y + region.height / 2;

	// Form columns/rows once and then flatten them. This yields a transitive
	// total order even when a block contains mixed vertical/horizontal fragments.
	const primarySorted = [...regions].sort((a, b) =>
		verticalLayout ? primaryCenter(b) - primaryCenter(a) : primaryCenter(a) - primaryCenter(b)
	);
	const groups: Array<{ center: number; items: DetectedTextRegion[] }> = [];
	for (const region of primarySorted) {
		const center = primaryCenter(region);
		const group = groups.find((candidate) => Math.abs(candidate.center - center) <= groupTolerance);
		if (group) {
			group.items.push(region);
			group.center = group.items.reduce((sum, item) => sum + primaryCenter(item), 0) / group.items.length;
		} else {
			groups.push({ center, items: [region] });
		}
	}

	return groups.flatMap((group) =>
		group.items.sort((a, b) =>
			verticalLayout
				? a.y + a.height / 2 - (b.y + b.height / 2)
				: a.x + a.width / 2 - (b.x + b.width / 2)
		)
	);
}

/**
 * Rebuild a shared recognition crop as one standalone region per source
 * component.
 *
 * Grouping drops the detector's must-link when the crop's sources resolve to
 * different bubbles (`sharedCropOwnershipSplits`). Recognition runs per raw
 * region and `rawByComponentId` maps every source ID to its region, so leaving
 * the union crop in place would hand the same recognized string to both groups.
 * Splitting first gives each fragment its own crop, its own CTC decode, and its
 * own string — the state that would have existed had the rescue never fired.
 */
function splitSharedCropIntoSources(region: DetectedTextRegion): DetectedTextRegion[] {
	const sources = region.sourceComponents;
	if (!sources || sources.length < 2) return [region];
	return sources.map((component) => ({
		...region,
		boxId: component.componentId,
		x: component.x,
		y: component.y,
		width: component.width,
		height: component.height,
		confidence: component.confidence,
		polygon: component.polygon,
		orientationDegrees: component.orientationDegrees,
		sourceComponents: [component],
		sourceComponentIds: [component.componentId],
		foregroundPixelCount: component.foregroundPixelCount,
		meanConfidence: component.meanConfidence,
		maxConfidence: component.maxConfidence
	}));
}

function componentIdsForRegion(region: DetectedTextRegion): number[] {
	const explicit = region.sourceComponentIds?.length
		? region.sourceComponentIds
		: region.sourceComponents?.map((component) => component.componentId);
	return [...new Set(explicit?.length ? explicit : [region.boxId])];
}

/**
 * Resolve group membership solely through detector lineage. Geometry is not a
 * fallback: a component near or inside a group must still name that group.
 */
function rawRegionsForGroup(
	group: DetectedTextRegion,
	rawByComponentId: ReadonlyMap<number, DetectedTextRegion>
): DetectedTextRegion[] {
	const componentIds = componentIdsForRegion(group);
	const seenRawBoxes = new Set<number>();
	const regions: DetectedTextRegion[] = [];
	for (const componentId of componentIds) {
		const raw = rawByComponentId.get(componentId);
		if (!raw || seenRawBoxes.has(raw.boxId)) continue;
		seenRawBoxes.add(raw.boxId);
		regions.push(raw);
	}
	return regions;
}

function separatorForGroup(group: DetectedTextRegion): string {
	// PP-OCR recognizes a Japanese vertical column as a continuous string. When
	// grouping adjacent columns, concatenation preserves normal manga reading.
	// Horizontal/rotated detector lines need an explicit boundary so words from
	// neighbouring baselines cannot be silently fused.
	return group.writingMode === 'vertical-rl' ? '' : '\n';
}

/**
 * Narrow a merged region to a grouped one.
 *
 * Exported because `groups`/`mergedRegions` are declared `DetectedTextRegion[]`
 * and only SOME of their members carry the grouping fields. Anything replaying
 * production needs the same narrowing production itself uses; a second copy of
 * this predicate in the harness is how the two drift apart.
 */
export function isPPOcrTextGroup(region: DetectedTextRegion): region is PPOcrTextGroup {
	return typeof (region as Partial<PPOcrTextGroup>).id === 'string'
		&& Array.isArray((region as Partial<PPOcrTextGroup>).componentIds)
		&& typeof (region as Partial<PPOcrTextGroup>).trace === 'object';
}

function median(values: number[]): number {
	if (!values.length) return 1;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2
		? ordered[middle]
		: (ordered[middle - 1] + ordered[middle]) / 2;
}

async function loadFeaturePixels(
	imageFile: File,
	maxDimension: number,
	signal?: AbortSignal
): Promise<FreeTextPixelBuffer | undefined> {
	if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return undefined;
	const bitmap = await createImageBitmap(imageFile);
	try {
		if (signal?.aborted) throw new Error('PP-OCR extraction cancelled');
		const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return undefined;
		context.drawImage(bitmap, 0, 0, width, height);
		const image = context.getImageData(0, 0, width, height);
		return { width, height, data: image.data };
	} finally {
		bitmap.close();
	}
}

/**
 * Extract text using native Android detection when available and WASM recognition.
 *
 * Returns both the recognized text blocks (with bounding boxes matching merged regions)
 * and the mergedRegions themselves (needed for overlay construction in callers that
 * build their own overlays).
 *
 * @param imageFile - Page image as File (converted to Blob internally)
 * @returns Recognized blocks mapped onto merged regions, plus the merged regions
 */
export async function extractTextWithPPOCR(
	imageFile: File,
	options: PPOCRExtractionOptions = {}
): Promise<PPOCRExtractionResult> {
	const throwIfCancelled = () => {
		if (options.signal?.aborted) throw new Error('PP-OCR extraction cancelled');
	};
	throwIfCancelled();
	// Every OCR path funnels through here, so one check covers the reader, the
	// batch job and the revision passes. Without it a missing model surfaces as
	// a protobuf parse failure from deep inside ONNX Runtime.
	if (!(await areOcrModelsReady())) {
		throw new Error(m.ocr_models_missing());
	}
	const totalStarted = performance.now();
	let detectorInitializationMs = 0;
	let detectionMs = 0;
	let detection = options.detection;
	if (!detection) {
		// Initialize/detect only when a page-level caller did not already do so.
		const detectorInitializationStarted = performance.now();
		await initDetector({ signal: options.signal });
		throwIfCancelled();
		detectorInitializationMs = performance.now() - detectorInitializationStarted;
		const detectionStarted = performance.now();
		detection = await detectTextRegionsForRecognition(imageFile, {
			signal: options.signal,
			locale: options.locale,
			deferGrouping: options.bubbles !== undefined
		});
		throwIfCancelled();
		detectionMs = performance.now() - detectionStarted;
	}

	const { imageWidth, imageHeight } = detection;
	let rawRegions = detection.rawRegions;
	let mergedRegions: DetectedTextRegion[] = detection.mergedRegions;
	let groupingDiagnostics: PPOcrGroupingDiagnostics | undefined;
	let groupingMs = 0;
	if (options.bubbles !== undefined) {
		const groupingStarted = performance.now();
		const grouping = groupRawTextComponents(
			rawRegions,
			options.bubbles,
			imageWidth,
			imageHeight,
			{
				locale: options.locale,
				readingDirection: options.readingDirection,
				signal: options.signal
			}
		);
		mergedRegions = grouping.groups;
		groupingDiagnostics = grouping.diagnostics;
		groupingMs = performance.now() - groupingStarted;
		// Grouping refused a detector must-link because the crop's sources sit in
		// different bubbles. Re-key recognition onto those sources before the CTC
		// decode below, or both groups would read the same union crop's string.
		const splitBoxIds = new Set(grouping.diagnostics.sharedCropOwnershipSplits);
		if (splitBoxIds.size > 0) {
			rawRegions = rawRegions.flatMap((region) =>
				splitBoxIds.has(region.boxId) ? splitSharedCropIntoSources(region) : [region]
			);
		}
	}

	const rawComponentIds = new Set(rawRegions.flatMap(componentIdsForRegion));
	const groupedComponentIds = new Set(mergedRegions.flatMap(componentIdsForRegion));
	const unmappedComponents = [...rawComponentIds].filter((id) => !groupedComponentIds.has(id)).length;

	if (rawRegions.length === 0 || mergedRegions.length === 0) {
		const metrics = sanitizeExtractionMetrics({
			rawRegions: rawRegions.length,
			mergedRegions: mergedRegions.length,
			groupedComponents: groupedComponentIds.size,
			unmappedComponents,
			ambiguousBubbleAssignments: groupingDiagnostics?.ambiguousBubbleAssignments ?? 0,
			recognizedLines: 0,
			unmappedRecognizedLines: 0,
			suppressedRubyLines: 0,
			blocks: 0,
			reusedDetection: options.detection !== undefined,
			freeTextFeatureMode: 'not-required',
			detectorInitializationMs,
			detectionMs,
			groupingMs,
			recognizerInitializationMs: 0,
			recognitionMs: 0,
			mappingMs: 0,
			classificationMs: 0,
			totalMs: performance.now() - totalStarted
		});
		logExtractionMetrics(metrics);
		return {
			blocks: [],
			mergedRegions,
			groups: mergedRegions,
			classificationInputGroups: mergedRegions
				.filter(isPPOcrTextGroup)
				.map((group) => structuredClone(group)),
			groupingDiagnostics,
			classificationCounts: emptyClassificationCounts(),
			metrics
		};
	}

	// 3. Recognize text on raw regions (per-line CTC decode). A debug-only
	// model-candidate override may substitute an alternative recognizer over
	// the same raw regions (no-op in production/release builds).
	let recognizerInitializationMs = 0;
	let results: RecognitionResult[];
	const recognitionStarted = performance.now();
	const overrideResults = await overrideRecognitionForEval(imageFile, rawRegions, {
		signal: options.signal
	});
	throwIfCancelled();
	if (overrideResults !== null) {
		results = overrideResults;
	} else {
		const recognizerInitializationStarted = performance.now();
		await initRecognizer({ signal: options.signal });
		throwIfCancelled();
		recognizerInitializationMs = performance.now() - recognizerInitializationStarted;
		// Keep the small recognizer resident with the detector. Text-only review can
		// process pages concurrently; one caller must never release the singleton
		// while another is using it, and reloading ~21 MB per page is avoidable.
		results = await recognizeTextRegions(imageFile, rawRegions, { signal: options.signal });
		throwIfCancelled();
	}
	const recognitionMs = performance.now() - recognitionStarted;

	// 4. Build exact detector-lineage lookups. A raw crop can carry more than
	// one component ID, but its recognized string is emitted at most once.
	const mappingStarted = performance.now();
	const rawTextMap = new Map<number, string>();
	const rawConfidenceMap = new Map<number, number>();
	for (const r of results) {
		rawTextMap.set(r.boxId, r.text);
		rawConfidenceMap.set(r.boxId, r.confidence);
	}
	const rawByComponentId = new Map<number, DetectedTextRegion>();
	for (const raw of rawRegions) {
		for (const componentId of componentIdsForRegion(raw)) {
			rawByComponentId.set(componentId, raw);
		}
	}

	// 5. Map recognized text onto groups by preserved source component IDs.
	const blocks: RecognizedBlock[] = [];
	const consumedRecognizedBoxes = new Set<number>();
	const groupRecognitionConfidence = new Map<number, number>();
	let suppressedRubyLines = 0;
	for (const merged of mergedRegions) {
		const orderedRaw = rawRegionsForGroup(merged, rawByComponentId);
		// Ruby columns are detected as their own lines, so without this the translator
		// receives the pronunciation guide spliced into the dialogue. Suppression is
		// text-only: the ruby component stays in the group so the overlay fill still
		// covers its pixels.
		const readableRaw = suppressRubyLines(orderedRaw, rawTextMap);
		const suppressed = orderedRaw.filter((raw) => !readableRaw.includes(raw));
		suppressedRubyLines += suppressed.length;
		// Suppressed lines were still attributed to a group, so they must not surface as
		// unmapped — that metric stays a lineage-bug signal rather than a ruby counter.
		for (const raw of suppressed) consumedRecognizedBoxes.add(raw.boxId);
		const texts: string[] = [];
		let confidenceWeight = 0;
		let confidenceSum = 0;
		for (const raw of readableRaw) {
			const text = rawTextMap.get(raw.boxId);
			if (text !== undefined && text.length > 0) {
				texts.push(text);
				consumedRecognizedBoxes.add(raw.boxId);
				// Length-weighted so a long confident line outweighs a stray
				// low-confidence fragment merged into the same group.
				const lineConfidence = rawConfidenceMap.get(raw.boxId);
				if (lineConfidence !== undefined) {
					confidenceWeight += text.length;
					confidenceSum += lineConfidence * text.length;
				}
			}
		}

		if (texts.length > 0) {
			if (confidenceWeight > 0) {
				groupRecognitionConfidence.set(merged.boxId, confidenceSum / confidenceWeight);
			}
			blocks.push({
				text: texts.join(separatorForGroup(merged)),
				x: merged.x,
				y: merged.y,
				width: merged.width,
				height: merged.height,
				// blockIndex is retained for RecognizedBlock compatibility; for PP-OCR it
				// is the stable group box ID rather than an array offset.
				blockIndex: merged.boxId
			});
		}
	}

	const mappingMs = performance.now() - mappingStarted;
	const classificationStarted = performance.now();
	const classificationCounts = emptyClassificationCounts();
	const ppocrGroups = mergedRegions.filter(isPPOcrTextGroup);
	const classificationInputGroups = ppocrGroups.map((group) => structuredClone(group));
	const pageMedianGlyphHeight = median(ppocrGroups.map((group) => group.trace.glyphScale));
	let featurePixels: FreeTextPixelBuffer | undefined;
	const needsFreeTextFeatures = ppocrGroups.some((group) => !group.inBubble);
	let freeTextFeatureMode: PPOCRExtractionMetrics['freeTextFeatureMode'] = 'not-required';
	if (needsFreeTextFeatures) {
		try {
			featurePixels = await loadFeaturePixels(imageFile, 1_200, options.signal);
			throwIfCancelled();
			freeTextFeatureMode = featurePixels ? 'visual' : 'geometry-fallback';
		} catch (error) {
			throwIfCancelled();
			freeTextFeatureMode = 'geometry-fallback';
			console.warn('[ppocr-extract] Free-text pixel features unavailable; using conservative geometry.', error);
		}
	}
	const featureDiagnostics = groupingDiagnostics ?? {
		inferredVerticalCuts: [],
		inferredHorizontalCuts: []
	};
	const blockTextByBoxId = new Map(blocks.map((block) => [block.blockIndex, block.text]));
	for (const merged of mergedRegions) {
		if (!isPPOcrTextGroup(merged)) {
			classificationCounts.unknown += 1;
			continue;
		}
		const recognizedText = blockTextByBoxId.get(merged.boxId);
		if (recognizedText === undefined) {
			classificationCounts[merged.groupKind ?? 'unknown'] += 1;
			continue;
		}
		const visualContext = featurePixels && !merged.inBubble
			? analyzeFreeTextGroupFeatures(featurePixels, merged, featureDiagnostics, {
				sourceWidth: imageWidth,
				sourceHeight: imageHeight,
				locale: options.locale,
				pageMedianGlyphHeight
			})
			: {
				locale: options.locale,
				imageWidth,
				imageHeight,
				pageMedianGlyphHeight
			};
		const classification = classifyRecognizedTextGroup(merged, recognizedText, visualContext);
		merged.groupKind = classification.kind;
		merged.classificationConfidence = classification.confidence;
		merged.classificationReasons = classification.reasons;
		merged.recognitionConfidence = groupRecognitionConfidence.get(merged.boxId);
		merged.trace.reasons = [...new Set([...merged.trace.reasons, ...classification.reasons])];
		classificationCounts[classification.kind] += 1;
	}
	if (groupingDiagnostics) groupingDiagnostics.classificationCounts = { ...classificationCounts };
	const classificationMs = performance.now() - classificationStarted;
	const metrics = sanitizeExtractionMetrics({
		rawRegions: rawRegions.length,
		mergedRegions: mergedRegions.length,
		groupedComponents: groupedComponentIds.size,
		unmappedComponents,
		ambiguousBubbleAssignments: groupingDiagnostics?.ambiguousBubbleAssignments ?? 0,
		recognizedLines: results.length,
		unmappedRecognizedLines: results.filter((result) => !consumedRecognizedBoxes.has(result.boxId)).length,
		suppressedRubyLines,
		blocks: blocks.length,
		reusedDetection: options.detection !== undefined,
		freeTextFeatureMode,
		detectorInitializationMs,
		detectionMs,
		groupingMs,
		recognizerInitializationMs,
		recognitionMs,
		mappingMs,
		classificationMs,
		totalMs: performance.now() - totalStarted
	});
	logExtractionMetrics(metrics);
	return {
		blocks,
		mergedRegions,
		groups: mergedRegions,
		classificationInputGroups,
		groupingDiagnostics,
		classificationCounts,
		metrics
	};
}

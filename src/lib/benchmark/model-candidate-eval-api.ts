/**
 * Model-candidate evaluation host (internal testing).
 *
 * Installs `window.__fumeto_model_candidates` beside the OCR benchmark host
 * (+page.svelte), gated on the same debug-build check. Drives the candidate
 * OCR / bubble-layout models pushed into `appDataDir()/models/` through the
 * PRODUCTION detection/grouping/classification pipeline so per-configuration
 * differences are exactly what production would see.
 *
 * Tier-1 (`runComponentMatrix`): per fixture page —
 *   detection once → for every bubble provider (incl. the `none` ablation)
 *   full extraction (grouping + classification + recognitionConfidence) →
 *   group/kind metrics + provider timings + pairwise bubble IoU agreement;
 *   optionally manga-ocr on the baseline merged groups and a vision-LLM
 *   reference reading per group for similarity scoring.
 *
 * Tier-2 lives in `model-candidate-overrides.ts`; this host exposes the
 * setters so the e2e spec can flip configurations between real translation
 * runs.
 */

import {
	detectTextRegionsForRecognition,
	initDetector
} from '$lib/detection/ppocr-detector.js';
import { extractTextWithPPOCR } from '$lib/translation/ppocr-text-extractor.js';
import {
	ALL_BUBBLE_PROVIDERS,
	detectLayoutWithProvider,
	isBubbleProviderAvailable,
	type BubbleProviderId,
	type CandidateLayoutResult
} from '$lib/detection/candidates/layout-provider.js';
import {
	candidateAvailability,
	releaseCandidateModelSessions
} from '$lib/detection/candidates/candidate-model-files.js';
import {
	initMangaOcr,
	isMangaOcrReady,
	recognizeCropWithMangaOcr,
	releaseMangaOcrRuntime
} from '$lib/detection/candidates/manga-ocr-recognizer.js';
import {
	clearModelCandidateOverrides,
	getModelCandidateOverrides,
	setModelCandidateOverrides,
	type ModelCandidateOverrides
} from '$lib/detection/model-candidate-overrides.js';
import { annotateImageWithBoxes } from '$lib/detection/image-annotator.js';
import { buildOverlayMessages, parseOverlayResponse } from '$lib/translation/full-page-prompt.js';
import { callLLM } from '$lib/translation/llm-client.js';
import { textSimilarity } from '$lib/util/text-similarity.js';
import type { DetectedTextRegion } from '$lib/types/index.js';

export const MODEL_CANDIDATE_SCHEMA_VERSION = 1;

export interface ModelCandidateFixtureDescriptor {
	id: string;
	base64: string;
	mimeType: string;
	sha256: string;
}

export interface ComponentMatrixOptions {
	/** Bubble providers to run; defaults to every available provider + none. */
	bubbleProviders?: BubbleProviderId[];
	/** Run manga-ocr on the baseline merged groups (default: if available). */
	runMangaOcr?: boolean;
	/** Ask the active vision provider to read each group as pseudo-GT. */
	llmReference?: boolean;
	/** Cap on groups fed to manga-ocr / the LLM reference (default 14). */
	maxGroups?: number;
	locale?: string;
}

interface GroupRecord {
	boxId: number;
	x: number;
	y: number;
	width: number;
	height: number;
	kind: string;
	inBubble: boolean;
	nonDialogueMeta: boolean;
	recognitionConfidence: number | null;
	ppocrText: string;
	mangaOcrText?: string;
	mangaOcrMs?: number;
	llmReferenceText?: string;
	ppocrSimilarity?: number;
	mangaOcrSimilarity?: number;
}

interface BubbleConfigRecord {
	providerId: BubbleProviderId;
	available: boolean;
	error?: string;
	layoutMs?: number;
	bubbleCount?: number;
	panelCount?: number;
	bubbles?: Array<{ x: number; y: number; width: number; height: number; confidence: number; contourPoints: number }>;
	groupCount?: number;
	kindHistogram?: Record<string, number>;
	inBubbleRate?: number;
	nonDialogueMetaCount?: number;
	meanRecognitionConfidence?: number | null;
	extractionMs?: number;
}

export interface ComponentMatrixResult {
	schemaVersion: number;
	fixtureId: string;
	fixtureSha256: string;
	imageWidth: number;
	imageHeight: number;
	detectionMs: number;
	rawRegionCount: number;
	baselineProvider: BubbleProviderId;
	groups: GroupRecord[];
	bubbleConfigs: BubbleConfigRecord[];
	/** IoU-based greedy agreement between provider bubble sets, keyed "a|b". */
	bubbleAgreement: Record<string, { matched: number; aOnly: number; bOnly: number; meanIou: number }>;
	llmReferenceUsed: boolean;
	llmReferenceError?: string;
	totalMs: number;
}

function decodeBase64ToFile(descriptor: ModelCandidateFixtureDescriptor): Promise<File> {
	const binary = atob(descriptor.base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return crypto.subtle.digest('SHA-256', bytes).then((digest) => {
		const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
		if (actual.toLowerCase() !== descriptor.sha256.toLowerCase()) {
			throw new Error(`fixture digest mismatch: expected ${descriptor.sha256}, got ${actual}`);
		}
		return new File([bytes], `${descriptor.id}.fixture`, { type: descriptor.mimeType });
	});
}

function boxIou(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number }
): number {
	const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
	const inter = ix * iy;
	const union = a.width * a.height + b.width * b.height - inter;
	return union > 0 ? inter / union : 0;
}

function greedyAgreement(
	setA: Array<{ x: number; y: number; width: number; height: number }>,
	setB: Array<{ x: number; y: number; width: number; height: number }>
): { matched: number; aOnly: number; bOnly: number; meanIou: number } {
	const usedB = new Set<number>();
	let matched = 0;
	let iouSum = 0;
	for (const a of setA) {
		let best = -1;
		let bestIou = 0.5; // match threshold
		setB.forEach((b, index) => {
			if (usedB.has(index)) return;
			const iou = boxIou(a, b);
			if (iou > bestIou) {
				bestIou = iou;
				best = index;
			}
		});
		if (best >= 0) {
			usedB.add(best);
			matched++;
			iouSum += bestIou;
		}
	}
	return {
		matched,
		aOnly: setA.length - matched,
		bOnly: setB.length - matched,
		meanIou: matched > 0 ? iouSum / matched : 0
	};
}

async function runLlmReference(
	imageFile: File,
	groups: DetectedTextRegion[]
): Promise<Map<number, string>> {
	const annotated = await annotateImageWithBoxes(imageFile, groups, 1536);
	const messages = buildOverlayMessages(annotated, 'ja', 'en');
	const response = await callLLM(messages, { temperature: 0 });
	// No authoritativeOriginals: the provider's own readings must survive.
	const parsed = parseOverlayResponse(response.content, groups);
	const readings = new Map<number, string>();
	for (const entry of parsed.overlayEntries) {
		if (entry.original_text) readings.set(entry.boxId, entry.original_text);
	}
	return readings;
}

async function runComponentMatrix(
	descriptor: ModelCandidateFixtureDescriptor,
	options: ComponentMatrixOptions = {}
): Promise<ComponentMatrixResult> {
	const totalStarted = performance.now();
	const file = await decodeBase64ToFile(descriptor);
	const locale = options.locale ?? 'ja';

	// Detection once; every bubble configuration regroups the same components.
	await initDetector();
	const detectionStarted = performance.now();
	const detection = await detectTextRegionsForRecognition(file, { locale, deferGrouping: true });
	const detectionMs = performance.now() - detectionStarted;

	const requested = options.bubbleProviders ?? [...ALL_BUBBLE_PROVIDERS];
	const layouts = new Map<BubbleProviderId, CandidateLayoutResult>();
	const bubbleConfigs: BubbleConfigRecord[] = [];
	let baselineGroups: DetectedTextRegion[] | null = null;
	let baselineTextByBoxId = new Map<number, string>();
	// Production baseline is the rtmdet native engine (see layout-detector.ts).
	const baselineProvider: BubbleProviderId = requested.includes('rtmdet-native')
		? 'rtmdet-native'
		: requested[0];

	for (const providerId of requested) {
		const record: BubbleConfigRecord = { providerId, available: false };
		bubbleConfigs.push(record);
		try {
			if (!(await isBubbleProviderAvailable(providerId))) {
				record.error = 'model files not present';
				continue;
			}
			const layout = await detectLayoutWithProvider(providerId, file);
			layouts.set(providerId, layout);
			record.available = true;
			record.layoutMs = Math.round(layout.inferenceMs);
			record.bubbleCount = layout.bubbles.length;
			record.panelCount = layout.panels.length;
			record.bubbles = layout.bubbles.map((bubble) => ({
				x: Math.round(bubble.x),
				y: Math.round(bubble.y),
				width: Math.round(bubble.width),
				height: Math.round(bubble.height),
				confidence: Number(bubble.confidence.toFixed(3)),
				contourPoints: bubble.contour.length
			}));

			const extractionStarted = performance.now();
			const extraction = await extractTextWithPPOCR(file, {
				detection,
				bubbles: layout.bubbles,
				locale
			});
			record.extractionMs = Math.round(performance.now() - extractionStarted);
			const regions = extraction.groups;
			const textByBoxId = new Map(extraction.blocks.map((block) => [block.blockIndex, block.text]));
			record.groupCount = regions.length;
			const histogram: Record<string, number> = {};
			let inBubble = 0;
			let meta = 0;
			let confidenceSum = 0;
			let confidenceCount = 0;
			for (const region of regions) {
				const kind = region.groupKind ?? 'unknown';
				histogram[kind] = (histogram[kind] ?? 0) + 1;
				if (region.inBubble) inBubble++;
				if (region.classificationReasons?.includes('non-dialogue-meta')) meta++;
				if (region.recognitionConfidence !== undefined) {
					confidenceSum += region.recognitionConfidence;
					confidenceCount++;
				}
			}
			record.kindHistogram = histogram;
			record.inBubbleRate = regions.length > 0 ? Number((inBubble / regions.length).toFixed(3)) : 0;
			record.nonDialogueMetaCount = meta;
			record.meanRecognitionConfidence =
				confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(3)) : null;

			if (providerId === baselineProvider) {
				baselineGroups = regions;
				baselineTextByBoxId = textByBoxId;
			}
		} catch (err) {
			record.error = err instanceof Error ? err.message : String(err);
		}
	}

	// Pairwise bubble agreement across providers that produced bubbles.
	const bubbleAgreement: ComponentMatrixResult['bubbleAgreement'] = {};
	const producing = [...layouts.entries()].filter(([id]) => id !== 'none');
	for (let i = 0; i < producing.length; i++) {
		for (let j = i + 1; j < producing.length; j++) {
			const [idA, layoutA] = producing[i];
			const [idB, layoutB] = producing[j];
			bubbleAgreement[`${idA}|${idB}`] = greedyAgreement(layoutA.bubbles, layoutB.bubbles);
		}
	}

	// Group-level OCR records from the baseline configuration.
	const groups: GroupRecord[] = (baselineGroups ?? []).map((region) => ({
		boxId: region.boxId,
		x: Math.round(region.x),
		y: Math.round(region.y),
		width: Math.round(region.width),
		height: Math.round(region.height),
		kind: region.groupKind ?? 'unknown',
		inBubble: Boolean(region.inBubble),
		nonDialogueMeta: Boolean(region.classificationReasons?.includes('non-dialogue-meta')),
		recognitionConfidence:
			region.recognitionConfidence !== undefined
				? Number(region.recognitionConfidence.toFixed(3))
				: null,
		ppocrText: baselineTextByBoxId.get(region.boxId) ?? ''
	}));
	const maxGroups = options.maxGroups ?? 14;
	const scoredGroups = groups.slice(0, maxGroups);

	// OCR axis: manga-ocr on the same crops.
	const availability = await candidateAvailability();
	const wantMangaOcr = options.runMangaOcr ?? availability['manga-ocr'];
	if (wantMangaOcr && availability['manga-ocr'] && baselineGroups) {
		await initMangaOcr();
		const bitmap = await createImageBitmap(file);
		try {
			for (const group of scoredGroups) {
				try {
					const result = await recognizeCropWithMangaOcr(bitmap, group);
					group.mangaOcrText = result.text;
					group.mangaOcrMs = Math.round(result.encoderMs + result.decodeMs);
				} catch (err) {
					group.mangaOcrText = `[error: ${err instanceof Error ? err.message : String(err)}]`;
				}
			}
		} finally {
			bitmap.close();
		}
	}

	// Vision-LLM pseudo-ground-truth per group.
	let llmReferenceUsed = false;
	let llmReferenceError: string | undefined;
	if (options.llmReference && baselineGroups) {
		try {
			const referenceRegions = baselineGroups.filter((region) =>
				scoredGroups.some((group) => group.boxId === region.boxId)
			);
			const readings = await runLlmReference(file, referenceRegions);
			for (const group of scoredGroups) {
				const reference = readings.get(group.boxId);
				if (reference === undefined) continue;
				group.llmReferenceText = reference;
				group.ppocrSimilarity = Number(textSimilarity(group.ppocrText, reference).toFixed(3));
				if (group.mangaOcrText !== undefined && !group.mangaOcrText.startsWith('[error')) {
					group.mangaOcrSimilarity = Number(
						textSimilarity(group.mangaOcrText, reference).toFixed(3)
					);
				}
			}
			llmReferenceUsed = true;
		} catch (err) {
			llmReferenceError = err instanceof Error ? err.message : String(err);
		}
	}

	return {
		schemaVersion: MODEL_CANDIDATE_SCHEMA_VERSION,
		fixtureId: descriptor.id,
		fixtureSha256: descriptor.sha256.toLowerCase(),
		imageWidth: detection.imageWidth,
		imageHeight: detection.imageHeight,
		detectionMs: Math.round(detectionMs),
		rawRegionCount: detection.rawRegions.length,
		baselineProvider,
		groups,
		bubbleConfigs,
		bubbleAgreement,
		llmReferenceUsed,
		llmReferenceError,
		totalMs: Math.round(performance.now() - totalStarted)
	};
}

export interface ReaderTranslationRunResult {
	status: string;
	error: string | null;
	durationMs: number;
	volumeUuid: string;
	pageIndex: number;
	overrides: ModelCandidateOverrides;
	/** From the persisted document after the run. */
	entryCount: number | null;
	overlayItemCount: number | null;
	entryKinds: Record<string, number> | null;
	overlayStatus: string;
}

/**
 * Tier-2 runner: drives the PRODUCTION reader translation controller on the
 * currently open reader page (whatever pipeline settings select), then
 * summarizes the persisted overlay document. The e2e spec flips overrides
 * between calls to compare configurations on identical pages.
 */
async function runReaderTranslation(): Promise<ReaderTranslationRunResult> {
	const [{ readerPageTranslationController }, readerState, storeModule, overlayModule] =
		await Promise.all([
			import('$lib/translation/reader-page-translation-runtime.js'),
			import('$lib/stores/reader-state.js'),
			import('svelte/store'),
			import('$lib/overlay-layout/index.js')
		]);
	const { get } = storeModule;
	const volume = get(readerState.currentVolume);
	if (!volume) throw new Error('Open a reader page before running a Tier-2 translation');
	const target = {
		readerSessionId: get(readerState.readerSessionId),
		targetEpoch: get(readerState.readerTargetEpoch),
		volumeUuid: volume.volume_uuid,
		pageIndex: get(readerState.currentPageIndex)
	};
	const started = performance.now();
	const outcome = await readerPageTranslationController.requestManual(target);
	const durationMs = Math.round(performance.now() - started);

	let entryCount: number | null = null;
	let overlayItemCount: number | null = null;
	let entryKinds: Record<string, number> | null = null;
	let overlayStatus = 'unread';
	try {
		const read = await overlayModule.pageOverlayRepository.load(target.volumeUuid, target.pageIndex);
		overlayStatus = read.status;
		if (read.pageTranslation) {
			entryCount = read.pageTranslation.entries.length;
			entryKinds = {};
			for (const entry of read.pageTranslation.entries) {
				const kind = entry.type ?? 'unknown';
				entryKinds[kind] = (entryKinds[kind] ?? 0) + 1;
			}
		}
		overlayItemCount = read.overlay?.items.length ?? null;
	} catch (err) {
		overlayStatus = `read-error: ${err instanceof Error ? err.message : String(err)}`;
	}

	const outcomeError = (outcome as { error?: { message?: string } | null }).error;
	return {
		status: outcome.status,
		error: outcomeError?.message ?? null,
		durationMs,
		volumeUuid: target.volumeUuid,
		pageIndex: target.pageIndex,
		overrides: getModelCandidateOverrides(),
		entryCount,
		overlayItemCount,
		entryKinds,
		overlayStatus
	};
}

export interface ModelCandidateEvalApi {
	getStatus: () => Promise<{
		schemaVersion: number;
		candidates: Record<string, boolean>;
		mangaOcrReady: boolean;
		overrides: ModelCandidateOverrides;
		crossOriginIsolated: boolean;
		hardwareConcurrency: number;
	}>;
	runComponentMatrix: (
		descriptor: ModelCandidateFixtureDescriptor,
		options?: ComponentMatrixOptions
	) => Promise<ComponentMatrixResult>;
	runReaderTranslation: () => Promise<ReaderTranslationRunResult>;
	setOverrides: (overrides: ModelCandidateOverrides) => ModelCandidateOverrides;
	clearOverrides: () => void;
	release: () => Promise<void>;
}

/** Debug-build-gated install, mirroring `installOcrBenchmarkHost`. */
export function installModelCandidateEvalApi(): (() => void) | null {
	if (typeof window === 'undefined') return null;
	const bridgeWindow = window as unknown as Record<string, unknown>;
	const buildBridge = bridgeWindow.__fumeto_llama as
		| { isBenchmarkBuild?: () => boolean }
		| undefined;
	if (buildBridge?.isBenchmarkBuild?.() !== true) return null;

	// One evaluation operation at a time: interleaved matrix/translation runs
	// (e.g. a runaway driver) would share detector sessions and overrides and
	// silently corrupt the comparison.
	let busy: string | null = null;
	const exclusive = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
		if (busy) throw new Error(`model-candidate host is busy with ${busy}`);
		busy = name;
		try {
			return await work();
		} finally {
			busy = null;
		}
	};

	const api: ModelCandidateEvalApi = {
		getStatus: async () => ({
			schemaVersion: MODEL_CANDIDATE_SCHEMA_VERSION,
			candidates: await candidateAvailability(),
			mangaOcrReady: isMangaOcrReady(),
			overrides: getModelCandidateOverrides(),
			// WASM threads only engage under cross-origin isolation (COOP/COEP)
			crossOriginIsolated: globalThis.crossOriginIsolated === true,
			hardwareConcurrency: navigator.hardwareConcurrency ?? 1
		}),
		runComponentMatrix: (descriptor, options) =>
			exclusive('runComponentMatrix', () => runComponentMatrix(descriptor, options)),
		runReaderTranslation: () => exclusive('runReaderTranslation', runReaderTranslation),
		setOverrides: (overrides) => setModelCandidateOverrides(overrides),
		clearOverrides: () => clearModelCandidateOverrides(),
		release: async () => {
			releaseMangaOcrRuntime();
			await releaseCandidateModelSessions();
		}
	};

	bridgeWindow.__fumeto_model_candidates = api;
	return () => {
		if (bridgeWindow.__fumeto_model_candidates === api) {
			delete bridgeWindow.__fumeto_model_candidates;
		}
	};
}

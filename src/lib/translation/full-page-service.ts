/**
 * Full-page translation service.
 *
 * Translates an entire manga page at once (not cropped regions),
 * returning ordered translations in manga reading order.
 */

import { PageTranslationMissingError } from '$lib/i18n/errors.js';
import { get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { db } from '$lib/db/index.js';
import { settings, type FumetoSettings } from '$lib/settings/settings.js';
import { callLLMWithProvider, resolveActiveProvider, isProviderVisionMode } from './llm-client.js';
import {
	buildOverlayMessages
} from './full-page-prompt.js';
import { extractTextWithPPOCR, type PPOCRExtractionResult } from './ppocr-text-extractor.js';
import type { RecognizedBlock } from './recognized-block.js';
import type { OverlayCoverageDiagnostics } from './translation-coverage.js';
import {
	buildTextOnlyOverlayMessages,
	buildMissingOverlayRepairMessages
} from './text-only-prompts.js';
import {
	aggregateTranslationUsage,
	reconcileOverlayTranslation
} from './overlay-translation-reconciliation.js';
import { debugLogParse } from './debug-log.js';
import { resizeBlobToBase64 } from '$lib/util/base64.js';
import { TRANSLATION_JSON_MODE, providerSupportsStructuredOutput } from './json-schemas.js';
import { readingDirection, currentVolume, currentPageIndex, overlayFontScale } from '$lib/stores/reader-state.js';
import {
	setCurrentPageTranslationPayload,
	isPageTranslating
} from '$lib/stores/translation-state.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import { combinePageRequestSignals } from '$lib/reader/page-source.js';
import {
	initDetector,
	detectTextRegionsForRecognition,
	type PPOcrRecognitionDetection
} from '$lib/detection/ppocr-detector.js';
import { type BubbleRegion } from '$lib/detection/bubble-geometry.js';
import { detectLayout } from '$lib/detection/layout-detector.js';
import { overrideBubblesForEval } from '$lib/detection/model-candidate-overrides.js';
import { mergeTextWithBubbles } from '$lib/detection/spatial-merge.js';
import { resolveTextDetectionFusion } from '$lib/detection/fusion-guard.js';
import { annotateImageWithBoxes } from '$lib/detection/image-annotator.js';
import type {
	PageTranslation,
	PageTranslationEntry,
	PageTranslationEntryDraft,
	PageOverlayData,
	PageOverlayDraft,
	TranslationRegion,
	Translation,
	DetectedTextRegion,
	OverlayEntry
} from '$lib/types/index.js';
import type { ChatMessage, LLMResponse } from './llm-types.js';
import { parseFirstJsonObject } from './json-utils.js';
import { isMeaningfulOcrText } from './ocr-text-filter.js';
import { acquirePageTranslationActivity, releasePageTranslationActivity } from './page-translation-activity.js';
import {
	createEmptyOverlayDocumentV2,
	createOverlayDocumentV2,
	ensureStableTranslationEntries,
	inspectOverlaySourceImage,
	overlayLayoutSettingsFromApp,
	overlayTargetLocale,
	adoptDurableRecord,
	pageOverlayRepository
} from '$lib/overlay-layout/index.js';

// ============================================================
// Image utilities (shared with volume translation)
// ============================================================

export interface FullPageTranslationRunOptions {
	/** Cancels page acquisition, OCR/detection, provider calls, persistence, and inpainting. */
	signal?: AbortSignal;
	/** Reports backend-owned work so reader UI does not guess from call boundaries. */
	onPhase?: (phase: 'detecting' | 'translating' | 'repairing' | 'persisting' | 'post-processing') => void;
	/**
	 * Runs synchronously after the page record transaction commits. A
	 * cancellation observed after this boundary must not make the durable
	 * translation disappear from the reader.
	 */
	onPersisted?: (result: FullPageTranslationPersistedResult) => void;
	/** Rejects an asynchronous result superseded by a newer reader run. */
	shouldPublishAsyncResult?: () => boolean;
	/** Immutable reader-run choices captured before any asynchronous work starts. */
	runtime?: {
		settings: Readonly<FumetoSettings>;
		provider: Awaited<ReturnType<typeof resolveActiveProvider>>;
		readingDirection: 'rtl' | 'ltr';
	};
	/**
	 * Detection and recognition already run for this page by
	 * `preparePageForTranslation`. Supplying it skips every OCR stage, so several
	 * providers can translate one page from identical box ids at one OCR cost.
	 * The reader never sets this; evaluation harnesses do.
	 */
	prepared?: PreparedPage;
	/**
	 * Return the result without writing `page_translations` or calling
	 * `onPersisted` — the on-device path's `skipPersist`, mirrored. A harness
	 * owns its own records; the reader never sets this.
	 */
	skipPersist?: boolean;
}

/** One page's detection and recognition, reusable across provider runs. */
export interface PreparedPage {
	imageBlob: Blob;
	sourceImage: Awaited<ReturnType<typeof inspectOverlaySourceImage>>;
	detection: PPOcrRecognitionDetection;
	bubbles: BubbleRegion[];
	/** Canonical groups; after recognition these are the refined groups. */
	regions: DetectedTextRegion[];
	/** `null` when detection found no regions, so recognition never ran. */
	extraction: PPOCRExtractionResult | null;
	meaningfulBlocks: RecognizedBlock[];
	sourceLocale: string;
	readingDirection: 'rtl' | 'ltr';
	useBubbleSeg: boolean;
	timings: { detectMs: number; extractMs: number };
}

/** Provider-side facts of one run that the durable record does not keep. */
export interface FullPageTranslationDiagnostics {
	coverage: OverlayCoverageDiagnostics;
	repaired: boolean;
	visionMode: boolean;
	requests: number;
	llmMs: number;
	repairMs: number;
	detectMs: number;
	extractMs: number;
	initialResponse: Pick<LLMResponse, 'model' | 'finish_reason' | 'usage'>;
	rawContent: string;
	repairRawContent?: string;
}

export interface FullPageTranslationPersistedResult {
	pageTranslation: PageTranslation;
	overlayData: PageOverlayData | null;
}

function translationCancelledError(): Error {
	const error = new Error('Translation cancelled');
	error.name = 'AbortError';
	return error;
}

function throwIfFullPageCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw translationCancelledError();
}

function throwIfAsyncResultStale(options: FullPageTranslationRunOptions): void {
	throwIfFullPageCancelled(options.signal);
	if (options.shouldPublishAsyncResult && !options.shouldPublishAsyncResult()) {
		throw translationCancelledError();
	}
}

/** Roll a page record back when cancellation lands while its IndexedDB put is pending. */
async function persistPageTranslation(
	pageTranslation: PageTranslation,
	signal?: AbortSignal
): Promise<void> {
	throwIfFullPageCancelled(signal);
	pageTranslation.entries = ensureStableTranslationEntries(
		pageTranslation.entries,
		[pageTranslation.volume_uuid, pageTranslation.page_index, pageTranslation.id]
	);
	// The durable row is the authority: the repository carries the reader's
	// manual edits forward from the record this one replaces, and the reader
	// must see THAT document, not the adapter's fresh one. Adoption is
	// content-guarded; see `adoptDurableRecord`.
	adoptDurableRecord(pageTranslation, await pageOverlayRepository.put(pageTranslation, signal));
}

async function persistPageTranslationForRun(
	pageTranslation: PageTranslation,
	options: FullPageTranslationRunOptions
): Promise<void> {
	options.onPhase?.('persisting');
	await persistPageTranslation(pageTranslation, options.signal);
	// pageOverlayRepository.put performs its final signal check inside the same
	// IndexedDB transaction. Once it resolves, the row is authoritative even if
	// AbortSignal flips before this continuation runs.
	options.onPersisted?.({
		pageTranslation,
		overlayData: pageTranslation.overlay_data ?? null
	});
}

/**
 * Convert a File to a resized base64 data URI for the LLM API.
 *
 * Uses resizeBlobToBase64 to avoid creating a full-resolution base64
 * intermediate string (which can be ~16MB for large manga pages).
 */
export async function fileToBase64(
	file: File,
	maxSize: number = 1536,
	signal?: AbortSignal
): Promise<string> {
	throwIfFullPageCancelled(signal);
	const result = await resizeBlobToBase64(file, maxSize, signal);
	throwIfFullPageCancelled(signal);
	return result;
}

// ============================================================
// LLM refusal detection
// ============================================================

/**
 * Strong refusal patterns — always indicate an outright refusal,
 * even if the response also contains some output.
 */
const STRONG_REFUSAL_PATTERNS = [
	/content policy/i,
	/inappropriate content/i,
	/I must decline/i,
	/against my guidelines/i,
	/I cannot assist/i,
	/I can't assist/i,
	/I won't be able to/i,
	/I'm not able to help/i,
	/violates? (?:my|the|our) (?:guidelines|policies|terms)/i,
	/I'm not designed to/i,
	/I don't feel comfortable/i,
	/I shouldn't (?:help|assist|provide)/i,
	/I refuse to/i,
	/not (?:able|going) to (?:help|assist|translate)/i
];

/**
 * Weak refusal patterns — only flag as a refusal if no valid
 * translation output is present. These phrases can appear in
 * legitimate responses (e.g., "I can't read this kanji").
 */
const WEAK_REFUSAL_PATTERNS = [
	/I can't (?:translate|process|help|do)/i,
	/I cannot (?:translate|process|help|do)/i,
	/I'm unable to (?:translate|process|help)/i,
	/I am unable to (?:translate|process|help)/i,
	/I'm sorry,? but I (?:can't|cannot|won't|am unable)/i,
	/I'm afraid I (?:can't|cannot|won't)/i,
	/as an AI,? I (?:can't|cannot|shouldn't)/i,
	/I'm not (?:able|going) to/i,
	/not appropriate for me to/i
];

/**
 * Check if content contains valid translation JSON output.
 * If it does, the response is useful regardless of hedging language.
 */
function hasValidTranslationOutput(content: string): boolean {
	const parsed = parseFirstJsonObject(content);
	if (!parsed) return false;

	// Full-page / revision entries schema
	if (Array.isArray(parsed.entries)) {
		return (
			parsed.entries.length === 0 ||
			parsed.entries.some(
				(e: Record<string, unknown>) =>
					typeof e.translated_text === 'string' || typeof e.original_text === 'string'
			)
		);
	}

	// Overlay schema: { translations: { "1": {...} } }
	if (parsed.translations && typeof parsed.translations === 'object') {
		return true; // even empty object is valid structured output (e.g., no text)
	}

	// Review schema: { issues: [...], revised_entries: ... }
	if (Array.isArray(parsed.issues) || 'revised_entries' in parsed) {
		return true;
	}

	// Single-box revision schema
	if (typeof parsed.translated_text === 'string' || typeof parsed.original_text === 'string') {
		return true;
	}

	// Misc structured schema used by some prompts
	if (typeof parsed.description === 'string' && parsed.description.trim().length > 0) {
		return true;
	}

	return false;
}

/**
 * Check LLM response for refusal patterns.
 *
 * Two-tier detection:
 * 1. Strong patterns always trigger (clear policy refusals)
 * 2. Weak patterns only trigger if no valid JSON output is present
 *
 * This prevents false positives like "I can't see any text on this page"
 * when the model still provides useful structured output.
 *
 * Throws an error with the refusal message if detected.
 */
export function detectRefusal(content: string): void {
	// If valid translation output is present, skip ALL refusal checks.
	// Translated manga dialogue can naturally contain refusal-like phrases
	// (e.g., "I won't be able to", "I refuse to", "I don't feel comfortable")
	// which are character dialogue, not LLM refusals.
	if (hasValidTranslationOutput(content)) return;

	// Strong refusals always trigger when no valid output is present
	for (const pattern of STRONG_REFUSAL_PATTERNS) {
		if (pattern.test(content)) {
			const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
			throw new Error(`LLM refused to translate. Response: "${preview}"`);
		}
	}

	// Weak refusals also trigger when no valid output is present
	for (const pattern of WEAK_REFUSAL_PATTERNS) {
		if (pattern.test(content)) {
			const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
			throw new Error(`LLM refused to translate. Response: "${preview}"`);
		}
	}
}

async function detectPageRegions(
	imageFile: File,
	{
		useBubbleSeg = false,
		locale,
		readingDirection: pageReadingDirection,
		signal
	}: {
		useBubbleSeg?: boolean;
		locale?: string;
		readingDirection?: 'rtl' | 'ltr';
		signal?: AbortSignal;
	} = {}
): Promise<{
	imageBlob: Blob;
	regions: DetectedTextRegion[];
	detection: PPOcrRecognitionDetection;
	bubbles: BubbleRegion[];
}> {
	throwIfFullPageCancelled(signal);
	await initDetector({ signal });
	throwIfFullPageCancelled(signal);
	const imageBuffer = await imageFile.arrayBuffer();
	throwIfFullPageCancelled(signal);
	const imageBlob = new Blob([imageBuffer], {
		type: imageFile.type
	});

	let detection: PPOcrRecognitionDetection;
	{
		detection = await detectTextRegionsForRecognition(imageBlob, {
			signal,
			deferGrouping: true,
			locale
		});
		throwIfFullPageCancelled(signal);
	}

	let bubbles: BubbleRegion[] = [];
	// Bubble segmentation is an enhancement. If the optional model/runtime is
	// unavailable, group the same raw evidence as free text.
	if (useBubbleSeg && detection.rawRegions.length > 0) {
		// Debug-only model-candidate override (no-op in production/release).
		const overrideBubbles = await overrideBubblesForEval(imageBlob, { signal });
		throwIfFullPageCancelled(signal);
		if (overrideBubbles !== null) {
			bubbles = overrideBubbles;
		} else {
			try {
				bubbles = (await detectLayout(imageBlob, { signal })).bubbles;
				throwIfFullPageCancelled(signal);
			} catch (error) {
				throwIfFullPageCancelled(signal);
				console.warn('Layout detection unavailable; falling back to PP-OCR auto-fit boxes.', error);
			}
		}
	}
	if (bubbles.length >= 2) {
		// The probability map (if captured above) intentionally stays at the
		// original detection resolution: it is page-level ink evidence for
		// inpainting, while regions are page-coordinate geometry either way.
		detection = await resolveTextDetectionFusion(imageBlob, detection, bubbles, {
			signal,
			locale
		});
		throwIfFullPageCancelled(signal);
	}
	const regions = mergeTextWithBubbles(
		detection.rawRegions,
		bubbles,
		detection.imageWidth,
		detection.imageHeight,
		{ signal, locale, readingDirection: pageReadingDirection }
	);
	throwIfFullPageCancelled(signal);
	detection = { ...detection, mergedRegions: regions };
	return { imageBlob, regions, detection, bubbles };
}

function createNoTextPageTranslation(
	volumeUuid: string,
	pageIndex: number,
	overlayData?: PageOverlayData
): PageTranslation {
	return {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		entries: [],
		model: 'ppocr-no-text',
		prompt_tokens: 0,
		completion_tokens: 0,
		created_at: new Date().toISOString(),
		overlay_data: overlayData,
		no_text_detected: true
	};
}

// ============================================================
// Full-page translation
// ============================================================

/**
 * Translate an entire page image.
 *
 * Sends the full page to the LLM with instructions to identify and
 * translate all text in manga reading order.
 */
export async function translateFullPage(
	volumeUuid: string,
	pageIndex: number,
	imageFile: File,
	context?: string,
	options: FullPageTranslationRunOptions = {}
): Promise<PageTranslation> {
	const signal = options.signal;
	throwIfFullPageCancelled(signal);
	options.onPhase?.('detecting');
	const $settings = options.runtime?.settings ?? get(settings);
	const sourceLocale = $settings.sourceLanguage === 'auto' ? 'ja' : $settings.sourceLanguage;
	const pageReadingDirection = options.runtime?.readingDirection ?? get(readingDirection);
	const { imageBlob, regions: detectedRegions, detection, bubbles } = await detectPageRegions(imageFile, {
		signal,
		locale: sourceLocale,
		readingDirection: pageReadingDirection
	});
	throwIfFullPageCancelled(signal);

	// Skip LLM calls on pages where PP-OCR detects no text.
	if (detectedRegions.length === 0) {
		const noText = createNoTextPageTranslation(volumeUuid, pageIndex);
		await persistPageTranslationForRun(noText, options);
		return noText;
	}
	const extraction = await extractTextWithPPOCR(imageFile, {
		signal,
		detection,
		bubbles,
		locale: sourceLocale,
		readingDirection: pageReadingDirection
	});
	throwIfFullPageCancelled(signal);
	const regions = extraction.mergedRegions;
	const meaningfulBlocks = extraction.blocks.filter((block) => isMeaningfulOcrText(block.text));
	if (meaningfulBlocks.length === 0) {
		const noText = createNoTextPageTranslation(volumeUuid, pageIndex);
		await persistPageTranslationForRun(noText, options);
		return noText;
	}

	// Resolve vision mode
	const resolvedProvider = options.runtime?.provider ?? await resolveActiveProvider();
	throwIfFullPageCancelled(signal);
	const provider = { ...resolvedProvider, config: { ...resolvedProvider.config } };
	const { config: providerConfig } = provider;
	const visionMode = isProviderVisionMode(providerConfig);

	let messages: ChatMessage[];
	if (visionMode) {
		const annotatedBase64 = await annotateImageWithBoxes(imageBlob, regions, 1536, signal);
		messages = buildOverlayMessages(
			annotatedBase64,
			$settings.sourceLanguage,
			$settings.targetLanguage,
			context
		);
	} else {
		messages = buildTextOnlyOverlayMessages(
			meaningfulBlocks,
			regions,
			$settings.sourceLanguage,
			$settings.targetLanguage,
			context
		);
	}

	const useJsonMode = providerSupportsStructuredOutput(providerConfig.type);
	options.onPhase?.('translating');
	const response = await callLLMWithProvider(provider, messages, {
		temperature: $settings.temperature,
		maxTokens: $settings.maxContextTokens ?? 10000,
		signal,
		responseFormat: useJsonMode ? TRANSLATION_JSON_MODE : undefined
	});
	throwIfFullPageCancelled(signal);
	if (response.finish_reason === 'length') {
		throw new Error(
			'Translation output was truncated (max tokens reached). Increase max context tokens and retry.'
		);
	}

	const authoritativeOriginals = new Map(meaningfulBlocks.map((block) => [block.blockIndex, block.text]));
	const parsedResponse = await reconcileOverlayTranslation({
		initialResponse: response,
		regions,
		authoritativeOriginals,
		onRepairing: () => options.onPhase?.('repairing'),
		validateResponse: (candidate) => {
			throwIfFullPageCancelled(signal);
			if (candidate.finish_reason === 'length') {
				throw new Error(
					'Translation output was truncated (max tokens reached). Increase max context tokens and retry.'
				);
			}
			detectRefusal(candidate.content);
		},
		requestRepair: async (missingRequiredIds) => callLLMWithProvider(
			provider,
			buildMissingOverlayRepairMessages(
				meaningfulBlocks,
				missingRequiredIds,
				$settings.sourceLanguage,
				$settings.targetLanguage
			),
			{
				temperature: $settings.temperature,
				maxTokens: $settings.maxContextTokens ?? 10000,
				signal,
				responseFormat: useJsonMode ? TRANSLATION_JSON_MODE : undefined
			}
		)
	});
	const entries = ensureStableTranslationEntries(parsedResponse.entries, [volumeUuid, pageIndex]);
	const usage = aggregateTranslationUsage(response, parsedResponse.repairResponse);
	debugLogParse('translateFullPage coverage', {
		requiredCount: parsedResponse.coverage.requiredCount,
		translatedRequiredCount: parsedResponse.coverage.translatedRequiredCount,
		optionalMissingCount: parsedResponse.coverage.optionalMissingIds.length,
		repaired: Boolean(parsedResponse.repairResponse)
	});

	const result: PageTranslation = {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		entries,
		model: usage.model,
		prompt_tokens: usage.usage.prompt_tokens,
		completion_tokens: usage.usage.completion_tokens,
		created_at: new Date().toISOString()
	};

	await persistPageTranslationForRun(result, options);
	return result;
}

// ============================================================
// Overlay-aware translation (numbered-boxes pipeline)
// ============================================================

/**
 * Run the OCR half of the numbered-boxes pipeline once: source-image identity,
 * PP-OCR detection with optional bubble segmentation, recognition and the
 * canonical regrouping. `translateFullPageWithOverlay` performs exactly these
 * steps itself when no `prepared` page is supplied, so the two paths cannot
 * diverge in what a provider is shown.
 */
export async function preparePageForTranslation(
	imageFile: File,
	options: {
		settings: Readonly<FumetoSettings>;
		readingDirection: 'rtl' | 'ltr';
		signal?: AbortSignal;
	}
): Promise<PreparedPage> {
	const { signal, settings: $settings } = options;
	throwIfFullPageCancelled(signal);
	const sourceImage = await inspectOverlaySourceImage(imageFile);
	const useBubbleSeg = $settings.overlayMode !== 'auto-fit';
	const sourceLocale = $settings.sourceLanguage === 'auto' ? 'ja' : $settings.sourceLanguage;
	const detectStarted = performance.now();
	const { imageBlob, regions, detection, bubbles } = await detectPageRegions(imageFile, {
		useBubbleSeg,
		locale: sourceLocale,
		readingDirection: options.readingDirection,
		signal
	});
	const detectMs = performance.now() - detectStarted;
	throwIfFullPageCancelled(signal);
	const base = {
		imageBlob,
		sourceImage,
		detection,
		bubbles,
		sourceLocale,
		readingDirection: options.readingDirection,
		useBubbleSeg
	};
	if (regions.length === 0) {
		return { ...base, regions, extraction: null, meaningfulBlocks: [], timings: { detectMs, extractMs: 0 } };
	}
	// PP-OCR grouping and post-recognition semantics are a production boundary,
	// not a property of the selected translation provider. Run the same bounded
	// recognition/classification pass for vision and text-only providers so a
	// backend switch cannot change component lineage, grouping, or item types.
	// Vision providers still receive the annotated page; recognized text is used
	// only to refine the canonical groups in that branch.
	const extractStarted = performance.now();
	const extraction = await extractTextWithPPOCR(imageFile, {
		signal,
		detection,
		bubbles,
		locale: sourceLocale,
		readingDirection: options.readingDirection
	});
	throwIfFullPageCancelled(signal);
	return {
		...base,
		regions: extraction.mergedRegions,
		extraction,
		meaningfulBlocks: extraction.blocks.filter((block) => isMeaningfulOcrText(block.text)),
		timings: { detectMs, extractMs: performance.now() - extractStarted }
	};
}

/**
 * Translate a page using the numbered-boxes overlay pipeline.
 *
 * Pipeline:
 * 1. Run PP-OCR det to find text regions
 * 2. Annotate the image with numbered boxes
 * 3. Send the annotated image to the LLM
 * 4. Parse box-keyed response and merge spatial coordinates
 *
 * Returns both a PageTranslation (for sidebar) and PageOverlayData (for rendering).
 */
export async function translateFullPageWithOverlay(
	volumeUuid: string,
	pageIndex: number,
	imageFile: File,
	context?: string,
	options: FullPageTranslationRunOptions = {}
): Promise<{
	pageTranslation: PageTranslation;
	overlayData: PageOverlayData;
	diagnostics?: FullPageTranslationDiagnostics;
}> {
	const signal = options.signal;
	throwIfFullPageCancelled(signal);
	options.onPhase?.('detecting');
	const $settings = options.runtime?.settings ?? get(settings);
	const pageReadingDirection = options.runtime?.readingDirection ?? get(readingDirection);
	const persist = async (pageTranslation: PageTranslation): Promise<void> => {
		if (options.skipPersist) return;
		await persistPageTranslationForRun(pageTranslation, options);
	};

	// Resolve vision mode
	const resolvedProvider = options.runtime?.provider ?? await resolveActiveProvider();
	throwIfFullPageCancelled(signal);
	const provider = { ...resolvedProvider, config: { ...resolvedProvider.config } };
	const { config: providerConfig } = provider;
	const visionMode = isProviderVisionMode(providerConfig);

	// ── PP-OCR numbered-boxes path (default) ──
	// Step 1: detect and recognise (or reuse a page prepared once for many runs).
	const prepared = options.prepared ?? await preparePageForTranslation(imageFile, {
		settings: $settings,
		readingDirection: pageReadingDirection,
		signal
	});
	throwIfFullPageCancelled(signal);
	const { sourceImage, imageBlob, meaningfulBlocks } = prepared;
	const adaptDraft = (draft: PageOverlayDraft, entries: PageTranslationEntryDraft[]) => createOverlayDocumentV2({
		draft,
		entries,
		sourceImage,
		locale: overlayTargetLocale($settings.targetLanguage),
		// Comic navigation order is independent from translated paragraph
		// direction. Let each overlay use Unicode first-strong resolution.
		baseDirection: 'auto',
		pipeline: $settings.overlayDetectionMethod
	});
	const emptyOverlay = () => createEmptyOverlayDocumentV2({
		sourceImage,
		locale: overlayTargetLocale($settings.targetLanguage),
		baseDirection: 'auto',
		pipeline: $settings.overlayDetectionMethod
	});

	// Recognition can refine free-layout semantics using OCR text and sampled
	// image evidence. Keep one active group list so text-only prompting, response
	// parsing, and the durable V2 adapter all consume those refined groups.
	const regions = prepared.regions;

	if (prepared.extraction === null || regions.length === 0) {
		const overlayData = emptyOverlay();
		const result = createNoTextPageTranslation(volumeUuid, pageIndex, overlayData);
		await persist(result);
		return { pageTranslation: result, overlayData };
	}
	if (meaningfulBlocks.length === 0) {
		const sourceOnlyOverlay = adaptDraft({ regions, entries: [] }, []).document;
		const result = createNoTextPageTranslation(volumeUuid, pageIndex, sourceOnlyOverlay);
		await persist(result);
		return { pageTranslation: result, overlayData: sourceOnlyOverlay };
	}

	let messages: ChatMessage[];
	if (visionMode) {
		const annotatedBase64 = await annotateImageWithBoxes(imageBlob, regions, 1536, signal);
		throwIfFullPageCancelled(signal);
		messages = buildOverlayMessages(
			annotatedBase64,
			$settings.sourceLanguage,
			$settings.targetLanguage,
			context
		);
	} else {
		messages = buildTextOnlyOverlayMessages(
			meaningfulBlocks,
			regions,
			$settings.sourceLanguage,
			$settings.targetLanguage,
			context
		);
	}

	const useJsonModeOverlay = providerSupportsStructuredOutput(providerConfig.type);
	options.onPhase?.('translating');
	const llmStarted = performance.now();
	const response = await callLLMWithProvider(provider, messages, {
		temperature: $settings.temperature,
		maxTokens: $settings.maxContextTokens ?? 10000,
		signal,
		responseFormat: useJsonModeOverlay ? TRANSLATION_JSON_MODE : undefined
	});
	const llmMs = performance.now() - llmStarted;
	let repairMs = 0;
	throwIfFullPageCancelled(signal);
	if (response.finish_reason === 'length') {
		throw new Error(
			'Translation output was truncated (max tokens reached). Increase max context tokens and retry.'
		);
	}

	const content = response.content;
	detectRefusal(content);

	const authoritativeOriginals = new Map(
		meaningfulBlocks.map((block) => [block.blockIndex, block.text])
	);
	const validateCoverageResponse = (candidate: typeof response) => {
		throwIfFullPageCancelled(signal);
		if (candidate.finish_reason === 'length') {
			throw new Error(
				'Translation output was truncated (max tokens reached). Increase max context tokens and retry.'
			);
		}
		detectRefusal(candidate.content);
	};
	const parsed = await reconcileOverlayTranslation({
		initialResponse: response,
		regions,
		authoritativeOriginals,
		validateResponse: validateCoverageResponse,
		onRepairing: () => options.onPhase?.('repairing'),
		requestRepair: async (missingRequiredIds) => {
			throwIfFullPageCancelled(signal);
			const repairMessages = buildMissingOverlayRepairMessages(
				meaningfulBlocks,
				missingRequiredIds,
				$settings.sourceLanguage,
				$settings.targetLanguage
			);
			const repairStarted = performance.now();
			const repairResponse = await callLLMWithProvider(provider, repairMessages, {
				temperature: $settings.temperature,
				maxTokens: $settings.maxContextTokens ?? 10000,
				signal,
				responseFormat: useJsonModeOverlay ? TRANSLATION_JSON_MODE : undefined
			});
			repairMs += performance.now() - repairStarted;
			throwIfFullPageCancelled(signal);
			return repairResponse;
		}
	});
	debugLogParse('translateFullPageWithOverlay coverage', {
		regionCount: regions.length,
		requiredCount: parsed.coverage.requiredCount,
		translatedRequiredCount: parsed.coverage.translatedRequiredCount,
		optionalMissingCount: parsed.coverage.optionalMissingIds.length,
		duplicateCount: parsed.coverage.duplicateIds.length,
		unmappedCount: parsed.coverage.unmappedIds.length,
		repaired: Boolean(parsed.repairResponse)
	});
	const finalEntries = parsed.entries;
	const overlayDraft: PageOverlayDraft = { regions, entries: parsed.overlayEntries };
	const usage = aggregateTranslationUsage(response, parsed.repairResponse);
	const adapted = adaptDraft(overlayDraft, finalEntries);
	const overlayData = adapted.document;
	const durableEntries = adapted.entries;

	const pageTranslation: PageTranslation = {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		entries: durableEntries,
		model: usage.model,
		prompt_tokens: usage.usage.prompt_tokens,
		completion_tokens: usage.usage.completion_tokens,
		created_at: new Date().toISOString(),
		overlay_data: overlayData
	};

	await persist(pageTranslation);

	const diagnostics: FullPageTranslationDiagnostics = {
		coverage: parsed.coverage,
		repaired: Boolean(parsed.repairResponse),
		visionMode,
		requests: parsed.repairResponse ? 2 : 1,
		llmMs,
		repairMs,
		detectMs: prepared.timings.detectMs,
		extractMs: prepared.timings.extractMs,
		initialResponse: { model: response.model, finish_reason: response.finish_reason, usage: response.usage },
		rawContent: response.content,
		repairRawContent: parsed.repairResponse?.content
	};
	return { pageTranslation, overlayData: pageTranslation.overlay_data ?? overlayData, diagnostics };
}

// ============================================================
// On-demand overlay generation (for already-translated pages)
// ============================================================

let overlayGenerationRunCounter = 0;

/**
 * Generate overlay data for the current page.
 *
 * Used when a page already has a translation (e.g., from volume translation)
 * but no overlay data. Runs the full detection → annotation → LLM pipeline
 * and updates both the translation and overlay stores.
 */
export async function generateOverlayForCurrentPage(
	options: FullPageTranslationRunOptions = {}
): Promise<void> {
	const runId = ++overlayGenerationRunCounter;
	throwIfAsyncResultStale(options);
	const vol = get(currentVolume);
	const pageIdx = get(currentPageIndex);
	if (!vol) throw new Error('No volume open');
	const cancellation = new AbortController();
	const combined = combinePageRequestSignals(options.signal, cancellation.signal);
	const runOptions: FullPageTranslationRunOptions = { ...options, signal: combined.signal };
	const isRunCurrent = () =>
		runId === overlayGenerationRunCounter &&
		get(currentPageIndex) === pageIdx &&
		get(currentVolume)?.volume_uuid === vol.volume_uuid &&
		!runOptions.signal?.aborted &&
		(runOptions.shouldPublishAsyncResult?.() ?? true);

	const activity = acquirePageTranslationActivity('overlay-generation', {
		volumeUuid: vol.volume_uuid,
		pageIndex: pageIdx
	}, {
		cancel: (reason?: string) => cancellation.abort(reason)
	});
	try {
		const source = await createPageSource(vol, { signal: runOptions.signal });
		let imageFile: File;
		try {
			imageFile = await source.getPageAsFile(pageIdx, { signal: runOptions.signal });
		} finally {
			source.dispose();
		}
		if (imageFile.type.startsWith('video/')) {
			throw new Error('Video pages have no text to translate.');
		}
		throwIfAsyncResultStale(runOptions);

		const { pageTranslation, overlayData } = await translateFullPageWithOverlay(
			vol.volume_uuid,
			pageIdx,
			imageFile,
			undefined,
			runOptions
		);

		// A navigation epoch supplied by the component rejects A → B → A results,
		// while the service run ID rejects an older same-page overlay request.
		if (isRunCurrent()) {
			setCurrentPageTranslationPayload(pageTranslation, overlayData);
		}

		// The newly published V2 record is authoritative. Older history is never
		// rewritten because that could resurrect legacy spatial identity.
	} finally {
		releasePageTranslationActivity(activity);
		combined.cleanup();
	}
}

/**
 * Persist overlay customizations (per-entry overrides) to IndexedDB.
 *
 * Updates the most recent PageTranslation record's overlay_data field
 * so per-box edits survive page navigation and app restarts.
 */
export async function saveOverlayCustomization(
	volumeUuid: string,
	pageIndex: number,
	overlayData: PageOverlayData
): Promise<void> {
	await pageOverlayRepository.replaceDocument(volumeUuid, pageIndex, overlayData);
}

/**
 * Delete an overlay box and its associated translation entry.
 *
 * Removes the OverlayEntry and DetectedTextRegion from overlay_data,
 * and removes the matching PageTranslationEntry from the entries array.
 * Returns the updated PageTranslation (already persisted).
 */
export async function deleteOverlayBox(
	volumeUuid: string,
	pageIndex: number,
	itemId: string
): Promise<{
	pageTranslation: PageTranslation;
	overlayData: PageOverlayData;
} | null> {
	try {
		const pageTranslation = await pageOverlayRepository.deleteItem(volumeUuid, pageIndex, itemId);
		return { pageTranslation, overlayData: pageTranslation.overlay_data! };
	} catch (error) {
		if (error instanceof PageTranslationMissingError) return null;
		throw error;
	}
}

/**
 * Convert one or more drawn regions (with translations) into overlay entries.
 *
 * Merges the converted entries into any existing PageOverlayData on the page.
 * If no PageTranslation record exists, creates a minimal one.
 *
 * @returns The updated PageOverlayData and PageTranslation (already persisted)
 */
export async function convertRegionsToOverlay(
	volumeUuid: string,
	pageIndex: number,
	regionsWithTranslations: Array<{
		region: TranslationRegion;
		translation: Translation;
	}>
): Promise<{
	overlayData: PageOverlayData;
	pageTranslation: PageTranslation;
	removedRegionIds: string[];
}> {
	const read = await pageOverlayRepository.load(volumeUuid, pageIndex);
	let sourceImage = read.overlay?.sourceImage;
	if (!sourceImage) {
		const volume = await db.volumes.get(volumeUuid);
		if (!volume) throw new Error(`Volume ${volumeUuid} does not exist`);
		const source = await createPageSource(volume);
		try {
			const pageFile = await source.getPageAsFile(pageIndex);
			if (pageFile.type.startsWith('video/')) {
				throw new Error('Video pages have no text to translate.');
			}
			sourceImage = await inspectOverlaySourceImage(pageFile);
		} finally {
			source.dispose();
		}
	}
	const currentSettings = get(settings);
	const result = await pageOverlayRepository.appendManualRegions({
		volumeUuid,
		pageIndex,
		sourceImage,
		locale: currentSettings.targetLanguage || 'en',
		baseDirection: 'auto',
		regions: regionsWithTranslations
	});
	return {
		overlayData: result.pageTranslation.overlay_data!,
		pageTranslation: result.pageTranslation,
		removedRegionIds: result.removedRegionIds
	};
}

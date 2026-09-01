/**
 * On-device translation pipeline orchestrator.
 *
 * Coordinates the two-phase on-device pipeline:
 *   1. Detection + Recognition — PP-OCRv6 finds and reads text
 *   2. Translation — Hy-MT2 1.8B via llama.cpp translates each block (progressive)
 *
 * The key UX difference from off-device: overlay boxes appear one at a time
 * as each translation completes, rather than all at once.
 *
 * Produces the same PageOverlayData and PageTranslation types as the
 * off-device pipeline — all downstream rendering works unchanged.
 */

import { writable, get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { readingDirection } from '$lib/stores/reader-state.js';
import { db } from '$lib/db/index.js';
import type { RecognizedBlock } from './recognized-block.js';
import { translateWithHyMT2, isModelLoaded as isHyMT2ModelLoaded } from './llamacpp-bridge.js';
import {
	activeHyMT2Variant,
	loadActiveHyMT2Model,
	HYMT2_VARIANTS,
	isModelDownloaded
} from './gguf-model-manager.js';
import {
	extractTextWithPPOCR,
	type PPOCRExtractionMetrics
} from './ppocr-text-extractor.js';
import { detectTextRegionsForRecognition } from '$lib/detection/ppocr-detector.js';
import { looksLikeMimeticSfx } from '$lib/overlay-layout/layout-service.js';
import { type BubbleRegion } from '$lib/detection/bubble-geometry.js';
import { detectLayout } from '$lib/detection/layout-detector.js';
import { overrideBubblesForEval } from '$lib/detection/model-candidate-overrides.js';
import { resolveTextDetectionFusion } from '$lib/detection/fusion-guard.js';
import { settings, type FumetoSettings } from '$lib/settings/settings.js';
import { isMeaningfulOcrText } from './ocr-text-filter.js';
import { blobToBase64 } from '$lib/util/base64.js';
import type {
	PageTranslation,
	PageTranslationEntry,
	PageTranslationEntryDraft,
	PageOverlayData,
	PageOverlayDraft,
	OverlayEntry,
	DetectedTextRegion,
	TranslationRegion
} from '$lib/types/index.js';
import {
	createEmptyOverlayDocumentV2,
	createOverlayDocumentV2,
	ensureStableTranslationEntries,
	inspectOverlaySourceImage,
	overlayTargetLocale,
	adoptDurableRecord,
	pageOverlayRepository
} from '$lib/overlay-layout/index.js';
import type { ProgressivePageTranslationSnapshot } from './progressive-page-translation-preview.js';
import {
	TranslationCoverageError,
	isRequiredTranslationRegion,
	REQUIRED_RECOGNITION_CONFIDENCE
} from './translation-coverage.js';

// ============================================================
// Progress Store
// ============================================================

/** Progress state for the on-device per-box translation pipeline */
export interface OnDeviceProgressState {
	phase: 'idle' | 'detecting' | 'translating' | 'persisting' | 'done';
	total: number;
	completed: number;
	currentBoxId: number | null;
}

export const onDeviceProgress = writable<OnDeviceProgressState | null>(null);

/**
 * The progress store is shared by the reader UI, while page translations can
 * also run back-to-back (or in separate volume jobs). A delayed completion
 * timer from an older run must never erase the progress of a newer run.
 */
let onDeviceProgressGeneration = 0;

async function persistOnDevicePageTranslation(
	pageTranslation: PageTranslation,
	signal?: AbortSignal
): Promise<void> {
	throwIfTranslationCancelled(signal);
	pageTranslation.entries = ensureStableTranslationEntries(
		pageTranslation.entries,
		[pageTranslation.volume_uuid, pageTranslation.page_index, pageTranslation.id]
	);
	// The durable row is the authority: the repository carries the reader's
	// manual edits forward from the record this one replaces (and parks the
	// ones it could not place as orphans), and the reader must see THAT
	// document — the adapter's fresh one was what made a re-translation look
	// like it had dropped every edit while the database still held them.
	// Adoption is content-guarded; see `adoptDurableRecord`.
	adoptDurableRecord(pageTranslation, await pageOverlayRepository.put(pageTranslation, signal));
}

function throwIfTranslationCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('Translation cancelled');
}

export interface OnDeviceRuntimeOverrides {
	sourceLang?: string;
	targetLang?: string;
	ocrProvider?: 'ppocr';
	translationBackend?: 'translategemma';
	overlayMode?: FumetoSettings['overlayMode'];
	/**
	 * Sampler temperature for this run only. Omitted, the bridge reads
	 * `settings.onDeviceTemperature` as it always has; a harness comparing
	 * temperatures passes it here instead of touching settings.
	 */
	temperature?: number;
}

/** Recognition already run for a page, so the model phase can start from it. */
export interface OnDeviceRecognizedPage {
	blocks: RecognizedBlock[];
	regions: DetectedTextRegion[];
	metrics: PPOCRExtractionMetrics | null;
}

/** What happened to one recognized block in the model phase. */
export interface OnDeviceBlockResult {
	boxId: number;
	sourceText: string;
	translatedText: string;
	required: boolean;
	status:
		| 'ok'
		| 'sfx-dictionary'
		| 'skipped-meta-or-low-confidence'
		| 'invariant-hidden'
		| 'invalid'
		| 'error';
	inferenceMs: number;
	error?: string;
}

/**
 * One renderable progressive publication. The translation entries and V2
 * document are cloned together so every overlay item can resolve its matching
 * translated text without observing data from another page or revision.
 */
export type OnDeviceProgressiveSnapshot = ProgressivePageTranslationSnapshot;

export interface OnDevicePageTranslationOptions {
	suppressProgressiveUpdates?: boolean;
	skipPersist?: boolean;
	runtimeOverrides?: OnDeviceRuntimeOverrides;
	/**
	 * Skip detection and recognition and translate these blocks. The reader
	 * never sets this; a harness that ran PP-OCR once for several models does,
	 * so every model sees identical box ids.
	 */
	recognized?: OnDeviceRecognizedPage;
	/** Observes each block's outcome as the model phase decides it. */
	onBlockResult?: (result: OnDeviceBlockResult) => void;
	/**
	 * Page reading direction, which orders the canonical box IDs. Omit it and the
	 * reader's live direction is used; a background volume job must pass the
	 * direction it resolved for its own volume.
	 */
	readingDirection?: 'rtl' | 'ltr';
	/** Cancels between OCR stages/blocks and interrupts an active Hy-MT2 decode. */
	signal?: AbortSignal;
	/**
	 * Reader identity gate for progressive writes. Persistence still targets the
	 * captured volume/page, but an old page must not paint over the current page.
	 */
	shouldPublishProgressiveUpdate?: () => boolean;
	/** Receives coherent translation/overlay writes owned by this exact invocation. */
	onProgressiveSnapshot?: (snapshot: OnDeviceProgressiveSnapshot) => void;
	/** Per-run progress callback used by background volume jobs. */
	onProgress?: (progress: OnDeviceProgressState) => void;
	/**
	 * Throw on the FIRST failed required block (the volume batch pass relies
	 * on atomic page results for its retry/checkpoint budget). The reader path
	 * leaves this unset: successfully translated blocks are kept and returned
	 * with a partialFailure marker instead of blanking the page.
	 */
	atomicCoverage?: boolean;
}

export interface OnDeviceTranslationMetrics {
	totalMs: number;
	ocrMs: number;
	modelLoadMs: number;
	translationPhaseMs: number;
	translationInferenceMs: number;
	firstOverlayStoreMs: number | null;
	detectedBlocks: number;
	translatedBlocks: number;
	modelCalls: number;
	hyModelSuccesses: number;
	hyModelErrors: number;
	hyOriginalFallbacks: number;
	hyInvariantOutputs: number;
	hyInvalidOutputs: number;
	hyChangedTranslations: number;
	retries: number;
	sfxMatches: number;
	ppocr: PPOCRExtractionMetrics | null;
}

function publishOnDeviceMetrics(metrics: OnDeviceTranslationMetrics): void {
	console.warn(`[on-device] metrics ${JSON.stringify(metrics)}`);
	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__fumeto_last_on_device_metrics = metrics;
	}
}

// ============================================================
// Sound Effect Dictionary
// ============================================================

/** Common manga onomatopoeia → English equivalents. Checked before model inference. */
const SFX_DICTIONARY = new Map<string, string>([
	// Laughter
	['ふふ', '*fufu*'],
	['ふふふ', '*fufufu*'],
	['はは', '*haha*'],
	['ははは', '*hahaha*'],
	['あはは', '*ahaha*'],
	['くすくす', '*snicker*'],
	['くす', '*snicker*'],
	['うふふ', '*ufufu*'],
	['けけけ', '*kekeke*'],
	['にやり', '*grin*'],
	['にや', '*smirk*'],
	['にこ', '*smile*'],
	['にこにこ', '*smile smile*'],
	['へへ', '*hehe*'],
	['へへへ', '*hehehe*'],
	// Heartbeat / emotions
	['どきどき', '*ba-dump ba-dump*'],
	['どき', '*ba-dump*'],
	['きゅん', '*squeeze*'],
	['きゅ', '*squeeze*'],
	['ガーン', '*shock*'],
	['がーん', '*shock*'],
	['じーん', '*moved*'],
	['じん', '*touched*'],
	['ぞくぞく', '*shiver*'],
	['ぞく', '*shiver*'],
	['わくわく', '*excited*'],
	['どきん', '*ba-dump!*'],
	['むかむか', '*nauseous*'],
	// Impact / actions
	['バタン', '*slam*'],
	['ばたん', '*slam*'],
	['ガチャ', '*click*'],
	['がちゃ', '*click*'],
	['ドン', '*boom*'],
	['どん', '*boom*'],
	['パン', '*clap*'],
	['ぱん', '*clap*'],
	['バン', '*bang*'],
	['ばん', '*bang*'],
	['ドカ', '*wham*'],
	['ガン', '*clang*'],
	['がん', '*clang*'],
	['ゴン', '*bonk*'],
	['ごん', '*bonk*'],
	['パタパタ', '*pitter-patter*'],
	['ぱたぱた', '*pitter-patter*'],
	['トントン', '*knock knock*'],
	['とんとん', '*knock knock*'],
	['カチ', '*click*'],
	['かち', '*click*'],
	['カチャ', '*clack*'],
	['バキ', '*crack*'],
	['ばき', '*crack*'],
	['ドカン', '*kaboom*'],
	['ズドン', '*thud*'],
	['ガシ', '*grab*'],
	['がし', '*grab*'],
	// Reactions / exclamations
	['え', 'Huh?'],
	['あ', 'Ah!'],
	['おお', 'Oh!'],
	['おおお', 'Ohhh!'],
	['うん', 'Yeah'],
	['へえ', 'Huh~'],
	['ええ', 'Eh?!'],
	['はあ', '*sigh*'],
	['ふう', '*phew*'],
	['ちぇ', 'Tch'],
	['むう', 'Hmm...'],
	['うわ', 'Whoa!'],
	['きゃ', 'Eek!'],
	['きゃあ', 'Kyaaa!'],
	['ぎゃ', 'Gyah!'],
	['ぎゃあ', 'Gyaaa!'],
	['わあ', 'Wow!'],
	['はっ', '*gasp*'],
	// Movement / atmosphere
	['ざわざわ', '*murmur murmur*'],
	['ざわ', '*murmur*'],
	['しーん', '*silence*'],
	['しん', '*silence*'],
	['ひそひそ', '*whisper whisper*'],
	['がやがや', '*chatter*'],
	['ごごご', '*rumble*'],
	['ゴゴゴ', '*menacing*'],
	['ぶるぶる', '*tremble*'],
	['ぶる', '*shudder*'],
	['ぷるぷる', '*quiver*'],
	['ひゅう', '*whoosh*'],
	['ビュウ', '*whoosh*'],
	['すたすた', '*stride stride*'],
	['ぞろぞろ', '*shuffling*'],
	['ぼー', '*daze*'],
	['ぽかん', '*blank stare*'],
	['キラキラ', '*sparkle*'],
	['きらきら', '*sparkle*'],
	['キラ', '*sparkle*'],
	['ぎろ', '*glare*'],
	['ぎろり', '*glare*'],
	['じろ', '*stare*'],
	['じろじろ', '*stare stare*'],
	['じー', '*staaare*'],
	// Eating / drinking
	['もぐもぐ', '*munch munch*'],
	['ぱくぱく', '*chomp chomp*'],
	['ごくごく', '*gulp gulp*'],
	['ごく', '*gulp*'],
	['ずずず', '*slurp*'],
]);

/**
 * Normalize SFX input by stripping emphasis markers.
 * "ふふっ" → "ふふ", "ドキドキー" → "ドキドキ", "バン！" → "バン"
 */
function normalizeSfx(text: string): string {
	return text
		.replace(/[\s　]/g, '')     // whitespace
		.replace(/[！!？?…。、]/g, '') // punctuation
		.replace(/ー+$/g, '')        // trailing long vowel
		.replace(/っ+$/g, '')        // trailing small tsu
		.replace(/ッ+$/g, '');       // trailing katakana small tsu
}

/**
 * Look up text in the SFX dictionary. Returns the English equivalent or null.
 * Normalizes input before lookup to handle emphasis variants.
 */
function lookupSfx(text: string): string | null {
	const normalized = normalizeSfx(text);
	if (normalized.length === 0) return null;
	return SFX_DICTIONARY.get(normalized) ?? null;
}

// ============================================================
// Translation Validation
// ============================================================

/**
 * Check if a translation result is valid and usable.
 */
function isValidTranslation(
	original: string,
	translated: string,
	sourceLanguage: string,
	targetLanguage: string
): boolean {
	const trimmed = translated.trim();
	const originalTrimmed = original.trim();
	const source = sourceLanguage.toLowerCase().split(/[-_]/)[0];
	const target = targetLanguage.toLowerCase().split(/[-_]/)[0];

	// Empty or whitespace-only
	if (trimmed.length === 0) return false;

	// Model echoed the input verbatim
	if (trimmed === originalTrimmed) return false;

	// Punctuation-only generations are not usable translations. Keep this as
	// explicit ranges rather than Unicode property escapes for older WebViews.
	const contentChars = trimmed.match(
		/[0-9A-Za-z\u00c0-\u024f\u0370-\u052f\u0590-\u08ff\u0900-\u1fff\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/g
	) ?? [];
	if (contentChars.length === 0) return false;

	// A response that embeds the complete source and appends commentary is an
	// echo, not an overlay-ready translation. Ignore very short sources because
	// proper names and abbreviations can legitimately be retained.
	if (
		source !== target
		&& originalTrimmed.length >= 3
		&& trimmed.includes(originalTrimmed)
	) return false;

	// English output should be predominantly Latin. Other selectable targets
	// must not be rejected merely because they use Cyrillic, CJK, or another
	// non-Latin script; their universal checks above and below still apply.
	if (target === 'en') {
		const latinCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
		if (latinCount / contentChars.length < 0.5) return false;
	}

	// Catch runaway generation without rejecting naturally expansive compact
	// Japanese-to-English phrases (for example, four source characters can
	// legitimately become a twenty-character English sentence).
	if (trimmed.length > Math.max(originalTrimmed.length * 5, 80)) return false;

	return true;
}

const JAPANESE_SCRIPT = /[\u3005\u3006\u303b\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
const HAN_SCRIPT = /[\u3005\u3006\u303b\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KOREAN_SCRIPT = /[\u1100-\u11ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/**
 * Identify the narrow, high-confidence invariant used by the Japanese-to-
 * English on-device path: OCR returned only non-source-script text and Hy-MT2
 * left it unchanged. Other language pairs remain conservative because shared
 * scripts cannot be classified from a single string alone.
 */
function isClearlyTargetInvariant(
	text: string,
	sourceLanguage: string,
	targetLanguage: string
): boolean {
	const source = sourceLanguage.toLowerCase().split(/[-_]/)[0];
	const target = targetLanguage.toLowerCase().split(/[-_]/)[0];
	if (target !== 'en') return false;
	if (source === 'ja') return !JAPANESE_SCRIPT.test(text);
	if (source === 'zh') return !HAN_SCRIPT.test(text);
	if (source === 'ko') return !KOREAN_SCRIPT.test(text);
	return false;
}

// ============================================================
// Image Helpers
// ============================================================

/**
 * Convert an image File to a base64 string (without data URI prefix).
 */
async function imageFileToBase64(imageFile: File, signal?: AbortSignal): Promise<string> {
	throwIfTranslationCancelled(signal);
	const dataUri = await blobToBase64(imageFile, signal);
	throwIfTranslationCancelled(signal);
	const separator = dataUri.indexOf(',');
	if (separator < 0) throw new Error('Unable to encode image for on-device OCR');
	return dataUri.slice(separator + 1);
}

// ============================================================
// PP-OCRv6 Recognition Adapter
// ============================================================

/**
 * Recognize text using PP-OCRv6 (detection + recognition via WASM).
 *
 * Thin wrapper around the shared extractor. Returning its sanitized metrics
 * lets physical-device runs attribute OCR time without exposing page text.
 */
async function recognizeWithPPOCR(
	imageFile: File,
	options: {
		signal?: AbortSignal;
		locale: string;
		useBubbleSeg: boolean;
		readingDirection: 'rtl' | 'ltr';
	}
): Promise<{
	blocks: RecognizedBlock[];
	regions: DetectedTextRegion[];
	metrics: PPOCRExtractionMetrics;
}> {
	const { signal } = options;
	let detection = await detectTextRegionsForRecognition(imageFile, {
		signal,
		deferGrouping: true,
		locale: options.locale
	});
	throwIfTranslationCancelled(signal);
	let bubbles: BubbleRegion[] = [];
	if (options.useBubbleSeg && detection.rawRegions.length > 0) {
		// Debug-only model-candidate override (no-op in production/release).
		const overrideBubbles = await overrideBubblesForEval(imageFile, { signal });
		throwIfTranslationCancelled(signal);
		if (overrideBubbles !== null) {
			bubbles = overrideBubbles;
		} else {
			try {
				bubbles = (await detectLayout(imageFile, { signal })).bubbles;
			} catch (error) {
				throwIfTranslationCancelled(signal);
				console.warn('[on-device] Layout detection unavailable; using free-text grouping.', error);
			}
		}
	}
	if (bubbles.length >= 2) {
		// Same protection the off-device full-page and volume paths have had: at a
		// coarse detector input the DB map can merge text columns from different
		// balloons into one component, which then fails recognition and silently
		// loses every involved balloon's text. Detect it by geometry and retry once
		// at the escalated target. This path went without it until 2026-07-24.
		detection = await resolveTextDetectionFusion(imageFile, detection, bubbles, {
			signal,
			locale: options.locale
		});
		throwIfTranslationCancelled(signal);
	}
	const { blocks, mergedRegions, metrics } = await extractTextWithPPOCR(imageFile, {
		signal,
		detection,
		bubbles,
		locale: options.locale,
		readingDirection: options.readingDirection
	});
	return { blocks, regions: mergedRegions, metrics };
}

function overlayTypeFromRegion(region: DetectedTextRegion): OverlayEntry['type'] {
	switch (region.groupKind) {
		case 'speech':
		case 'thought':
		case 'narration':
		case 'sign':
		case 'sfx':
			return region.groupKind;
		case 'borderless':
		case 'unknown':
		default:
			return 'unknown';
	}
}

// ============================================================
// Full Page On-Device Translation (Progressive)
// ============================================================

/**
 * Translate a page using the on-device pipeline with progressive overlay updates.
 *
 * Pipeline: PP-OCRv6 (detect+recognize) → per-block Hy-MT2 translation.
 *
 * @param volumeUuid - Volume ID
 * @param pageIndex - Page index within the volume
 * @param imageFile - Page image file
 * @param options - Optional: suppress progressive overlay updates (for volume batch)
 * @returns Final PageTranslation and PageOverlayData
 */
/**
 * Fail with something the user can act on when the selected model is not on
 * the device. Settings lets a variant be picked without downloading it, and
 * without this the failure surfaced as Kotlin's raw
 * "Failed to load model from: /data/…/model.gguf" — once per region — in the
 * translate status dialog.
 */
async function requireDownloadedModel(): Promise<void> {
	const variant = activeHyMT2Variant();
	if (await isModelDownloaded(variant)) return;
	// A custom model cannot be "downloaded" — if its file is gone the user
	// deleted it or storage was cleared, and pointing them at a Download button
	// that does not exist for this row would be nonsense.
	throw new Error(
		variant === 'custom'
			? 'Your imported model file is missing. Open Settings → Translation → On-Device and choose it again.'
			: `${HYMT2_VARIANTS[variant].label} isn't downloaded yet. Open Settings → Translation → On-Device and download it, then try again.`
	);
}

export async function translatePageOnDevice(
	volumeUuid: string,
	pageIndex: number,
	imageFile: File,
	options?: OnDevicePageTranslationOptions
): Promise<{
	pageTranslation: PageTranslation;
	overlayData: PageOverlayData;
	metrics: OnDeviceTranslationMetrics;
	/** Present when required blocks failed validation but translated overlays were kept. */
	partialFailure?: {
		failedBlockIndexes: number[];
		requiredCount: number;
		translatedRequiredCount: number;
	};
}> {
	const pageStarted = performance.now();
	const suppressUpdates = options?.suppressProgressiveUpdates ?? false;
	const skipPersist = options?.skipPersist ?? false;
	const signal = options?.signal;
	// Background volume jobs suppress reader overlays and must not take ownership
	// of the reader's global progress indicator. Their per-run callback still fires.
	throwIfTranslationCancelled(signal);
	const progressGeneration = suppressUpdates ? null : ++onDeviceProgressGeneration;
	const publishProgress = (progress: OnDeviceProgressState): void => {
		if (progressGeneration !== null && progressGeneration === onDeviceProgressGeneration) {
			onDeviceProgress.set(progress);
		}
		try {
			options?.onProgress?.(progress);
		} catch (error) {
			console.warn('[on-device] Progress callback failed:', error);
		}
	};
	const clearProgressAfterCompletion = (): void => {
		if (progressGeneration === null) return;
		setTimeout(() => {
			if (progressGeneration === onDeviceProgressGeneration) {
				onDeviceProgress.set(null);
			}
		}, 2000);
	};
	const shouldPublishProgressiveUpdate = (): boolean => {
		if (suppressUpdates || signal?.aborted) return false;
		try {
			return options?.shouldPublishProgressiveUpdate?.() ?? true;
		} catch {
			return false;
		}
	};
	const publishProgressiveSnapshot = (
		pageTranslation: PageTranslation,
		overlayData: PageOverlayData
	): boolean => {
		if (!shouldPublishProgressiveUpdate()) return false;
		// Clone the pair in one operation. This preserves the shared overlay object
		// referenced by PageTranslation.overlay_data and prevents later mutations of
		// the in-progress draft from changing an already-published revision.
		const snapshot = structuredClone<OnDeviceProgressiveSnapshot>({
			target: { volumeUuid, pageIndex },
			pageTranslation: { ...pageTranslation, overlay_data: overlayData },
			overlayData
		});
		// The caller owns target-scoped preview publication and rollback. Keeping the
		// reusable service store-free prevents a cancelled or failed invocation from
		// leaving an unpersisted partial page in the reader.
		options?.onProgressiveSnapshot?.(snapshot);
		return true;
	};

	try {

	// Read language settings
	const currentSettings = get(settings);
	const sourceLang = options?.runtimeOverrides?.sourceLang ?? currentSettings.onDeviceSourceLang ?? 'auto';
	const targetLang = options?.runtimeOverrides?.targetLang ?? currentSettings.onDeviceTargetLang ?? 'en';
	const effectiveSourceLang = sourceLang === 'auto' ? 'ja' : sourceLang;
	const ocrProvider = options?.runtimeOverrides?.ocrProvider ?? currentSettings.onDeviceOCRProvider ?? 'ppocr';
	const translationBackend = options?.runtimeOverrides?.translationBackend
		?? currentSettings.onDeviceTranslationBackend
		?? 'translategemma';
	const overlayMode = options?.runtimeOverrides?.overlayMode ?? currentSettings.overlayMode;
	// A background volume job runs against a volume that is not necessarily the
	// one open in the reader, so it supplies the direction it resolved. Reader
	// invocations fall back to the live store, which openReader already set from
	// effectiveReadingDirection().
	const pageReadingDirection = options?.readingDirection ?? get(readingDirection);
	const translationIdentity = {
		id: randomUUID(),
		createdAt: new Date().toISOString()
	};
	const pageModel = `on-device-hymt2-1.25bit-${ocrProvider}`;
	const pageTranslationSnapshot = (
		entries: PageTranslationEntry[],
		overlayData: PageOverlayData,
		model: string = pageModel,
		noTextDetected: boolean = false
	): PageTranslation => ({
		id: translationIdentity.id,
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		entries,
		model,
		prompt_tokens: 0,
		completion_tokens: 0,
		created_at: translationIdentity.createdAt,
		overlay_data: overlayData,
		no_text_detected: noTextDetected || undefined
	});
	throwIfTranslationCancelled(signal);
	const sourceImage = await inspectOverlaySourceImage(imageFile);
	throwIfTranslationCancelled(signal);
	const emptyOverlay = (documentRevision: number = 1) => createEmptyOverlayDocumentV2({
		sourceImage,
		locale: overlayTargetLocale(targetLang),
		baseDirection: 'auto',
		documentRevision,
		pipeline: `on-device-${ocrProvider}`
	});

	// ── Phase 1: Text Recognition (detect + recognize) ──
	publishProgress({ phase: 'detecting', total: 0, completed: 0, currentBoxId: null });

	const ocrStarted = performance.now();
	let recognizedBlocks: RecognizedBlock[];
	let ppocrRegions: DetectedTextRegion[] | null = null;
	let ppocrMetrics: PPOCRExtractionMetrics | null = null;
	console.warn('[on-device] PP-OCRv6 OCR path');
	{
		const extraction = options?.recognized ?? await recognizeWithPPOCR(imageFile, {
			signal,
			locale: effectiveSourceLang,
			useBubbleSeg: overlayMode !== 'auto-fit',
			readingDirection: pageReadingDirection
		});
		recognizedBlocks = extraction.blocks;
		ppocrRegions = extraction.regions;
		ppocrMetrics = extraction.metrics;
	}
	const ocrMs = performance.now() - ocrStarted;
	throwIfTranslationCancelled(signal);

	console.warn(`[on-device] Phase 1: found ${recognizedBlocks.length} text blocks (${ocrProvider})`);

	// A single kana/kanji is valid manga dialogue/SFX (and several entries in
	// SFX_DICTIONARY are intentionally one character). Discard punctuation-only noise.
	const validBlocks = recognizedBlocks.filter((block) => isMeaningfulOcrText(block.text));

	console.warn(`[on-device] After filtering: ${validBlocks.length} valid blocks`);

	if (validBlocks.length === 0) {
		console.warn('[on-device] No text blocks found — returning no-text result');
		// A page can have valid PP-OCR geometry while every recognition is empty or
		// punctuation-only. Keep those canonical detector sources so switching to
		// the off-device backend cannot change V2 lineage; no translation item is
		// created and no provider is invoked.
		const overlayData = ppocrRegions?.length
			? createOverlayDocumentV2({
				draft: { regions: ppocrRegions, entries: [] },
				entries: [],
				sourceImage,
				locale: overlayTargetLocale(targetLang),
				baseDirection: 'auto',
				documentRevision: 1,
				pipeline: `on-device-${ocrProvider}`
			}).document
			: emptyOverlay();
		const result = pageTranslationSnapshot([], overlayData, 'on-device-no-regions', true);
		throwIfTranslationCancelled(signal);
		publishProgressiveSnapshot(result, overlayData);
		throwIfTranslationCancelled(signal);
		if (!skipPersist) {
			publishProgress({ phase: 'persisting', total: 0, completed: 0, currentBoxId: null });
			await persistOnDevicePageTranslation(result, signal);
		}
		publishProgress({ phase: 'done', total: 0, completed: 0, currentBoxId: null });
		clearProgressAfterCompletion();
		const metrics: OnDeviceTranslationMetrics = {
			totalMs: performance.now() - pageStarted,
			ocrMs,
			modelLoadMs: 0,
			translationPhaseMs: 0,
			translationInferenceMs: 0,
			firstOverlayStoreMs: null,
			detectedBlocks: recognizedBlocks.length,
			translatedBlocks: 0,
			modelCalls: 0,
			hyModelSuccesses: 0,
			hyModelErrors: 0,
			hyOriginalFallbacks: 0,
			hyInvariantOutputs: 0,
			hyInvalidOutputs: 0,
			hyChangedTranslations: 0,
			retries: 0,
			sfxMatches: 0,
			ppocr: ppocrMetrics
		};
		publishOnDeviceMetrics(metrics);
		return { pageTranslation: result, overlayData: result.overlay_data ?? overlayData, metrics };
	}

	// Map translated blocks to their canonical classified regions. The durable
	// source list retains every PP-OCR group, including a crop whose recognized
	// text was empty or punctuation-only; only meaningful blocks become items.
	// This matches the off-device adapter and keeps backend switches from changing
	// page source lineage.
	const ppocrRegionByBoxId = new Map(ppocrRegions?.map((region) => [region.boxId, region]) ?? []);
	const translatedRegions: DetectedTextRegion[] = validBlocks.map((block) =>
		ppocrRegionByBoxId.get(block.blockIndex) ?? {
			boxId: block.blockIndex,
			x: block.x,
			y: block.y,
			width: block.width,
			height: block.height,
			confidence: 1.0
		}
	);
	const overlaySourceRegions = ppocrRegions ?? translatedRegions;

	// ── Phase 2: Translation (per block, progressive overlay) ──
	const overlayDraft: PageOverlayDraft = { regions: overlaySourceRegions, entries: [] };
	const pageEntries: PageTranslationEntryDraft[] = [];

	// Show empty overlay container
	const initialOverlay = emptyOverlay();
	publishProgressiveSnapshot(pageTranslationSnapshot([], initialOverlay), initialOverlay);

	const total = validBlocks.length;
	const requiredCount = translatedRegions.filter(isRequiredTranslationRegion).length;
	let translatedRequiredCount = 0;
	const invalidRequiredBlocks: number[] = [];
	// One monotonic counter for progressive AND final document revisions.
	// Index-based progressive revisions with an entry-count-based final
	// revision moved BACKWARDS whenever any block was skipped or failed,
	// which made the preview commit reject the finished page (blank + failed
	// while the persisted record was fine).
	let documentRevision = 1;
	console.warn(`[on-device] Phase 2: starting translation of ${total} blocks (backend=${translationBackend})`);
	publishProgress({ phase: 'translating', total, completed: 0, currentBoxId: null });
	const translationPhaseStarted = performance.now();
	let modelLoadMs = 0;
	let translationInferenceMs = 0;
	let firstOverlayStoreMs: number | null = null;
	let modelCalls = 0;
	let hyModelSuccesses = 0;
	let hyModelErrors = 0;
	let hyOriginalFallbacks = 0;
	let hyInvariantOutputs = 0;
	let hyInvalidOutputs = 0;
	let hyChangedTranslations = 0;
	let retries = 0;
	let sfxMatches = 0;
	const emitBlockResult = (result: OnDeviceBlockResult): void => {
		try {
			options?.onBlockResult?.(result);
		} catch (error) {
			console.warn('[on-device] Block result callback failed:', error);
		}
	};

	// Lazy-load Hy-MT2 on first use per session.
	// The settings literal is still 'translategemma' for migration stability even
	// though the underlying GGUF is now Hy-MT2 1.8B 1.25-bit.
	if (translationBackend === 'translategemma' && !(await isHyMT2ModelLoaded())) {
		throwIfTranslationCancelled(signal);
		const variantLabel = HYMT2_VARIANTS[activeHyMT2Variant()].label;
		console.warn(`[on-device] Loading ${variantLabel} model...`);
		await requireDownloadedModel();
		const modelLoadStarted = performance.now();
		// Resolves path AND prompt format together: a custom model needs both,
		// and loading one without the other is how it would run under the
		// wrong chat template.
		await loadActiveHyMT2Model(signal);
		modelLoadMs = performance.now() - modelLoadStarted;
		throwIfTranslationCancelled(signal);
		console.warn(`[on-device] ${variantLabel} model loaded`);
	}

	for (let i = 0; i < validBlocks.length; i++) {
		throwIfTranslationCancelled(signal);
		const block = validBlocks[i];
		const region = translatedRegions[i];

		publishProgress({
			phase: 'translating',
			total,
			completed: i,
			currentBoxId: block.blockIndex
		});

		let translatedText = '';
		// PP-OCR blocks carry the shared classifier verdict, which keeps on-device
		// and off-device overlays identical. (Label-free blocks used to fall back
		// to the policy-22 mimetic heuristic here; that path existed only for the
		// ML Kit recognizer, removed 2026-07-24.)
		let overlayType = overlayTypeFromRegion(region);
		let hideInvariantOverlay = false;
		let invalidOutput = false;
		const required = isRequiredTranslationRegion(region);
		let blockStatus: OnDeviceBlockResult['status'] = 'ok';
		let blockError: string | undefined;
		let blockInferenceMs = 0;
		const blockResult = (status: OnDeviceBlockResult['status']): OnDeviceBlockResult => ({
			boxId: block.blockIndex,
			sourceText: block.text,
			translatedText,
			required,
			status,
			inferenceMs: blockInferenceMs,
			error: blockError
		});

		// Non-dialogue meta (credits, page markers, counters) and shaky-OCR
		// groups skip the model entirely: per-region Hy-MT2 calls cost ~10 s
		// each and garbage input only yields fabricated output (report T5).
		if (
			!required
			&& (region.classificationReasons?.includes('non-dialogue-meta')
				|| (region.recognitionConfidence !== undefined
					&& region.recognitionConfidence < REQUIRED_RECOGNITION_CONFIDENCE))
		) {
			console.warn(`[on-device] Phase 2: block=${block.blockIndex} skipped (non-dialogue meta / low OCR confidence)`);
			emitBlockResult(blockResult('skipped-meta-or-low-confidence'));
			continue;
		}

		// Check SFX dictionary first — skip model entirely if matched
		const sfxResult = lookupSfx(block.text);
		if (sfxResult) {
			translatedText = sfxResult;
			sfxMatches += 1;
			blockStatus = 'sfx-dictionary';
			// The shared PP-OCR classifier stays authoritative so on-device and
			// off-device overlays remain identical; a dictionary hit does not
			// override it.
			console.warn(`[on-device] Phase 2: block=${block.blockIndex} SFX translation match`);
		} else {
			// Hy-MT2 is deterministic, so its output is validated once — there is
			// no second attempt to make (the removed ML Kit backend had one).
			try {
				throwIfTranslationCancelled(signal);
				console.warn(`[on-device] Phase 2: translating block=${block.blockIndex} chars=${block.text.length} backend=${translationBackend}`);

				const inferenceStarted = performance.now();
				try {
					modelCalls += 1;
					translatedText = await translateWithHyMT2(
						block.text,
						effectiveSourceLang,
						targetLang,
						signal,
						options?.runtimeOverrides?.temperature
					);
					if (translatedText.trim().length > 0) hyModelSuccesses += 1;
					else hyModelErrors += 1;
				} finally {
					blockInferenceMs = performance.now() - inferenceStarted;
					translationInferenceMs += blockInferenceMs;
				}
				throwIfTranslationCancelled(signal);
			} catch (err) {
				throwIfTranslationCancelled(signal);
				console.warn(`[on-device] Phase 2: block=${block.blockIndex} translation error: ${err instanceof Error ? err.message : err}`);
				translatedText = '';
				invalidOutput = true;
				hyModelErrors += 1;
				blockStatus = 'error';
				blockError = err instanceof Error ? err.message : String(err);
			}

			// Fixture builds only: deterministic failure injection for live tests.
			// window.__fumeto_force_echo_blocks = N makes the next N model outputs
			// echo their input, which validation rejects.
			if (import.meta.env?.VITE_FUMETO_DEBUG_UI_FIXTURES && typeof window !== 'undefined') {
				const w = window as unknown as { __fumeto_force_echo_blocks?: number };
				if ((w.__fumeto_force_echo_blocks ?? 0) > 0) {
					w.__fumeto_force_echo_blocks = (w.__fumeto_force_echo_blocks ?? 0) - 1;
					translatedText = block.text;
				}
			}
			if (translationBackend === 'translategemma') {
				const unchanged = translatedText.trim() === block.text.trim();
				if (!invalidOutput && unchanged && isClearlyTargetInvariant(
					block.text,
					effectiveSourceLang,
					targetLang
				)) {
					hyInvariantOutputs += 1;
					hideInvariantOverlay = true;
				} else if (!invalidOutput && (
					unchanged
					|| !isValidTranslation(block.text, translatedText, effectiveSourceLang, targetLang)
				)) {
					hyInvalidOutputs += 1;
					invalidOutput = true;
				} else {
					if (!invalidOutput) hyChangedTranslations += 1;
				}
				if (invalidOutput) hyOriginalFallbacks += 1;
			} else if (!isValidTranslation(
				block.text,
				translatedText,
				effectiveSourceLang,
				targetLang
			)) {
				invalidOutput = true;
			}
		}
		throwIfTranslationCancelled(signal);
		if (invalidOutput) {
			emitBlockResult(blockResult(blockStatus === 'error' ? 'error' : 'invalid'));
			// Mimetic SFX rarely survives MT validation (unchanged/romaji output
			// is the normal failure), and one drawn sound effect must not fail
			// the whole page atomically — label-free pipelines mark every block
			// required, so demote SFX-shaped sources to optional here.
			if (required && !looksLikeMimeticSfx(block.text)) {
				if (options?.atomicCoverage) {
					throw new TranslationCoverageError(
						'invalid-output',
						requiredCount,
						translatedRequiredCount,
						[block.blockIndex]
					);
				}
				// Reader path: keep going — every block that translates cleanly
				// still ships; the aggregate failure is reported after the loop.
				invalidRequiredBlocks.push(block.blockIndex);
				console.warn(`[on-device] Phase 2: block=${block.blockIndex} failed validation (kept page, will report partial)`);
				continue;
			}
			// Optional SFX/unknown detections remain visible in the source page and
			// are deliberately absent from the translated overlay.
			continue;
		}
		if (required) translatedRequiredCount += 1;
		console.warn(`[on-device] Phase 2: block=${block.blockIndex} translatedChars=${translatedText.length}`);
		emitBlockResult(blockResult(hideInvariantOverlay ? 'invariant-hidden' : blockStatus));

		// Build OverlayEntry
		const overlayEntry: OverlayEntry = {
			boxId: block.blockIndex,
			original_text: block.text,
			translated_text: translatedText,
			type: overlayType,
			x: region.x,
			y: region.y,
			width: region.width,
			height: region.height,
			// Target-script OCR noise that is already readable (for example a
			// misread Latin date label) remains available for review without
			// covering the original page with a no-op translation box.
			isHidden: hideInvariantOverlay || undefined
		};

		// Build PageTranslationEntry
		const pageEntry: PageTranslationEntryDraft = {
			order: i,
			original_text: block.text,
			translated_text: translatedText,
			type: overlayType,
			boxId: block.blockIndex
		};

		overlayDraft.entries.push(overlayEntry);
		pageEntries.push(pageEntry);

		// Progressive overlay update — TranslationOverlay.svelte re-renders
		const progressive = createOverlayDocumentV2({
			draft: { regions: [...overlayDraft.regions], entries: [...overlayDraft.entries] },
			entries: pageEntries,
			sourceImage,
			locale: overlayTargetLocale(targetLang),
			baseDirection: 'auto',
			documentRevision: ++documentRevision,
			pipeline: `on-device-${ocrProvider}`
		});
		pageEntries.splice(0, pageEntries.length, ...progressive.entries);
		if (publishProgressiveSnapshot(
			pageTranslationSnapshot(progressive.entries, progressive.document),
			progressive.document
		)) {
			if (firstOverlayStoreMs === null) firstOverlayStoreMs = performance.now() - pageStarted;
		}
	}

	if (invalidRequiredBlocks.length > 0 && overlayDraft.entries.length === 0) {
		// Nothing translated cleanly: fail the page outright (retryable).
		throw new TranslationCoverageError(
			'invalid-output',
			requiredCount,
			translatedRequiredCount,
			invalidRequiredBlocks
		);
	}
	if (invalidRequiredBlocks.length > 0) {
		console.warn(`[on-device] Phase 2: ${invalidRequiredBlocks.length} required blocks failed validation; keeping ${overlayDraft.entries.length} translated overlays`);
	}
	console.warn(`[on-device] Phase 2 complete: ${overlayDraft.entries.length} overlay entries created`);

	// ── Persist ──
	const adapted = createOverlayDocumentV2({
		draft: overlayDraft,
		entries: pageEntries,
		sourceImage,
		locale: overlayTargetLocale(targetLang),
		baseDirection: 'auto',
		// Reuse the counter: the final document is content-identical to the last
		// progressive snapshot, so it must carry the SAME revision (equal is
		// accepted by the preview port; lower is rejected as backwards).
		documentRevision,
		pipeline: `on-device-${ocrProvider}`
	});
	const overlayData = adapted.document;
	// NOTE: the settings literal is still 'translategemma' (kept to minimize
	// blast radius across settings migration), but pageModel identifies Hy-MT2
	// while preserving that settings migration key.
	const pageTranslation = pageTranslationSnapshot(adapted.entries, overlayData);

	throwIfTranslationCancelled(signal);
	if (!skipPersist) {
		publishProgress({ phase: 'persisting', total, completed: total, currentBoxId: null });
		await persistOnDevicePageTranslation(pageTranslation, signal);
	}
	publishProgress({ phase: 'done', total, completed: total, currentBoxId: null });
	clearProgressAfterCompletion();
	const metrics: OnDeviceTranslationMetrics = {
		totalMs: performance.now() - pageStarted,
		ocrMs,
		modelLoadMs,
		translationPhaseMs: performance.now() - translationPhaseStarted,
		translationInferenceMs,
		firstOverlayStoreMs,
		detectedBlocks: recognizedBlocks.length,
		translatedBlocks: overlayData.items.length,
		modelCalls,
		hyModelSuccesses,
		hyModelErrors,
		hyOriginalFallbacks,
		hyInvariantOutputs,
		hyInvalidOutputs,
		hyChangedTranslations,
		retries,
		sfxMatches,
		ppocr: ppocrMetrics
	};
	publishOnDeviceMetrics(metrics);
	return {
		pageTranslation,
		overlayData: pageTranslation.overlay_data ?? overlayData,
		metrics,
		partialFailure: invalidRequiredBlocks.length > 0
			? { failedBlockIndexes: [...invalidRequiredBlocks], requiredCount, translatedRequiredCount }
			: undefined
	};
	} catch (error) {
		if (progressGeneration !== null && progressGeneration === onDeviceProgressGeneration) {
			onDeviceProgress.set(null);
		}
		throw error;
	}
}

// ============================================================
// Single Region On-Device Translation (for sidebar)
// ============================================================

/**
 * Translate a single user-drawn region using the on-device pipeline.
 * Recognizes the full image and filters blocks within the drawn region bounds.
 */
export async function translateRegionOnDevice(
	region: TranslationRegion,
	imageFile: File,
	signal?: AbortSignal
): Promise<{ original_text: string; translated_text: string }> {
	throwIfTranslationCancelled(signal);
	const currentSettings = get(settings);
	const ocrProvider = currentSettings.onDeviceOCRProvider ?? 'ppocr';

	let blocks: RecognizedBlock[];
	blocks = (await recognizeWithPPOCR(imageFile, {
		signal,
		locale: currentSettings.onDeviceSourceLang === 'auto'
			? 'ja'
			: currentSettings.onDeviceSourceLang,
		useBubbleSeg: false,
		// One user-drawn region: no regrouping runs, so this only satisfies the
		// boundary. Passing the reader's live direction keeps it honest anyway.
		readingDirection: get(readingDirection)
	})).blocks;
	throwIfTranslationCancelled(signal);

	// Filter blocks whose center falls within the user-drawn region
	const matchingBlocks = blocks.filter((b) => {
		const cx = b.x + b.width / 2;
		const cy = b.y + b.height / 2;
		return (
			cx >= region.x &&
			cx <= region.x + region.width &&
			cy >= region.y &&
			cy <= region.y + region.height
		);
	});

	if (matchingBlocks.length === 0) {
		return { original_text: '', translated_text: '[No text detected in region]' };
	}

	// Concatenate all matching block texts
	const recognizedText = matchingBlocks.map((b) => b.text).join('');

	if (!recognizedText.trim()) {
		return { original_text: '', translated_text: '[No text detected in region]' };
	}

	// Translate through the backend selected in settings. The serialized
	// `translategemma` value is retained for migration compatibility, but now
	// dispatches to Hy-MT2 just like the full-page pipeline above.
	const sourceLang = currentSettings.onDeviceSourceLang ?? 'auto';
	const targetLang = currentSettings.onDeviceTargetLang ?? 'en';
	let translatedText: string;

	const sfxResult = lookupSfx(recognizedText);
	if (sfxResult) {
		translatedText = sfxResult;
	} else {
		if (!(await isHyMT2ModelLoaded())) {
			throwIfTranslationCancelled(signal);
			await requireDownloadedModel();
			await loadActiveHyMT2Model(signal);
			throwIfTranslationCancelled(signal);
		}
		translatedText = await translateWithHyMT2(
			recognizedText,
			sourceLang === 'auto' ? 'ja' : sourceLang,
			targetLang,
			signal
		);
	}
	throwIfTranslationCancelled(signal);

	return { original_text: recognizedText, translated_text: translatedText };
}

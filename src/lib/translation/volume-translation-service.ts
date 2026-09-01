/**
 * Volume translation service — 2-pass orchestrator.
 *
 * Pass 1: Translation — translate each page with rolling context
 * Pass 2: Review — quality check and corrections
 *
 * Features:
 * - Sequential page processing (avoids rate limiting)
 * - Checkpoint after each page (resumable)
 * - AbortController for cancellation
 * - Per-page retry (translation: 4 attempts, review: 2 attempts)
 * - Rolling context with periodic LLM summary consolidation
 * - Refusal detection
 * - Progress callbacks for UI updates
 */

import { describeError, renderUserMessage, type UserMessage } from '$lib/i18n/user-messages.js';
import { get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { db } from '$lib/db/index.js';
import { settings } from '$lib/settings/settings.js';
import {
	callLLMWithProvider,
	MAX_RETRIES,
	resolveActiveProvider,
	isProviderVisionMode,
	type ResolvedLLMProvider
} from './llm-client.js';
import { fileToBase64, detectRefusal } from './full-page-service.js';
import {
	parseFullPageResponseResult,
	buildOverlayMessages
} from './full-page-prompt.js';
import {
	initDetector,
	detectTextRegionsForRecognition,
	type PPOcrRecognitionDetection
} from '$lib/detection/ppocr-detector.js';
import { isVideoPageFilename } from '$lib/import/types.js';
import { type BubbleRegion } from '$lib/detection/bubble-geometry.js';
import { detectLayout } from '$lib/detection/layout-detector.js';
import { mergeTextWithBubbles } from '$lib/detection/spatial-merge.js';
import { resolveTextDetectionFusion } from '$lib/detection/fusion-guard.js';
import { annotateImageWithBoxes } from '$lib/detection/image-annotator.js';
import { debugLogParse, debugLogError } from './debug-log.js';
import { LLMProviderError } from './llm-types.js';
import type { ChatMessage, LLMCallOptions, LLMResponse } from './llm-types.js';
import { TRANSLATION_JSON_MODE, providerSupportsStructuredOutput } from './json-schemas.js';
import { parseFirstJsonObject } from './json-utils.js';
import { buildSummaryConsolidationMessages, buildReviewMessages } from './volume-prompts.js';
import {
	translatePageOnDevice,
	type OnDeviceProgressState
} from './on-device-service.js';
import { extractTextWithPPOCR } from './ppocr-text-extractor.js';
import { isMeaningfulOcrText } from './ocr-text-filter.js';
import {
	buildTextOnlyOverlayMessages,
	buildMissingOverlayRepairMessages,
	buildTextOnlyReviewMessages
} from './text-only-prompts.js';
import { updateJob } from '$lib/stores/volume-translation-state.js';
import type {
	VolumeTranslationJob,
	VolumeTranslationOptions,
	RollingContext,
	VolumePageTranslation,
	PageReview,
	PageTranslationEntry,
	PageTranslationEntryDraft,
	PageOverlayData,
	PageOverlayDraft,
	DetectedTextRegion,
	VolumeTranslationPageFailure,
	PageTranslation
} from '$lib/types/index.js';
import type { FumetoSettings } from '$lib/settings/settings.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import type { PageSource } from '$lib/reader/page-source.js';
import { RemotePageSource } from '$lib/reader/remote-page-source.js';
import { KomgaPageSource } from '$lib/reader/komga-page-source.js';
import { KavitaPageSource } from '$lib/reader/kavita-page-source.js';
import { PrefetchedPageSource } from '$lib/reader/prefetched-page-source.js';
import { isAndroid } from '$lib/util/platform.js';
import { applyReviewRevisions } from './review-sync.js';
import {
	createOverlayDocumentV2,
	ensureStableTranslationEntries,
	inspectOverlaySourceImage,
	overlayTargetLocale,
	pageOverlayRepository
} from '$lib/overlay-layout/index.js';
import {
	aggregateTranslationUsage,
	reconcileOverlayTranslation
} from './overlay-translation-reconciliation.js';
import { isTranslationCoverageError } from './translation-coverage.js';
import { effectiveReadingDirection } from '$lib/reader/reading-direction.js';
import {
	disposeOfPageFailure,
	pageRetryBudget,
	pageRetryDelayMs,
	retryAfterMsOf
} from './page-retry-policy.js';

// Active abort controllers by volume_uuid
const abortControllers = new Map<string, AbortController>();

/**
 * What each running job was started against. A job keeps using the provider it
 * resolved at startup, so this is also the record of which configuration a job
 * would be lying about if the user changed it mid-run.
 */
export interface ActiveRunDescriptor {
	volumeUuid: string;
	pipeline: 'off-device' | 'on-device';
	providerId?: string;
}
const runDescriptors = new Map<string, ActiveRunDescriptor>();

/** Reason to report when an abort was not the user pressing Cancel. */
const cancelReasons = new Map<string, UserMessage>();

/** Descriptors for every volume translation currently running. */
export function activeRunDescriptors(): ActiveRunDescriptor[] {
	return [...runDescriptors.values()];
}

// Atomic same-volume execution leases. Duplicate callers join the same run.
const activeRuns = new Map<string, Promise<VolumeTranslationJob>>();

function throwIfVolumeTranslationCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('Translation cancelled');
}

/** Sleep that gives up as soon as the run is cancelled. */
function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Translation cancelled'));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new Error('Translation cancelled'));
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

/** Summary consolidation interval (pages) */
const SUMMARY_INTERVAL = 20;

/** Number of recent pages to keep as raw context (fallback when setting missing). */
const RECENT_PAGES_WINDOW_FALLBACK = 3;

/**
 * Maximum consecutive page failures before aborting a pass.
 *
 * If this many pages in a row fail (e.g., all page fetches timeout because
 * the YACReader server session expired and re-open also fails), it signals
 * a systemic issue rather than isolated per-page problems. Failing fast
 * gives the user a clear error instead of silently skipping every page.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Maximum fraction of maxResponseTokens that rolling context may consume. */
const CONTEXT_BUDGET_FRACTION = 0.4;

/**
 * Minimum maxResponseTokens to use LLM-based summary consolidation.
 * Below this, use simple text truncation instead to avoid context-length failures.
 */
const MIN_TOKENS_FOR_LLM_CONSOLIDATION = 4096;

class PageLLMError extends Error {
	constructor(
		public readonly originalError: unknown,
		public readonly attempts: number
	) {
		super(originalError instanceof Error ? originalError.message : String(originalError));
		this.name = 'PageLLMError';
	}
}

function classifyFailure(err: unknown): NonNullable<VolumeTranslationPageFailure['category']> {
	const original = err instanceof PageLLMError ? err.originalError : err;
	if (isTranslationCoverageError(original)) return 'coverage';
	if (original instanceof LLMProviderError) {
		if (original.isContentFiltered) return 'content_filter';
		if (original.isAuthError) return 'auth';
		if (original.status === 429) return 'rate_limit';
		// 402 is an exhausted balance or key cap: every later page fails the same
		// way, so it is fatal rather than merely retryable.
		if (original.status === 402) return 'insufficient_credit';
		if (original.status === 400 || original.status === 413) return 'invalid_request';
		if (original.status >= 500) return 'server';
	}
	const message =
		original instanceof Error ? original.message.toLowerCase() : String(original).toLowerCase();
	if (message.includes('cancel')) return 'cancelled';
	if (
		message.includes('api key') ||
		message.includes('unauthorized') ||
		message.includes('forbidden')
	)
		return 'auth';
	if (message.includes('malformed') || message.includes('json')) return 'parse';
	if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
	if (message.includes('network') || message.includes('connect') || message.includes('fetch'))
		return 'network';
	if (message.includes('page') || message.includes('prefetch')) return 'page_source';
	return 'unknown';
}

/** Pages a previous run could not translate, still waiting for another attempt. */
export function outstandingTranslationFailures(job: VolumeTranslationJob): number[] {
	return (job.failed_pages ?? [])
		.filter((failure) => failure.phase === 'translation')
		.map((failure) => failure.page_index);
}

/**
 * Pages this pass will work through: everything still ahead of the checkpoint,
 * plus any page an earlier attempt left behind. Retrying the stragglers first
 * keeps the durable checkpoint meaningful — it only ever moves forward.
 */
/**
 * Page indexes whose stored filename marks them as video (never translated).
 * Exported for tests.
 */
export async function videoPageIndexSet(volumeUuid: string): Promise<Set<number>> {
	const dims = await db.page_dimensions.get(volumeUuid);
	const videos = new Set<number>();
	for (const page of dims?.pages ?? []) {
		if (isVideoPageFilename(page.filename)) videos.add(page.index);
	}
	return videos;
}

function pagesForTranslationPass(job: VolumeTranslationJob): number[] {
	const offset = job.start_page_offset ?? 0;
	const pages = new Set<number>();
	for (const index of outstandingTranslationFailures(job)) {
		if (index >= offset && index < offset + job.total_pages) pages.add(index);
	}
	for (let i = job.current_page + offset; i < offset + job.total_pages; i++) pages.add(i);
	return [...pages].sort((left, right) => left - right);
}

function recordPageFailure(
	job: VolumeTranslationJob,
	pageIndex: number,
	phase: VolumeTranslationPageFailure['phase'],
	err: unknown,
	attempts?: number
): void {
	const original = err instanceof PageLLMError ? err.originalError : err;
	const error = original instanceof Error ? original.message : String(original);
	const category = classifyFailure(err);
	job.failed_pages ??= [];
	const failure: VolumeTranslationPageFailure = {
		page_index: pageIndex,
		phase,
		error,
		attempts: attempts ?? (err instanceof PageLLMError ? err.attempts : 1),
		category,
		failed_at: new Date().toISOString()
	};
	const existing = job.failed_pages.findIndex(
		(item) => item.page_index === pageIndex && item.phase === phase
	);
	if (existing >= 0) job.failed_pages[existing] = failure;
	else job.failed_pages.push(failure);
	if (job.diagnostics) job.diagnostics.last_error_category = category;
}

function clearPageFailure(
	job: VolumeTranslationJob,
	pageIndex: number,
	phase: VolumeTranslationPageFailure['phase']
): void {
	if (!job.failed_pages) return;
	job.failed_pages = job.failed_pages.filter(
		(item) => item.page_index !== pageIndex || item.phase !== phase
	);
}

async function callPageLLM(
	job: VolumeTranslationJob,
	provider: ResolvedLLMProvider,
	messages: ChatMessage[],
	options: LLMCallOptions
): Promise<LLMResponse> {
	throwIfVolumeTranslationCancelled(options.signal);
	job.diagnostics ??= { request_attempts: 0 };
	job.diagnostics.request_attempts++;
	let attempts = 1;
	const originalOnRetry = options.onRetry;
	try {
		const response = await callLLMWithProvider(provider, messages, {
			...options,
			onRetry: (attempt, delayMs, error) => {
				throwIfVolumeTranslationCancelled(options.signal);
				attempts++;
				job.diagnostics!.request_attempts++;
				originalOnRetry?.(attempt, delayMs, error);
			}
		});
		// Provider clients should reject on abort, but this guard also covers a
		// response/body implementation that completes after ignoring its signal.
		throwIfVolumeTranslationCancelled(options.signal);
		return response;
	} catch (err) {
		throw new PageLLMError(err, attempts);
	}
}

/** Persisted job checkpoints never embed accumulated per-page payloads. */
function lightweightJob(job: VolumeTranslationJob): VolumeTranslationJob {
	const { translations: _translations, reviews: _reviews, ...checkpoint } = job;
	return { ...checkpoint, results_storage: 'page_translations' };
}

function pageRecord(job: VolumeTranslationJob, page: VolumePageTranslation): PageTranslation {
	return {
		id: `vol_trans_${job.volume_uuid}_${page.page_index}`,
		volume_uuid: job.volume_uuid,
		page_index: page.page_index,
		entries: ensureStableTranslationEntries(page.entries, [job.volume_uuid, page.page_index]),
		no_text_detected: page.no_text_detected,
		model: job.model,
		prompt_tokens: page.prompt_tokens,
		completion_tokens: page.completion_tokens,
		created_at: job.updated_at,
		overlay_data: page.overlay_data
	};
}

async function persistCheckpoint(
	job: VolumeTranslationJob,
	pages: VolumePageTranslation[] = [],
	signal?: AbortSignal
): Promise<void> {
	throwIfVolumeTranslationCancelled(signal);
	const records = pages
		.filter((page) => page.entries.length > 0 || page.no_text_detected)
		.map((page) => pageRecord(job, page));
	const checkpoint = lightweightJob(job);
	await pageOverlayRepository.putCheckpoint(records, checkpoint, signal);
	throwIfVolumeTranslationCancelled(signal);
}

async function rehydrateTranslations(job: VolumeTranslationJob, signal?: AbortSignal): Promise<void> {
	throwIfVolumeTranslationCancelled(signal);
	const persisted = await pageOverlayRepository.listVolume(job.volume_uuid);
	throwIfVolumeTranslationCancelled(signal);
	const offset = job.start_page_offset ?? 0;
	const end = offset + job.total_pages;
	const byPage = new Map<number, VolumePageTranslation>();
	for (const page of job.translations ?? []) byPage.set(page.page_index, page);
	for (const record of persisted) {
		if (record.page_index < offset || record.page_index >= end) continue;
		const existing = byPage.get(record.page_index);
		const deterministic = record.id === `vol_trans_${job.volume_uuid}_${record.page_index}`;
		if (!existing || deterministic) {
			byPage.set(record.page_index, {
				page_index: record.page_index,
				entries: record.entries,
				no_text_detected: record.no_text_detected,
				prompt_tokens: record.prompt_tokens,
				completion_tokens: record.completion_tokens,
				overlay_data: record.overlay_data
			});
		}
	}
	job.translations = Array.from(byPage.values()).sort((a, b) => a.page_index - b.page_index);
}

/**
 * Create a retry callback that updates job progress for UI display.
 */
function makeRetryCallback(
	job: VolumeTranslationJob,
	onProgress?: (job: VolumeTranslationJob) => void
): (attempt: number, delayMs: number, error: string) => void {
	return (attempt, delayMs, error) => {
		job.error_message = { code: 'job_retry', params: { attempt, max: MAX_RETRIES, seconds: Math.ceil(delayMs / 1000), detail: error } };
		job.error_kind = 'retry';
		job.updated_at = new Date().toISOString();
		updateJob(job);
		onProgress?.(job);
	};
}

/** Clear retry message from job after a successful API call. */
function clearRetryMessage(job: VolumeTranslationJob): void {
	if (job.error_kind === 'retry') {
		job.error_message = undefined;
		job.error_kind = undefined;
	}
}

/**
 * Append a warning to the job error field without losing previous warnings.
 * Each pass may report its own skip count; they accumulate separated by newlines.
 * Retry messages (transient) are replaced, but pass-level summaries persist.
 */
function appendJobWarning(job: VolumeTranslationJob, warning: UserMessage): void {
	clearRetryMessage(job);
	job.warnings = [...(job.warnings ?? []), warning];
	job.error_message = warning;
	job.error_kind = 'warning';
}

/** Clear every error state (a run starting over). */
function clearJobError(job: VolumeTranslationJob): void {
	job.error = undefined;
	job.error_message = undefined;
	job.error_kind = undefined;
	job.warnings = undefined;
}

function clearActivity(job: VolumeTranslationJob): void {
	job.activity = undefined;
	job.activity_message = undefined;
}

/** Update job activity text and push to store (lightweight UI feedback). */
function setActivity(
	job: VolumeTranslationJob,
	activity: UserMessage,
	onProgress?: (job: VolumeTranslationJob) => void
): void {
	job.activity_message = activity;
	// English shadow: logs, tests and the Android notification read it.
	job.activity = renderUserMessage(activity, { locale: 'en' });
	job.updated_at = new Date().toISOString();
	updateJob(job);
	onProgress?.(job);
}

/**
 * Pre-fetch all pages from a remote source into memory.
 *
 * When translating from a YACReader server, the long LLM API calls between
 * page fetches cause the server's inactivity timeout to expire, leading to
 * 404/412/424 errors. By pre-fetching all pages up-front (rapid sequential
 * requests while the session is alive), we avoid this entirely.
 *
 * For local page sources, this is a no-op — returns the source as-is.
 */
function boundRemoteSource(pageSource: PageSource): PageSource {
	if (
		!(pageSource instanceof RemotePageSource) &&
		!(pageSource instanceof KomgaPageSource) &&
		!(pageSource instanceof KavitaPageSource)
	) {
		return pageSource;
	}
	// Residency covers the burst window plus the page in hand, so a warm
	// burst never evicts what it just fetched.
	return new PrefetchedPageSource(pageSource, 5, { burstAhead: 3 });
}

/**
 * Start (or resume) a 2-pass volume translation.
 */
export function startVolumeTranslation(
	volumeUuid: string,
	options?: VolumeTranslationOptions,
	onProgress?: (job: VolumeTranslationJob) => void
): Promise<VolumeTranslationJob> {
	const existing = activeRuns.get(volumeUuid);
	if (existing) return existing;

	const controller = new AbortController();
	abortControllers.set(volumeUuid, controller);

	let run!: Promise<VolumeTranslationJob>;
	run = runVolumeTranslation(volumeUuid, options, onProgress, controller).finally(() => {
		if (activeRuns.get(volumeUuid) === run) activeRuns.delete(volumeUuid);
		if (abortControllers.get(volumeUuid) === controller) abortControllers.delete(volumeUuid);
	});
	activeRuns.set(volumeUuid, run);
	return run;
}

async function runVolumeTranslation(
	volumeUuid: string,
	options: VolumeTranslationOptions | undefined,
	onProgress: ((job: VolumeTranslationJob) => void) | undefined,
	controller: AbortController
): Promise<VolumeTranslationJob> {
	const $settings = get(settings);
	const jobStartTime = performance.now();
	let job: VolumeTranslationJob | undefined;
	let pageSource: PageSource | null = null;
	let effectivePageSource: PageSource | null = null;
	let bgBridge: typeof import('./background-service-bridge.js') | null = null;

	try {
		// Load volume data
		const volume = await db.volumes.get(volumeUuid);
		throwIfVolumeTranslationCancelled(controller.signal);
		if (!volume) throw new Error('Volume not found');

		// Check for existing incomplete job to resume
		const existingJobs = await db.volume_translation_jobs
			.where('volume_uuid')
			.equals(volumeUuid)
			.toArray();
		throwIfVolumeTranslationCancelled(controller.signal);

		// Anything short of a clean finish is picked up again rather than restarted:
		// an interrupted pass, a run that hit a fatal error, a cancelled run, and a
		// run that finished with pages it could not use. Only a job that completed
		// with nothing outstanding is left alone, so "Get Full Translation" on a
		// finished volume still means a fresh translation.
		for (const j of existingJobs) {
			if (j.status === 'translating' || j.status === 'reviewing') { job = j; break; }
			if ((j.status === 'failed' || j.status === 'cancelled') && !job) job = j;
			if (j.status === 'completed' && outstandingTranslationFailures(j).length > 0 && !job) job = j;
		}
		const resumedJob = !!job;
		// A finished volume being picked up again is only here to repair the pages
		// it could not use; its review pass already ran and must not be re-billed.
		const repairingFinishedVolume = job?.status === 'completed';
		if (job && job.status !== 'translating' && job.status !== 'reviewing') {
			// Re-enter whichever pass was interrupted. A run that died in review
			// has a translation-pass checkpoint that no longer describes it, so
			// resuming it as a translation would re-translate finished pages.
			job.status = !repairingFinishedVolume && job.interrupted_phase === 'review'
				? 'reviewing'
				: 'translating';
			clearJobError(job);
			job.completed_at = undefined;
		}

		if (!job) {
			// Apply custom options if provided
			const isGallery = options?.mode === 'gallery';
			const startOffset = options?.startPage ?? 0;
			const effectiveEnd = options?.endPage ?? volume.page_count;
			const totalPages = effectiveEnd - startOffset;

			// Persist the job before provider/page-source setup so any subsequent
			// setup failure has a durable terminal record.
			job = {
				id: randomUUID(),
				volume_uuid: volumeUuid,
				status: 'translating',
				current_page: 0,
				total_pages: totalPages,
				total_prompt_tokens: 0,
				total_completion_tokens: 0,
				started_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				model: $settings.selectedModel || 'unknown',
				rolling_context: isGallery
					? undefined
					: {
							summary: options?.initialSummary || '',
							summarized_through_page: -1,
							recent_pages: [],
							characters: []
						},
				translations: [],
				reviews: [],
				start_page_offset: startOffset > 0 ? startOffset : undefined,
				gallery_mode: isGallery || undefined,
				source_language: options?.sourceLanguage,
				target_language: options?.targetLanguage,
				generate_overlays: options?.generateOverlays ?? $settings.overlayAutoGenerate,
				skip_review: options?.skipReview ?? $settings.skipReviewPass
			};
			await persistCheckpoint(job, [], controller.signal);
		}
		if (resumedJob) {
			const earliestLegacyPage = await pageOverlayRepository.purgeLegacyJobCheckpoints(volumeUuid);
			if (earliestLegacyPage !== null) {
				const offset = job.start_page_offset ?? 0;
				job.current_page = Math.max(0, earliestLegacyPage - offset);
				job.translations = (job.translations ?? []).filter((page) => page.page_index < earliestLegacyPage);
				if (!job.gallery_mode) {
					job.rolling_context = { summary: '', summarized_through_page: -1, recent_pages: [], characters: [] };
					for (const page of [...job.translations].sort((a, b) => a.page_index - b.page_index)) {
						updateRollingContextAfterPage(job.rolling_context, page.page_index, page.entries, $settings.mode3RecentPages ?? RECENT_PAGES_WINDOW_FALLBACK);
					}
				}
			}
			await rehydrateTranslations(job, controller.signal);
			await persistCheckpoint(job, job.translations ?? [], controller.signal);
		}

		// Create page source only after a resumable/new job exists in the database.
		// Remote sources acquire a per-server session lease inside — with one
		// background session per server, a second job queues here, so say so
		// instead of looking stuck.
		if (volume.source && volume.source.type !== 'local') {
			setActivity(job, { code: 'job_activity_waiting_session' }, onProgress);
		}
		pageSource = await createPageSource(volume, { signal: controller.signal });
		throwIfVolumeTranslationCancelled(controller.signal);

		// A fully on-device translation must not depend on a configured cloud/local
		// OpenAI-compatible provider. Resolve one only for an off-device pass (or a
		// resumed review pass that was created by an earlier off-device run).
		const needsOffDeviceProvider = $settings.translationPipeline !== 'on-device'
			|| job.status === 'reviewing';
		let provider: ResolvedLLMProvider | null = null;
		let visionMode = false;
		if (needsOffDeviceProvider) {
			const resolvedProvider = await resolveActiveProvider();
			throwIfVolumeTranslationCancelled(controller.signal);
			provider = {
				...resolvedProvider,
				config: { ...resolvedProvider.config }
			};
			visionMode = isProviderVisionMode(provider.config);
			job.model = provider.model;
			job.diagnostics ??= { request_attempts: 0 };
			job.diagnostics.provider_id = provider.config.id;
			job.diagnostics.provider_type = provider.config.type;
		} else {
			const ocr = $settings.onDeviceOCRProvider ?? 'ppocr';
			job.model = `on-device-hymt2-1.25bit-${ocr}`;
		}

		// Pre-load model in LM Studio (ensures exactly one model is loaded).
		if (provider?.config.type === 'lmstudio') {
			setActivity(job, { code: 'job_activity_loading_lm_studio' }, onProgress);
			try {
				const { ensureModelLoaded } = await import('./lmstudio-native.js');
				throwIfVolumeTranslationCancelled(controller.signal);
				const baseUrl = provider.config.baseUrl || 'http://localhost:1234';
				const result = await ensureModelLoaded(baseUrl, provider.model);
				throwIfVolumeTranslationCancelled(controller.signal);
				if (!result.success) {
					console.warn('[volume-translation] Model preload failed:', result.error);
				}
			} catch (error) {
				throwIfVolumeTranslationCancelled(controller.signal);
				// Native API unavailable — JIT loading will handle it
			}
		}

		runDescriptors.set(volumeUuid, {
			volumeUuid,
			pipeline: $settings.translationPipeline === 'on-device' ? 'on-device' : 'off-device',
			providerId: provider?.config.id
		});

		setActivity(job, { code: 'job_activity_starting' }, onProgress);

		// Build effective settings with per-job language overrides
		const effectiveSettings: FumetoSettings = {
			...$settings,
			sourceLanguage: job.source_language ?? $settings.sourceLanguage,
			targetLanguage: job.target_language ?? $settings.targetLanguage
		};

		// Snapshot context token budget — remains constant for the entire job
		// even if the user changes maxContextTokens in Settings mid-translation.
		const maxResponseTokens = effectiveSettings.maxContextTokens ?? 10000;

		// Remote pages are fetched lazily through a two-page LRU window.
		effectivePageSource = boundRemoteSource(pageSource);

		// Start Android foreground service if background translation is enabled.
		// This prevents the OS from killing the process when backgrounded and
		// acquires a wake lock to prevent CPU sleep when the screen turns off.
		const shouldRunInBackground = $settings.backgroundTranslation && isAndroid;
		if (shouldRunInBackground) {
			try {
				bgBridge = await import('./background-service-bridge.js');
				throwIfVolumeTranslationCancelled(controller.signal);
				const volumeName = volume.title || volume.filename || 'Volume';
				if (!bgBridge.startBackgroundTranslation(volumeName, job.total_pages, volume.volume_uuid)) {
					// Android refused the claim (it already told the user). Drop the
					// handle so the run stops pushing progress at a service it does
					// not hold, and so the release in `finally` stays a no-op.
					bgBridge = null;
				}
			} catch (err) {
				throwIfVolumeTranslationCancelled(controller.signal);
				console.warn('[volume-translation] Failed to start background service:', err);
				bgBridge = null;
			}
		}

		// Wrap onProgress to also update the foreground service notification
		const wrappedOnProgress = (j: VolumeTranslationJob) => {
			onProgress?.(j);
			if (bgBridge) {
				const volumeName = volume.title || volume.filename || 'Volume';
				bgBridge.updateTranslationProgress(
					volumeName,
					j.current_page,
					j.total_pages,
					j.activity || `Page ${j.current_page}/${j.total_pages}`,
					volume.volume_uuid
				);
			}
		};

		// Run passes sequentially, resuming where we left off
		if (job.status === 'translating') {
			await runTranslationPass(
				job,
				effectivePageSource,
				effectiveSettings,
				effectiveReadingDirection(volume, effectiveSettings),
				controller.signal,
				maxResponseTokens,
				visionMode,
				provider,
					wrappedOnProgress
				);
				throwIfVolumeTranslationCancelled(controller.signal);

			// Pages the retry budget could not rescue do not condemn the run: the
			// rest of the volume is translated and the leftovers stay recorded, so
			// running the job again picks up exactly those pages.
			if (
				job.gallery_mode ||
				job.skip_review ||
				repairingFinishedVolume ||
				effectiveSettings.translationPipeline === 'on-device'
			) {
				// Gallery mode, skip_review, or on-device: skip review pass entirely
			} else {
				// Story mode: advance to review
				job.status = 'reviewing';
					job.current_page = 0;
					setActivity(job, { code: 'job_activity_review_starting' }, wrappedOnProgress);
					await persistCheckpoint(job, [], controller.signal);
					updateJob(job);
			}
		}

		if (job.status === 'reviewing') {
			if (!provider) {
				throw new Error('An off-device provider is required to resume the review pass');
			}
			await runReviewPass(
				job,
				effectivePageSource,
				effectiveSettings,
				controller.signal,
				maxResponseTokens,
				visionMode,
				provider,
					wrappedOnProgress
				);
				throwIfVolumeTranslationCancelled(controller.signal);
		}

		// Mark completed
		throwIfVolumeTranslationCancelled(controller.signal);
		job.status = 'completed';
		clearActivity(job);
		job.interrupted_phase = undefined;
		job.completed_at = new Date().toISOString();
		job.updated_at = new Date().toISOString();
		await persistCheckpoint(job, [], controller.signal);
		updateJob(job);

		// Job summary timing
		const jobElapsedMs = Math.round(performance.now() - jobStartTime);
		const jobElapsedMin = (jobElapsedMs / 60000).toFixed(1);
		const totalPages = job.total_pages;
		const avgMs = totalPages > 0 ? Math.round(jobElapsedMs / totalPages) : 0;
		const leftover = (job.failed_pages ?? []).length;
		console.warn(
			`[volume-translation] ✅ COMPLETED ${totalPages} pages in ${jobElapsedMin}min (avg ${avgMs}ms/page)` +
			`${leftover > 0 ? ` | ${leftover} page(s) still need another pass` : ''}` +
			` | ${job.total_prompt_tokens}+${job.total_completion_tokens} tokens | pipeline=${$settings.translationPipeline} model=${job.model || 'on-device'}`
		);

		return job;
	} catch (err) {
		if (job) {
			job.interrupted_phase = job.status === 'reviewing' ? 'review' : 'translation';
			if (controller.signal.aborted) {
				job.status = 'cancelled';
				job.error = undefined;
				job.error_message = cancelReasons.get(volumeUuid);
				job.error_kind = 'cancelled';
			} else {
				job.status = 'failed';
				job.error = err instanceof Error ? err.message : String(err);
				job.error_message = describeError(err);
				job.error_kind = 'failure';
				if (job.diagnostics) job.diagnostics.last_error_category = classifyFailure(err);
			}
			clearActivity(job);
			job.updated_at = new Date().toISOString();
			try {
				await persistCheckpoint(job);
				updateJob(job);
			} catch (persistError) {
				console.error('[volume-translation] Failed to persist terminal job state:', persistError);
			}
		}
		throw err;
	} finally {
		if (effectivePageSource) {
			try {
				effectivePageSource.dispose();
			} catch {
				/* best effort */
			}
		} else if (pageSource) {
			try { pageSource.dispose(); } catch { /* best effort */ }
		}
		// Release only this volume's claim — other jobs may still need the service.
		if (bgBridge) bgBridge.stopBackgroundTranslation(volumeUuid);
		runDescriptors.delete(volumeUuid);
		cancelReasons.delete(volumeUuid);
	}
}

/**
 * Cancel an in-progress volume translation.
 *
 * If the job is actively running (has an AbortController), aborts it.
 * If the job is stale (e.g., leftover from a previous session), directly
 * updates the DB record and in-memory store to 'cancelled'.
 */
export async function cancelVolumeTranslation(volumeUuid: string, reason?: UserMessage): Promise<void> {
	const controller = abortControllers.get(volumeUuid);
	if (controller) {
		if (reason) cancelReasons.set(volumeUuid, reason);
		controller.abort();
		return;
	}

	// No active controller — this is a stale/stuck job.
	// Directly update the DB record and in-memory store.
	const jobs = await db.volume_translation_jobs.where('volume_uuid').equals(volumeUuid).toArray();

	for (const job of jobs) {
		if (job.status === 'translating' || job.status === 'reviewing') {
			job.interrupted_phase = job.status === 'reviewing' ? 'review' : 'translation';
			job.status = 'cancelled';
			job.error = undefined;
			job.error_message = reason;
			job.error_kind = 'cancelled';
			clearActivity(job);
			job.updated_at = new Date().toISOString();
			await persistCheckpoint(job);
			updateJob(job);
		}
	}
}

/** Check whether a translation job is actively running (has an AbortController). */
export function isJobActive(volumeUuid: string): boolean {
	return abortControllers.has(volumeUuid);
}

/**
 * External work (e.g. a volume export) registers its AbortController here,
 * NOT in abortControllers: isJobActive() feeds the paused-checkpoint
 * annotation and the card's ✕ routes through cancelVolumeTranslation, so an
 * export sharing the translation map made a paused card render as running
 * and let "Discard paused translation" abort the export instead.
 */
const externalCancelHandles = new Map<string, AbortController>();

/**
 * Register an external AbortController (e.g. a volume export) so the
 * notification's uuid-scoped Cancel reaches it like any translation job.
 * Returns an unregister function; always call it when the work settles.
 */
export function registerVolumeCancelHandle(
	volumeUuid: string,
	controller: AbortController
): () => void {
	externalCancelHandles.set(volumeUuid, controller);
	return () => {
		if (externalCancelHandles.get(volumeUuid) === controller) externalCancelHandles.delete(volumeUuid);
	};
}

/**
 * Notification-scoped cancel for whatever is running on this volume:
 * external work (export) first, else the translation run/checkpoint.
 */
export async function cancelVolumeWork(volumeUuid: string): Promise<void> {
	const external = externalCancelHandles.get(volumeUuid);
	if (external) {
		external.abort();
		return;
	}
	await cancelVolumeTranslation(volumeUuid);
}

/**
 * Cancel whatever translation job is currently active.
 * Used by the notification cancel button (which doesn't know the volume UUID).
 */
export function cancelActiveTranslation(): void {
	for (const [, controller] of externalCancelHandles) {
		controller.abort();
	}
	for (const [, controller] of abortControllers) {
		controller.abort();
	}
}

// ============================================================
// Pass 1: Translation with Rolling Context
// ============================================================

async function runTranslationPass(
	job: VolumeTranslationJob,
	pageSource: PageSource,
	$settings: FumetoSettings,
	readingDir: 'rtl' | 'ltr',
	signal: AbortSignal,
	maxResponseTokens: number,
	visionMode: boolean,
	provider: ResolvedLLMProvider | null,
	onProgress?: (job: VolumeTranslationJob) => void
): Promise<void> {
	if (!job.translations) job.translations = [];
	if (!job.gallery_mode && !job.rolling_context) {
		job.rolling_context = {
			summary: '',
			summarized_through_page: -1,
			recent_pages: [],
			characters: []
		};
	}

	// Check if provider supports structured output (JSON schema enforcement).
	const useStructuredOutput = provider
		? providerSupportsStructuredOutput(provider.config.type)
		: false;

	const useOverlay = !!job.generate_overlays;
	const sourceLocale = $settings.sourceLanguage === 'auto' ? 'ja' : $settings.sourceLanguage;
	// Off-device paths use PP-OCR as their text/no-text preflight.
	if ($settings.translationPipeline !== 'on-device') {
		setActivity(job, { code: 'job_activity_loading_detector' }, onProgress);
		await initDetector({ signal });
		throwIfVolumeTranslationCancelled(signal);
	}

	const offset = job.start_page_offset ?? 0;
	let skipped = 0;
	let consecutiveFailures = 0;
	const retryBudget = pageRetryBudget();

	// Video pages carry no translatable text and the detector/providers must
	// never see a video blob — identified once per run by stored filename.
	const videoPages = await videoPageIndexSet(job.volume_uuid);

	const plannedPages = pagesForTranslationPass(job);
	for (const i of plannedPages) {
		throwIfVolumeTranslationCancelled(signal);

		const pageNum = i - offset + 1; // 1-indexed progress within range
		let succeeded = false;
		let isCorruptedFallback = false;
		const pageStartTime = performance.now();
		const translationIndexBeforePage = job.translations.findIndex((page) => page.page_index === i);
		const translationBeforePage = translationIndexBeforePage >= 0
			? structuredClone(job.translations[translationIndexBeforePage])
			: undefined;
		const rollingContextBeforePage = job.rolling_context
			? structuredClone(job.rolling_context)
			: undefined;
		const promptTokensBeforePage = job.total_prompt_tokens;
		const completionTokensBeforePage = job.total_completion_tokens;
		const currentPageBeforePage = job.current_page;
		let billedPromptTokens = 0;
		let billedCompletionTokens = 0;
		const recordBilledResponse = (response: LLMResponse): void => {
			billedPromptTokens += response.usage.prompt_tokens;
			billedCompletionTokens += response.usage.completion_tokens;
		};
		const retainBilledUsage = (): void => {
			job.total_prompt_tokens = promptTokensBeforePage + billedPromptTokens;
			job.total_completion_tokens = completionTokensBeforePage + billedCompletionTokens;
		};
		const restoreUncommittedPageState = () => {
			const currentIndex = job.translations!.findIndex((page) => page.page_index === i);
			if (translationBeforePage) {
				if (currentIndex >= 0) job.translations![currentIndex] = translationBeforePage;
				else job.translations!.push(translationBeforePage);
			} else if (currentIndex >= 0) {
				job.translations!.splice(currentIndex, 1);
			}
			job.rolling_context = rollingContextBeforePage;
			job.total_prompt_tokens = promptTokensBeforePage;
			job.total_completion_tokens = completionTokensBeforePage;
			job.current_page = currentPageBeforePage;
		};

		if (videoPages.has(i)) {
			// Commit the same empty no-text outcome the OCR preflight produces:
			// progress totals, checkpointing, and the review pass (which skips
			// entry-less pages) behave identically, and the attempt loop below
			// is bypassed via `succeeded`.
			const pageTranslation: VolumePageTranslation = {
				page_index: i,
				entries: [],
				no_text_detected: true,
				prompt_tokens: 0,
				completion_tokens: 0
			};
			const existingIdx = job.translations.findIndex((t) => t.page_index === i);
			if (existingIdx >= 0) job.translations[existingIdx] = pageTranslation;
			else job.translations.push(pageTranslation);
			succeeded = true;
		}

		// The provider client owns its own short retry; this loop is the one that
		// decides whether a page is worth another go at all (page-retry-policy.ts).
		for (let attempt = 0; attempt < retryBudget.maxAttempts && !succeeded; attempt++) {
			try {
				setActivity(job, { code: 'job_activity_loading_page', params: { page: pageNum, total: job.total_pages } }, onProgress);
				const imageFile = await pageSource.getPageAsFile(i, { signal });
				throwIfVolumeTranslationCancelled(signal);

				let entries: PageTranslationEntryDraft[];
				let overlayData: PageOverlayData | undefined;
				let overlayDraft: PageOverlayDraft | undefined;
				let promptTokens: number;
				let completionTokens: number;
				let noTextDetected = false;
				const sourceImagePromise = useOverlay ? inspectOverlaySourceImage(imageFile) : undefined;
				const finalizeOverlayDraft = async (): Promise<void> => {
					if (!overlayDraft || !sourceImagePromise) return;
					const adapted = createOverlayDocumentV2({
						draft: overlayDraft,
						entries,
						sourceImage: await sourceImagePromise,
						locale: overlayTargetLocale($settings.targetLanguage),
						baseDirection: 'auto',
						pipeline: 'ppocr'
					});
					entries = adapted.entries;
					overlayData = adapted.document;
					overlayDraft = undefined;
				};

				// ── On-device pipeline: bypass cloud LLM entirely ──
				if ($settings.translationPipeline === 'on-device') {
					setActivity(job, { code: 'job_activity_on_device_page', params: { page: pageNum, total: job.total_pages } }, onProgress);
					const result = await translatePageOnDevice(job.volume_uuid, i, imageFile, {
						suppressProgressiveUpdates: true,
						skipPersist: true,
						// This job's volume, not whatever the reader has open.
						readingDirection: readingDir,
						// The batch pass depends on atomic page results for its
						// retry/checkpoint budget; partial pages must throw.
						atomicCoverage: true,
						signal,
						runtimeOverrides: {
							sourceLang: $settings.sourceLanguage,
							targetLang: $settings.targetLanguage,
							ocrProvider: $settings.onDeviceOCRProvider,
							translationBackend: $settings.onDeviceTranslationBackend,
							overlayMode: $settings.overlayMode
						},
							onProgress: (progress: OnDeviceProgressState) => {
							if (signal.aborted) return;
							const pageParams = { page: pageNum, total: job.total_pages };
							const activity: UserMessage = progress.phase === 'detecting'
								? { code: 'job_activity_on_device_detecting', params: pageParams }
								: progress.phase === 'translating' && progress.total > 0
									? { code: 'job_activity_on_device_box', params: { ...pageParams, box: Math.min(progress.completed + 1, progress.total), boxes: progress.total } }
									: { code: 'job_activity_on_device_finishing', params: pageParams };
							setActivity(job, activity, onProgress);
							}
						});
						throwIfVolumeTranslationCancelled(signal);
					entries = result.pageTranslation.entries;
					const durableEntries = result.pageTranslation.entries;
					overlayData = useOverlay ? result.overlayData : undefined;
					noTextDetected = result.pageTranslation.no_text_detected ?? false;
					promptTokens = 0;
					completionTokens = 0;

					// Build page translation result
					const pageTranslation: VolumePageTranslation = {
						page_index: i,
						entries: durableEntries,
						no_text_detected: noTextDetected || undefined,
						prompt_tokens: promptTokens,
						completion_tokens: completionTokens,
						overlay_data: overlayData
					};

					const existingIdx = job.translations!.findIndex((t) => t.page_index === i);
					if (existingIdx >= 0) {
						job.translations![existingIdx] = pageTranslation;
					} else {
						job.translations!.push(pageTranslation);
					}

					// Update rolling context with on-device results (simple text context)
					if (!job.gallery_mode && job.rolling_context && durableEntries.length > 0) {
						updateRollingContextAfterPage(
							job.rolling_context,
							i,
							durableEntries,
							$settings.mode3RecentPages ?? RECENT_PAGES_WINDOW_FALLBACK
						);

						// On-device: use simple truncation instead of LLM summary consolidation.
						// Keep only the recent_pages window, let oldest pages fall off naturally.
						// No LLM call needed — the rolling context just uses raw recent translations.
						if (shouldConsolidateSummary(i, job.rolling_context)) {
							// Simple truncation: summarize by keeping a text snippet of recent pages
							const recentText = job.rolling_context.recent_pages
								.map((p) => p.entries.map((e) => e.translated_text).join(' '))
								.join(' | ');
							job.rolling_context.summary =
								recentText.length > 2000 ? recentText.slice(-2000) : recentText;
							job.rolling_context.summarized_through_page = i;
						}
					}

					succeeded = true;
					consecutiveFailures = 0;
					clearPageFailure(job, i, 'translation');
					break; // Exit retry loop, proceed to checkpoint
				}

				// ── Off-device pipeline (unchanged) ──
				if (!provider) {
					throw new Error('Off-device translation requires an active provider');
				}

				// Build rolling context string (empty for gallery mode).
				// Truncate to fit within the token budget so low maxContextTokens
				// settings don't cause context-length errors.
				const contextText = job.rolling_context
					? formatRollingContext(truncateRollingContext(job.rolling_context, maxResponseTokens))
					: '';
				const runCanonicalProviderCall = async (
					messages: ChatMessage[],
					canonicalRegions: DetectedTextRegion[],
					blocks: Awaited<ReturnType<typeof extractTextWithPPOCR>>['blocks'],
					activity: UserMessage
				) => {
					setActivity(job, activity, onProgress);
					const callOptions: LLMCallOptions = {
						temperature: $settings.temperature,
						maxTokens: maxResponseTokens,
						onRetry: makeRetryCallback(job, onProgress),
						signal,
						responseFormat: useStructuredOutput ? TRANSLATION_JSON_MODE : undefined
					};
					const initialResponse = await callPageLLM(job, provider, messages, callOptions);
					recordBilledResponse(initialResponse);
					clearRetryMessage(job);
					const authoritativeOriginals = new Map(
						blocks.map((block) => [block.blockIndex, block.text])
					);
					const validateResponse = (response: LLMResponse): void => {
						throwIfVolumeTranslationCancelled(signal);
						if (response.finish_reason === 'length') {
							throw new Error('Translation output was truncated (max tokens reached).');
						}
						detectRefusal(response.content);
					};
					const parsed = await reconcileOverlayTranslation({
						initialResponse,
						regions: canonicalRegions,
						authoritativeOriginals,
						validateResponse,
						onRepairing: () => setActivity(
							job,
							{ code: 'job_activity_repairing_page', params: { page: pageNum, total: job.total_pages } },
							onProgress
						),
						requestRepair: async (missingRequiredIds) => {
							const repairResponse = await callPageLLM(
								job,
								provider,
								buildMissingOverlayRepairMessages(
									blocks,
									missingRequiredIds,
									$settings.sourceLanguage,
									$settings.targetLanguage
								),
								callOptions
							);
							recordBilledResponse(repairResponse);
							return repairResponse;
						}
					});
					const usage = aggregateTranslationUsage(initialResponse, parsed.repairResponse);
					debugLogParse(`Translation page ${pageNum} coverage`, {
						requiredCount: parsed.coverage.requiredCount,
						translatedRequiredCount: parsed.coverage.translatedRequiredCount,
						optionalMissingCount: parsed.coverage.optionalMissingIds.length,
						repaired: Boolean(parsed.repairResponse)
					});
					return { parsed, usage };
				};

				const imageBuffer = await imageFile.arrayBuffer();
				throwIfVolumeTranslationCancelled(signal);
				const imageBlob = new Blob([imageBuffer], {
					type: imageFile.type
				});

				// When overlay pipeline is active with bubble segmentation or
				// text-replacement, merge text detections with bubble masks.
				const useBubbleSeg = useOverlay && $settings.overlayMode !== 'auto-fit';
				let regions: DetectedTextRegion[] = [];
				let detectedBubbles: BubbleRegion[] = [];
				let pageDetection: PPOcrRecognitionDetection | undefined;
				let pageExtraction: Awaited<ReturnType<typeof extractTextWithPPOCR>> | undefined;
				let meaningfulPageBlocks: Awaited<ReturnType<typeof extractTextWithPPOCR>>['blocks'] = [];

				setActivity(job, { code: 'job_activity_detecting_page', params: { page: pageNum, total: job.total_pages } }, onProgress);
				pageDetection = await detectTextRegionsForRecognition(imageBlob, {
					signal,
					deferGrouping: true,
					locale: sourceLocale
				});
				throwIfVolumeTranslationCancelled(signal);
				if (useBubbleSeg && pageDetection.rawRegions.length > 0) {
					try {
						// Same backend the single-page paths use (rtmdet-manga, Apache-2.0).
						// This was a direct bubble-segmenter call until 2026-07-24, which
						// meant whole-volume runs used a different — and weaker — model
						// than "translate this page" did.
						detectedBubbles = (await detectLayout(imageBlob, { signal })).bubbles;
						throwIfVolumeTranslationCancelled(signal);
					} catch (error) {
						throwIfVolumeTranslationCancelled(signal);
						console.warn('Bubble segmentation unavailable; continuing with PP-OCR auto-fit boxes.', error);
					}
				}
				if (detectedBubbles.length >= 2) {
					pageDetection = await resolveTextDetectionFusion(imageBlob, pageDetection, detectedBubbles, {
						signal,
						locale: sourceLocale
					});
					throwIfVolumeTranslationCancelled(signal);
				}
				regions = mergeTextWithBubbles(
					pageDetection.rawRegions,
					detectedBubbles,
					pageDetection.imageWidth,
					pageDetection.imageHeight,
					{ signal, locale: sourceLocale, readingDirection: readingDir }
				);
				throwIfVolumeTranslationCancelled(signal);
				pageDetection = { ...pageDetection, mergedRegions: regions };
				if (!pageDetection) {
					throw new Error('PP-OCR page detection did not produce a reusable result');
				}

				// Provider choice must not alter PP-OCR lineage or semantics. Overlay
				// vision and text-only branches therefore share one recognition/classifier
				// result; only their translation prompt differs.
				if (regions.length > 0) {
					if (!pageDetection) {
						throw new Error('PP-OCR overlay classification requires reusable detection');
					}
					pageExtraction = await extractTextWithPPOCR(imageFile, {
						signal,
						detection: pageDetection,
						bubbles: detectedBubbles,
						locale: sourceLocale,
						readingDirection: readingDir
					});
					throwIfVolumeTranslationCancelled(signal);
					regions = pageExtraction.mergedRegions;
					meaningfulPageBlocks = pageExtraction.blocks.filter((block) =>
						isMeaningfulOcrText(block.text));
					pageDetection = { ...pageDetection, mergedRegions: regions };
				}

				if (regions.length === 0 || meaningfulPageBlocks.length === 0) {
					noTextDetected = true;
					entries = [];
					overlayDraft = useOverlay ? { regions, entries: [] } : undefined;
					promptTokens = 0;
					completionTokens = 0;
				} else if (useOverlay) {
					// ── Overlay pipeline ──
					let overlayMessages: ChatMessage[];

					if (visionMode) {
						// PP-OCR numbered-boxes: annotate image, LLM translates by box ID
						const annotatedBase64 = await annotateImageWithBoxes(
							imageBlob,
							regions,
							1536,
							signal
						);
						throwIfVolumeTranslationCancelled(signal);
						overlayMessages = buildOverlayMessages(
							annotatedBase64,
							$settings.sourceLanguage,
							$settings.targetLanguage,
							contextText || undefined,
							$settings.variableFontSizing ?? false
						);

						const canonical = await runCanonicalProviderCall(
							overlayMessages,
							regions,
							meaningfulPageBlocks,
							{ code: 'job_activity_translating_page_overlay', params: { page: pageNum, total: job.total_pages } }
						);
						entries = canonical.parsed.entries;
						overlayDraft = { regions, entries: canonical.parsed.overlayEntries };
						promptTokens = canonical.usage.usage.prompt_tokens;
						completionTokens = canonical.usage.usage.completion_tokens;
					} else {
						// Text-only: run full OCR for text extraction
						const extraction = pageExtraction ?? await extractTextWithPPOCR(imageFile, {
							signal,
							detection: pageDetection,
							locale: sourceLocale,
							readingDirection: readingDir
						});
						throwIfVolumeTranslationCancelled(signal);
						const ocrBlocks = extraction.blocks.filter((block) => isMeaningfulOcrText(block.text));
						// Recognition enriches the shared groups with image/text-backed
						// free-layout semantics. Keep those exact groups authoritative
						// through parsing and durable V2 persistence.
						regions = extraction.mergedRegions;
						if (ocrBlocks.length === 0) {
							throwIfVolumeTranslationCancelled(signal);
							noTextDetected = true;
							entries = [];
							overlayDraft = { regions: [], entries: [] };
							promptTokens = 0;
							completionTokens = 0;
							await finalizeOverlayDraft();

							const pageTranslation: VolumePageTranslation = {
								page_index: i,
								entries: [],
								no_text_detected: true,
								prompt_tokens: 0,
								completion_tokens: 0,
								overlay_data: overlayData
							};
							const existingIdx = job.translations!.findIndex((t) => t.page_index === i);
							if (existingIdx >= 0) {
								job.translations![existingIdx] = pageTranslation;
							} else {
								job.translations!.push(pageTranslation);
							}
							succeeded = true;
							consecutiveFailures = 0;
							break;
						}
						overlayMessages = buildTextOnlyOverlayMessages(
							ocrBlocks,
							regions,
							$settings.sourceLanguage,
							$settings.targetLanguage,
							contextText || undefined
						);

						const canonical = await runCanonicalProviderCall(
							overlayMessages,
							regions,
							ocrBlocks,
							{ code: 'job_activity_translating_page_overlay', params: { page: pageNum, total: job.total_pages } }
						);
						entries = canonical.parsed.entries;
						overlayDraft = { regions, entries: canonical.parsed.overlayEntries };
						promptTokens = canonical.usage.usage.prompt_tokens;
						completionTokens = canonical.usage.usage.completion_tokens;
					}
				} else {
					// ── Sidebar-only pipeline ──
					// It still uses canonical PP-OCR box IDs so provider completeness
					// cannot differ merely because overlay rendering is disabled.
					let stdMessages: ChatMessage[];
					if (visionMode) {
						const annotatedBase64 = await annotateImageWithBoxes(
							imageBlob,
							regions,
							1536,
							signal
						);
						throwIfVolumeTranslationCancelled(signal);
						stdMessages = buildOverlayMessages(
							annotatedBase64,
							$settings.sourceLanguage,
							$settings.targetLanguage,
							contextText || undefined
						);
					} else {
						stdMessages = buildTextOnlyOverlayMessages(
							meaningfulPageBlocks,
							regions,
							$settings.sourceLanguage,
							$settings.targetLanguage,
							contextText || undefined
						);
					}
					const canonical = await runCanonicalProviderCall(
						stdMessages,
						regions,
						meaningfulPageBlocks,
						{ code: 'job_activity_translating_page', params: { page: pageNum, total: job.total_pages } }
					);
					entries = canonical.parsed.entries;
					promptTokens = canonical.usage.usage.prompt_tokens;
					completionTokens = canonical.usage.usage.completion_tokens;
				}

				throwIfVolumeTranslationCancelled(signal);
				await finalizeOverlayDraft();
				const durableEntries = ensureStableTranslationEntries(entries, [job.volume_uuid, i]);
				// Detect if the parse fell back to a single "unknown" blob
				// (entire LLM response stuffed into translated_text of one entry)
				isCorruptedFallback =
					!noTextDetected &&
					entries.length === 1 &&
					entries[0].type === 'unknown' &&
					entries[0].original_text === '';

				if (isCorruptedFallback) {
					debugLogError(
						`Translation page ${pageNum}`,
						new Error('Response parsed as single unknown blob — likely malformed JSON from LLM'),
						'will attempt to recover in review pass'
					);
				} else {
					debugLogParse(`Translation page ${pageNum}`, {
						entryCount: entries.length,
						entries
					});
				}

				const pageTranslation: VolumePageTranslation = {
					page_index: i,
					entries: durableEntries,
					no_text_detected: noTextDetected || undefined,
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					overlay_data: overlayData
				};

				// Store/replace translation
				const existingIdx = job.translations.findIndex((t) => t.page_index === i);
				if (existingIdx >= 0) {
					job.translations[existingIdx] = pageTranslation;
				} else {
					job.translations.push(pageTranslation);
				}

				job.total_prompt_tokens += promptTokens;
				job.total_completion_tokens += completionTokens;

				// Update rolling context (skip for gallery mode AND corrupted fallback)
				// Corrupted fallback entries contain a raw JSON blob as translated_text
				// which would pollute the context for subsequent pages.
				if (
					!job.gallery_mode &&
					job.rolling_context &&
					!isCorruptedFallback &&
					durableEntries.length > 0
				) {
					updateRollingContextAfterPage(
						job.rolling_context,
						i,
						durableEntries,
						$settings.mode3RecentPages ?? RECENT_PAGES_WINDOW_FALLBACK
					);

					// Periodic summary consolidation (every SUMMARY_INTERVAL pages).
					// Only use LLM consolidation if the token budget supports it.
					// Below the threshold, use simple text truncation instead.
						if (shouldConsolidateSummary(i, job.rolling_context)) {
							if (maxResponseTokens >= MIN_TOKENS_FOR_LLM_CONSOLIDATION) {
								setActivity(job, { code: 'job_activity_consolidating', params: { page: pageNum } }, onProgress);
								await consolidateSummary(job, $settings, signal, provider);
								throwIfVolumeTranslationCancelled(signal);
						} else {
							// Simple truncation for low token budgets
							const recentText = job.rolling_context.recent_pages
								.map((p) => p.entries.map((e) => e.translated_text).join(' '))
								.join(' | ');
							job.rolling_context.summary =
								recentText.length > 1000 ? recentText.slice(-1000) : recentText;
							job.rolling_context.summarized_through_page = i;
						}
					}
				}

				succeeded = true;
				consecutiveFailures = 0;
			} catch (err) {
				// If the signal was aborted (user cancelled), re-throw immediately
				// instead of burning through remaining retry attempts.
				if (signal.aborted) {
					restoreUncommittedPageState();
					retainBilledUsage();
					throwIfVolumeTranslationCancelled(signal);
				}
				restoreUncommittedPageState();
				retainBilledUsage();

				debugLogError(`Translation page ${pageNum}`, err, `attempt ${attempt + 1} failed`);
				const category = classifyFailure(err);
				const msg = err instanceof Error ? err.message : 'Translation failed';
				recordPageFailure(job, i, 'translation', err, attempt + 1);
				const disposition = disposeOfPageFailure(category, attempt + 1, retryBudget);

				// A key, a rejected request shape or an empty balance fails every
				// remaining page identically — stop instead of spending the budget.
				if (disposition === 'abort') {
					if (err instanceof PageLLMError) throw err.originalError;
					throw err;
				}

				if (disposition === 'retry') {
					const delay = pageRetryDelayMs(attempt + 1, {
						retryAfterMs: retryAfterMsOf(err instanceof PageLLMError ? err.originalError : err),
						budget: retryBudget
					});
					console.warn(
						`Translation page ${pageNum} attempt ${attempt + 1} failed (${category}); retrying in ${Math.round(delay / 1000)}s:`,
						msg
					);
					setActivity(
						job,
						{ code: 'job_activity_retrying_page', params: { page: pageNum, total: job.total_pages, seconds: Math.max(1, Math.round(delay / 1000)), category: category.replace('_', ' ') } },
						onProgress
					);
					await delayWithSignal(delay, signal);
					throwIfVolumeTranslationCancelled(signal);
					continue;
				}

				skipped++;
				if (category !== 'content_filter') consecutiveFailures++;
				console.error(`Translation failed for page ${pageNum}:`, msg);

				if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
					throw new Error(
						`Aborting: ${consecutiveFailures} consecutive pages failed in translation pass. Last error: ${msg}`
					);
				}
			}
		}

		if (succeeded) clearPageFailure(job, i, 'translation');

		// Atomically persist the page payload before advancing durable progress.
		// A crash can re-run a page, but can never checkpoint past a missing result.
		throwIfVolumeTranslationCancelled(signal);
		const checkpointAt = new Date().toISOString();
		const checkpointDiagnostics = job.diagnostics
			? { ...job.diagnostics, last_checkpoint_at: checkpointAt }
			: undefined;
		const checkpointJob: VolumeTranslationJob = {
			...job,
			current_page: Math.max(job.current_page, i - offset + 1),
			activity: undefined,
			updated_at: checkpointAt,
			diagnostics: checkpointDiagnostics
		};
		const pageTrans = job.translations.find((t) => t.page_index === i);
		try {
			await persistCheckpoint(
				checkpointJob,
				succeeded && pageTrans ? [pageTrans] : [],
				signal
			);
		} catch (error) {
			if (signal.aborted) restoreUncommittedPageState();
			throw error;
		}
		job.current_page = checkpointJob.current_page;
		job.activity = checkpointJob.activity;
		job.updated_at = checkpointJob.updated_at;
		job.diagnostics = checkpointJob.diagnostics;
		// Per-page timing (always logged for diagnostics)
		const pageElapsedMs = Math.round(performance.now() - pageStartTime);
		const entryCount = pageTrans?.entries.length ?? 0;
		const noText = pageTrans?.no_text_detected ? ' [no-text]' : '';
		const tokens = pageTrans
			? `${pageTrans.prompt_tokens ?? 0}+${pageTrans.completion_tokens ?? 0}tok`
			: '0tok';
		const status = succeeded ? 'OK' : 'SKIP';
		console.warn(
			`[volume-translation] Page ${pageNum}/${job.total_pages} ${status} ${pageElapsedMs}ms ${entryCount}entries ${tokens}${noText}`
		);

		updateJob(job);
	}

	if (skipped > 0) {
		appendJobWarning(job, { code: 'job_warning_translation_skipped', params: { skipped, total: job.total_pages } });
	}
}

// ============================================================
// Rolling Context Helpers
// ============================================================

/** Format the rolling context into a string for the translation prompt */
function formatRollingContext(ctx: RollingContext): string {
	const parts: string[] = [];

	if (ctx.summary) {
		parts.push(`Story so far (through page ${ctx.summarized_through_page + 1}):\n${ctx.summary}`);
	}

	if (ctx.characters.length > 0) {
		const charList = ctx.characters.map((c) => `- ${c.name}: ${c.description}`).join('\n');
		parts.push(`Known characters:\n${charList}`);
	}

	if (ctx.recent_pages.length > 0) {
		const recentText = ctx.recent_pages
			.map((p) => {
				const entriesText = p.entries
					.map(
						(e) =>
							`  [${e.type ?? 'unknown'}]${e.speaker ? ` (${e.speaker})` : ''}: "${e.original_text}" → "${e.translated_text}"`
					)
					.join('\n');
				return `Page ${p.page_index + 1}:\n${entriesText}`;
			})
			.join('\n');
		parts.push(`Recent pages' translations:\n${recentText}`);
	}

	return parts.join('\n\n');
}

/** Rough token estimate: ~4 chars per token (conservative for mixed JP/EN). */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Truncate rolling context to fit within a fraction of the response token budget.
 * Removes oldest recent pages first, then truncates the summary if still over budget.
 * Returns a shallow copy — the original context is not mutated.
 */
function truncateRollingContext(ctx: RollingContext, maxResponseTokens: number): RollingContext {
	const budget = Math.floor(maxResponseTokens * CONTEXT_BUDGET_FRACTION);
	if (budget <= 0) return { ...ctx, summary: '', recent_pages: [], characters: [] };

	const truncated: RollingContext = {
		...ctx,
		recent_pages: [...ctx.recent_pages],
		characters: [...ctx.characters]
	};

	let tokens = estimateTokens(formatRollingContext(truncated));

	// Drop oldest recent pages until within budget (keep at least 1 if possible)
	while (tokens > budget && truncated.recent_pages.length > 1) {
		truncated.recent_pages.shift();
		tokens = estimateTokens(formatRollingContext(truncated));
	}

	// If still over budget, truncate summary from the beginning
	if (tokens > budget && truncated.summary) {
		// Estimate how much room we have for the summary
		const withoutSummary = { ...truncated, summary: '' };
		const nonSummaryTokens = estimateTokens(formatRollingContext(withoutSummary));
		const summaryBudgetChars = Math.max(200, (budget - nonSummaryTokens) * 4);
		if (truncated.summary.length > summaryBudgetChars) {
			truncated.summary = '...' + truncated.summary.slice(-summaryBudgetChars);
		}
	}

	return truncated;
}

/** Update rolling context after a page is translated */
function updateRollingContextAfterPage(
	ctx: RollingContext,
	pageIndex: number,
	entries: PageTranslationEntry[],
	recentPagesWindow: number
): void {
	// Add to recent pages
	ctx.recent_pages.push({ page_index: pageIndex, entries });

	// Keep only the last N pages
	while (ctx.recent_pages.length > Math.max(1, recentPagesWindow)) {
		ctx.recent_pages.shift();
	}
}

/** Determine if we should run a summary consolidation */
function shouldConsolidateSummary(pageIndex: number, ctx: RollingContext): boolean {
	const pagesSinceSummary = pageIndex - ctx.summarized_through_page;
	return pagesSinceSummary >= SUMMARY_INTERVAL;
}

/** Run the LLM summary consolidation call */
async function consolidateSummary(
	job: VolumeTranslationJob,
	$settings: FumetoSettings,
	signal: AbortSignal,
	provider: ResolvedLLMProvider
): Promise<void> {
	throwIfVolumeTranslationCancelled(signal);
	if (!job.rolling_context || !job.translations) return;

	// Gather translations for pages since the last summary
	const startPage = job.rolling_context.summarized_through_page + 1;
	const endPage = job.current_page + 1; // include current page
	const pagesToSummarize = job.translations
		.filter((t) => t.page_index >= startPage && t.page_index < endPage)
		.sort((a, b) => a.page_index - b.page_index);

	if (pagesToSummarize.length === 0) return;

	const recentPagesText = pagesToSummarize
		.map((p) => {
			const text = p.entries
				.map((e) => `${e.speaker ? `${e.speaker}: ` : ''}${e.translated_text}`)
				.join('\n');
			return `[Page ${p.page_index + 1}]:\n${text}`;
		})
		.join('\n\n');

	try {
		const messages = buildSummaryConsolidationMessages(
			job.rolling_context.summary,
			recentPagesText,
			job.rolling_context.summarized_through_page,
			endPage - 1
		);

		const response = await callLLMWithProvider(provider, messages, {
			temperature: $settings.temperature,
			maxTokens: 2048,
			signal
		});
		throwIfVolumeTranslationCancelled(signal);
		const parsed = parseFirstJsonObject(response.content);
		throwIfVolumeTranslationCancelled(signal);
		if (parsed) {
			debugLogParse(`SummaryConsolidation (pages ${startPage + 1}-${endPage})`, parsed);

			if (parsed.summary) {
				job.rolling_context.summary = String(parsed.summary);
				job.rolling_context.summarized_through_page = endPage - 1;
			}
			if (Array.isArray(parsed.characters)) {
				job.rolling_context.characters = parsed.characters.map((c: Record<string, unknown>) => ({
					name: String(c.name ?? ''),
					description: String(c.description ?? ''),
					first_appearance: typeof c.first_appearance === 'number' ? c.first_appearance : 0
				}));
			}
		}

		job.total_prompt_tokens += response.usage.prompt_tokens;
		job.total_completion_tokens += response.usage.completion_tokens;
	} catch (err) {
		throwIfVolumeTranslationCancelled(signal);
		// Non-fatal: continue without updated summary
		console.error('Failed to consolidate summary:', err);
	}
}

// ============================================================
// Pass 2: Review + Character Attribution
// ============================================================

async function runReviewPass(
	job: VolumeTranslationJob,
	pageSource: PageSource,
	$settings: FumetoSettings,
	signal: AbortSignal,
	maxResponseTokens: number,
	visionMode: boolean,
	provider: ResolvedLLMProvider,
	onProgress?: (job: VolumeTranslationJob) => void
): Promise<void> {
	if (!job.reviews) job.reviews = [];
	if (!job.translations) {
		throw new Error('Cannot run review without translations.');
	}

	const characterContext =
		job.rolling_context?.characters.map((c) => `- ${c.name}: ${c.description}`).join('\n') || '';
	const plotContext = job.rolling_context?.summary || '';

	const offset = job.start_page_offset ?? 0;
	let reviewFailures = 0;
	let consecutiveFailures = 0;
	// The review pass used to allow exactly one attempt and rethrow every
	// provider error, so a single 429 or 5xx anywhere in a long review ended the
	// whole job — while the translation pass rode out the identical failure. Both
	// passes now spend the same classified budget.
	const reviewRetryBudget = pageRetryBudget();
	const localProvider =
		provider.config.type === 'ollama' ||
		provider.config.type === 'lmstudio' ||
		provider.config.type === 'local-compatible';
	const reviewConcurrency = localProvider
		? Math.max(1, Math.min(8, $settings.localProviderConcurrency ?? 1))
		: 1;

	/**
	 * Process a single page review. Returns result for the caller to merge.
	 */
	async function reviewPage(i: number): Promise<{ succeeded: boolean; pageIndex: number }> {
		throwIfVolumeTranslationCancelled(signal);
		const pageNum = i - offset + 1;
		const pageTranslation = job.translations!.find((t) => t.page_index === i);
		if (!pageTranslation || pageTranslation.entries.length === 0) {
			return { succeeded: true, pageIndex: i }; // skip — no translations
		}

		const reviewPageStartTime = performance.now();
		let succeeded = false;

		for (let attempt = 0; attempt < reviewRetryBudget.maxAttempts && !succeeded; attempt++) {
			try {
				const imageFile = await pageSource.getPageAsFile(i, { signal });
				throwIfVolumeTranslationCancelled(signal);

				let reviewMessages: ChatMessage[];
				if (visionMode) {
					const imageBase64 = await fileToBase64(imageFile, 1536, signal);
					throwIfVolumeTranslationCancelled(signal);
					reviewMessages = buildReviewMessages(
						imageBase64,
						i,
						pageTranslation,
						characterContext,
						plotContext,
						$settings.sourceLanguage,
						$settings.targetLanguage
					);
				} else {
					const { blocks: ocrBlocks } = await extractTextWithPPOCR(imageFile, { signal });
					throwIfVolumeTranslationCancelled(signal);
					reviewMessages = buildTextOnlyReviewMessages(
						ocrBlocks,
						i,
						pageTranslation,
						characterContext,
						plotContext,
						$settings.sourceLanguage,
						$settings.targetLanguage
					);
				}

				const response = await callPageLLM(job, provider, reviewMessages, {
					temperature: $settings.temperature,
					maxTokens: maxResponseTokens,
					signal,
					responseFormat: providerSupportsStructuredOutput(provider.config.type)
						? TRANSLATION_JSON_MODE
						: undefined
				});
				throwIfVolumeTranslationCancelled(signal);
				if (response.finish_reason === 'length') {
					throw new Error('Review output was truncated (max tokens reached).');
				}

				const content = response.content;
				detectRefusal(content);

				const review = parseReviewResponse(content, i, pageTranslation.entries);
				if (!review) {
					throw new Error('The translation provider returned malformed review JSON.');
				}
				throwIfVolumeTranslationCancelled(signal);
				debugLogParse(`Review page ${pageNum}`, review);
				job.reviews!.push(review);

				if (review.revised_entries && review.revised_entries.length > 0) {
					const validEntries = review.revised_entries.filter(
						(e) => e.translated_text.trim().length > 0 || e.original_text.trim().length > 0
					);
					if (validEntries.length >= pageTranslation.entries.length) {
						applyReviewRevisions(pageTranslation, validEntries);
					}
				}

				job.total_prompt_tokens += response.usage.prompt_tokens;
				job.total_completion_tokens += response.usage.completion_tokens;

				succeeded = true;
				clearPageFailure(job, i, 'review');
			} catch (err) {
				throwIfVolumeTranslationCancelled(signal);

				const category = classifyFailure(err);
				const msg = err instanceof Error ? err.message : 'Review failed';
				recordPageFailure(job, i, 'review', err, attempt + 1);
				const disposition = disposeOfPageFailure(category, attempt + 1, reviewRetryBudget);

				// A key, a rejected request shape or an empty balance fails every
				// remaining page identically — stop instead of spending the budget.
				if (disposition === 'abort') {
					if (err instanceof PageLLMError) throw err.originalError;
					throw err;
				}

				if (disposition === 'retry') {
					const delay = pageRetryDelayMs(attempt + 1, {
						retryAfterMs: retryAfterMsOf(err instanceof PageLLMError ? err.originalError : err),
						budget: reviewRetryBudget
					});
					debugLogError(`Review page ${pageNum}`, err, `attempt ${attempt + 1} failed`);
					console.warn(
						`Review page ${pageNum} attempt ${attempt + 1} failed (${category}); retrying in ${Math.round(delay / 1000)}s:`,
						msg
					);
					await delayWithSignal(delay, signal);
					throwIfVolumeTranslationCancelled(signal);
					continue;
				}

				debugLogError(`Review page ${pageNum}`, err, 'review failed; skipping the page');
				// Pushed only on the terminal skip. Pushing per attempt would leave
				// one advisory per retry beside the real review for a page that
				// later succeeded.
				job.reviews!.push({
					page_index: i,
					issues: [
						{
							type: 'consistency',
							severity: 'error',
							description: `Review not completed: ${msg}`
						}
					]
				});
				console.error(`Review failed for page ${pageNum}:`, msg);
			}
		}

		const reviewElapsedMs = Math.round(performance.now() - reviewPageStartTime);
		console.warn(
			`[volume-translation] Review ${pageNum}/${job.total_pages} ${succeeded ? 'OK' : 'SKIP'} ${reviewElapsedMs}ms`
		);

		return { succeeded, pageIndex: i };
	}

	// Process reviews in batches (pages are independent — safe to parallelize)
	const startPage = job.current_page + offset;
	const endPage = offset + job.total_pages;

	for (let batchStart = startPage; batchStart < endPage; batchStart += reviewConcurrency) {
		throwIfVolumeTranslationCancelled(signal);

		const batchEnd = Math.min(batchStart + reviewConcurrency, endPage);
		const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);
		const reviewsLengthBeforeBatch = job.reviews.length;
		const translationsBeforeBatch = batchIndices.map((pageIndex) => {
			const translation = job.translations!.find((page) => page.page_index === pageIndex);
			return {
				pageIndex,
				translation: translation ? structuredClone(translation) : undefined
			};
		});
		const promptTokensBeforeBatch = job.total_prompt_tokens;
		const completionTokensBeforeBatch = job.total_completion_tokens;
		const currentPageBeforeBatch = job.current_page;
		const restoreUncommittedBatchState = () => {
			job.reviews!.splice(reviewsLengthBeforeBatch);
			for (const snapshot of translationsBeforeBatch) {
				const currentIndex = job.translations!.findIndex(
					(page) => page.page_index === snapshot.pageIndex
				);
				if (snapshot.translation) {
					if (currentIndex >= 0) job.translations![currentIndex] = snapshot.translation;
					else job.translations!.push(snapshot.translation);
				} else if (currentIndex >= 0) {
					job.translations!.splice(currentIndex, 1);
				}
			}
			job.total_prompt_tokens = promptTokensBeforeBatch;
			job.total_completion_tokens = completionTokensBeforeBatch;
			job.current_page = currentPageBeforeBatch;
		};

		setActivity(
			job,
			{ code: 'job_activity_reviewing_pages', params: { from: batchStart - offset + 1, to: batchEnd - offset, total: job.total_pages } },
			onProgress
		);

		const results =
			reviewConcurrency > 1
				? await Promise.allSettled(batchIndices.map((i) => reviewPage(i)))
				: await Promise.allSettled(
						[reviewPage(batchIndices[0])].concat(batchIndices.slice(1).map((i) => reviewPage(i)))
					);
		if (signal.aborted) {
			restoreUncommittedBatchState();
			throwIfVolumeTranslationCancelled(signal);
		}

		// Process results in page order
		for (const result of results) {
			if (result.status === 'rejected') {
				// If abort, re-throw
				if (signal.aborted) {
					restoreUncommittedBatchState();
					throwIfVolumeTranslationCancelled(signal);
				}

				// reviewPage rejects only for systemic provider failures after the
				// centralized retry budget is exhausted.
				throw result.reason;
			} else {
				if (result.value.succeeded) {
					consecutiveFailures = 0;
				} else {
					reviewFailures++;
					const isContentFilter =
						job.failed_pages?.some(
							(failure) =>
								failure.phase === 'review' &&
								failure.page_index === result.value.pageIndex &&
								failure.category === 'content_filter'
						) ?? false;
					if (!isContentFilter) consecutiveFailures++;
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						throw new Error(
							`Aborting: ${consecutiveFailures} consecutive pages failed in review pass.`
						);
					}
				}
			}
		}

		// Checkpoint after each batch
		const lastPageInBatch = batchIndices[batchIndices.length - 1];
		throwIfVolumeTranslationCancelled(signal);
		const checkpointJob: VolumeTranslationJob = {
			...job,
			current_page: lastPageInBatch - offset + 1,
			activity: undefined,
			updated_at: new Date().toISOString()
		};
		const reviewedPages = results
			.filter((result): result is PromiseFulfilledResult<{ succeeded: boolean; pageIndex: number }> =>
				result.status === 'fulfilled' && result.value.succeeded
			)
			.map((result) => job.translations!.find((page) => page.page_index === result.value.pageIndex))
			.filter((page): page is VolumePageTranslation => !!page);
		try {
			await persistCheckpoint(checkpointJob, reviewedPages, signal);
		} catch (error) {
			if (signal.aborted) restoreUncommittedBatchState();
			throw error;
		}
		job.current_page = checkpointJob.current_page;
		job.activity = checkpointJob.activity;
		job.updated_at = checkpointJob.updated_at;
		updateJob(job);
	}

	// Note if some reviews failed
	if (reviewFailures > 0) {
		appendJobWarning(job, { code: 'job_warning_review_failed', params: { failed: reviewFailures, total: job.total_pages } });
	}
}

// ============================================================
// Response Parsing
// ============================================================

function parseReviewResponse(
	content: string,
	pageIndex: number,
	originalEntries: PageTranslationEntry[] = []
): PageReview | null {
	const parsed = parseFirstJsonObject(content);
	if (parsed) {
		const issues = Array.isArray(parsed.issues)
			? parsed.issues.map((issue: Record<string, unknown>) => ({
					type: validateIssueType(issue.type),
					severity: validateIssueSeverity(issue.severity),
					description: String(issue.description ?? ''),
					entry_order: typeof issue.entry_order === 'number' ? issue.entry_order : undefined,
					suggested_fix: issue.suggested_fix ? String(issue.suggested_fix) : undefined
				}))
			: [];

		let revised_entries: PageTranslationEntry[] | undefined;
		if (Array.isArray(parsed.revised_entries) && parsed.revised_entries.length > 0) {
			revised_entries = parsed.revised_entries.map(
				(e: Record<string, unknown>, idx: number): PageTranslationEntry => {
					const order =
						typeof e.order === 'number'
							? e.order
							: typeof e.index === 'number'
								? e.index
								: typeof e.entry_order === 'number'
									? e.entry_order
									: idx;
					const original =
						originalEntries.find((entry) => entry.order === order) ?? originalEntries[idx];
					return {
						order,
						original_text: String(
							e.original_text ??
								e.japanese ??
								e.jp_text ??
								e.original ??
								original?.original_text ??
								''
						),
						translated_text: String(
							e.translated_text ??
								e.translation ??
								e.english ??
								e.text ??
								original?.translated_text ??
								''
						),
						type:
							e.type !== undefined || e.panel_type !== undefined
								? validateEntryType(e.type ?? e.panel_type)
								: (original?.type ?? 'unknown'),
						speaker: e.speaker ? String(e.speaker) : original?.speaker,
						id: original?.id,
						overlayItemId: original?.overlayItemId
					};
				}
			);
		}

		return { page_index: pageIndex, issues, revised_entries };
	}

	return null;
}

function validateIssueType(type: unknown): PageReview['issues'][number]['type'] {
	const valid = [
		'attribution',
		'bubble_assignment',
		'colloquial',
		'hallucination',
		'missing',
		'consistency'
	] as const;
	if (typeof type === 'string' && valid.includes(type as (typeof valid)[number])) {
		return type as PageReview['issues'][number]['type'];
	}
	return 'consistency';
}

function validateIssueSeverity(severity: unknown): PageReview['issues'][number]['severity'] {
	const valid = ['info', 'warning', 'error'] as const;
	if (typeof severity === 'string' && valid.includes(severity as (typeof valid)[number])) {
		return severity as PageReview['issues'][number]['severity'];
	}
	return 'info';
}

function validateEntryType(type: unknown): 'speech' | 'narration' | 'sign' | 'sfx' | 'thought' | 'unknown' {
	const valid = ['speech', 'narration', 'sign', 'sfx', 'thought'];
	if (typeof type === 'string' && valid.includes(type)) {
		return type as 'speech' | 'narration' | 'sign' | 'sfx' | 'thought';
	}
	return 'unknown';
}

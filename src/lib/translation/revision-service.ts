/**
 * Revision service — revise existing translations with user instructions.
 *
 * Three scopes:
 * - Box:    Revise a single entry on a page
 * - Page:   Revise all entries on a page
 * - Volume: Revise all translated pages in a volume (with progress tracking)
 *
 * All revisions are non-destructive: they create new PageTranslation records,
 * preserving the originals (loadPageData picks the most recent by created_at).
 */

import { describeError, renderUserMessage, type UserMessage } from '$lib/i18n/user-messages.js';
import { withUserMessage } from '$lib/i18n/errors.js';
import { get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { db } from '$lib/db/index.js';
import { settings } from '$lib/settings/settings.js';
import {
	callLLMWithProvider,
	resolveActiveProvider,
	isProviderVisionMode
} from './llm-client.js';
import { fileToBase64, detectRefusal } from './full-page-service.js';
import { parseFullPageResponse } from './full-page-prompt.js';
import { LLMProviderError } from './llm-types.js';
import {
	buildBoxRevisionMessages,
	parseBoxRevisionResponse,
	buildPageRevisionMessages,
	buildVolumePageRevisionMessages
} from './revision-prompts.js';
import { extractTextWithPPOCR } from './ppocr-text-extractor.js';
import {
	buildTextOnlyBoxRevisionMessages,
	buildTextOnlyPageRevisionMessages,
	buildTextOnlyVolumePageRevisionMessages
} from './text-only-prompts.js';
import { debugLogParse, debugLogError } from './debug-log.js';
import { updateJob } from '$lib/stores/volume-translation-state.js';
import {
	startBackgroundTranslation,
	stopBackgroundTranslation
} from '$lib/translation/background-service-bridge.js';
import { registerVolumeCancelHandle } from '$lib/translation/volume-translation-service.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import { RemotePageSource } from '$lib/reader/remote-page-source.js';
import { PrefetchedPageSource } from '$lib/reader/prefetched-page-source.js';
import type {
	PageTranslation,
	PageTranslationEntry,
	PageOverlayData,
	VolumeTranslationJob
} from '$lib/types/index.js';
import type { PageSource } from '$lib/reader/page-source.js';
import { ensureStableTranslationEntries, pageOverlayRepository } from '$lib/overlay-layout/index.js';

// ============================================================
// Constants
// ============================================================

/** Per-page preprocessing attempts for volume revision. Provider transport owns its retry budget. */
const PAGE_MAX_ATTEMPTS = 4;

/** Delay between per-page retry attempts (ms) */
const PAGE_RETRY_DELAY = 5000;

/** Max consecutive failures before aborting volume revision */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Sleep that rejects immediately if the abort signal fires. */
async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new Error('Revision cancelled');
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Revision cancelled'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function throwIfRevisionCancelled(signal: AbortSignal): void {
	if (signal.aborted) throw new Error('Revision cancelled');
}

function isNonRetryablePageError(err: unknown): boolean {
	return err instanceof LLMProviderError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

// ============================================================
// Volume revision abort controllers (separate from volume-translation-service)
// ============================================================

const revisionAbortControllers = new Map<string, AbortController>();

/** Check whether a revision job is actively running (has an AbortController). */
export function isRevisionActive(volumeUuid: string): boolean {
	return revisionAbortControllers.has(volumeUuid);
}

// ============================================================
// Helpers
// ============================================================

/** Load the most recent PageTranslation for a given page. */
async function loadLatestPageTranslation(
	volumeUuid: string,
	pageIndex: number
): Promise<PageTranslation | null> {
	const read = await pageOverlayRepository.load(volumeUuid, pageIndex);
	if (read.status === 'future') throw new Error(`Overlay schema ${read.schemaVersion} requires a newer app`);
	if (read.status === 'malformed') throw new Error(read.reason);
	return read.pageTranslation;
}

/**
 * Carry forward the durable V2 overlay document while preserving stable entry/item
 * links. Text lives in PageTranslationEntry; a revision only invalidates the plan.
 */
function mergeOverlayData(
	originalOverlay: PageOverlayData | undefined,
	originalEntries: PageTranslationEntry[],
	revisedEntries: PageTranslationEntry[]
): PageOverlayData | undefined {
	if (!originalOverlay) return undefined;

	const originalByOrder = new Map(originalEntries.map((entry) => [entry.order, entry]));
	for (const entry of revisedEntries) {
		const original = originalByOrder.get(entry.order);
		entry.id = entry.id ?? original?.id;
		entry.overlayItemId = entry.overlayItemId ?? original?.overlayItemId;
		entry.boxId = undefined;
	}
	const next = structuredClone(originalOverlay);
	next.documentRevision += 1;
	delete next.cachedPlan;
	return next;
}

/** Update job activity text and push to store. */
function setActivity(
	job: VolumeTranslationJob,
	activity: UserMessage,
	onProgress?: (job: VolumeTranslationJob) => void
): void {
	job.activity_message = activity;
	job.activity = renderUserMessage(activity, { locale: 'en' });
	job.updated_at = new Date().toISOString();
	updateJob(job);
	onProgress?.(job);
}

// ============================================================
// Box Revision (single entry)
// ============================================================

/**
 * Revise a single translation entry on a page.
 *
 * Creates a new PageTranslation record with the revised entry spliced in.
 * Updates overlay data if present.
 */
export async function reviseBox(
	volumeUuid: string,
	pageIndex: number,
	entryOrder: number,
	instructions: string,
	imageFile: File
): Promise<PageTranslation> {
	const $settings = get(settings);

	// 1. Load latest translation for this page
	const latest = await loadLatestPageTranslation(volumeUuid, pageIndex);
	if (!latest || latest.entries.length === 0) {
		throw new Error('No existing translation found for this page.');
	}

	// 2. Resolve pipeline and build messages
	const resolvedProvider = await resolveActiveProvider();
	const provider = { ...resolvedProvider, config: { ...resolvedProvider.config } };
	const { config: providerConfig } = provider;
	const visionMode = isProviderVisionMode(providerConfig);

	let messages;
	if (visionMode) {
		const imageBase64 = await fileToBase64(imageFile);
		messages = buildBoxRevisionMessages(
			imageBase64,
			latest.entries,
			entryOrder,
			instructions,
			$settings.sourceLanguage,
			$settings.targetLanguage
		);
	} else {
		const { blocks } = await extractTextWithPPOCR(imageFile);
		messages = buildTextOnlyBoxRevisionMessages(
			blocks,
			latest.entries,
			entryOrder,
			instructions,
			$settings.sourceLanguage,
			$settings.targetLanguage
		);
	}

	// 3. Call LLM
	const response = await callLLMWithProvider(provider, messages, {
		temperature: $settings.temperature,
		maxTokens: $settings.maxContextTokens ?? 10000
	});
	if (response.finish_reason === 'length') {
		throw new Error('Revision output was truncated (max tokens reached).');
	}

	detectRefusal(response.content);

	// 4. Parse revised entry
	const revisedEntry = parseBoxRevisionResponse(response.content);
	if (!revisedEntry) {
		throw new Error('Failed to parse revision response from LLM.');
	}

	debugLogParse('reviseBox', { entryOrder, revisedEntry });

	// 5. Splice revised entry into the entries array
	const newEntries = latest.entries.map((e) => {
		if (e.order === entryOrder) {
			return {
				...revisedEntry,
				order: entryOrder,
				id: e.id,
				overlayItemId: e.overlayItemId,
				boxId: undefined
			};
		}
		return { ...e };
	});

	// 6. Update overlay data if present
	let overlayData = latest.overlay_data;
	if (overlayData) {
		overlayData = mergeOverlayData(overlayData, latest.entries, newEntries);
	}

	// 7. Store new PageTranslation
	const result: PageTranslation = {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		entries: newEntries,
		model: response.model,
		prompt_tokens: response.usage.prompt_tokens,
		completion_tokens: response.usage.completion_tokens,
		created_at: new Date().toISOString(),
		overlay_data: overlayData
	};

	result.entries = ensureStableTranslationEntries(result.entries, [volumeUuid, pageIndex]);
	await pageOverlayRepository.put(result);
	return result;
}

// ============================================================
// Page Revision (all entries)
// ============================================================

/**
 * Revise all translation entries on a page.
 *
 * Creates a new PageTranslation record with revised entries while preserving
 * stable V2 entry/item identity and invalidating the cached plan.
 */
export async function revisePage(
	volumeUuid: string,
	pageIndex: number,
	instructions: string,
	imageFile: File
): Promise<PageTranslation> {
	const $settings = get(settings);

	// 1. Load latest translation for this page
	const latest = await loadLatestPageTranslation(volumeUuid, pageIndex);
	if (!latest || latest.entries.length === 0) {
		throw new Error('No existing translation found for this page.');
	}

	// 2. Resolve pipeline and build messages
	const resolvedProvider = await resolveActiveProvider();
	const provider = { ...resolvedProvider, config: { ...resolvedProvider.config } };
	const { config: providerConfig } = provider;
	const visionMode = isProviderVisionMode(providerConfig);

	let messages;
	if (visionMode) {
		const imageBase64 = await fileToBase64(imageFile);
		messages = buildPageRevisionMessages(
			imageBase64,
			latest.entries,
			instructions,
			$settings.sourceLanguage,
			$settings.targetLanguage
		);
	} else {
		const { blocks } = await extractTextWithPPOCR(imageFile);
		messages = buildTextOnlyPageRevisionMessages(
			blocks,
			latest.entries,
			instructions,
			$settings.sourceLanguage,
			$settings.targetLanguage
		);
	}

	// 3. Call LLM
	const response = await callLLMWithProvider(provider, messages, {
		temperature: $settings.temperature,
		maxTokens: $settings.maxContextTokens ?? 10000
	});
	if (response.finish_reason === 'length') {
		throw new Error('Revision output was truncated (max tokens reached).');
	}

	detectRefusal(response.content);

	// 4. Parse revised entries
	const revisedEntries = parseFullPageResponse(response.content);
	if (revisedEntries.length === 0) {
		throw new Error('Failed to parse revision output from the LLM.');
	}
	debugLogParse('revisePage', { entryCount: revisedEntries.length, revisedEntries });

	// 5. Validate — use revised entries if they have at least as many as original
	//    (prevents partial revision from destroying good translations)
	const effectiveEntries =
		revisedEntries.length >= latest.entries.length ? revisedEntries : latest.entries;

	// 6. Merge stable identity from original entries into revised entries.
	for (let i = 0; i < effectiveEntries.length; i++) {
		const originalEntry = latest.entries.find((e) => e.order === effectiveEntries[i].order);
		effectiveEntries[i].id = originalEntry?.id;
		effectiveEntries[i].overlayItemId = originalEntry?.overlayItemId;
		effectiveEntries[i].boxId = undefined;
	}
	const durableEntries = ensureStableTranslationEntries(effectiveEntries, [volumeUuid, pageIndex]);

	// 7. Update overlay data if present
	const overlayData = mergeOverlayData(latest.overlay_data, latest.entries, durableEntries);

	// 8. Store new PageTranslation
	const result: PageTranslation = {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		entries: durableEntries,
		model: response.model,
		prompt_tokens: response.usage.prompt_tokens,
		completion_tokens: response.usage.completion_tokens,
		created_at: new Date().toISOString(),
		overlay_data: overlayData
	};

	await pageOverlayRepository.put(result);
	return result;
}

// ============================================================
// Volume Revision (all translated pages)
// ============================================================

/** Wrap remote access in a bounded lazy Blob window (warm-burst: see PrefetchedPageSource). */
function boundRemoteSource(pageSource: PageSource): PageSource {
	if (!(pageSource instanceof RemotePageSource)) {
		return pageSource;
	}
	return new PrefetchedPageSource(pageSource, 5, { burstAhead: 3 });
}

/**
 * Revise all translated pages in a volume with user instructions.
 *
 * Only processes pages that have existing translations.
 * Creates a VolumeTranslationJob with status 'revising' for progress tracking.
 * New PageTranslation records are created per page (non-destructive).
 */
export async function reviseVolume(
	volumeUuid: string,
	instructions: string,
	onProgress?: (job: VolumeTranslationJob) => void
): Promise<VolumeTranslationJob> {
	const $settings = get(settings);

	// Load volume
	const volume = await db.volumes.get(volumeUuid);
	if (!volume) throw new Error('Volume not found');

	// Find all pages with existing translations
	// The repository performs the only overlay decode and lazily purges any V1
	// page histories before a revision can observe them.
	const allTranslations = await pageOverlayRepository.listVolume(volumeUuid);
	const latestByPage = new Map(allTranslations.map((translation) => [translation.page_index, translation]));

	const translatedPages = Array.from(latestByPage.keys()).sort((a, b) => a - b);
	if (translatedPages.length === 0) {
		throw new Error('No existing translations found for this volume.');
	}

	// Try to load character/plot context from the original translation job
	const existingJobs = await db.volume_translation_jobs
		.where('volume_uuid')
		.equals(volumeUuid)
		.toArray();

	let characterContext = '';
	let plotContext = '';
	for (const j of existingJobs) {
		if (j.status === 'completed' && j.rolling_context) {
			characterContext =
				j.rolling_context.characters
					?.map((c) => `- ${c.name}: ${c.description}`)
					.join('\n') || '';
			plotContext = j.rolling_context.summary || '';
			break;
		}
	}

	// Resolve model name and pipeline mode
	const resolvedProvider = await resolveActiveProvider();
	const provider = { ...resolvedProvider, config: { ...resolvedProvider.config } };
	const { model: activeModel, config: providerConfig } = provider;
	const visionMode = isProviderVisionMode(providerConfig);

	// Create revision job
	const job: VolumeTranslationJob = {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		status: 'revising',
		current_page: 0,
		total_pages: translatedPages.length,
		total_prompt_tokens: 0,
		total_completion_tokens: 0,
		started_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		model: activeModel,
		revision_instructions: instructions
	};

	await db.volume_translation_jobs.put(job);
	updateJob(job);

	// Set up abort controller
	const controller = new AbortController();
	revisionAbortControllers.set(volumeUuid, controller);
	// A revision now raises a notification, so its Cancel button must reach this
	// run. cancelVolumeWork and cancelActiveTranslation both walk this registry;
	// without registering, pressing Cancel on a revision's own notification
	// would do nothing at all.
	const unregisterCancelHandle = registerVolumeCancelHandle(volumeUuid, controller);

	// Everything from here on must reach the finally that clears the controller.
	// Opening the page source used to sit OUTSIDE this try: a missing local
	// file, an unreachable server or an aborted YACReader lease threw with the
	// map entry still set and the row already written as 'revising'. Nothing
	// then wrote a terminal status, so the card showed "Revising · 0%" forever,
	// the ✕ aborted a controller nobody was listening to, and Revise refused to
	// start again — until the app was restarted.
	let effectivePageSource: PageSource;
	let serviceClaimed = false;
	try {
		const pageSource = await createPageSource(volume, { signal: controller.signal });
		effectivePageSource = boundRemoteSource(pageSource);
		// A revision is a long unattended run exactly like a translation, and had
		// no foreground service at all — so leaving the app froze or killed it.
		serviceClaimed = startBackgroundTranslation(
			volume.title ?? 'Revision',
			translatedPages.length,
			volumeUuid
		);
	} catch (err) {
		unregisterCancelHandle();
		revisionAbortControllers.delete(volumeUuid);
		job.status = controller.signal.aborted ? 'cancelled' : 'failed';
		job.error = controller.signal.aborted ? undefined : err instanceof Error ? err.message : String(err);
		job.error_message = controller.signal.aborted ? undefined : describeError(err);
		job.error_kind = controller.signal.aborted ? 'cancelled' : 'failure';
		job.activity = undefined;
		job.activity_message = undefined;
		job.updated_at = new Date().toISOString();
		await db.volume_translation_jobs.put(job);
		updateJob(job);
		throw err;
	}

	try {
		let skipped = 0;
		let consecutiveFailures = 0;

		for (let idx = 0; idx < translatedPages.length; idx++) {
			throwIfRevisionCancelled(controller.signal);

			const pageIndex = translatedPages[idx];
			const pageNum = idx + 1;
			const latest = latestByPage.get(pageIndex)!;
			let succeeded = false;

			for (let attempt = 0; attempt < PAGE_MAX_ATTEMPTS && !succeeded; attempt++) {
				let providerCallStarted = false;
				try {
					setActivity(job, { code: 'job_activity_revision_loading_page', params: { page: pageNum, total: translatedPages.length } }, onProgress);
					const imageFile = await effectivePageSource.getPageAsFile(pageIndex, {
						signal: controller.signal
					});
					throwIfRevisionCancelled(controller.signal);

					let messages;
					if (visionMode) {
						const imageBase64 = await fileToBase64(imageFile, 1536, controller.signal);
						messages = buildVolumePageRevisionMessages(
							imageBase64,
							latest.entries,
							instructions,
							characterContext,
							plotContext,
							$settings.sourceLanguage,
							$settings.targetLanguage
						);
					} else {
						const { blocks } = await extractTextWithPPOCR(imageFile, {
							signal: controller.signal
						});
						messages = buildTextOnlyVolumePageRevisionMessages(
							blocks,
							latest.entries,
							instructions,
							characterContext,
							plotContext,
							$settings.sourceLanguage,
							$settings.targetLanguage
						);
					}

					setActivity(job, { code: 'job_activity_revision_revising_page', params: { page: pageNum, total: translatedPages.length } }, onProgress);
					providerCallStarted = true;
					const response = await callLLMWithProvider(provider, messages, {
						temperature: $settings.temperature,
						maxTokens: $settings.maxContextTokens ?? 10000,
						signal: controller.signal
					});
					throwIfRevisionCancelled(controller.signal);
					if (response.finish_reason === 'length') {
						throw new Error('Revision output was truncated (max tokens reached).');
					}

					detectRefusal(response.content);

					// Parse revised entries
					const revisedEntries = parseFullPageResponse(response.content);
					if (revisedEntries.length === 0) {
						throw new Error('Failed to parse revision output from the LLM.');
					}
					debugLogParse(`Revision page ${pageNum}`, {
						entryCount: revisedEntries.length,
						revisedEntries
					});

					// Validate — only use if at least as many entries as original
					const effectiveEntries =
						revisedEntries.length >= latest.entries.length
							? revisedEntries
							: latest.entries;

					// Merge stable identity from the original page snapshot.
					for (let i = 0; i < effectiveEntries.length; i++) {
						const orig = latest.entries.find(
							(e) => e.order === effectiveEntries[i].order
						);
						effectiveEntries[i].id = orig?.id;
						effectiveEntries[i].overlayItemId = orig?.overlayItemId;
						effectiveEntries[i].boxId = undefined;
					}
					const durableEntries = ensureStableTranslationEntries(effectiveEntries, [volumeUuid, pageIndex]);

					// Update overlay data
					const overlayData = mergeOverlayData(
						latest.overlay_data,
						latest.entries,
						durableEntries
					);

					// Store new PageTranslation
					const result: PageTranslation = {
						id: randomUUID(),
						volume_uuid: volumeUuid,
						page_index: pageIndex,
						entries: durableEntries,
						model: response.model,
						prompt_tokens: response.usage.prompt_tokens,
						completion_tokens: response.usage.completion_tokens,
						created_at: new Date().toISOString(),
						overlay_data: overlayData
					};

					// A provider/body implementation may settle after abort. Keep the
					// cancellation guard inside the transaction so that a cancellation
					// during the write rolls the new revision back as well.
					throwIfRevisionCancelled(controller.signal);
					await pageOverlayRepository.put(result, controller.signal);
					throwIfRevisionCancelled(controller.signal);

					job.total_prompt_tokens += response.usage.prompt_tokens;
					job.total_completion_tokens += response.usage.completion_tokens;

					succeeded = true;
					consecutiveFailures = 0;
				} catch (err) {
					// If the signal was aborted (user cancelled), re-throw immediately.
					if (controller.signal.aborted) throw err;

					// callLLMWithProvider already owns the bounded transport retry. Once a
					// provider request begins, never multiply it with the page-source retry loop.
					const nonRetryable = providerCallStarted || isNonRetryablePageError(err);
					if (attempt < PAGE_MAX_ATTEMPTS - 1 && !nonRetryable) {
						debugLogError(
							`Revision page ${pageNum} attempt ${attempt + 1}/${PAGE_MAX_ATTEMPTS}`,
							err,
							'retrying'
						);
						await delayWithAbort(PAGE_RETRY_DELAY, controller.signal);
					} else {
						debugLogError(
							`Revision page ${pageNum}`,
							err,
							`revision failed after ${PAGE_MAX_ATTEMPTS} attempts`
						);
						skipped++;
						consecutiveFailures++;
						const msg = err instanceof Error ? err.message : 'Revision failed';
						console.error(
							`Revision failed for page ${pageNum} after ${PAGE_MAX_ATTEMPTS} attempts:`,
							msg
						);

						if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
							throw withUserMessage(
								new Error(`Aborting: ${consecutiveFailures} consecutive pages failed in revision — likely a systemic issue. Last error: ${msg}`),
								{ code: 'job_revision_aborted_consecutive', params: { count: consecutiveFailures, detail: msg } }
							);
						}
					}
				}
			}

			// Checkpoint
			job.current_page = idx + 1;
			job.activity = undefined;
			job.updated_at = new Date().toISOString();
			await db.transaction('rw', db.volume_translation_jobs, async () => {
				throwIfRevisionCancelled(controller.signal);
				await db.volume_translation_jobs.put(job);
				throwIfRevisionCancelled(controller.signal);
			});
			throwIfRevisionCancelled(controller.signal);
			updateJob(job);
		}

		// Complete
		job.status = 'completed';
		job.activity = undefined;
		job.completed_at = new Date().toISOString();
		job.updated_at = new Date().toISOString();

		if (skipped > 0) {
			job.warnings = [...(job.warnings ?? []), { code: 'job_warning_revision_skipped', params: { skipped, total: translatedPages.length } }];
			job.error_message = job.warnings[job.warnings.length - 1];
			job.error_kind = 'warning';
		}

		await db.volume_translation_jobs.put(job);
		updateJob(job);

		return job;
	} catch (err) {
		if (controller.signal.aborted) {
			job.status = 'cancelled';
		} else {
			job.status = 'failed';
			job.error = err instanceof Error ? err.message : String(err);
			job.error_message = describeError(err);
			job.error_kind = 'failure';
		}
		job.activity = undefined;
		job.activity_message = undefined;
		job.updated_at = new Date().toISOString();
		await db.volume_translation_jobs.put(job);
		updateJob(job);
		throw err;
	} finally {
		effectivePageSource.dispose();
		if (serviceClaimed) stopBackgroundTranslation(volumeUuid);
		unregisterCancelHandle();
		revisionAbortControllers.delete(volumeUuid);
	}
}

/**
 * Cancel an in-progress volume revision.
 *
 * If the job is actively running, aborts it.
 * If stale, directly updates the DB record.
 */
export async function cancelVolumeRevision(volumeUuid: string): Promise<void> {
	const controller = revisionAbortControllers.get(volumeUuid);
	if (controller) {
		controller.abort();
		return;
	}

	// No active controller — stale/stuck job
	const jobs = await db.volume_translation_jobs
		.where('volume_uuid')
		.equals(volumeUuid)
		.toArray();

	for (const job of jobs) {
		if (job.status === 'revising') {
			job.status = 'cancelled';
			job.activity = undefined;
			job.updated_at = new Date().toISOString();
			await db.volume_translation_jobs.put(job);
			updateJob(job);
		}
	}
}

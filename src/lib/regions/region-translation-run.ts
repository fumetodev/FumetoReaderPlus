/**
 * One owner for a region translation's lifetime.
 *
 * Region translation was the only translation path in the app with no
 * cancellation at all. Neither the desktop Sidebar handler nor the mobile
 * guided handler created an `AbortController`, and neither registered a
 * `page-translation-activity` token — so:
 *
 * - The Sidebar's Cancel button is rendered from that registry and therefore
 *   was not rendered at all during a region translation. There was nothing to
 *   press.
 * - The mobile bottom bar derives its intent the same way, so tapping Translate
 *   during an in-flight region run read as `start` and launched a CONCURRENT
 *   full-page translation instead.
 * - Turning the page did not stop the work. The result was still written to
 *   IndexedDB before the staleness guard, so it reappeared on navigating back —
 *   the cancel had not merely been slow, it had done nothing.
 * - On-device, `acquireInferenceTurn` is a strict FIFO over one process-global
 *   llama context. An abandoned region decode holds that turn, so the page the
 *   user is now looking at waits behind it — and `translateGuidedRegions` loops
 *   over the whole highlighted set, so it is N uninterruptible decodes deep.
 *
 * Both handlers now call in here, which owns the controller, publishes the
 * token so the existing Stop affordances can reach it, supersedes automatic
 * work for the same page the way the manual full-page path does, and releases
 * on the way out.
 */

import { get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { currentPageIndex, currentVolume, readerTargetEpoch } from '$lib/stores/reader-state.js';
import {
	beginRegionTranslation,
	currentPageRegions,
	currentPageTranslations,
	endRegionTranslation
} from '$lib/stores/translation-state.js';
import { settings } from '$lib/settings/settings.js';
import { translateRegionSafe } from '$lib/translation/translation-service.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import {
	acquirePageTranslationActivity,
	releasePageTranslationActivity,
	supersedeAutomaticPageTranslation,
	type PageTranslationActivityCancelReason
} from '$lib/translation/page-translation-activity.js';
import type { Translation, TranslationRegion, VolumeMetadata } from '$lib/types/index.js';

export interface RegionTranslationResult {
	ok: boolean;
	error?: string;
	/** True when the run stopped because it was cancelled, not because it failed. */
	cancelled?: boolean;
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function isTargetCurrent(targetEpoch: number, volumeUuid: string, pageIndex: number): boolean {
	return get(readerTargetEpoch) === targetEpoch
		&& get(currentVolume)?.volume_uuid === volumeUuid
		&& get(currentPageIndex) === pageIndex;
}

/** Translate one region with an already-owned signal. */
async function translateOne(
	region: TranslationRegion,
	volume: VolumeMetadata,
	targetEpoch: number,
	signal: AbortSignal
): Promise<RegionTranslationResult> {
	if (signal.aborted) return { ok: false, cancelled: true };
	const volumeUuid = volume.volume_uuid;
	const shouldPublishResult = () => isTargetCurrent(targetEpoch, volumeUuid, region.page_index);

	const source = await createPageSource(volume, { signal });
	let imageFile: File;
	try {
		imageFile = await source.getPageAsFile(region.page_index, { signal });
	} finally {
		source.dispose();
	}
	if (signal.aborted) return { ok: false, cancelled: true };

	// The OCR crop cannot decode a video blob, and the friendly message beats a
	// raw decode failure.
	if (imageFile.type.startsWith('video/')) {
		return { ok: false, error: 'Video pages have no text to translate.' };
	}

	const appSettings = get(settings);
	if (appSettings.translationPipeline === 'on-device') {
		beginRegionTranslation(region.id);
		try {
			const { translateRegionOnDevice } = await import('$lib/translation/on-device-service.js');
			// This overload has always accepted a signal and threaded it through
			// OCR, the model load and the decode; both callers simply never passed
			// one.
			const result = await translateRegionOnDevice(region, imageFile, signal);
			const translation: Translation = {
				id: randomUUID(),
				region_id: region.id,
				volume_uuid: volumeUuid,
				page_index: region.page_index,
				mode: 1,
				model: `on-device-hymt2-1.25bit-${appSettings.onDeviceOCRProvider ?? 'ppocr'}`,
				original_text: result.original_text,
				translated_text: result.translated_text,
				prompt_tokens: 0,
				completion_tokens: 0,
				created_at: new Date().toISOString()
			};
			// A cancelled run must leave nothing behind to resurface later.
			if (signal.aborted) return { ok: false, cancelled: true };
			const { db } = await import('$lib/db/index.js');
			await db.translations.put(translation);
			if (shouldPublishResult()) {
				currentPageTranslations.update((translations) => [...translations, translation]);
			}
		} finally {
			endRegionTranslation(region.id);
		}
		return { ok: true };
	}

	const error = await translateRegionSafe(region, imageFile, undefined, {
		shouldPublishResult,
		signal
	});
	if (error) return { ok: false, error };
	return { ok: true };
}

/**
 * Run `regions` under one activity token, so a single Stop press cancels the
 * whole batch rather than one decode of it.
 */
async function runOwned(regions: TranslationRegion[]): Promise<RegionTranslationResult> {
	const volume = get(currentVolume);
	if (!volume) return { ok: false, error: 'No comic is open' };
	if (regions.length === 0) return { ok: true };

	const targetEpoch = get(readerTargetEpoch);
	const controller = new AbortController();
	const target = { volumeUuid: volume.volume_uuid, pageIndex: regions[0].page_index };
	const token = acquirePageTranslationActivity('manual', target, {
		cancel(_reason: PageTranslationActivityCancelReason) {
			controller.abort();
		}
	});

	try {
		// Manual work wins, but only once matching automatic work has settled —
		// the same order the manual full-page path uses.
		await supersedeAutomaticPageTranslation(target, controller.signal);

		let firstError: string | undefined;
		for (const region of regions) {
			if (controller.signal.aborted) return { ok: false, cancelled: true };
			const result = await translateOne(region, volume, targetEpoch, controller.signal);
			if (result.cancelled) return result;
			if (!result.ok && !firstError) firstError = result.error;
		}
		return firstError ? { ok: false, error: firstError } : { ok: true };
	} catch (error) {
		if (isAbort(error) || controller.signal.aborted) return { ok: false, cancelled: true };
		return {
			ok: false,
			error: error instanceof Error ? error.message : 'Failed to load page image'
		};
	} finally {
		releasePageTranslationActivity(token);
	}
}

/** Translate a single region, cancellable from the reader's Stop control. */
export function runRegionTranslation(region: TranslationRegion): Promise<RegionTranslationResult> {
	return runOwned([region]);
}

/** Translate every listed region under one cancellable run. */
export function runRegionTranslations(regionIds: Iterable<string>): Promise<RegionTranslationResult> {
	const requested = new Set(regionIds);
	return runOwned(get(currentPageRegions).filter((candidate) => requested.has(candidate.id)));
}

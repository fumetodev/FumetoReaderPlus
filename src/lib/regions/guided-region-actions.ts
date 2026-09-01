/**
 * Region actions for the mobile guided post-draw flow, extracted from the
 * Sidebar's mobile Regions tab so the review strip and per-region popovers
 * can share them. Desktop keeps its own Sidebar handlers.
 */

import { get } from 'svelte/store';
import { currentPageIndex, currentVolume, isOverlayMode } from '$lib/stores/reader-state.js';
import {
	currentPageRegions,
	currentPageTranslations,
	regionTranslationMap,
	setCurrentPageTranslationPayload
} from '$lib/stores/translation-state.js';
import { convertRegionsToOverlay } from '$lib/translation/full-page-service.js';
import { runRegionTranslation, runRegionTranslations } from '$lib/regions/region-translation-run.js';
import { deleteDrawnRegionsOnPage, deleteRegion } from '$lib/regions/region-manager.js';
import type { Translation, TranslationRegion } from '$lib/types/index.js';

export interface GuidedRegionResult {
	ok: boolean;
	error?: string;
}

export async function translateGuidedRegion(region: TranslationRegion): Promise<GuidedRegionResult> {
	const result = await runRegionTranslation(region);
	// A cancel is not a failure to report: the user asked for it.
	if (result.cancelled) return { ok: false };
	return result;
}

/** Translate every listed region under one cancellable run. */
export async function translateGuidedRegions(regionIds: Iterable<string>): Promise<GuidedRegionResult> {
	const result = await runRegionTranslations(regionIds);
	if (result.cancelled) return { ok: false };
	return result;
}

function removeConvertedRegions(removedRegionIds: string[]): void {
	const removed = new Set(removedRegionIds);
	currentPageRegions.update((regions) => regions.filter((region) => !removed.has(region.id)));
	currentPageTranslations.update((translations) => translations.filter((translation) => !removed.has(translation.region_id)));
}

/** Promote every translated region on the page into overlay boxes. */
export async function convertTranslatedRegionsToOverlay(): Promise<GuidedRegionResult> {
	const volume = get(currentVolume);
	if (!volume) return { ok: false, error: 'No comic is open' };
	const pairs = get(currentPageRegions)
		.map((region) => {
			const translation = get(regionTranslationMap).get(region.id);
			return translation ? { region, translation } : null;
		})
		.filter((pair): pair is { region: TranslationRegion; translation: Translation } => pair !== null);
	if (pairs.length === 0) return { ok: false, error: 'No translated regions to add' };
	try {
		const { overlayData, pageTranslation, removedRegionIds } = await convertRegionsToOverlay(
			volume.volume_uuid,
			get(currentPageIndex),
			pairs
		);
		setCurrentPageTranslationPayload(pageTranslation, overlayData);
		removeConvertedRegions(removedRegionIds);
		if (!get(isOverlayMode)) isOverlayMode.set(true);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : 'Failed to convert regions to overlay' };
	}
}

export async function clearDrawnRegionsOnCurrentPage(): Promise<GuidedRegionResult> {
	const volume = get(currentVolume);
	if (!volume) return { ok: false, error: 'No comic is open' };
	await deleteDrawnRegionsOnPage(volume.volume_uuid, get(currentPageIndex));
	return { ok: true };
}

export async function deleteGuidedRegion(regionId: string): Promise<GuidedRegionResult> {
	await deleteRegion(regionId);
	return { ok: true };
}

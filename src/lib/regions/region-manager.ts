/**
 * Region manager — CRUD operations for translation regions.
 *
 * Handles creating, reading, deleting regions and
 * transforming coordinates between screen space and image space.
 */

import { db } from '$lib/db/index.js';
import { randomUUID } from '$lib/util/uuid.js';
import type { TranslationRegion } from '$lib/types/index.js';
import { currentPageRegions } from '$lib/stores/translation-state.js';
import { get } from 'svelte/store';

/**
 * Create a new translation region for the current page.
 *
 * @param volumeUuid - Volume identifier
 * @param pageIndex - Page index
 * @param rect - Rectangle in image-space coordinates
 * @returns The created region
 */
export async function createRegion(
	volumeUuid: string,
	pageIndex: number,
	rect: { x: number; y: number; width: number; height: number }
): Promise<TranslationRegion> {
	// Auto-calculate sort order (append to end)
	const existingRegions = get(currentPageRegions);
	const maxOrder = existingRegions.reduce((max, r) => Math.max(max, r.sort_order), -1);

	const region: TranslationRegion = {
		id: randomUUID(),
		volume_uuid: volumeUuid,
		page_index: pageIndex,
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
		created_at: new Date().toISOString(),
		sort_order: maxOrder + 1,
		source: 'user-drawn'
	};

	await db.regions.put(region);

	// Update store
	currentPageRegions.update((regions) => [...regions, region]);

	return region;
}

/**
 * Delete a region and its translations.
 */
export async function deleteRegion(regionId: string): Promise<void> {
	await db.transaction('rw', [db.regions, db.translations], async () => {
		await db.regions.delete(regionId);
		await db.translations.where('region_id').equals(regionId).delete();
	});

	// Update store
	currentPageRegions.update((regions) => regions.filter((r) => r.id !== regionId));
}

/**
 * Delete all regions on a page.
 */
export async function deleteAllRegionsOnPage(
	volumeUuid: string,
	pageIndex: number
): Promise<void> {
	const regions = await db.regions
		.where('[volume_uuid+page_index]')
		.equals([volumeUuid, pageIndex])
		.toArray();

	const regionIds = regions.map((r) => r.id);

	await db.transaction('rw', [db.regions, db.translations], async () => {
		await db.regions.bulkDelete(regionIds);
		for (const id of regionIds) {
			await db.translations.where('region_id').equals(id).delete();
		}
	});

	currentPageRegions.set([]);
}

/**
 * Delete only user-drawn regions on a page (preserves auto-detected/full-page regions).
 */
export async function deleteDrawnRegionsOnPage(
	volumeUuid: string,
	pageIndex: number
): Promise<void> {
	const allRegions = await db.regions
		.where('[volume_uuid+page_index]')
		.equals([volumeUuid, pageIndex])
		.toArray();

	const drawnRegions = allRegions.filter((r) => r.source === 'user-drawn');
	const regionIds = drawnRegions.map((r) => r.id);

	if (regionIds.length === 0) return;

	await db.transaction('rw', [db.regions, db.translations], async () => {
		await db.regions.bulkDelete(regionIds);
		for (const id of regionIds) {
			await db.translations.where('region_id').equals(id).delete();
		}
	});

	// Update store — remove only user-drawn regions
	currentPageRegions.update((regions) => regions.filter((r) => r.source !== 'user-drawn'));
}

// ============================================================
// Coordinate transforms
// ============================================================

/**
 * Transform screen coordinates to image-space coordinates.
 *
 * @param screenX - X position in screen/viewport pixels
 * @param screenY - Y position in screen/viewport pixels
 * @param containerRect - The bounding rect of the image container element
 * @param pzTransform - Current panzoom transform { x, y, scale }
 * @returns Image-space coordinates
 */
export function screenToImage(
	screenX: number,
	screenY: number,
	containerRect: DOMRect,
	pzTransform: { x: number; y: number; scale: number }
): { x: number; y: number } {
	return {
		x: (screenX - containerRect.left - pzTransform.x) / pzTransform.scale,
		y: (screenY - containerRect.top - pzTransform.y) / pzTransform.scale
	};
}

/**
 * Transform image-space coordinates to screen coordinates.
 *
 * @param imageX - X position in image pixels
 * @param imageY - Y position in image pixels
 * @param containerRect - The bounding rect of the image container element
 * @param pzTransform - Current panzoom transform { x, y, scale }
 * @returns Screen-space coordinates
 */
export function imageToScreen(
	imageX: number,
	imageY: number,
	containerRect: DOMRect,
	pzTransform: { x: number; y: number; scale: number }
): { x: number; y: number } {
	return {
		x: imageX * pzTransform.scale + pzTransform.x + containerRect.left,
		y: imageY * pzTransform.scale + pzTransform.y + containerRect.top
	};
}

/**
 * Convert an image-space region rectangle to screen-space for canvas rendering.
 */
export function regionToScreenRect(
	region: TranslationRegion,
	containerRect: DOMRect,
	pzTransform: { x: number; y: number; scale: number }
): { x: number; y: number; width: number; height: number } {
	const topLeft = imageToScreen(region.x, region.y, containerRect, pzTransform);
	return {
		x: topLeft.x - containerRect.left, // relative to canvas element
		y: topLeft.y - containerRect.top,
		width: region.width * pzTransform.scale,
		height: region.height * pzTransform.scale
	};
}

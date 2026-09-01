import type { UserMessage } from '$lib/i18n/user-messages.js';
/**
 * Translation state store — tracks regions and translations for the current page.
 */

import { writable, derived, get, type Subscriber, type Unsubscriber, type Updater, type Writable } from 'svelte/store';
import type { TranslationRegion, Translation, TranslationMode, PageTranslation, PageOverlayData } from '$lib/types/index.js';
import { db } from '$lib/db/index.js';
import { isPageBenchmarkPersistenceSuppressed } from '$lib/benchmark/page-benchmark-mode.js';
import { isPageTranslating } from '$lib/translation/page-translation-activity.js';
import { pageOverlayRepository } from '$lib/overlay-layout/index.js';

export { isPageTranslating } from '$lib/translation/page-translation-activity.js';

/** All regions for the current page */
export const currentPageRegions = writable<TranslationRegion[]>([]);

/** All translations for the current page */
export const currentPageTranslations = writable<Translation[]>([]);

/** Region IDs currently being translated (supports concurrent requests safely). */
export const translatingRegionIds = writable<Set<string>>(new Set());

/** Mark a region translation as in-flight. */
export function beginRegionTranslation(regionId: string): void {
	translatingRegionIds.update((ids) => {
		const next = new Set(ids);
		next.add(regionId);
		return next;
	});
}

/** Mark a region translation as completed/failed. */
export function endRegionTranslation(regionId: string): void {
	translatingRegionIds.update((ids) => {
		const next = new Set(ids);
		next.delete(regionId);
		return next;
	});
}

/** Current translation mode */
export const translationMode = writable<TranslationMode>(1);

export interface CurrentPageTranslationPayload {
	pageTranslation: PageTranslation | null;
	overlayData: PageOverlayData | null;
}

export interface VersionedCurrentPageTranslationPayload extends CurrentPageTranslationPayload {
	version: number;
}

type ProjectionSubscriber<T> = readonly [Subscriber<T>, () => void];

/**
 * The full-page translation and its V2 overlay are one page-owned value.  The
 * two public stores below are writable projections retained for compatibility
 * with editors that intentionally change only one half.
 *
 * Publishing updates the authoritative pair before either projection notifies.
 * Consequently a synchronous subscriber can safely read the other projection,
 * even when an earlier subscriber throws. Projection notifications are based
 * on identity so an overlay-only edit does not wake translation subscribers.
 */
let currentPageTranslationPayload: CurrentPageTranslationPayload = {
	pageTranslation: null,
	overlayData: null
};
let currentPageTranslationPayloadVersion = 0;

const pageTranslationSubscribers = new Set<ProjectionSubscriber<PageTranslation | null>>();
const pageOverlaySubscribers = new Set<ProjectionSubscriber<PageOverlayData | null>>();

const pagePayloadNotificationQueue: Array<() => void> = [];
let flushingPagePayloadNotifications = false;

function queueProjectionNotification<T>(
	subscribers: Set<ProjectionSubscriber<T>>,
	value: T,
	errors: unknown[]
): void {
	const snapshot = [...subscribers];
	for (const [, invalidate] of snapshot) {
		try {
			invalidate();
		} catch (error) {
			errors.push(error);
		}
	}
	for (const [run] of snapshot) pagePayloadNotificationQueue.push(() => run(value));
}

function publishCurrentPageTranslationPayload(
	next: CurrentPageTranslationPayload,
	expectedVersion?: number
): number | null {
	if (
		expectedVersion !== undefined
		&& expectedVersion !== currentPageTranslationPayloadVersion
	) return null;
	const translationChanged = !Object.is(
		currentPageTranslationPayload.pageTranslation,
		next.pageTranslation
	);
	const overlayChanged = !Object.is(currentPageTranslationPayload.overlayData, next.overlayData);

	// Commit both fields and advance the ownership token before running any
	// invalidator or subscriber. Even an identity-preserving external write must
	// supersede a preview that captured the preceding version.
	currentPageTranslationPayload = next;
	currentPageTranslationPayloadVersion += 1;
	const committedVersion = currentPageTranslationPayloadVersion;
	if (!translationChanged && !overlayChanged) return committedVersion;
	const errors: unknown[] = [];
	if (translationChanged) {
		queueProjectionNotification(pageTranslationSubscribers, next.pageTranslation, errors);
	}
	if (overlayChanged) {
		queueProjectionNotification(pageOverlaySubscribers, next.overlayData, errors);
	}

	if (!flushingPagePayloadNotifications) {
		flushingPagePayloadNotifications = true;
		try {
			while (pagePayloadNotificationQueue.length > 0) {
				const notify = pagePayloadNotificationQueue.shift()!;
				try {
					notify();
				} catch (error) {
					errors.push(error);
				}
			}
		} finally {
			flushingPagePayloadNotifications = false;
		}
	}

	if (errors.length > 0) throw errors[0];
	// A subscriber may synchronously publish another payload while this write's
	// notifications are flushing. Return the version owned by this exact commit,
	// not the newer global version, so a caller's next CAS correctly fails.
	return committedVersion;
}

function createCurrentPageProjection<T>(
	read: (payload: CurrentPageTranslationPayload) => T,
	write: (value: T, payload: CurrentPageTranslationPayload) => CurrentPageTranslationPayload,
	subscribers: Set<ProjectionSubscriber<T>>
): Writable<T> {
	return {
		subscribe(run: Subscriber<T>, invalidate: () => void = () => undefined): Unsubscriber {
			const subscriber = [run, invalidate] as const;
			subscribers.add(subscriber);
			run(read(currentPageTranslationPayload));
			return () => subscribers.delete(subscriber);
		},
		set(value: T): void {
			publishCurrentPageTranslationPayload(write(value, currentPageTranslationPayload));
		},
		update(updater: Updater<T>): void {
			const value = read(currentPageTranslationPayload);
			publishCurrentPageTranslationPayload(write(updater(value), currentPageTranslationPayload));
		}
	};
}

/** Full-page translation result for the current page. */
export const currentPageTranslation = createCurrentPageProjection(
	(payload) => payload.pageTranslation,
	(pageTranslation, payload) => ({ ...payload, pageTranslation }),
	pageTranslationSubscribers
);

/** Overlay data for the current page (detected regions + matched translations). */
export const currentPageOverlay = createCurrentPageProjection(
	(payload) => payload.overlayData,
	(overlayData, payload) => ({ ...payload, overlayData }),
	pageOverlaySubscribers
);

/** Atomically replace the current page's translation and overlay projections. */
export function setCurrentPageTranslationPayload(
	pageTranslation: PageTranslation | null,
	overlayData: PageOverlayData | null
): void {
	publishCurrentPageTranslationPayload({ pageTranslation, overlayData });
}

/** Read the coherent payload together with its monotonic compare-and-set token. */
export function readCurrentPageTranslationPayload(): VersionedCurrentPageTranslationPayload {
	return {
		...currentPageTranslationPayload,
		version: currentPageTranslationPayloadVersion
	};
}

/**
 * Replace both projections only if no owner has written since `expectedVersion`.
 * Returns the new version on success, or null without changing state on failure.
 */
export function compareAndSetCurrentPageTranslationPayload(
	expectedVersion: number,
	pageTranslation: PageTranslation | null,
	overlayData: PageOverlayData | null
): number | null {
	return publishCurrentPageTranslationPayload(
		{ pageTranslation, overlayData },
		expectedVersion
	);
}

/** Explicit reason that a stored overlay cannot be rendered and must be regenerated. */
export const currentPageOverlayInvalidation = writable<UserMessage | null>(null);


/**
 * Monotonic counter to discard stale loadPageData results.
 * When the user flips pages rapidly, earlier (slower) queries must not
 * overwrite stores that were already set by a later call.
 */
let loadGeneration = 0;

function resetPageScopedStores(resetTranslationActivity: boolean): void {
	currentPageRegions.set([]);
	currentPageTranslations.set([]);
	setCurrentPageTranslationPayload(null, null);
	currentPageOverlayInvalidation.set(null);
	if (resetTranslationActivity) isPageTranslating.set(false);
}

/**
 * Clear data owned by the previously displayed page and invalidate pending loads.
 * This is also used when the reader closes its current volume.
 */
export function clearPageData(): void {
	loadGeneration += 1;
	resetPageScopedStores(true);
}

/**
 * Load regions and translations for the current page from IndexedDB.
 */
export async function loadPageData(volumeUuid: string, pageIndex: number): Promise<void> {
	const gen = ++loadGeneration;
	// Clear the previous page synchronously, before the first IndexedDB await.
	// A page change invalidates page-owned data, but the active translation runner
	// owns its lifecycle flag until its AbortSignal has actually settled. Clearing
	// it here could allow the next page to start a concurrent OCR/LLM job.
	resetPageScopedStores(false);

	// Run all three independent queries in parallel for faster page loads
	const [regions, translations, overlayRead] = await Promise.all([
		db.regions
			.where('[volume_uuid+page_index]')
			.equals([volumeUuid, pageIndex])
			.sortBy('sort_order'),
		db.translations
			.where('[volume_uuid+page_index]')
			.equals([volumeUuid, pageIndex])
			.toArray(),
		pageOverlayRepository.load(volumeUuid, pageIndex)
	]);

	if (gen !== loadGeneration) return; // stale — a newer call is in flight

	currentPageRegions.set(regions);
	currentPageTranslations.set(translations);

	let overlayData: PageOverlayData | null = null;

	if (overlayRead.status === 'ready') {
		overlayData = overlayRead.overlay;
	} else {
		if (overlayRead.status === 'invalidated') {
			currentPageOverlayInvalidation.set({ code: 'reader_overlay_invalidated_legacy' });
		} else if (overlayRead.status === 'future') {
			currentPageOverlayInvalidation.set({ code: 'reader_overlay_requires_newer_app', params: { version: overlayRead.schemaVersion } });
		} else if (overlayRead.status === 'malformed') {
			currentPageOverlayInvalidation.set({ code: 'reader_overlay_invalid', params: { reason: overlayRead.reason } });
		}
	}
	setCurrentPageTranslationPayload(overlayRead.pageTranslation, overlayData);
}

/**
 * Get the latest translation for a region.
 */
export function getTranslationForRegion(
	regionId: string,
	translations: Translation[]
): Translation | undefined {
	// Return the most recent translation for this region
	return translations
		.filter((t) => t.region_id === regionId)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

/**
 * Map of region_id → latest Translation (derived).
 *
 * Pre-indexes translations by region_id in a single pass (O(R+T))
 * instead of scanning all translations for each region (O(R*T)).
 */
export const regionTranslationMap = derived(
	[currentPageRegions, currentPageTranslations],
	([$regions, $translations]) => {
		// Build index: region_id → most recent Translation
		const latestByRegion = new Map<string, Translation>();
		for (const t of $translations) {
			const existing = latestByRegion.get(t.region_id);
			if (!existing || t.created_at > existing.created_at) {
				latestByRegion.set(t.region_id, t);
			}
		}

		// Only include regions that actually have translations
		const map = new Map<string, Translation>();
		for (const region of $regions) {
			const translation = latestByRegion.get(region.id);
			if (translation) {
				map.set(region.id, translation);
			}
		}
		return map;
	}
);

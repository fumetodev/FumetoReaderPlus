/**
 * Reader state store — tracks current volume, page, and view state.
 */

import { writable, derived, get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import type { AppView, PageViewMode, VolumeMetadata, PageInfo, ReaderReturnView } from '$lib/types/index.js';
import { db } from '$lib/db/index.js';
import { settings } from '$lib/settings/settings.js';
import { openingPageFor } from '$lib/reader/opening-page.js';
import { isVideoPageFilename } from '$lib/import/types.js';
import { effectiveReadingDirection, oppositeReadingDirection } from '$lib/reader/reading-direction.js';
import { resetReaderInteractionState } from '$lib/reader/reader-interaction-reset.js';
import { viewAfterLeavingReader } from '$lib/navigation/mobile-navigation.js';
import { updateVolume, findNextVolumeInFolder } from '$lib/catalog/catalog-repository.js';

/** Current app view */
export const appView = writable<AppView>('catalog');

/** Destination restored by both native and visual reader Back controls. */
export const readerReturnView = writable<ReaderReturnView>('catalog');

/** Currently loaded volume metadata */
export const currentVolume = writable<VolumeMetadata | null>(null);

/** Current page index (0-based) */
export const currentPageIndex = writable<number>(0);

/** Identity and monotonic target epoch for app-scoped manual reader work. */
export const readerSessionId = writable<string>('');
export const readerTargetEpoch = writable<number>(0);
let observedTargetVolumeUuid: string | null = null;
let observedTargetPageIndex = 0;
let readerTargetTrackingActive = false;

currentVolume.subscribe((volume) => {
	const volumeUuid = volume?.volume_uuid ?? null;
	if (readerTargetTrackingActive && volumeUuid !== observedTargetVolumeUuid) {
		observedTargetVolumeUuid = volumeUuid;
		readerTargetEpoch.update((epoch) => epoch + 1);
	} else {
		observedTargetVolumeUuid = volumeUuid;
	}
});

currentPageIndex.subscribe((pageIndex) => {
	if (readerTargetTrackingActive && pageIndex !== observedTargetPageIndex) {
		observedTargetPageIndex = pageIndex;
		readerTargetEpoch.update((epoch) => epoch + 1);
	} else {
		observedTargetPageIndex = pageIndex;
	}
});

/** All page dimensions for current volume */
export const pageDimensions = writable<PageInfo[]>([]);

/** Page view mode (single/dual/auto) */
export const pageViewMode = writable<PageViewMode>('single');

/** Reading direction */
export const readingDirection = writable<'rtl' | 'ltr'>('rtl');

/** Whether the reader is in "draw region" mode vs "navigate" mode */
export const isDrawingMode = writable<boolean>(false);

/** Whether text overlays are visible on the page */
export const isOverlayMode = writable<boolean>(true);

/** Overlay font scale for the current volume (1.0 = 100%) */
export const overlayFontScale = writable<number>(1.0);

/**
 * View-only rotation of the current page in 90° steps. Transient by design —
 * it exists to read a sideways spread, so it resets on every page or volume
 * change and never touches stored geometry: detection, overlay plans, and
 * export all keep operating in the image's own pixel space.
 */
export type PageRotation = 0 | 90 | 180 | 270;
export const pageRotation = writable<PageRotation>(0);
// Reset only on ACTUAL page/volume changes. Writables notify on every set,
// and currentVolume is also re-set for in-place metadata edits (reading
// direction override, details dialog) — those must not yank the rotation.
let rotationVolumeUuid: string | null = null;
let rotationPageIndex: number | null = null;
currentVolume.subscribe((volume) => {
	const uuid = volume?.volume_uuid ?? null;
	if (uuid !== rotationVolumeUuid) {
		rotationVolumeUuid = uuid;
		pageRotation.set(0);
	}
});
currentPageIndex.subscribe((index) => {
	if (index !== rotationPageIndex) {
		rotationPageIndex = index;
		pageRotation.set(0);
	}
});

/**
 * Rotation is a paged-mode view state: the long strip renders no rotation frame
 * and offers no rotate control, so a quarter turn taken before the switch just
 * sits in the store — invisible, un-clearable from the strip, and re-applied the
 * moment the reader goes back to paged mode on a page the user has since left.
 * Clearing it on the mode change keeps the store honest about what is on screen.
 */
export function resetRotationForReaderMode(): void {
	pageRotation.set(0);
}

/** Advance the current page's view rotation by a quarter turn. */
export function rotateCurrentPage(): void {
	pageRotation.update((value) => ((value + 90) % 360) as PageRotation);
}

/** Total page count (derived) */
export const totalPages = derived(pageDimensions, ($pages) => $pages.length);

/** Current page info (derived) */
export const currentPageInfo = derived(
	[pageDimensions, currentPageIndex],
	([$pages, $index]) => $pages[$index] ?? null
);

/**
 * Current page is a stored video (video-pages feature): drives the reader's
 * <video> surface and gates every translate affordance. Filename-based by
 * contract — remote sources synthesize `.jpg` names, so remote pages are
 * never video. Follows the tracked page in both paged and long-strip modes.
 */
export const currentPageIsVideo = derived(
	currentPageInfo,
	($info) => !!$info && isVideoPageFilename($info.filename)
);

/**
 * Enter the reader through one shared initialization path.
 *
 * `origin` means exactly one thing: where Back returns to. It deliberately does
 * NOT create a tab. It used to, which made whether reading left a tab behind
 * depend on which exit door you used — and made a resume affordance hosted in
 * the Tabs view impossible, since returning there required the very origin that
 * minted tabs. A tab is now created only by an explicit act, at the call site
 * that means it (a Tabs card tap, or "Open in New Tab").
 */
export async function openReader(volume: VolumeMetadata, origin: ReaderReturnView): Promise<boolean> {
	const dimensions = await db.page_dimensions.get(volume.volume_uuid);
	if (!dimensions && volume.page_count <= 0) return false;
	resetReaderInteractionState();
	currentVolume.set(volume);
	pageDimensions.set(dimensions?.pages ?? Array.from({ length: volume.page_count }, (_, index) => ({
		index,
		width: 0,
		height: 0,
		filename: `page_${index + 1}`
	})));
	readingDirection.set(effectiveReadingDirection(volume, get(settings)));
	currentPageIndex.set(openingPageFor(volume, get(settings)));
	observedTargetVolumeUuid = volume.volume_uuid;
	observedTargetPageIndex = get(currentPageIndex);
	readerTargetTrackingActive = true;
	readerTargetEpoch.set(0);
	// The bump store is module-level; without this reset a new PageViewer's
	// subscription replays the previous session's final boundary hit as a
	// spurious edge glow + haptic on mount.
	readerBoundaryBump.set(null);
	readerSessionId.set(randomUUID());
	readerReturnView.set(origin);
	appView.set('reader');
	return true;
}

/**
 * The last page index the reader actually rendered.
 *
 * `currentPageIndex` moves the moment navigation is requested, so it can name a
 * page whose image never loaded. The reader publishes what it committed, and
 * progress is written from that — otherwise backing out after a failed page
 * turn recorded the broken page, and reopening the volume landed straight back
 * on the error card.
 */
let committedPageIndex: { volumeUuid: string; index: number } | null = null;

export function recordCommittedPage(volumeUuid: string, index: number): void {
	committedPageIndex = { volumeUuid, index };
}

/** Persist the current position best-effort and return to the recorded origin. */
export function leaveReader(): ReaderReturnView {
	const volume = get(currentVolume);
	if (volume) {
		// Books deliberately keep the generic path: BookReader writes
		// currentPageIndex from its own relocate handler, so it is authoritative
		// there and no separate commit is recorded.
		const committed = committedPageIndex?.volumeUuid === volume.volume_uuid
			? committedPageIndex.index
			: get(currentPageIndex);
		void updateVolume(volume.volume_uuid, {
			current_page: committed,
			last_read_at: new Date().toISOString()
		});
	}
	committedPageIndex = null;
	resetReaderInteractionState();
	const destination = get(readerReturnView);
	appView.set(viewAfterLeavingReader(destination));
	return destination;
}

/**
 * Reader Tabs control: pure navigation. It creates no tab and focuses none —
 * it sits at pixel parity with the dock's Tabs item precisely so it reads as
 * "go to Tabs", and it used to quietly keep the comic instead. Continue Reading
 * is what carries the current comic forward now.
 */
export function showTabsFromReader(): void {
	readerReturnView.set('tabs');
	leaveReader();
}

/** Navigate to a specific page */
export function goToPage(index: number): void {
	const pages = get(pageDimensions);
	if (pages.length === 0) return;

	const clamped = Math.max(0, Math.min(index, pages.length - 1));
	currentPageIndex.set(clamped);
}

/**
 * Flip the reading direction from the reader's quick toggle.
 *
 * This changes the *app-wide* preference and clears the open volume's override
 * so the choice actually propagates. The toggle used to patch
 * `defaultReadingDirection` while leaving the volume's own value untouched;
 * because every locally-imported volume carried a hardcoded 'rtl', the volume
 * always won on reopen. The visible result was a toggle that reverted, a
 * Settings → Display control that appeared to do nothing, and no carry-over to
 * other comics.
 *
 * A volume-specific direction is still available — deliberately, in Volume
 * Details — but the quick toggle is a global control.
 */
export async function toggleReadingDirection(): Promise<'rtl' | 'ltr'> {
	const next = oppositeReadingDirection(get(readingDirection));
	readingDirection.set(next);
	settings.patch({ defaultReadingDirection: next });
	const volume = get(currentVolume);
	if (volume && volume.reading_direction !== undefined) {
		currentVolume.set({ ...volume, reading_direction: undefined });
		await updateVolume(volume.volume_uuid, { reading_direction: undefined });
	}
	return next;
}

/**
 * Fired when the user tries to page past either end of the volume. Silent
 * clamping reads as a dead tap (UX report U6); the reader renders an edge
 * bump + haptic instead. `direction` is logical: 'end' = past the last page.
 */
export const readerBoundaryBump = writable<{ direction: 'start' | 'end'; seq: number } | null>(null);
let boundaryBumpSeq = 0;

function publishBoundaryBump(direction: 'start' | 'end'): void {
	boundaryBumpSeq += 1;
	readerBoundaryBump.set({ direction, seq: boundaryBumpSeq });
}

/**
 * Number of pages to advance per step.
 * Returns 2 in dual-page mode, 1 otherwise.
 */
function pageStep(): number {
	const mode = get(pageViewMode);
	return mode === 'dual' ? 2 : 1;
}

/** Go to next page (advances by 2 in dual-page mode) */
export function nextPage(): void {
	const index = get(currentPageIndex);
	const pages = get(pageDimensions);
	if (pages.length > 0 && index >= pages.length - 1) {
		if (get(settings).continueToNextVolume) {
			// Bumps the edge itself when there is no next volume, so the end of
			// a folder still feels like the end of a folder.
			void advanceToNextVolume();
			return;
		}
		publishBoundaryBump('end');
		return;
	}
	goToPage(index + pageStep());
}

/** Guards against a burst of swipes opening several volumes in a row. */
let advancingToNextVolume = false;

/**
 * Open the next comic in the current folder, or bump the edge if this is the
 * last one. Progress on the finished volume is recorded first, exactly as
 * leaving the reader would, so it is not marked unread by the jump.
 */
export async function advanceToNextVolume(): Promise<boolean> {
	if (advancingToNextVolume) return false;
	advancingToNextVolume = true;
	try {
		const volume = get(currentVolume);
		if (!volume) {
			publishBoundaryBump('end');
			return false;
		}
		const next = await findNextVolumeInFolder(volume);
		if (!next) {
			publishBoundaryBump('end');
			return false;
		}
		await updateVolume(volume.volume_uuid, {
			current_page: get(currentPageIndex),
			last_read_at: new Date().toISOString()
		});
		return await openReader(next, get(readerReturnView));
	} finally {
		advancingToNextVolume = false;
	}
}

/** Go to previous page (retreats by 2 in dual-page mode) */
export function prevPage(): void {
	const index = get(currentPageIndex);
	if (index <= 0) {
		publishBoundaryBump('start');
		return;
	}
	goToPage(index - pageStep());
}

/** Go to first page */
export function firstPage(): void {
	goToPage(0);
}

/** Go to last page */
export function lastPage(): void {
	const pages = get(pageDimensions);
	goToPage(pages.length - 1);
}

import { get, writable } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { currentPageIndex, currentVolume, isDrawingMode, isOverlayMode } from '$lib/stores/reader-state.js';
import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
import { zoomFitToScreen } from '$lib/panzoom/util.js';
import { createRegion, deleteRegion } from './region-manager.js';
import type { ReaderPageTranslationTarget } from '$lib/translation/reader-page-translation-controller.js';

export interface RegionDrawSession {
	sessionId: string;
	target: ReaderPageTranslationTarget;
	createdRegionIds: string[];
	previousOverlayVisible: boolean;
}

export const activeRegionDrawSession = writable<RegionDrawSession | null>(null);
export const highlightedDrawRegionIds = writable<Set<string>>(new Set());
const pendingCreates = new Map<string, Set<Promise<string>>>();
let creationTail: Promise<void> = Promise.resolve();

function targetMatches(session: RegionDrawSession): boolean {
	return get(currentVolume)?.volume_uuid === session.target.volumeUuid
		&& get(currentPageIndex) === session.target.pageIndex;
}

export function beginRegionDrawSession(target: ReaderPageTranslationTarget): RegionDrawSession {
	const session: RegionDrawSession = {
		sessionId: randomUUID(),
		target: { ...target },
		createdRegionIds: [],
		previousOverlayVisible: get(isOverlayMode)
	};
	highlightedDrawRegionIds.set(new Set());
	activeRegionDrawSession.set(session);
	isOverlayMode.set(false);
	isDrawingMode.set(true);
	mobileReaderUi.closeDisclosure();
	mobileReaderUi.setToolMode('draw-regions');
	if (mobileReaderUi.inspect().chrome === 'visible') mobileReaderUi.toggleChrome();
	requestAnimationFrame(() => requestAnimationFrame(zoomFitToScreen));
	return session;
}

function recordDrawnRegion(sessionId: string, regionId: string): void {
	activeRegionDrawSession.update((session) => {
		if (!session || session.sessionId !== sessionId || !targetMatches(session)) return session;
		return { ...session, createdRegionIds: [...session.createdRegionIds, regionId] };
	});
}

export function persistDrawSessionRegion(rect: { x: number; y: number; width: number; height: number }): Promise<string> | null {
	const session = get(activeRegionDrawSession);
	if (!session || !targetMatches(session)) return null;
	const operation = creationTail.then(async () => {
		const region = await createRegion(session.target.volumeUuid, session.target.pageIndex, rect);
		recordDrawnRegion(session.sessionId, region.id);
		return region.id;
	});
	creationTail = operation.then(() => undefined, () => undefined);
	let pending = pendingCreates.get(session.sessionId);
	if (!pending) {
		pending = new Set();
		pendingCreates.set(session.sessionId, pending);
	}
	pending.add(operation);
	const cleanup = () => {
		const current = pendingCreates.get(session.sessionId);
		current?.delete(operation);
		if (current?.size === 0) pendingCreates.delete(session.sessionId);
	};
	void operation.then(cleanup, cleanup);
	return operation;
}

export async function undoNewestDrawnRegion(): Promise<boolean> {
	const session = get(activeRegionDrawSession);
	if (!session || session.createdRegionIds.length === 0 || !targetMatches(session)) return false;
	const regionId = session.createdRegionIds.at(-1)!;
	await deleteRegion(regionId);
	activeRegionDrawSession.update((current) => current?.sessionId === session.sessionId
		? { ...current, createdRegionIds: current.createdRegionIds.slice(0, -1) }
		: current);
	return true;
}

export async function finishRegionDrawSession(
	options: { enterReview: boolean; waitForPending?: boolean } = { enterReview: true }
): Promise<string[]> {
	const session = get(activeRegionDrawSession);
	if (!session) return [];
	if (options.waitForPending !== false) {
		await Promise.allSettled([...(pendingCreates.get(session.sessionId) ?? [])]);
	}
	const current = get(activeRegionDrawSession);
	if (!current || current.sessionId !== session.sessionId) return [...session.createdRegionIds];
	const created = [...current.createdRegionIds];
	activeRegionDrawSession.set(null);
	isDrawingMode.set(false);
	isOverlayMode.set(session.previousOverlayVisible);
	mobileReaderUi.setToolMode('navigate');
	// The post-draw review strip renders in the chrome-tied bottom section
	// whenever highlightedDrawRegionIds is non-empty; drawing hid the chrome,
	// so bring it back for the review.
	if (options.enterReview && targetMatches(current) && created.length > 0) {
		highlightedDrawRegionIds.set(new Set(created));
		if (mobileReaderUi.inspect().chrome === 'hidden') mobileReaderUi.toggleChrome();
	} else {
		highlightedDrawRegionIds.set(new Set());
	}
	return created;
}

export function syncRegionDrawTarget(target: ReaderPageTranslationTarget): void {
	const session = get(activeRegionDrawSession);
	if (!session) return;
	if (
		session.target.readerSessionId !== target.readerSessionId
		|| session.target.targetEpoch !== target.targetEpoch
		|| session.target.volumeUuid !== target.volumeUuid
		|| session.target.pageIndex !== target.pageIndex
	) void finishRegionDrawSession({ enterReview: false, waitForPending: false });
}

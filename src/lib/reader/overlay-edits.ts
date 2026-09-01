/**
 * Every edit a reader makes to an overlay box goes through here.
 *
 * Three things have to happen on every commit and used to happen in four
 * places, each slightly differently: the repository write, the store publish
 * so the page re-plans, and — new — the way back. A commit captures the manual
 * constraints of every item on the page BEFORE writing, keeps that snapshot as
 * the one-level undo for the page, and offers it in a snackbar for a few
 * seconds. Delete is a flag on the item now, so it is undoable like the rest.
 *
 * Nothing destructive without a way back (the proposal's third principle).
 */
import { get } from 'svelte/store';
import { writable } from 'svelte/store';
import { OverlayUndoStaleError, pageOverlayRepository } from '$lib/overlay-layout/repository.js';
import { currentPageIndex, currentVolume } from '$lib/stores/reader-state.js';
import { currentPageOverlay, setCurrentPageTranslationPayload } from '$lib/stores/translation-state.js';
import { dismissToast, pushToast } from '$lib/stores/toasts.js';
import type { OverlayManualConstraintsV2, PageTranslation } from '$lib/types/index.js';
import type { UserMessageCode } from '$lib/i18n/user-messages.js';

export interface OverlayPageKey {
	volumeUuid: string;
	pageIndex: number;
}

interface UndoEntry {
	key: OverlayPageKey;
	/** The message code naming the edit — what the snackbar and the box sheet show, in the live locale. */
	label: UserMessageCode;
	snapshot: Map<string, OverlayManualConstraintsV2>;
	/** The document revision the edit produced; the undo applies to that revision only. */
	revision: number;
}

const UNDO_TOAST_MS = 6000;

let pending: UndoEntry | null = null;
let toastId: number | null = null;

/** What Undo would revert, for surfaces that want to offer it themselves. */
export const overlayUndoLabel = writable<UserMessageCode | null>(null);

function samePage(key: OverlayPageKey): boolean {
	return get(currentVolume)?.volume_uuid === key.volumeUuid && get(currentPageIndex) === key.pageIndex;
}

function publish(key: OverlayPageKey, updated: PageTranslation): void {
	if (samePage(key)) setCurrentPageTranslationPayload(updated, updated.overlay_data!);
}

function offerUndo(entry: UndoEntry): void {
	pending = entry;
	overlayUndoLabel.set(entry.label);
	if (toastId !== null) dismissToast(toastId);
	toastId = pushToast({
		message: { code: entry.label },
		action: { label: { code: 'common_undo' }, run: () => { void undoLastOverlayEdit(); } },
		autoDismissMs: UNDO_TOAST_MS
	});
}

/**
 * Commit one edit: snapshot the page's constraints, write, publish, offer
 * Undo. `write` is the repository call; it returns the durable record.
 *
 * The snapshot is read from the DURABLE record, never from the live store:
 * the box editor previews its sliders and textarea by writing the draft into
 * `currentPageOverlay`, so by the time Done commits, the store already holds
 * the edit and a snapshot of it would undo to itself. Undo is offered only
 * for the page on screen — that is where the snackbar is.
 */
async function commit(
	key: OverlayPageKey,
	label: UserMessageCode,
	write: () => Promise<PageTranslation>
): Promise<PageTranslation> {
	const snapshot = samePage(key) ? await pageOverlayRepository.readManualConstraints(key.volumeUuid, key.pageIndex) : null;
	const updated = await write();
	publish(key, updated);
	const revision = updated.overlay_data?.documentRevision;
	if (snapshot && revision !== undefined) offerUndo({ key, label, snapshot, revision });
	return updated;
}

export function commitManualConstraints(
	key: OverlayPageKey,
	itemId: string,
	manual: OverlayManualConstraintsV2,
	label: UserMessageCode = 'reader_edit_box_edited'
): Promise<PageTranslation> {
	return commit(key, label, () => pageOverlayRepository.updateManualConstraints(key.volumeUuid, key.pageIndex, itemId, manual));
}

export function deleteOverlayBox(key: OverlayPageKey, itemId: string): Promise<PageTranslation> {
	return commit(key, 'reader_edit_box_deleted', () => pageOverlayRepository.deleteItem(key.volumeUuid, key.pageIndex, itemId));
}

export function restoreOverlayBox(key: OverlayPageKey, itemId: string): Promise<PageTranslation> {
	return commit(key, 'reader_edit_box_restored', () => pageOverlayRepository.restoreItem(key.volumeUuid, key.pageIndex, itemId));
}

export function hideOverlayBox(key: OverlayPageKey, itemId: string, hidden: boolean): Promise<PageTranslation> {
	return commit(key, hidden ? 'reader_edit_box_hidden' : 'reader_edit_box_shown', async () => {
		const document = samePage(key) ? get(currentPageOverlay) : (await pageOverlayRepository.load(key.volumeUuid, key.pageIndex)).overlay;
		const item = document?.items.find((candidate) => candidate.id === itemId);
		if (!item) throw new Error(`Overlay item ${itemId} does not exist`);
		const { hidden: _hidden, ...rest } = item.manual;
		return pageOverlayRepository.updateManualConstraints(key.volumeUuid, key.pageIndex, itemId, hidden ? { ...rest, hidden: true } : rest);
	});
}

export function resetOverlayBox(key: OverlayPageKey, itemId: string, options: { keepText?: boolean } = {}): Promise<PageTranslation> {
	return commit(key, 'reader_edit_box_reset', () => pageOverlayRepository.resetManual(key.volumeUuid, key.pageIndex, itemId, options));
}

/** An orphaned edit is already gone from the page; discarding it forgets it. Not undoable. */
export async function discardOrphanedOverlayEdit(key: OverlayPageKey, itemId: string): Promise<PageTranslation> {
	const updated = await pageOverlayRepository.discardOrphanedEdit(key.volumeUuid, key.pageIndex, itemId);
	publish(key, updated);
	return updated;
}

/** Revert the most recent committed edit. One level; any page. */
export async function undoLastOverlayEdit(): Promise<boolean> {
	const entry = pending;
	if (!entry) return false;
	pending = null;
	overlayUndoLabel.set(null);
	if (toastId !== null) { dismissToast(toastId); toastId = null; }
	let updated: PageTranslation;
	try {
		updated = await pageOverlayRepository.restoreManualSnapshot(entry.key.volumeUuid, entry.key.pageIndex, entry.snapshot, entry.revision);
	} catch (error) {
		if (!(error instanceof OverlayUndoStaleError)) throw error;
		// The page was re-translated or edited elsewhere after this edit; the
		// snapshot no longer describes anything the reader saw.
		pushToast({ message: { code: 'reader_undo_stale' }, autoDismissMs: 3500 });
		return false;
	}
	publish(entry.key, updated);
	pushToast({ message: { code: 'reader_undo_done' }, autoDismissMs: 2500 });
	return true;
}

/** A page change or a re-translation makes the pending snapshot meaningless. */
export function forgetOverlayUndo(): void {
	pending = null;
	overlayUndoLabel.set(null);
	if (toastId !== null) { dismissToast(toastId); toastId = null; }
}

// Leaving the page leaves the snackbar behind. The snapshot would still apply
// to the right page, but a "Box deleted · Undo" row on the next page's box
// list describes an edit the reader cannot see.
let lastSeen: { volumeUuid: string | undefined; pageIndex: number } | null = null;
function forgetIfLeft(): void {
	const seen = { volumeUuid: get(currentVolume)?.volume_uuid, pageIndex: get(currentPageIndex) };
	if (lastSeen && (lastSeen.volumeUuid !== seen.volumeUuid || lastSeen.pageIndex !== seen.pageIndex) && pending && !samePage(pending.key)) {
		forgetOverlayUndo();
	}
	lastSeen = seen;
}
currentVolume.subscribe(forgetIfLeft);
currentPageIndex.subscribe(forgetIfLeft);

export function inspectOverlayUndoForTests(): { label: UserMessageCode; itemIds: string[] } | null {
	return pending ? { label: pending.label, itemIds: [...pending.snapshot.keys()] } : null;
}

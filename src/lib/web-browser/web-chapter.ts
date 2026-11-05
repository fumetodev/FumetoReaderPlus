/**
 * A chapter read from a web page: the pages the page finder found, opened in the manga reader like any volume, so
 * every translation feature works on them.
 *
 * The chapter is a volume record (the reader, the translation runs and their stored results are all keyed by one)
 * that nothing else lists: `visibility: 'internal'`, under a library id no library has. Its pages are fetched as the
 * browser would and held only in a temporary folder (`web-page-source.ts`), which goes when the reader is left.
 *
 * A chapter the person did not save goes with it — or, when a whole-chapter translation is running, when that ends —
 * and nothing unsaved survives a restart: leftovers are purged at launch, and their batches are not resumed. A saved
 * chapter keeps its volume and translations (`web-chapter-store.ts`): reading its pages again, however they were
 * reached, opens it again, matched by the fingerprints of its first pages.
 */

import { get, writable } from 'svelte/store';
import { db } from '$lib/db/index.js';
import { putVolume } from '$lib/catalog/catalog-repository.js';
import { appView, openReader } from '$lib/stores/reader-state.js';
import { deleteVolume } from '$lib/import/import-service.js';
import { randomUUID } from '$lib/util/uuid.js';
import type { VolumeMetadata, WebChapterRecord } from '$lib/types/index.js';
import {
	WebPageSource,
	adoptWebChapterPages,
	discardAllWebChapterPages,
	discardWebChapterPages
} from '$lib/reader/web-page-source.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import type { FinderPage } from './finder-report.js';
import {
	adoptFingerprints,
	chapterShows,
	findSavedChapter,
	fingerprintsSeen,
	forgetFingerprints,
	interruptedJob,
	isSavedWebChapter,
	markOpened,
	pageFetched,
	saveWebChapter,
	savedWebChapterIds,
	type SaveDetails
} from './web-chapter-store.js';
import { guardWebChapter } from './web-page-gate.js';

/** The library id web chapters sit under. No library has it, so no catalog view, count or scan reaches them. */
export const WEB_CHAPTER_LIBRARY_ID = '__fumeto_web__';

/** How many of a chapter's first pages are fingerprinted to recognise a saved chapter (`findSavedChapter`). */
const PROBE_PAGES = 3;

let openChapter: string | null = null;

// Every chapter created since the last launch, kept until the launch purge has removed its rows: a translation still
// in flight when the chapter closed can write after the delete, and only the volume id finds those rows again.
const CREATED_KEY = 'fumeto.webChapters.created';

function createdChapters(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(CREATED_KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

function recordCreated(volumeUuid: string): void {
	try {
		localStorage.setItem(CREATED_KEY, JSON.stringify([...new Set([...createdChapters(), volumeUuid])].slice(-500)));
	} catch {
		// Storage unavailable: the library-id sweep at launch still finds the chapter itself.
	}
}

/** Chapters left while their batch translation ran: dealt with when it ends. */
const closeWhenIdle = new Set<string>();
/** Saved chapters whose remembered images were not there when they were last tried. */
const rememberedGone = new Set<string>();
/** How long the images a chapter remembers get to answer before its site is asked instead. */
const REMEMBERED_WAIT_MS = 12_000;

/**
 * The chapter open in the reader, while the person passes a site's check in the browser. Like Settings, that is not
 * leaving: the chapter and its translations are there when they come back, and its pages are asked for again.
 */
export const chapterAwaitingCheck = writable<string | null>(null);

export function leaveToPassCheck(volume: VolumeMetadata): void {
	chapterAwaitingCheck.set(volume.volume_uuid);
	appView.set('browser');
}

export function returnToChapter(): void {
	chapterAwaitingCheck.set(null);
	appView.set('reader');
}

export function isWebChapter(volume: Pick<VolumeMetadata, 'source'> | null | undefined): boolean {
	return volume?.source?.type === 'web';
}

/** The web chapter open in the reader, if any. */
export function openWebChapterId(): string | null {
	return openChapter;
}

function siteHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

export interface OpenedChapter {
	opened: boolean;
	/** The saved chapter these pages turned out to be. */
	saved: WebChapterRecord | null;
}

/**
 * Opens `pages` from the page at `pageUrl` in the reader; Back returns to the browser. When saved chapters exist,
 * the first pages are fetched first (the reader would fetch them at once anyway) and their fingerprints looked up:
 * pages of a saved chapter open that chapter, with its translations, wherever on the site they were found.
 */
export async function openWebChapter(
	pages: FinderPage[],
	pageUrl: string,
	pageTitle: string,
	options: {
		/** Open nothing unless the pages are a saved chapter. */
		onlyIfSaved?: boolean;
		/** Open nothing unless the pages are this saved chapter (reopening it). */
		expect?: string;
		/** Asked once the first pages are in: the person may have cancelled, or left, while they were being fetched. */
		stillWanted?: () => boolean;
	} = {}
): Promise<OpenedChapter> {
	if (pages.length === 0) return { opened: false, saved: null };
	const provisional = randomUUID();
	const pageUrls = pages.map((p) => p.url);
	if ((await savedWebChapterIds()).size > 0) {
		const probe = new WebPageSource(provisional, pageUrl, pageUrls, 'reader');
		await Promise.allSettled(Array.from({ length: Math.min(PROBE_PAGES, pages.length) }, (_, i) => probe.getPage(i)));
		const match = await matchSaved(fingerprintsSeen(provisional), pages, provisional, pageUrl, options.expect);
		if (options.stillWanted && !options.stillWanted()) {
			forgetFingerprints(provisional);
			await discardWebChapterPages(provisional);
			return { opened: false, saved: null };
		}
		if (match && (!options.expect || match.volume_uuid === options.expect)) {
			// Part of it: a viewer that shows one page at a time, or a gallery still arriving. A chapter is not cut down to
			// what happened to be on screen while the images it remembers are there. A page it does not have means the site
			// has changed the chapter, and the chapter follows the site.
			if (await showsPartOf(match, pages.length, fingerprintsSeen(provisional)) && await openRememberedChapter(match, options.stillWanted ?? (() => true))) {
				forgetFingerprints(provisional);
				await discardWebChapterPages(provisional);
				return { opened: true, saved: match };
			}
			return { opened: await reopenSaved(match, provisional, pages, pageUrl), saved: match };
		}
		if (match) {
			forgetFingerprints(provisional);
			await discardWebChapterPages(provisional);
			return { opened: false, saved: match };
		}
	}
	if (options.onlyIfSaved || options.expect) {
		forgetFingerprints(provisional);
		await discardWebChapterPages(provisional);
		return { opened: false, saved: null };
	}
	return { opened: await openUnsaved(provisional, pages, pageUrl, pageTitle), saved: null };
}

/**
 * The saved chapter these pages are. Asked for one chapter, that chapter's own known pages are looked at as well: one
 * saved from its middle knows nothing of its first pages, so those alone can never recognise it.
 */
async function matchSaved(
	prints: string[],
	pages: FinderPage[],
	provisional: string,
	pageUrl: string,
	expect?: string
): Promise<WebChapterRecord | null> {
	const match = await findSavedChapter(prints, pages.length);
	if (match || !expect) return match;
	const chapter = await db.web_chapters.get(expect);
	if (!chapter) return null;
	const probe = new WebPageSource(provisional, pageUrl, pages.map((p) => p.url), 'reader');
	const known = knownPages(chapter, pages.length);
	await Promise.allSettled(known.map((index) => probe.getPage(index)));
	return chapterShows(chapter, fingerprintsSeen(provisional), known) ? chapter : null;
}

async function showsPartOf(chapter: WebChapterRecord, pageCount: number, prints: string[]): Promise<boolean> {
	if (rememberedGone.has(chapter.volume_uuid)) return false;
	const source = (await db.volumes.get(chapter.volume_uuid))?.source;
	if (source?.type !== 'web' || source.pageUrls.length <= pageCount) return false;
	const inChapter = new Set(chapter.pageFingerprints.slice(0, source.pageUrls.length));
	return prints.every((print) => !print || inChapter.has(print));
}

/** Up to a few of the pages whose image a saved chapter knows, among its first `pageCount`. */
function knownPages(chapter: WebChapterRecord, pageCount: number): number[] {
	const known: number[] = [];
	for (let index = 0; index < Math.min(pageCount, chapter.pageFingerprints.length) && known.length < PROBE_PAGES; index++) {
		if (chapter.pageFingerprints[index]) known.push(index);
	}
	return known;
}

/**
 * Opens a saved chapter from the images it was read from, once they are shown to still be those images. False when they
 * are not there, or are something else now: its site is asked instead.
 */
export async function openRememberedChapter(chapter: WebChapterRecord, stillWanted: () => boolean): Promise<boolean> {
	const volume = await db.volumes.get(chapter.volume_uuid);
	const source = volume?.source;
	if (!volume || source?.type !== 'web' || source.pageUrls.length === 0) return false;
	const known = knownPages(chapter, source.pageUrls.length);
	if (known.length === 0) return false;
	const provisional = randomUUID();
	const probe = new WebPageSource(provisional, source.pageUrl, source.pageUrls, 'reader');
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled(known.map((index) => probe.getPage(index))),
		new Promise((resolve) => { timer = setTimeout(resolve, REMEMBERED_WAIT_MS); })
	]);
	clearTimeout(timer);
	const same = chapterShows(chapter, fingerprintsSeen(provisional), known);
	if (!same) rememberedGone.add(chapter.volume_uuid);
	if (!same || !stillWanted()) {
		forgetFingerprints(provisional);
		await discardWebChapterPages(provisional);
		return false;
	}
	rememberedGone.delete(chapter.volume_uuid);
	const sizes = (await db.page_dimensions.get(chapter.volume_uuid))?.pages;
	const pages = source.pageUrls.map((url, index) => ({ url, width: sizes?.[index]?.width ?? 0, height: sizes?.[index]?.height ?? 0 }));
	return reopenSaved(chapter, provisional, pages, source.pageUrl);
}

function newChapterVolume(volumeUuid: string, pages: FinderPage[], pageUrl: string, pageTitle: string): VolumeMetadata {
	const title = pageTitle.trim() || siteHost(pageUrl) || pageUrl;
	return {
		volume_uuid: volumeUuid,
		title,
		filename: title,
		page_count: pages.length,
		created_at: new Date().toISOString(),
		current_page: 0,
		library_id: WEB_CHAPTER_LIBRARY_ID,
		visibility: 'internal',
		source: { type: 'web', pageUrl, pageUrls: pages.map((p) => p.url), siteHost: siteHost(pageUrl) }
	};
}

async function putChapterVolume(volume: VolumeMetadata, pages: FinderPage[]): Promise<void> {
	await putVolume(volume);
	// Sizes as the finder saw them (0 until loaded); the reader measures each page as it shows it.
	await db.page_dimensions.put({
		volume_uuid: volume.volume_uuid,
		pages: pages.map((p, index) => ({ index, width: p.width, height: p.height, filename: `page_${index + 1}` }))
	});
}

/**
 * Saves a chapter open in the reader. Its first pages are what a later visit recognises it by, and a chapter saved from
 * its middle has not fetched them, so they are fetched now if they can be.
 */
export async function saveOpenChapter(volume: VolumeMetadata, details: SaveDetails): Promise<WebChapterRecord> {
	const source = await createPageSource(volume, { purpose: 'reader' });
	try {
		await fetchFirstPages(source);
	} finally {
		source.dispose();
	}
	return saveWebChapter(volume, details);
}

async function fetchFirstPages(source: { pageCount: number; getPage(index: number): Promise<Blob> }): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled(Array.from({ length: Math.min(PROBE_PAGES, source.pageCount) }, (_, index) => source.getPage(index))),
		new Promise((resolve) => { timer = setTimeout(resolve, REMEMBERED_WAIT_MS); })
	]);
	clearTimeout(timer);
}

/**
 * Saves the pages found on a page without opening them: read later, from the start page. Pages that already are a saved
 * chapter stay that chapter.
 */
export async function saveFoundPages(
	pages: FinderPage[],
	pageUrl: string,
	pageTitle: string,
	details: SaveDetails
): Promise<{ saved: WebChapterRecord; existed: boolean }> {
	const volumeUuid = randomUUID();
	const source = new WebPageSource(volumeUuid, pageUrl, pages.map((p) => p.url), 'reader');
	await fetchFirstPages(source);
	const match = await findSavedChapter(fingerprintsSeen(volumeUuid), pages.length);
	try {
		if (match) return { saved: match, existed: true };
		const volume = newChapterVolume(volumeUuid, pages, pageUrl, pageTitle);
		await putChapterVolume(volume, pages);
		return { saved: await saveWebChapter(volume, details), existed: false };
	} finally {
		forgetFingerprints(volumeUuid);
		await discardWebChapterPages(volumeUuid);
	}
}

async function openUnsaved(volumeUuid: string, pages: FinderPage[], pageUrl: string, pageTitle: string): Promise<boolean> {
	const volume = newChapterVolume(volumeUuid, pages, pageUrl, pageTitle);
	recordCreated(volumeUuid);
	await putChapterVolume(volume, pages);
	await becomeOpenChapter(volumeUuid);
	const opened = await openReader(volume, 'browser');
	if (!opened) {
		openChapter = null;
		await removeChapter(volumeUuid);
	}
	return opened;
}

async function reopenSaved(
	chapter: WebChapterRecord,
	provisional: string,
	pages: FinderPage[],
	pageUrl: string
): Promise<boolean> {
	const volumeUuid = chapter.volume_uuid;
	const existing = await db.volumes.get(volumeUuid);
	if (!existing) {
		forgetFingerprints(provisional);
		await discardWebChapterPages(provisional);
		return false;
	}
	// The pages fetched to recognise it are the chapter's now; their fingerprints are checked against its stored
	// translations as any page of it is (`pageFetched`).
	const probed = fingerprintsSeen(provisional);
	// The reader shows what is stored for a page only once the page is reconciled (`web-page-gate.ts`).
	guardWebChapter(volumeUuid);
	adoptFingerprints(provisional, volumeUuid);
	await adoptWebChapterPages(provisional, volumeUuid);
	for (const [index, print] of probed.entries()) if (print) await pageFetched(volumeUuid, index, print, pages.length);
	const volume: VolumeMetadata = {
		...existing,
		page_count: pages.length,
		source: { type: 'web', pageUrl, pageUrls: pages.map((p) => p.url), siteHost: siteHost(pageUrl) }
	};
	await putVolume(volume);
	if (existing.page_count !== pages.length || !(await db.page_dimensions.get(volumeUuid))) {
		await db.page_dimensions.put({
			volume_uuid: volumeUuid,
			pages: pages.map((p, index) => ({ index, width: p.width, height: p.height, filename: `page_${index + 1}` }))
		});
	}
	// Where it was saved and how it was reached stay as they were: a site can show a chapter's pages under any
	// address (one shows whatever chapter it last remembers), and the address it turned up at says nothing about
	// where the chapter is.
	await markOpened(volumeUuid);
	await becomeOpenChapter(volumeUuid);
	const opened = await openReader(volume, 'browser');
	if (!opened) {
		openChapter = null;
		await closeSaved(volumeUuid);
		return false;
	}
	// A batch the app was closed under carries on now, with the chapter open again (never at launch).
	if (await interruptedJob(volumeUuid)) void resumeBatch(volume);
	return true;
}

async function resumeBatch(volume: VolumeMetadata): Promise<void> {
	try {
		const { isJobActive, startVolumeTranslation } = await import('$lib/translation/volume-translation-service.js');
		if (isJobActive(volume.volume_uuid)) return;
		await prefetchWebChapter(volume);
		// Left while its pages were being fetched: the chapter was closed, and no batch is wanted on it.
		if (openChapter !== volume.volume_uuid) return;
		await startVolumeTranslation(volume.volume_uuid);
	} catch (error) {
		console.warn('[web-chapter] Resuming the chapter\'s translation ended with an error:', error);
	}
}

/**
 * Fetches every page of a web chapter into its temporary folder, before a whole-chapter translation: Android cuts a
 * backgrounded app's network unless the background service runs, and an on-device translation needs none once the
 * pages are here. Pages that fail are left to the translation's own retries.
 */
export async function prefetchWebChapter(volume: VolumeMetadata): Promise<void> {
	if (!isWebChapter(volume)) return;
	const source = await createPageSource(volume, { purpose: 'background' });
	try {
		await Promise.allSettled(Array.from({ length: source.pageCount }, (_, index) => source.getPage(index)));
	} finally {
		source.dispose();
	}
}

async function removeChapter(volumeUuid: string): Promise<void> {
	closeWhenIdle.delete(volumeUuid);
	forgetFingerprints(volumeUuid);
	try {
		await deleteVolume(volumeUuid, { deletePhysicalFile: false });
	} finally {
		await discardWebChapterPages(volumeUuid);
	}
}

/** A saved chapter stays; only its pages go, as the pages of every chapter do. */
async function closeSaved(volumeUuid: string): Promise<void> {
	closeWhenIdle.delete(volumeUuid);
	forgetFingerprints(volumeUuid);
	await discardWebChapterPages(volumeUuid);
}

async function jobActive(volumeUuid: string): Promise<boolean> {
	const { isJobActive } = await import('$lib/translation/volume-translation-service.js');
	return isJobActive(volumeUuid);
}

/** The person left the reader: the chapter (or, if saved, its pages) goes, unless its batch is still running. */
async function closeOpenChapter(): Promise<void> {
	const volumeUuid = openChapter;
	openChapter = null;
	if (!volumeUuid) return;
	if (await jobActive(volumeUuid)) {
		closeWhenIdle.add(volumeUuid);
		return;
	}
	if (await isSavedWebChapter(volumeUuid)) await closeSaved(volumeUuid);
	else await removeChapter(volumeUuid);
}

/** One chapter is open at a time. One waiting on a site's check is left when the person opens another from the browser. */
async function becomeOpenChapter(volumeUuid: string): Promise<void> {
	chapterAwaitingCheck.set(null);
	if (openChapter !== volumeUuid) await closeOpenChapter();
	openChapter = volumeUuid;
}

/** Called when any volume's batch translation ends; a web chapter left during it is dealt with now. */
export async function onVolumeRunEnded(volumeUuid: string): Promise<void> {
	if (!closeWhenIdle.has(volumeUuid) || openChapter === volumeUuid) return;
	if (await isSavedWebChapter(volumeUuid)) await closeSaved(volumeUuid);
	else await removeChapter(volumeUuid);
}

/**
 * Launch: no web chapter can be open, so every unsaved one left behind by a closed app goes, with its stored
 * translation job (which is therefore never resumed), and every chapter's temporary pages go.
 */
export async function purgeWebChapters(): Promise<void> {
	const listed = await db.volumes.where('library_id').equals(WEB_CHAPTER_LIBRARY_ID).primaryKeys();
	const keep = await savedWebChapterIds();
	const leftovers = [...new Set([...listed, ...createdChapters()])].filter((id) => !keep.has(id));
	for (const volumeUuid of leftovers) {
		try {
			await deleteVolume(volumeUuid, { deletePhysicalFile: false });
		} catch (error) {
			console.warn('[web-chapter] Could not remove a leftover chapter:', error);
		}
	}
	try {
		localStorage.removeItem(CREATED_KEY);
	} catch {
		// Nothing recorded.
	}
	await discardAllWebChapterPages();
}

let installed = false;

/**
 * Watches the reader: leaving it (to the browser, where web chapters always return) closes the open chapter. Settings
 * is not leaving: the reader's own buttons open it and it returns to the reader, to a chapter that must still be there.
 * Going on from Settings to anywhere else is.
 */
export function installWebChapterLifecycle(): void {
	if (installed) return;
	installed = true;
	let reading = get(appView) === 'reader';
	appView.subscribe((view) => {
		if (view === 'reader') {
			reading = true;
		} else if (view === 'browser' && get(chapterAwaitingCheck)) {
			// Passing a site's check, and coming back.
		} else if (view !== 'settings' && reading) {
			reading = false;
			chapterAwaitingCheck.set(null);
			if (openChapter) void closeOpenChapter();
		}
	});
}

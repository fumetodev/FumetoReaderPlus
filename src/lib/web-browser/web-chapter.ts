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

import { get } from 'svelte/store';
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
	findSavedChapter,
	fingerprintsSeen,
	forgetFingerprints,
	interruptedJob,
	isSavedWebChapter,
	markOpened,
	pageFetched,
	savedWebChapterIds
} from './web-chapter-store.js';

/** The library id web chapters sit under. No library has it, so no catalog view, count or scan reaches them. */
export const WEB_CHAPTER_LIBRARY_ID = '__fumeto_web__';

/** How many of a chapter's first pages are fingerprinted to recognise a saved chapter. */
const PROBE_PAGES = 2;

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
		reachedBy?: { fromUrl: string; linkHref: string } | null;
		/** Open nothing unless the pages are a saved chapter. */
		onlyIfSaved?: boolean;
		/** Open nothing unless the pages are this saved chapter (reopening it). */
		expect?: string;
	} = {}
): Promise<OpenedChapter> {
	if (pages.length === 0) return { opened: false, saved: null };
	const provisional = randomUUID();
	const pageUrls = pages.map((p) => p.url);
	if ((await savedWebChapterIds()).size > 0) {
		const probe = new WebPageSource(provisional, pageUrl, pageUrls, 'reader');
		await Promise.allSettled(Array.from({ length: Math.min(PROBE_PAGES, pages.length) }, (_, i) => probe.getPage(i)));
		const match = await findSavedChapter(fingerprintsSeen(provisional));
		if (match && (!options.expect || match.volume_uuid === options.expect)) {
			return { opened: await reopenSaved(match, provisional, pages, pageUrl, options.reachedBy), saved: match };
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

async function openUnsaved(volumeUuid: string, pages: FinderPage[], pageUrl: string, pageTitle: string): Promise<boolean> {
	const now = new Date().toISOString();
	const title = pageTitle.trim() || siteHost(pageUrl) || pageUrl;
	const volume: VolumeMetadata = {
		volume_uuid: volumeUuid,
		title,
		filename: title,
		page_count: pages.length,
		created_at: now,
		current_page: 0,
		library_id: WEB_CHAPTER_LIBRARY_ID,
		visibility: 'internal',
		source: { type: 'web', pageUrl, pageUrls: pages.map((p) => p.url), siteHost: siteHost(pageUrl) }
	};
	recordCreated(volumeUuid);
	await putVolume(volume);
	// Sizes as the finder saw them (0 until loaded); the reader measures each page as it shows it.
	await db.page_dimensions.put({
		volume_uuid: volumeUuid,
		pages: pages.map((p, index) => ({ index, width: p.width, height: p.height, filename: `page_${index + 1}` }))
	});
	openChapter = volumeUuid;
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
	pageUrl: string,
	reachedBy?: { fromUrl: string; linkHref: string } | null
): Promise<boolean> {
	const volumeUuid = chapter.volume_uuid;
	const existing = await db.volumes.get(volumeUuid);
	if (!existing) return false;
	// The pages fetched to recognise it are the chapter's now; their fingerprints are checked against its stored
	// translations as any page of it is (a page the site replaced loses its stale translation).
	const probed = fingerprintsSeen(provisional);
	adoptFingerprints(provisional, volumeUuid);
	await adoptWebChapterPages(provisional, volumeUuid);
	for (const [index, print] of probed.entries()) if (print) await pageFetched(volumeUuid, index, print);
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
	await db.web_chapters.update(volumeUuid, {
		chapterUrl: pageUrl,
		...(reachedBy && reachedBy.linkHref === pageUrl ? { fromUrl: reachedBy.fromUrl, linkHref: reachedBy.linkHref } : {})
	});
	await markOpened(volumeUuid);
	openChapter = volumeUuid;
	const opened = await openReader(volume, 'browser');
	if (!opened) {
		openChapter = null;
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

/** Watches the reader: leaving it (to the browser, where web chapters always return) closes the open chapter. */
export function installWebChapterLifecycle(): void {
	if (installed) return;
	installed = true;
	let previous = get(appView);
	appView.subscribe((view) => {
		if (previous === 'reader' && view !== 'reader' && openChapter) void closeOpenChapter();
		previous = view;
	});
}

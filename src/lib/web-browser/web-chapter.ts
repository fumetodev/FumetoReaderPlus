/**
 * A chapter read from a web page: the pages the page finder found, opened in the manga reader like any volume, so
 * every translation feature works on them.
 *
 * The chapter is a volume record (the reader, the translation runs and their stored results are all keyed by one)
 * that nothing else lists: `visibility: 'internal'`, under a library id no library has. Its pages are fetched as the
 * browser would and held only in a temporary folder (`web-page-source.ts`). It lasts until the person leaves the
 * reader — or, when a whole-chapter translation is running, until that ends. Nothing survives a restart: leftovers
 * are purged at launch, and their batches are not resumed.
 */

import { get } from 'svelte/store';
import { db } from '$lib/db/index.js';
import { putVolume } from '$lib/catalog/catalog-repository.js';
import { appView, openReader } from '$lib/stores/reader-state.js';
import { deleteVolume } from '$lib/import/import-service.js';
import { randomUUID } from '$lib/util/uuid.js';
import type { VolumeMetadata } from '$lib/types/index.js';
import { discardAllWebChapterPages, discardWebChapterPages } from '$lib/reader/web-page-source.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import type { FinderPage } from './finder-report.js';

/** The library id web chapters sit under. No library has it, so no catalog view, count or scan reaches them. */
export const WEB_CHAPTER_LIBRARY_ID = '__fumeto_web__';

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
/** Chapters left while their batch translation ran: deleted when it ends. */
const closeWhenIdle = new Set<string>();

export function isWebChapter(volume: Pick<VolumeMetadata, 'source'> | null | undefined): boolean {
	return volume?.source?.type === 'web';
}

function siteHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

/** Opens `pages` from the page at `pageUrl` in the reader; Back returns to the browser. */
export async function openWebChapter(pages: FinderPage[], pageUrl: string, pageTitle: string): Promise<boolean> {
	if (pages.length === 0) return false;
	const volumeUuid = randomUUID();
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
	try {
		await deleteVolume(volumeUuid, { deletePhysicalFile: false });
	} finally {
		await discardWebChapterPages(volumeUuid);
	}
}

async function jobActive(volumeUuid: string): Promise<boolean> {
	const { isJobActive } = await import('$lib/translation/volume-translation-service.js');
	return isJobActive(volumeUuid);
}

/** The person left the reader: the chapter goes, unless its batch translation is still running. */
async function closeOpenChapter(): Promise<void> {
	const volumeUuid = openChapter;
	openChapter = null;
	if (!volumeUuid) return;
	if (await jobActive(volumeUuid)) {
		closeWhenIdle.add(volumeUuid);
		return;
	}
	await removeChapter(volumeUuid);
}

/** Called when any volume's batch translation ends; a web chapter left during it is removed now. */
export async function onVolumeRunEnded(volumeUuid: string): Promise<void> {
	if (!closeWhenIdle.has(volumeUuid) || openChapter === volumeUuid) return;
	await removeChapter(volumeUuid);
}

/**
 * Launch: no web chapter can be open, so every one left behind by a closed app goes, with its stored translation
 * job (which is therefore never resumed) and the temporary pages.
 */
export async function purgeWebChapters(): Promise<void> {
	const listed = await db.volumes.where('library_id').equals(WEB_CHAPTER_LIBRARY_ID).primaryKeys();
	const leftovers = [...new Set([...listed, ...createdChapters()])];
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

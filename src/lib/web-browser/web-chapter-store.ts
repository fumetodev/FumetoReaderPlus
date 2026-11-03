/**
 * Saved web chapters: a chapter the person chose to keep, so its translations come back when they read it on the
 * site again. Only text is kept — the translations on its volume, its title, where it was read and how it was
 * reached, and the fingerprint (sha256) of each page image. The fingerprints are how a chapter is recognised: a
 * site may show it under another address, or (as some do) show another chapter under its address, but the images
 * are what they are.
 *
 * Fingerprints are taken as the pages are fetched (`web-page-source.ts`), for every chapter, so a chapter saved
 * after it was read already knows the pages it showed.
 */

import { db } from '$lib/db/index.js';
import { deleteVolume } from '$lib/import/import-service.js';
import { randomUUID } from '$lib/util/uuid.js';
import type { PageTranslation, VolumeMetadata, WebChapterRecord, WebSeriesRecord } from '$lib/types/index.js';
import { releaseWebChapter, webPageReconciled } from './web-page-gate.js';

/** Fingerprints of the pages fetched so far, per open chapter (saved or not). */
const seen = new Map<string, string[]>();
/** Saved chapters, so the per-page path can skip IndexedDB for the unsaved ones. */
let savedIds: Set<string> | null = null;

async function saved(): Promise<Set<string>> {
	if (!savedIds) savedIds = new Set(await db.web_chapters.toCollection().primaryKeys());
	return savedIds;
}

export async function isSavedWebChapter(volumeUuid: string): Promise<boolean> {
	return (await saved()).has(volumeUuid);
}

export async function savedWebChapterIds(): Promise<Set<string>> {
	return new Set(await saved());
}

export function fingerprintsSeen(volumeUuid: string): string[] {
	return [...(seen.get(volumeUuid) ?? [])];
}

/** Moves what was seen under a provisional id to the chapter it turned out to be. */
export function adoptFingerprints(from: string, to: string): void {
	const prints = seen.get(from);
	seen.delete(from);
	if (prints) seen.set(to, prints);
}

export function forgetFingerprints(volumeUuid: string): void {
	seen.delete(volumeUuid);
	releaseWebChapter(volumeUuid);
}

/**
 * A page of a chapter was fetched: remember its fingerprint, and for a saved chapter make sure what is stored for
 * that position is this image's — the site may have reordered, added or dropped pages since. Translations of this
 * image move here from wherever they were; translations of another image found here are set aside past the
 * chapter's last page, where no page shows them, until their image turns up again. Nothing is deleted: a chapter
 * read once from its second page, or a page the site put in front, would otherwise cost every translation after it.
 * Runs before the page is handed to the reader. `pageCount` is how many pages the chapter has as it is read now.
 */
export async function pageFetched(volumeUuid: string, index: number, fingerprint: string, pageCount: number): Promise<void> {
	const prints = seen.get(volumeUuid) ?? [];
	prints[index] = fingerprint;
	seen.set(volumeUuid, prints);
	if (!(await saved()).has(volumeUuid)) return webPageReconciled(volumeUuid, index);
	await db.transaction('rw', db.web_chapters, db.page_translations, async () => {
		const chapter = await db.web_chapters.get(volumeUuid);
		if (!chapter) return;
		const stored = [...chapter.pageFingerprints];
		if (stored[index] === fingerprint) return;
		const rows = await db.page_translations.where('volume_uuid').equals(volumeUuid).toArray();
		// A translation names its image; one that does not is of the image the chapter knew at its position.
		const imageOf = (t: PageTranslation) => translationFingerprint(t) ?? stored[t.page_index] ?? '';
		const here = rows.filter((t) => t.page_index === index);
		const away = new Map<string, PageTranslation[]>();
		for (const t of here) {
			const image = imageOf(t);
			if (image && image !== fingerprint) away.set(image, [...(away.get(image) ?? []), t]);
		}
		for (const [image, list] of away) {
			const spot = Math.max(stored.length, pageCount);
			while (stored.length < spot) stored.push('');
			stored.push(image);
			for (const t of list) await moveTranslation(t, spot);
		}
		if (!here.some((t) => imageOf(t) === fingerprint)) {
			for (const t of rows) {
				if (t.page_index !== index && imageOf(t) === fingerprint) await moveTranslation(t, index);
			}
		}
		for (let i = 0; i < stored.length; i++) if (i !== index && stored[i] === fingerprint) stored[i] = '';
		while (stored.length <= index) stored.push('');
		stored[index] = fingerprint;
		await db.web_chapters.update(volumeUuid, { pageFingerprints: stored });
	});
	webPageReconciled(volumeUuid, index);
}

/**
 * Moves a translation to another position. A batch translation's row is named after its page
 * (`vol_trans_<volume>_<page>`) and the batch writes over that name, so a moved one takes the name of where it is now.
 */
async function moveTranslation(t: PageTranslation, to: number): Promise<void> {
	const batchRow = `vol_trans_${t.volume_uuid}_`;
	const id = t.id.startsWith(batchRow) ? `${batchRow}${to}` : t.id;
	if (id !== t.id) await db.page_translations.delete(t.id);
	t.id = id;
	t.page_index = to;
	await db.page_translations.put({ ...t });
}

function translationFingerprint(t: PageTranslation): string | null {
	return t.overlay_data?.sourceImage?.fingerprint ?? null;
}

/**
 * The saved chapter whose pages these are, by the fingerprints of its first pages (`fingerprints[i]` is page i's,
 * empty where it could not be fetched); null when none is clearly it. A chapter of several pages needs two of them:
 * chapters of one series often open with the same credits or cover page, and taking another chapter for a saved one
 * re-points it and drops its translations page by page. Nor may a page be another image where the chapter knows
 * which image it has there.
 */
export async function findSavedChapter(fingerprints: string[], pageCount: number): Promise<WebChapterRecord | null> {
	const prints = new Set(fingerprints.filter(Boolean));
	if (prints.size === 0 || (await saved()).size === 0) return null;
	const needed = Math.min(2, pageCount);
	const candidates = new Set<string>();
	for (const print of prints) {
		for (const id of await db.web_chapters.where('pageFingerprints').equals(print).primaryKeys()) candidates.add(id);
	}
	const ranked: { chapter: WebChapterRecord; score: number }[] = [];
	for (const chapter of await db.web_chapters.bulkGet([...candidates])) {
		if (!chapter) continue;
		const known = new Set(chapter.pageFingerprints.filter(Boolean));
		const score = [...prints].filter((print) => known.has(print)).length;
		const conflict = fingerprints.some((print, index) => !!print && !known.has(print) && !!chapter.pageFingerprints[index]);
		if (score >= needed && !conflict) ranked.push({ chapter, score });
	}
	ranked.sort((a, b) => b.score - a.score);
	// A tie means the pages are shared between saved chapters: not enough to say which chapter this is.
	if (ranked.length === 0 || (ranked.length > 1 && ranked[0].score === ranked[1].score)) return null;
	return ranked[0].chapter;
}

export interface SaveDetails {
	chapterTitle: string;
	seriesTitle: string;
	siteHost: string;
	chapterUrl: string;
	seriesUrl: string;
	fromUrl?: string;
	linkHref?: string;
	icon?: string;
}

/** Keeps an open web chapter: its volume and translations stay; it is filed under its series (made if new). */
export async function saveWebChapter(volume: VolumeMetadata, details: SaveDetails): Promise<WebChapterRecord> {
	const now = new Date().toISOString();
	const series = await seriesFor(details.siteHost, details.seriesTitle, details.seriesUrl, details.icon);
	const prints = fingerprintsSeen(volume.volume_uuid);
	const record: WebChapterRecord = {
		volume_uuid: volume.volume_uuid,
		seriesId: series.id,
		title: details.chapterTitle.trim() || volume.title,
		chapterUrl: details.chapterUrl,
		fromUrl: details.fromUrl,
		linkHref: details.linkHref,
		pageFingerprints: Array.from({ length: Math.max(volume.page_count, prints.length) }, (_, i) => prints[i] ?? ''),
		savedAt: now,
		lastOpenedAt: now
	};
	await db.web_chapters.put(record);
	(await saved()).add(volume.volume_uuid);
	return record;
}

async function seriesFor(siteHost: string, title: string, seriesUrl: string, icon?: string): Promise<WebSeriesRecord> {
	const name = title.trim() || siteHost;
	const existing = (await db.web_series.where('siteHost').equals(siteHost).toArray())
		.find((s) => s.title.toLocaleLowerCase() === name.toLocaleLowerCase());
	if (existing) {
		if (icon && !existing.icon) await db.web_series.update(existing.id, { icon });
		return existing;
	}
	const series: WebSeriesRecord = { id: randomUUID(), siteHost, title: name, seriesUrl, icon, createdAt: new Date().toISOString() };
	await db.web_series.put(series);
	return series;
}

export async function markOpened(volumeUuid: string): Promise<void> {
	await db.web_chapters.update(volumeUuid, { lastOpenedAt: new Date().toISOString() });
}

/** Renames a chapter and files it under `seriesTitle` on its site (an existing series, or a new one). */
export async function editSavedChapter(volumeUuid: string, chapterTitle: string, seriesTitle: string): Promise<void> {
	const chapter = await db.web_chapters.get(volumeUuid);
	if (!chapter) return;
	const current = await db.web_series.get(chapter.seriesId);
	const siteHost = current?.siteHost ?? '';
	const series = await seriesFor(siteHost, seriesTitle, current?.seriesUrl ?? chapter.fromUrl ?? chapter.chapterUrl, current?.icon);
	const title = chapterTitle.trim() || chapter.title;
	await db.web_chapters.update(volumeUuid, { title, seriesId: series.id });
	await db.volumes.update(volumeUuid, { title, filename: title });
	await dropEmptySeries();
}

/** Deletes a saved chapter: its volume, translations and record; its series too when it was the last. */
export async function deleteSavedChapter(volumeUuid: string): Promise<void> {
	await deleteVolume(volumeUuid, { deletePhysicalFile: false });
	(await saved()).delete(volumeUuid);
	forgetFingerprints(volumeUuid);
	await dropEmptySeries();
}

async function dropEmptySeries(): Promise<void> {
	const used = new Set(await db.web_chapters.orderBy('seriesId').uniqueKeys());
	const empty = (await db.web_series.toCollection().primaryKeys()).filter((id) => !used.has(id));
	if (empty.length) await db.web_series.bulkDelete(empty);
}

export interface SavedChapterView {
	chapter: WebChapterRecord;
	volume: VolumeMetadata | undefined;
}

export interface SavedSeriesView {
	series: WebSeriesRecord;
	chapters: SavedChapterView[];
}

/** Every saved chapter, by series, most recently opened first. */
export async function listSavedChapters(): Promise<SavedSeriesView[]> {
	const [series, chapters] = await Promise.all([db.web_series.toArray(), db.web_chapters.toArray()]);
	const volumes = new Map(
		(await db.volumes.bulkGet(chapters.map((c) => c.volume_uuid))).filter((v): v is VolumeMetadata => !!v).map((v) => [v.volume_uuid, v])
	);
	const bySeries = new Map<string, SavedChapterView[]>();
	for (const chapter of chapters) {
		const list = bySeries.get(chapter.seriesId) ?? [];
		list.push({ chapter, volume: volumes.get(chapter.volume_uuid) });
		bySeries.set(chapter.seriesId, list);
	}
	const latest = (list: SavedChapterView[]) => list.reduce((m, c) => (c.chapter.lastOpenedAt > m ? c.chapter.lastOpenedAt : m), '');
	return series
		.filter((s) => bySeries.has(s.id))
		.map((s) => ({
			series: s,
			chapters: (bySeries.get(s.id) ?? []).sort((a, b) =>
				a.chapter.title.localeCompare(b.chapter.title, undefined, { numeric: true }))
		}))
		.sort((a, b) => latest(b.chapters).localeCompare(latest(a.chapters)));
}

/** A saved chapter's interrupted batch (it resumes when the chapter is opened again, never at launch). */
export async function interruptedJob(volumeUuid: string): Promise<boolean> {
	const jobs = await db.volume_translation_jobs
		.where('volume_uuid')
		.equals(volumeUuid)
		.toArray();
	return jobs.some((job) => job.status === 'translating' || job.status === 'reviewing');
}

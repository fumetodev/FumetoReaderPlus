/**
 * Validation of what the page finder reports. The report comes from inside a web page, where any script could post
 * to the same port, so it is treated as untrusted data: only the expected shape survives, page addresses must be web
 * addresses, and sizes are capped.
 */

export type FinderKind = 'gallery' | 'single' | 'protected' | 'none';

export interface FinderPage {
	url: string;
	width: number;
	height: number;
}

export interface FinderReport {
	kind: FinderKind;
	pages: FinderPage[];
	pager: boolean;
	/** The page has more pages than one report may carry: `pages` are the first of them. */
	more: boolean;
	/** Images on the page still loading: a gallery's pages are reported as their images arrive. */
	loading: number;
	/** The page address the report was made on (single-page apps change it without loading a new page). */
	at: string;
}

export interface LinkTap {
	href: string;
	from: string;
}

const MAX_PAGES = 2000;
const MAX_URL = 4096;
const KINDS = new Set<FinderKind>(['gallery', 'single', 'protected', 'none']);

export function isWebAddress(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

const dimension = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000 ? Math.round(value) : 0;

export function parseFinderReport(data: unknown, fallbackUrl: string): FinderReport | null {
	if (!data || typeof data !== 'object') return null;
	const raw = data as Record<string, unknown>;
	if (raw.t !== 'finder' || !KINDS.has(raw.kind as FinderKind)) return null;
	const pages: FinderPage[] = [];
	const seen = new Set<string>();
	if (Array.isArray(raw.pages)) {
		for (const entry of raw.pages.slice(0, MAX_PAGES)) {
			if (!entry || typeof entry !== 'object') continue;
			const p = entry as Record<string, unknown>;
			if (!isWebAddress(p.u) || seen.has(p.u)) continue;
			seen.add(p.u);
			pages.push({ url: p.u, width: dimension(p.w), height: dimension(p.h) });
		}
	}
	let kind = raw.kind as FinderKind;
	// The kind must agree with what survived validation.
	if (kind === 'gallery' && pages.length < 2) kind = pages.length === 1 ? 'single' : 'none';
	if (kind === 'single' && pages.length !== 1) kind = pages.length >= 2 ? 'gallery' : 'none';
	if (kind === 'protected' || kind === 'none') pages.length = 0;
	const loading = typeof raw.loading === 'number' && Number.isFinite(raw.loading) ? Math.min(Math.max(Math.round(raw.loading), 0), 10_000) : 0;
	const more = raw.more === true || (Array.isArray(raw.pages) && raw.pages.length > MAX_PAGES);
	return { kind, pages, pager: raw.pager === true, more, loading, at: isWebAddress(raw.at) ? raw.at : fallbackUrl };
}

export function parseLinkTap(data: unknown): LinkTap | null {
	if (!data || typeof data !== 'object') return null;
	const raw = data as Record<string, unknown>;
	if (raw.t !== 'link' || !isWebAddress(raw.href) || !isWebAddress(raw.from)) return null;
	return { href: raw.href, from: raw.from };
}

/**
 * Pages gathered as a viewer shows them: every report adds the pages it shows that are not gathered yet, in the order
 * they were first seen.
 */
export function addCollected(collected: FinderPage[], report: FinderReport): FinderPage[] {
	if (report.kind !== 'gallery' && report.kind !== 'single') return collected;
	const have = new Set(collected.map((p) => p.url));
	const added = report.pages.filter((p) => !have.has(p.url));
	return added.length ? [...collected, ...added].slice(0, MAX_PAGES) : collected;
}

/**
 * What has been gathered after this report; null when the page's own report says it all. A viewer that shows a page at
 * a time, or has a page picker, is gathered as the person turns its pages. So is one that keeps only the pages near the
 * screen: its report loses pages as it gains others. A gallery that has nothing to do with what came before is a new
 * chapter. Anything else (the spinner between two pages) leaves what was gathered alone.
 */
export function collectedAfter(collected: FinderPage[] | null, previous: FinderReport | null, report: FinderReport): FinderPage[] | null {
	if (report.kind === 'single' || (report.kind === 'gallery' && report.pager)) return addCollected(collected ?? [], report);
	if (report.kind !== 'gallery') return collected;
	const now = new Set(report.pages.map((p) => p.url));
	if (collected) {
		// The page now lists all of it (a viewer switched to showing every page), or something else altogether.
		if (collected.every((p) => now.has(p.url)) || !collected.some((p) => now.has(p.url))) return null;
		return addCollected(collected, report);
	}
	const before = previous?.kind === 'gallery' ? previous.pages : [];
	const moved = before.some((p) => now.has(p.url)) && before.some((p) => !now.has(p.url));
	return moved ? addCollected(before, report) : null;
}

// An address's path with its numbers and image type folded away: one chapter's page images share it, and differ only
// in a page number. The host is left out: a chapter's pages can come from several mirrors, in several formats.
function addressShape(url: string): string {
	try {
		return new URL(url).pathname.replace(/\d+/g, '#').replace(/\.(?:jpe?g|png|webp|avif|gif|bmp)$/i, '.image');
	} catch {
		return url;
	}
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

function pathNumbers(url: string): number[] {
	try {
		return (new URL(url).pathname.match(/\d+/g) ?? []).map(Number);
	} catch {
		return [];
	}
}

/**
 * The pages to read. Whatever neither shares the address pattern most pages share nor has their size is dropped: the
 * loading spinner a viewer shows between pages, an ad in the reader's column. A page that merely lives elsewhere (a
 * cover in another folder) has the size of the others and stays. Collected pages are also put in page order when their
 * addresses differ in exactly one number — a person may flip back and forth while collecting; a gallery's own order
 * is the page's and is kept.
 */
export function readablePages(pages: FinderPage[], options: { sortByPageNumber: boolean }): FinderPage[] {
	if (pages.length < 2) return pages;
	const counts = new Map<string, number>();
	for (const p of pages) counts.set(addressShape(p.url), (counts.get(addressShape(p.url)) ?? 0) + 1);
	let dominant = '';
	let best = 0;
	for (const [shape, count] of counts) if (count > best) [dominant, best] = [shape, count];
	let kept = pages;
	if (best >= 2 && best >= pages.length * 0.6) {
		const main = pages.filter((p) => addressShape(p.url) === dominant);
		const width = median(main.map((p) => p.width));
		const height = median(main.map((p) => p.height));
		const samePageSize = (p: FinderPage) =>
			width > 0 && height > 0 && Math.abs(p.width - width) <= width * 0.2 && Math.abs(p.height - height) <= height * 0.2;
		kept = pages.filter((p) => addressShape(p.url) === dominant || samePageSize(p));
	}
	if (!options.sortByPageNumber || kept.length < 2) return kept;
	const numbers = kept.map((p) => pathNumbers(p.url));
	const width = numbers[0].length;
	if (width === 0 || numbers.some((n) => n.length !== width)) return kept;
	const varying = [...Array(width).keys()].filter((i) => numbers.some((n) => n[i] !== numbers[0][i]));
	if (varying.length !== 1) return kept;
	const at = varying[0];
	return kept
		.map((page, index) => ({ page, key: numbers[index][at], index }))
		.sort((a, b) => a.key - b.key || a.index - b.index)
		.map((entry) => entry.page);
}

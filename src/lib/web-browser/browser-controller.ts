/**
 * The in-app browser's state on the app side: what the native browser reports (navigation, progress, the page
 * finder's findings), the collecting of pages on viewers that show one page at a time, and the settings it obeys.
 * The browser screen renders from these stores; the Back ladder and the Tabs button act through the functions.
 */

import { get, writable } from 'svelte/store';
import { appView } from '$lib/stores/reader-state.js';
import { settings } from '$lib/settings/settings.js';
import { pushToast } from '$lib/stores/toasts.js';
import { browserAvailable, browserNative, onBrowserEvent, type BrowserNavState } from './browser-bridge.js';
import { addCollected, parseFinderReport, parseLinkTap, readablePages, type FinderPage, type FinderReport, type LinkTap } from './finder-report.js';
import { openWebChapter } from './web-chapter.js';
import type { SaveDetails, SavedChapterView } from './web-chapter-store.js';
import type { VolumeMetadata } from '$lib/types/index.js';
import finderSource from './page-finder.inject.js?raw';

const EMPTY_NAV: BrowserNavState = { created: false, visible: false, url: '', title: '', canGoBack: false, canGoForward: false };

export const browserNav = writable<BrowserNavState>(EMPTY_NAV);
/** 0–100 while a page loads; 100 when it has. */
export const browserProgress = writable(100);
/** What the page finder found on the page now shown; null until it reports. */
export const finderReport = writable<FinderReport | null>(null);
/** Pages collected on a one-page-at-a-time viewer; null when not collecting. */
export const collectedPages = writable<FinderPage[] | null>(null);
/** Requests blocked on the page now shown. */
export const blockedOnPage = writable(0);
/** The last link tapped, and from where: how a chapter was reached (kept for saved chapters). */
export const lastLinkTap = writable<LinkTap | null>(null);
/** True while the browser's page is replaced by a still image so the app can draw over its rectangle. */
export const browserCovered = writable(false);
export const browserSnapshot = writable<string | null>(null);
/** The start page (saved chapters) shown over a loaded page, from the menu. */
export const showStartPage = writable(false);
/** Titles of recently shown pages, so a saved chapter's series can be named after the page it was reached from. */
const pageTitles = new Map<string, string>();
/** The latest favicon per site (small PNG, base64): a saved series' icon. */
const siteIcons = new Map<string, string>();

export function titleOfPage(url: string): string | undefined {
	return pageTitles.get(url);
}

export function iconOfSite(host: string): string | undefined {
	return siteIcons.get(host);
}

/** A saved chapter being opened again through its site. */
export interface ReopenState {
	volumeUuid: string;
	title: string;
	/** 'site': its address is loading; 'retrace': the link that led to it is being followed again; 'manual': over to the person. */
	phase: 'site' | 'retrace' | 'manual';
}
export const reopening = writable<ReopenState | null>(null);

/** Closes whatever of the browser screen's own is open over the page (its menu); Back asks it first. */
export const browserTransientClose = writable<(() => void) | null>(null);

let installed = false;
let finderInstalled = false;

/** Whether a web page (not the start page) is loaded. */
export function hasPage(nav: BrowserNavState): boolean {
	return nav.created && /^https?:/i.test(nav.url);
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

function syncBlocking(): void {
	const s = get(settings);
	browserNative.setBlocking(s.browserAdBlock, s.browserAdBlockOffHosts);
}

/** Starts listening to the browser and keeps it in step with Settings. Android only, and only where it can run. */
export function installBrowserController(): () => void {
	if (installed || !browserAvailable()) return () => undefined;
	installed = true;
	const stopEvents = onBrowserEvent((event) => {
		switch (event.type) {
			case 'nav': {
				const previous = get(browserNav).url;
				browserNav.set({ created: event.created, visible: event.visible, url: event.url, title: event.title, canGoBack: event.canGoBack, canGoForward: event.canGoForward });
				if (event.url && event.title) {
					pageTitles.set(event.url, event.title);
					if (pageTitles.size > 100) pageTitles.delete(pageTitles.keys().next().value as string);
				}
				// A different document: what the finder found belonged to the last one. Single-page apps keep the
				// document and report again on their own.
				if (event.url !== previous && !sameDocument(previous, event.url)) finderReport.set(null);
				break;
			}
			case 'progress':
				browserProgress.set(event.progress);
				break;
			case 'finder': {
				const report = parseFinderReport(event.data, event.url);
				if (!report) break;
				finderReport.set(report);
				collectedPages.update((pages) => (pages ? addCollected(pages, report) : pages));
				onReopenReport(report);
				break;
			}
			case 'link': {
				const tap = parseLinkTap(event.data);
				if (tap) lastLinkTap.set(tap);
				break;
			}
			case 'blocked':
				blockedOnPage.set(event.count);
				break;
			case 'icon':
				if (event.host && event.png && event.png.length < 64_000) siteIcons.set(event.host, event.png);
				break;
			case 'crashed':
				browserNav.set(EMPTY_NAV);
				finderReport.set(null);
				pushToast({ message: { code: 'browser_page_crashed' }, tone: 'error' });
				break;
		}
	});
	let last = '';
	const stopSettings = settings.subscribe((s) => {
		const key = JSON.stringify([s.browserAdBlock, s.browserAdBlockOffHosts]);
		if (key === last) return;
		last = key;
		syncBlocking();
	});
	return () => {
		stopEvents();
		stopSettings();
		installed = false;
	};
}

function sameDocument(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
	} catch {
		return false;
	}
}

/** The finder is installed before the first page loads, and applies to every page after it. */
export function ensureFinderInstalled(): void {
	if (finderInstalled) return;
	finderInstalled = true;
	browserNative.setFinderScript(finderSource);
	syncBlocking();
}

export function openBrowser(): void {
	ensureFinderInstalled();
	appView.set('browser');
}

/** The Back ladder's rung: page history first, then out to Tabs. */
export function browserBack(): void {
	const close = get(browserTransientClose);
	if (close) {
		close();
		return;
	}
	if (get(showStartPage) && hasPage(get(browserNav))) {
		showStartPage.set(false);
		return;
	}
	if (get(reopening)) {
		cancelReopen();
		return;
	}
	if (get(collectedPages)) {
		collectedPages.set(null);
		return;
	}
	if (get(browserNav).canGoBack) {
		browserNative.back();
		return;
	}
	appView.set('tabs');
}

export function navigate(url: string): void {
	ensureFinderInstalled();
	finderReport.set(null);
	browserNative.load(url);
}

/** What Read opens: the collected pages in page order, or the gallery as the page lays it out. */
export function pagesToRead(collected: FinderPage[] | null, report: FinderReport | null): FinderPage[] {
	if (collected) return readablePages(collected, { sortByPageNumber: true });
	return report ? readablePages(report.pages, { sortByPageNumber: false }) : [];
}

export async function readPages(pages: FinderPage[]): Promise<void> {
	const nav = get(browserNav);
	if (pages.length === 0 || !hasPage(nav)) return;
	collectedPages.set(null);
	const target = get(reopening);
	reopening.set(null);
	clearReopenTimer();
	const result = await openWebChapter(pages, nav.url, nav.title);
	// Pages of a saved chapter open that chapter wherever they turn up. Say so when they turned up somewhere else
	// than where it was saved, or than the chapter asked for: otherwise it looks as if the app chose the chapter.
	if (result.saved && (target ? result.saved.volume_uuid !== target.volumeUuid : !sameDocumentUrl(result.saved.chapterUrl, nav.url))) {
		pushToast({ message: { code: 'browser_reopen_other', params: { title: result.saved.title } } });
	}
}

/** What the save dialog starts from, for the web chapter `volume`: its title, its series, how it was reached. */
export function saveDefaults(volume: VolumeMetadata): SaveDetails | null {
	if (volume.source?.type !== 'web') return null;
	const { pageUrl, siteHost } = volume.source;
	const via = reachedBy(pageUrl);
	return {
		chapterTitle: volume.title,
		seriesTitle: (via && titleOfPage(via.fromUrl)) || siteHost,
		siteHost,
		chapterUrl: pageUrl,
		seriesUrl: via?.fromUrl ?? pageUrl,
		fromUrl: via?.fromUrl,
		linkHref: via?.linkHref,
		icon: iconOfSite(siteHost)
	};
}

/** The link tap that led to `url`, if the last one did. */
function reachedBy(url: string): { fromUrl: string; linkHref: string } | null {
	const tap = get(lastLinkTap);
	return tap && tap.href === url ? { fromUrl: tap.from, linkHref: tap.href } : null;
}

// ---- reopening a saved chapter through its site ---------------------------------------------------------------

const SITE_WAIT_MS = 15_000;
const RETRACE_WAIT_MS = 12_000;
/** How long a gallery may go on loading its images before a reopen takes the pages it has. */
const SETTLE_MS = 8_000;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let reopenTarget: SavedChapterView | null = null;
let matching = false;
/** Whether the gallery on the page is being given time to load its images (`onReopenReport`). */
let settle: 'idle' | 'waiting' | 'over' = 'idle';

function clearReopenTimer(): void {
	if (reopenTimer) clearTimeout(reopenTimer);
	reopenTimer = null;
	settle = 'idle';
}

export function cancelReopen(): void {
	clearReopenTimer();
	reopenTarget = null;
	reopening.set(null);
}

/**
 * Opens a saved chapter again the way it was read: through its site. Its address is loaded first; if the pages that
 * appear are not the chapter (or none appear), the page it was reached from is loaded and the same link tapped; if
 * that fails too, the person is asked to find it — reading its pages from anywhere opens it, by their fingerprints.
 */
export function reopenSavedChapter(view: SavedChapterView): void {
	cancelReopen();
	reopenTarget = view;
	reopening.set({ volumeUuid: view.chapter.volume_uuid, title: view.chapter.title, phase: 'site' });
	showStartPage.set(false);
	openBrowser();
	navigate(view.chapter.chapterUrl);
	reopenTimer = setTimeout(() => void retrace(), SITE_WAIT_MS);
}

async function retrace(): Promise<void> {
	clearReopenTimer();
	const target = reopenTarget;
	const state = get(reopening);
	if (!target || !state) return;
	const { fromUrl, linkHref } = target.chapter;
	if (state.phase !== 'site' || !fromUrl || !linkHref) {
		reopening.set({ ...state, phase: 'manual' });
		return;
	}
	reopening.set({ ...state, phase: 'retrace' });
	navigate(fromUrl);
	// Give the page time to load and draw its links, then tap the one that led to the chapter.
	const started = Date.now();
	const tryTap = async (): Promise<void> => {
		if (get(reopening)?.phase !== 'retrace') return;
		const nav = get(browserNav);
		const ready = nav.url && sameDocumentUrl(nav.url, fromUrl) && get(browserProgress) >= 100;
		if (ready) {
			const tapped = await browserNative.evaluate(
				`(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => x.href === ${JSON.stringify(linkHref)}); if (!a) return false; a.scrollIntoView({ block: 'center' }); a.click(); return true; })()`
			);
			if (tapped === true) {
				reopenTimer = setTimeout(() => giveUpReopen(), RETRACE_WAIT_MS);
				return;
			}
		}
		if (Date.now() - started > RETRACE_WAIT_MS) return giveUpReopen();
		reopenTimer = setTimeout(() => void tryTap(), 1000);
	};
	reopenTimer = setTimeout(() => void tryTap(), 1500);
}

function giveUpReopen(): void {
	clearReopenTimer();
	const state = get(reopening);
	if (state) reopening.set({ ...state, phase: 'manual' });
}

function sameDocumentUrl(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
	} catch {
		return a === b;
	}
}

/** While reopening, a gallery that appears is checked against the saved chapters; the chapter opens if it is one. */
function onReopenReport(report: FinderReport): void {
	const state = get(reopening);
	if (!state || state.phase === 'manual' || matching || report.kind !== 'gallery') return;
	const nav = get(browserNav);
	if (!hasPage(nav)) return;
	// A gallery's pages are reported as their images arrive. Matching the first report opened the chapter with the
	// pages that happened to have loaded (6 of 14 on a slow connection), so its images get time to finish first.
	if (report.loading > 0 && settle !== 'over') {
		if (settle === 'idle') {
			clearReopenTimer();
			settle = 'waiting';
			reopenTimer = setTimeout(settleOver, SETTLE_MS);
		}
		return;
	}
	clearReopenTimer();
	matching = true;
	void (async () => {
		try {
			const pages = readablePages(report.pages, { sortByPageNumber: false });
			const result = await openWebChapter(pages, nav.url, nav.title, { expect: state.volumeUuid });
			if (!get(reopening)) return;
			if (result.opened) {
				cancelReopen();
				return;
			}
			// Not the chapter: the site shows something else under its address — say so when it is another saved one.
			if (result.saved) pushToast({ message: { code: 'browser_reopen_other', params: { title: result.saved.title } } });
			if (state.phase === 'site') void retrace();
			else giveUpReopen();
		} finally {
			matching = false;
		}
	})();
}

/** The gallery's images took too long: it is matched as it is — or, gone from the page, counts as not found. */
function settleOver(): void {
	reopenTimer = null;
	settle = 'over';
	const report = get(finderReport);
	if (report?.kind === 'gallery' && hasPage(get(browserNav))) return onReopenReport(report);
	if (get(reopening)?.phase === 'site') void retrace();
	else giveUpReopen();
}

export function startCollecting(): void {
	const report = get(finderReport);
	collectedPages.set(report ? addCollected([], report) : []);
}

export function stopCollecting(): void {
	collectedPages.set(null);
}

/** The per-site switch: ad blocking off (or back on) for the site now shown. */
export function toggleBlockingForSite(): void {
	const host = hostOf(get(browserNav).url);
	if (!host) return;
	settings.update((s) => {
		const off = new Set(s.browserAdBlockOffHosts);
		if (off.has(host)) off.delete(host);
		else off.add(host);
		return { ...s, browserAdBlockOffHosts: [...off] };
	});
	browserNative.reload();
}

/**
 * Something of the app's must draw over the browser's rectangle (a menu, a dialog): the native page cannot be drawn
 * over, so it is swapped for a still image of itself until the app is done.
 */
export async function coverBrowser(covered: boolean): Promise<void> {
	if (covered === get(browserCovered)) return;
	if (covered) {
		// The still image first: covering hides the native page, and a hidden page cannot be captured.
		browserSnapshot.set(await browserNative.snapshot());
		browserCovered.set(true);
	} else {
		browserCovered.set(false);
		browserSnapshot.set(null);
	}
}

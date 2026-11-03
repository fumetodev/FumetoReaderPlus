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
	await openWebChapter(pages, nav.url, nav.title);
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

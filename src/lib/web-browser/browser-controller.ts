/**
 * The in-app browser's state on the app side: its tabs, and for each what the native browser reports (navigation,
 * progress, the page finder's findings) and the pages gathered from a viewer that shows one at a time. The stores below
 * are the tab on screen's: the browser screen renders from them, and the Back ladder and the Tabs view act through the
 * functions.
 */

import { get, writable } from 'svelte/store';
import { db } from '$lib/db/index.js';
import { appView } from '$lib/stores/reader-state.js';
import { settings } from '$lib/settings/settings.js';
import { pushToast } from '$lib/stores/toasts.js';
import { randomUUID } from '$lib/util/uuid.js';
import { browserAvailable, browserNative, onBrowserEvent, type BrowserNavState } from './browser-bridge.js';
import { addCollected, collectedAfter, parseFinderReport, parseLinkTap, readablePages, type FinderPage, type FinderReport, type LinkTap } from './finder-report.js';
import { chapterAwaitingCheck, leaveToPassCheck, openRememberedChapter, openWebChapter, returnToChapter, saveFoundPages } from './web-chapter.js';
import { bookmarkedAddresses, setBookmark, type SaveDetails, type SavedChapterView } from './web-chapter-store.js';
import type { BrowserTabRecord, VolumeMetadata } from '$lib/types/index.js';
import finderSource from './page-finder.inject.js?raw';

const EMPTY_NAV: BrowserNavState = { created: false, visible: false, url: '', title: '', canGoBack: false, canGoForward: false };

export const browserNav = writable<BrowserNavState>(EMPTY_NAV);
/** 0–100 while a page loads; 100 when it has. */
export const browserProgress = writable(100);
/** What the page finder found on the page now shown; null until it reports. */
export const finderReport = writable<FinderReport | null>(null);
/** Pages gathered from a viewer that shows some at a time; null when the page's own report says it all. */
export const collectedPages = writable<FinderPage[] | null>(null);
/** Requests blocked on the page now shown. */
export const blockedOnPage = writable(0);
/** The last link tapped, and from where: how a chapter was reached (kept for saved chapters). */
export const lastLinkTap = writable<LinkTap | null>(null);
/** True while the browser's page is replaced by a still image so the app can draw over its rectangle. */
export const browserCovered = writable(false);
export const browserSnapshot = writable<string | null>(null);
/** The start page (bookmarks and saved chapters) shown over a loaded page. */
export const showStartPage = writable(false);
/** An address is on its way to a tab with no page yet: it shows nothing rather than flash the start page. */
export const browserNavigating = writable(false);
/** The tab on screen has a page to go back to that the system closed while it was covered. */
export const browserPageWaiting = writable(false);
/** The tabs, oldest first, for the Tabs view. */
export const browserTabs = writable<BrowserTabRecord[]>([]);
/** The addresses of the pages bookmarked. */
export const bookmarks = writable<Set<string>>(new Set());
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

/** The site's name, as the native browser compares it (no port). */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

function syncBlocking(): void {
	const s = get(settings);
	browserNative.setBlocking(s.browserAdBlock, s.browserAdBlockOffHosts);
}

// ---- tabs ---------------------------------------------------------------------------------------------------------

/** What a tab is up to while the app runs. Its record is what survives a restart. */
interface TabState {
	nav: BrowserNavState;
	progress: number;
	report: FinderReport | null;
	collected: FinderPage[] | null;
	/** A new page has not shown any pages yet: what was gathered waits, out of sight, in case it does. */
	gatheredWaiting: boolean;
	blocked: number;
	linkTap: LinkTap | null;
	/** Why the start page is over its page. From the menu, Back returns to the page; from Back, it goes on to Tabs. */
	startPage: 'menu' | 'back' | false;
	/**
	 * A page to load when the person next comes to this tab, never before: nothing contacts a site at launch, and a page
	 * the system closed for memory, loaded while they stay away, would only be closed again.
	 */
	restore: string | null;
	navigating: boolean;
}

const freshState = (restore: string | null = null): TabState => ({
	nav: EMPTY_NAV, progress: 100, report: null, collected: null, gatheredWaiting: false, blocked: 0, linkTap: null, startPage: false, restore, navigating: false
});

const states = new Map<string, TabState>();
let activeId: string | null = null;
let navigatingTimer: ReturnType<typeof setTimeout> | null = null;

function activeState(): TabState | null {
	return activeId ? (states.get(activeId) ?? null) : null;
}

/** The stores show the tab on screen. */
function mirror(): void {
	const tab = activeState();
	browserNav.set(tab?.nav ?? EMPTY_NAV);
	browserProgress.set(tab?.progress ?? 100);
	finderReport.set(tab?.report ?? null);
	collectedPages.set(tab && !tab.gatheredWaiting ? tab.collected : null);
	blockedOnPage.set(tab?.blocked ?? 0);
	lastLinkTap.set(tab?.linkTap ?? null);
	showStartPage.set(!!tab?.startPage);
	browserNavigating.set(!!tab?.navigating);
	browserPageWaiting.set(!!tab?.restore);
}

const unsaved = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveTabsSoon(id: string): void {
	unsaved.add(id);
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		const records = get(browserTabs).filter((r) => unsaved.has(r.id));
		unsaved.clear();
		void db.browser_tabs.bulkPut(records).catch((error) => console.warn('[browser] Could not keep the tabs:', error));
	}, 400);
}

function updateRecord(id: string, patch: Partial<BrowserTabRecord>): void {
	let changed = false;
	browserTabs.update((records) =>
		records.map((record) => {
			if (record.id !== id) return record;
			const next = { ...record, ...patch };
			changed = (Object.keys(patch) as (keyof BrowserTabRecord)[]).some((key) => record[key] !== next[key]);
			return changed ? next : record;
		})
	);
	if (changed) saveTabsSoon(id);
}

/** The tab everything goes to from now on. A tab whose page is waiting for it loads it here, if it is on screen. */
function selectTab(id: string): void {
	const switching = id !== activeId;
	if (switching) cancelReopen();
	activeId = id;
	ensureFinderInstalled();
	browserNative.selectTab(id);
	updateRecord(id, { lastActiveAt: new Date().toISOString() });
	mirror();
	restorePage();
}

function ensureActiveTab(): void {
	if (activeId) return;
	const newest = get(browserTabs).at(-1);
	if (newest) selectTab(newest.id);
	else selectTab(createTab());
}

function createTab(): string {
	const now = new Date().toISOString();
	const position = (get(browserTabs).at(-1)?.position ?? -1) + 1;
	const record: BrowserTabRecord = { id: randomUUID(), position, url: '', title: '', siteHost: '', openedAt: now, lastActiveAt: now };
	states.set(record.id, freshState());
	browserTabs.update((records) => [...records, record]);
	saveTabsSoon(record.id);
	return record.id;
}

/** Opens a tab on the browser screen. */
export function openBrowserTab(id: string): void {
	if (!states.has(id)) return;
	selectTab(id);
	appView.set('browser');
}

/** The Tabs button: a new tab, on the start page. A tab already waiting there is used rather than another added. */
export function openNewBrowserTab(): void {
	const blank = get(browserTabs).find((record) => !record.url && !states.get(record.id)?.navigating);
	openBrowserTab(blank?.id ?? createTab());
}

export function closeBrowserTab(id: string): void {
	if (id === activeId) {
		cancelReopen();
		activeId = null;
	}
	states.delete(id);
	unsaved.delete(id);
	browserNative.closeTab(id);
	browserTabs.update((records) => records.filter((record) => record.id !== id));
	void db.browser_tabs.delete(id).catch((error) => console.warn('[browser] Could not forget a tab:', error));
	mirror();
}

/** Clearing browsing data takes the tabs with it: their addresses are browsing data too. */
export async function closeAllBrowserTabs(): Promise<void> {
	for (const record of get(browserTabs)) closeBrowserTab(record.id);
	await db.browser_tabs.clear();
}

/** Starts listening to the browser and keeps it in step with Settings. Android only, and only where it can run. */
export function installBrowserController(): () => void {
	if (installed || !browserAvailable()) return () => undefined;
	installed = true;
	const stopEvents = onBrowserEvent((event) => {
		const tab = states.get(event.tab);
		if (!tab) return;
		const shown = event.tab === activeId;
		let found: FinderReport | null = null;
		switch (event.type) {
			case 'nav': {
				tab.nav = { created: event.created, visible: event.visible, url: event.url, title: event.title, canGoBack: event.canGoBack, canGoForward: event.canGoForward };
				if (hasPage(tab.nav)) {
					if (tab.navigating) {
						tab.navigating = false;
						if (navigatingTimer) clearTimeout(navigatingTimer);
					}
					const siteHost = hostOf(event.url);
					const icon = get(browserTabs).find((record) => record.id === event.tab)?.siteHost === siteHost ? {} : { icon: undefined };
					updateRecord(event.tab, { url: event.url, title: event.title, siteHost, ...icon });
				}
				if (event.url && event.title) {
					pageTitles.set(event.url, event.title);
					if (pageTitles.size > 100) pageTitles.delete(pageTitles.keys().next().value as string);
				}
				// A different document: what the finder found belonged to the last one. A page that changes its own
				// address (a reader counting pages as they scroll by) is the same document, and the finder reports
				// only what changes, so nothing would bring back the pages it found.
				if (event.newDocument) {
					// Pages turned on another site are not this site's chapter. On this site they may be the next page of a
					// viewer that loads a page for each, or may be nothing to do with where the person went: until that page
					// shows some, the bar does not go on offering them.
					if (tab.collected && gatheredOn.get(event.tab) !== hostOf(event.url)) tab.collected = null;
					tab.gatheredWaiting = !!tab.collected;
					tab.report = null;
					tab.blocked = 0;
				}
				break;
			}
			case 'progress':
				tab.progress = event.progress;
				break;
			case 'finder': {
				const report = parseFinderReport(event.data, event.url);
				if (!report) break;
				tab.collected = collectedAfter(tab.collected, tab.report, report);
				if (tab.collected) gatheredOn.set(event.tab, hostOf(report.at));
				if (report.kind === 'single' || report.kind === 'gallery') tab.gatheredWaiting = false;
				tab.report = report;
				found = report;
				break;
			}
			case 'link': {
				const tap = parseLinkTap(event.data);
				if (tap) tab.linkTap = tap;
				// Moving on from a page with no pages on it: the person has left that chapter behind.
				if (tap && tab.gatheredWaiting && tab.report?.kind === 'none') {
					tab.collected = null;
					tab.gatheredWaiting = false;
				}
				break;
			}
			case 'blocked':
				tab.blocked = event.count;
				break;
			case 'icon':
				if (event.host && event.png && event.png.length < 64_000) {
					siteIcons.set(event.host, event.png);
					updateRecord(event.tab, { icon: event.png });
				}
				break;
			case 'backExhausted':
				if (shown) tab.startPage = 'back';
				break;
			case 'crashed':
				tab.nav = EMPTY_NAV;
				tab.report = null;
				if (shown) cancelReopen();
				// Not on screen: the system took its memory back, and nothing went wrong that the person can see.
				if (event.hidden && event.url && /^https?:/i.test(event.url)) {
					tab.restore = event.url;
				} else {
					updateRecord(event.tab, { url: '', title: '', siteHost: '' });
					pushToast({ message: { code: 'browser_page_crashed' }, tone: 'error' });
				}
				break;
		}
		if (shown) {
			mirror();
			if (found) onReopenReport(found);
		}
	});
	const stopView = appView.subscribe((view) => {
		if (view === 'browser') {
			ensureActiveTab();
			restorePage();
		}
		// Gone elsewhere: a chapter must not open over whatever the person went on to.
		else if (view !== 'reader' && view !== 'settings' && get(reopening)) cancelReopen();
	});
	document.addEventListener('visibilitychange', restorePage);
	let last = '';
	const stopSettings = settings.subscribe((s) => {
		const key = JSON.stringify([s.browserAdBlock, s.browserAdBlockOffHosts]);
		if (key === last) return;
		last = key;
		syncBlocking();
	});
	// The tabs of the last run come back as cards; none contacts its site until it is opened.
	void db.browser_tabs.orderBy('position').toArray().then((records) => {
		for (const record of records) if (!states.has(record.id)) states.set(record.id, freshState(record.url || null));
		browserTabs.update((created) => [...records, ...created.filter((tab) => !records.some((record) => record.id === tab.id))]);
		restorePage();
	}).catch((error) => console.warn('[browser] Could not read the tabs:', error));
	void refreshBookmarks();
	return () => {
		stopEvents();
		stopView();
		document.removeEventListener('visibilitychange', restorePage);
		stopSettings();
		installed = false;
	};
}

/** Which site a tab's gathered pages came from. */
const gatheredOn = new Map<string, string>();

function restorePage(): void {
	const tab = activeState();
	if (!tab?.restore || tab.startPage || get(appView) !== 'browser' || document.visibilityState !== 'visible') return;
	navigate(tab.restore);
}

/** The finder is installed before the first page loads, and applies to every page after it. */
export function ensureFinderInstalled(): void {
	if (finderInstalled) return;
	finderInstalled = true;
	browserNative.setFinderScript(finderSource);
	syncBlocking();
}

/** Comes to the browser screen, on the tab it was left on. */
export function openBrowser(): void {
	ensureActiveTab();
	ensureFinderInstalled();
	appView.set('browser');
}

/** The start page over the page on screen, from the menu. */
export function openStartPage(): void {
	const tab = activeState();
	if (!tab) return;
	tab.startPage = 'menu';
	mirror();
}

export function closeStartPage(): void {
	const tab = activeState();
	if (!tab) return;
	tab.startPage = false;
	mirror();
	restorePage();
}

/** Back on the page itself. With nothing before the page, the tab's start page is what came before it. */
export function pageBack(): void {
	const tab = activeState();
	if (!tab) return;
	if (tab.nav.canGoBack) {
		browserNative.back();
		return;
	}
	tab.startPage = 'back';
	mirror();
}

/** The Back ladder's rung: page history first, then the tab's start page, then out to Tabs. */
export function browserBack(): void {
	const close = get(browserTransientClose);
	if (close) {
		close();
		return;
	}
	if (get(chapterAwaitingCheck)) {
		returnToChapter();
		return;
	}
	if (get(reopening)) {
		cancelReopen();
		return;
	}
	const tab = activeState();
	if (tab?.startPage) {
		const from = tab.startPage;
		if (from === 'menu' && tab.restore) return closeStartPage();
		tab.startPage = false;
		mirror();
		if (from === 'back' || !hasPage(tab.nav)) appView.set('tabs');
		return;
	}
	if (tab && hasPage(tab.nav)) {
		pageBack();
		return;
	}
	appView.set('tabs');
	// Opened and left without going anywhere: nothing to come back to.
	if (activeId && tab && !tab.navigating && !tab.restore) closeBrowserTab(activeId);
}

export function navigate(url: string): void {
	ensureActiveTab();
	const tab = activeState();
	if (!tab) return;
	ensureFinderInstalled();
	tab.restore = null;
	tab.report = null;
	tab.navigating = !hasPage(tab.nav);
	if (tab.navigating) {
		const id = activeId;
		if (navigatingTimer) clearTimeout(navigatingTimer);
		// A blocked address never begins: the start page comes back rather than an empty screen staying up.
		navigatingTimer = setTimeout(() => {
			const waiting = id ? states.get(id) : null;
			if (!waiting?.navigating) return;
			waiting.navigating = false;
			mirror();
		}, 10_000);
	}
	tab.startPage = false;
	mirror();
	browserNative.load(url);
}

/** What Read opens: the pages gathered in page order, or the gallery as the page lays it out. */
export function pagesToRead(collected: FinderPage[] | null, report: FinderReport | null): FinderPage[] {
	if (collected) return readablePages(collected, { sortByPageNumber: true });
	return report ? readablePages(report.pages, { sortByPageNumber: false }) : [];
}

export async function readPages(pages: FinderPage[]): Promise<void> {
	const nav = get(browserNav);
	if (pages.length === 0 || !hasPage(nav)) return;
	const target = get(reopening);
	reopening.set(null);
	clearReopenTimer();
	reopenTarget = null;
	checkingRemembered = false;
	const tab = activeState();
	const result = await openWebChapter(pages, nav.url, nav.title);
	// Kept until the chapter opens: flipping through a whole chapter is not something to ask of anyone twice.
	if (result.opened && tab) {
		tab.collected = null;
		tab.gatheredWaiting = false;
		mirror();
	}
	// Pages of a saved chapter open that chapter wherever they turn up. Say so when they turned up somewhere else
	// than where it was saved, or than the chapter asked for: otherwise it looks as if the app chose the chapter.
	if (result.saved && (target ? result.saved.volume_uuid !== target.volumeUuid : !sameDocumentUrl(result.saved.chapterUrl, nav.url))) {
		pushToast({ message: { code: 'browser_reopen_other', params: { title: result.saved.title } } });
	}
}

/** Saving the pages found without reading them now. */
export async function saveFound(pages: FinderPage[], details: SaveDetails): Promise<void> {
	const nav = get(browserNav);
	if (pages.length === 0 || !hasPage(nav)) return;
	const { saved, existed } = await saveFoundPages(pages, nav.url, nav.title, details);
	pushToast({ message: existed ? { code: 'browser_already_saved', params: { title: saved.title } } : { code: 'browser_chapter_saved' } });
}

/** Passing a site's check for the chapter open in the reader: the browser shows the site, and the chapter waits. */
export function openSiteForCheck(volume: VolumeMetadata): void {
	if (volume.source?.type !== 'web') return;
	const { pageUrl } = volume.source;
	leaveToPassCheck(volume);
	navigate(pageUrl);
}

/** What a chapter's save dialog starts from: its title, its series, how it was reached. */
function saveDetails(chapterTitle: string, pageUrl: string, siteHost: string): SaveDetails {
	const via = reachedBy(pageUrl);
	return {
		chapterTitle,
		seriesTitle: (via && titleOfPage(via.fromUrl)) || siteHost,
		siteHost,
		chapterUrl: pageUrl,
		seriesUrl: via?.fromUrl ?? pageUrl,
		fromUrl: via?.fromUrl,
		linkHref: via?.linkHref,
		icon: iconOfSite(hostOf(pageUrl))
	};
}

export function saveDefaults(volume: VolumeMetadata): SaveDetails | null {
	if (volume.source?.type !== 'web') return null;
	return saveDetails(volume.title, volume.source.pageUrl, volume.source.siteHost);
}

/** The same, for the page on screen. */
export function saveDefaultsForPage(): SaveDetails | null {
	const nav = get(browserNav);
	if (!hasPage(nav)) return null;
	return saveDetails(nav.title.trim() || new URL(nav.url).host, nav.url, new URL(nav.url).host);
}

/** The link tap that led to `url`, if the last one did. */
function reachedBy(url: string): { fromUrl: string; linkHref: string } | null {
	const tap = get(lastLinkTap);
	return tap && sameDocumentUrl(tap.href, url) ? { fromUrl: tap.from, linkHref: tap.href } : null;
}

// ---- bookmarks ----------------------------------------------------------------------------------------------------

async function refreshBookmarks(): Promise<void> {
	bookmarks.set(await bookmarkedAddresses());
}

/** Bookmarks the page on screen, or takes the bookmark off. */
export async function toggleBookmark(): Promise<void> {
	const nav = get(browserNav);
	if (!hasPage(nav)) return;
	const url = new URL(nav.url);
	const on = !get(bookmarks).has(nav.url);
	await setBookmark(on, { url: nav.url, title: nav.title.trim() || url.host, siteHost: url.host, icon: iconOfSite(url.hostname) });
	await refreshBookmarks();
	if (on) pushToast({ message: { code: 'browser_bookmarked' } });
}

/** Takes a bookmark off from the start page. */
export async function removeBookmark(url: string): Promise<void> {
	await setBookmark(false, { url, title: '', siteHost: '' });
	await refreshBookmarks();
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
let retraceTapped = false;
let pagesBeforeTap = '';

const pageAddresses = (report: FinderReport | null): string => (report?.pages ?? []).map((p) => p.url).join('\n');

/** Its remembered images are being checked: nothing the page on screen shows has any say yet. */
let checkingRemembered = false;

function clearReopenTimer(): void {
	if (reopenTimer) clearTimeout(reopenTimer);
	reopenTimer = null;
	settle = 'idle';
}

export function cancelReopen(): void {
	clearReopenTimer();
	reopenTarget = null;
	checkingRemembered = false;
	reopening.set(null);
}

/**
 * Opens a saved chapter again. The images it was read from are tried first, and checked against their fingerprints: a
 * site's address may not show the chapter again, and a viewer that shows one page at a time never shows all of it. Where
 * they are gone, it goes through the site: its address, and if the pages that appear are not the chapter (or none appear),
 * the page it was reached from and the same link tapped; if that fails too, the person is asked to find it — reading its
 * pages from anywhere opens it, by their fingerprints.
 */
export function reopenSavedChapter(view: SavedChapterView): void {
	cancelReopen();
	reopenTarget = view;
	reopening.set({ volumeUuid: view.chapter.volume_uuid, title: view.chapter.title, phase: 'site' });
	openBrowser();
	checkingRemembered = true;
	void (async () => {
		const opened = await openRememberedChapter(view.chapter, () => reopenTarget === view).catch(() => false);
		if (reopenTarget !== view) return;
		checkingRemembered = false;
		if (opened) {
			cancelReopen();
			return;
		}
		navigate(view.chapter.chapterUrl);
		reopenTimer = setTimeout(() => void retrace(), SITE_WAIT_MS);
	})();
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
	retraceTapped = false;
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
			// Cancelled, or another chapter asked for, while the page was answering.
			if (reopenTarget !== target || get(reopening)?.phase !== 'retrace') return;
			if (tapped === true) {
				retraceTapped = true;
				pagesBeforeTap = pageAddresses(get(finderReport));
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
	if (!state || state.phase === 'manual' || matching || checkingRemembered || report.kind !== 'gallery') return;
	const nav = get(browserNav);
	if (!hasPage(nav)) return;
	// Still on the page the chapter was reached from: what is found here (a series' covers) is not the chapter, and
	// checking it would stop the link being tapped. The address cannot tell: a viewer can open over that page without
	// changing it, so it is the tap, and then pages other than the ones already there.
	if (state.phase === 'retrace' && (!retraceTapped || pageAddresses(report) === pagesBeforeTap)) return;
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
			const result = await openWebChapter(pages, nav.url, nav.title, {
				expect: state.volumeUuid,
				stillWanted: () => get(reopening)?.volumeUuid === state.volumeUuid
			});
			// Cancelled, or another chapter asked for, while this one was being checked.
			if (get(reopening)?.volumeUuid !== state.volumeUuid) return;
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

/** Starts gathering again from the page on screen. */
export function startOverCollecting(): void {
	const tab = activeState();
	if (!tab) return;
	tab.collected = tab.report?.kind === 'single' || tab.report?.pager ? addCollected([], tab.report) : null;
	tab.gatheredWaiting = false;
	mirror();
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
		// The page closed while this covered it, and the person is back looking for it.
		restorePage();
	}
}

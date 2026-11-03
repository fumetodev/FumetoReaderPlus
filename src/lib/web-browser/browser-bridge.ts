/**
 * The app's handle on the in-app browser (`__fumeto_browser`, `browser/BrowserBridge.kt`). Android only: where the
 * bridge is absent, or the system WebView cannot give the browser a profile of its own, the browser is not offered.
 *
 * The browser is a second, native WebView laid over the app's in a rectangle the app reserves. It has no JavaScript
 * interface: pages reach the app only as the page finder's reports, delivered here as `fumeto:browser` events.
 */

interface BrowserNativeBridge {
	isAvailable(): boolean;
	show(rectJson: string): void;
	setRect(rectJson: string): void;
	hide(): void;
	load(url: string): void;
	back(): void;
	forward(): void;
	reload(): void;
	stop(): void;
	state(): string;
	setFinderScript(src: string): void;
	evaluate(js: string, callbackId: string): void;
	setBlocking(enabled: boolean, exemptHostsJson: string): void;
	refreshLists(force: boolean, callbackId: string): void;
	listsStatus(): string;
	snapshot(callbackId: string): void;
	clearData(callbackId: string): void;
	fetchPage(url: string, pageUrl: string, relPath: string, callbackId: string): void;
	cancel(callbackId: string): void;
}

declare global {
	interface Window {
		__fumeto_browser?: BrowserNativeBridge;
		__browser_native_resolve?: (id: string, json: string) => void;
		__browser_native_reject?: (id: string, message: string) => void;
	}
}

export interface BrowserRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface BrowserNavState {
	created: boolean;
	visible: boolean;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
}

export interface BrowserListsStatus {
	domains: number;
	refreshing: boolean;
	lists: { name: string; url: string; updatedAt: number; bytes: number }[];
}

/** Everything the browser reports. `finder` and `link` carry page data: validate before use (`finder-report.ts`). */
export type BrowserEvent =
	| ({ type: 'nav' } & BrowserNavState)
	| { type: 'progress'; progress: number }
	| { type: 'finder'; data: unknown; url: string }
	| { type: 'link'; data: unknown; url: string }
	| { type: 'blocked'; count: number }
	| { type: 'popupDenied' }
	| { type: 'icon'; host: string; png: string }
	| { type: 'crashed' };

/** Why a page image could not be fetched; `challenge` means the site wants the person to pass a check first. */
export type PageFetchFailure = 'challenge' | 'not-image' | 'too-large' | 'network' | 'cancelled' | 'bad-path' | 'bad-url' | 'io' | `http:${number}`;

export class PageFetchError extends Error {
	constructor(readonly code: PageFetchFailure) {
		super(`page fetch failed: ${code}`);
		this.name = 'PageFetchError';
	}
}

const pending = new Map<string, { resolve: (json: string) => void; reject: (error: Error) => void }>();
let counter = 0;
let handlersInstalled = false;

function installHandlers(): void {
	if (handlersInstalled) return;
	handlersInstalled = true;
	window.__browser_native_resolve = (id, json) => {
		const call = pending.get(id);
		if (!call) return;
		pending.delete(id);
		call.resolve(json);
	};
	window.__browser_native_reject = (id, message) => {
		const call = pending.get(id);
		if (!call) return;
		pending.delete(id);
		call.reject(new PageFetchError(message as PageFetchFailure));
	};
}

function bridge(): BrowserNativeBridge | null {
	try {
		const b = typeof window !== 'undefined' ? window.__fumeto_browser : undefined;
		return b ?? null;
	} catch {
		return null;
	}
}

let availability: boolean | null = null;

/** Whether this device can run the browser: the bridge exists and the system WebView supports browser profiles. */
export function browserAvailable(): boolean {
	if (availability !== null) return availability;
	const b = bridge();
	try {
		availability = !!b && b.isAvailable();
	} catch {
		availability = false;
	}
	return availability;
}

/** Whether the bridge exists at all (Android); the button is hidden elsewhere, and explains itself on old WebViews. */
export function browserBridgePresent(): boolean {
	return bridge() !== null;
}

function call(invoke: (b: BrowserNativeBridge, id: string) => void, signal?: AbortSignal): Promise<string> {
	const b = bridge();
	if (!b) return Promise.reject(new Error('browser bridge unavailable'));
	installHandlers();
	const id = `browser-${++counter}-${Date.now()}`;
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => {
			pending.delete(id);
			try {
				b.cancel(id);
			} catch {
				// The call finished as it was cancelled.
			}
			reject(new PageFetchError('cancelled'));
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener('abort', onAbort, { once: true });
		pending.set(id, {
			resolve: (json) => {
				signal?.removeEventListener('abort', onAbort);
				resolve(json);
			},
			reject: (error) => {
				signal?.removeEventListener('abort', onAbort);
				reject(error);
			}
		});
		try {
			invoke(b, id);
		} catch (error) {
			pending.delete(id);
			signal?.removeEventListener('abort', onAbort);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

const rectJson = (rect: BrowserRect) =>
	JSON.stringify({ x: rect.x, y: rect.y, w: Math.max(0, rect.w), h: Math.max(0, rect.h) });

export const browserNative = {
	show(rect: BrowserRect): void {
		bridge()?.show(rectJson(rect));
	},
	setRect(rect: BrowserRect): void {
		bridge()?.setRect(rectJson(rect));
	},
	hide(): void {
		bridge()?.hide();
	},
	load(url: string): void {
		bridge()?.load(url);
	},
	back(): void {
		bridge()?.back();
	},
	forward(): void {
		bridge()?.forward();
	},
	reload(): void {
		bridge()?.reload();
	},
	stop(): void {
		bridge()?.stop();
	},
	state(): BrowserNavState | null {
		try {
			const raw = bridge()?.state();
			if (!raw) return null;
			const s = JSON.parse(raw) as Partial<BrowserNavState>;
			return typeof s.url === 'string' ? (s as BrowserNavState) : null;
		} catch {
			return null;
		}
	},
	setFinderScript(src: string): void {
		bridge()?.setFinderScript(src);
	},
	/** Runs `js` in the current page and returns its completion value, JSON-decoded; null without a page. */
	async evaluate(js: string): Promise<unknown> {
		const raw = await call((b, id) => b.evaluate(js, id));
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	},
	setBlocking(enabled: boolean, exemptHosts: string[]): void {
		bridge()?.setBlocking(enabled, JSON.stringify(exemptHosts));
	},
	async refreshLists(force: boolean): Promise<BrowserListsStatus> {
		return JSON.parse(await call((b, id) => b.refreshLists(force, id))) as BrowserListsStatus;
	},
	listsStatus(): BrowserListsStatus | null {
		try {
			const raw = bridge()?.listsStatus();
			return raw ? (JSON.parse(raw) as BrowserListsStatus) : null;
		} catch {
			return null;
		}
	},
	/** A JPEG data URL of the page as shown, or null; for the app to show while it covers the browser. */
	async snapshot(): Promise<string | null> {
		try {
			return JSON.parse(await call((b, id) => b.snapshot(id))) as string;
		} catch {
			return null;
		}
	},
	async clearData(): Promise<boolean> {
		const raw = await call((b, id) => b.clearData(id));
		return (JSON.parse(raw) as { cleared?: boolean }).cleared === true;
	},
	/** Fetches one page image into `appDataDir()/web-pages/<relPath>`; rejects with a {@link PageFetchError}. */
	async fetchPage(url: string, pageUrl: string, relPath: string, signal?: AbortSignal): Promise<{ mime: string; bytes: number }> {
		const raw = await call((b, id) => b.fetchPage(url, pageUrl, relPath, id), signal);
		return JSON.parse(raw) as { mime: string; bytes: number };
	}
};

/** Subscribes to everything the browser reports; returns the unsubscribe. */
export function onBrowserEvent(listener: (event: BrowserEvent) => void): () => void {
	const handler = (event: Event) => {
		const detail = (event as CustomEvent).detail as BrowserEvent | undefined;
		if (detail && typeof detail === 'object' && typeof detail.type === 'string') listener(detail);
	};
	window.addEventListener('fumeto:browser', handler);
	return () => window.removeEventListener('fumeto:browser', handler);
}

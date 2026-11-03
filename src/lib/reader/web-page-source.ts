/**
 * Pages of a chapter read from a web page in the in-app browser. Each image is fetched natively, as the browser
 * would (its cookies, user agent and Referer: `browser/PageFetcher.kt`), into a temporary folder under
 * `appDataDir()/web-pages/<volume>/`, read from there, and kept in memory while the chapter is open. Nothing here
 * outlives the chapter: `discardWebChapterPages` removes the folder and the cached pages when it closes.
 *
 * The cache is shared by every source of a chapter — the reader, the translation runs and the thumbnails each build
 * their own — so a page is fetched from the site once however many readers want it.
 */

import { appDataDir, join } from '@tauri-apps/api/path';
import { readFile, remove, rename } from '@tauri-apps/plugin-fs';
import { writable } from 'svelte/store';
import { appWorkCoordinator } from '$lib/work-coordination/index.js';
import { browserNative, PageFetchError } from '$lib/web-browser/browser-bridge.js';
import { pageFetched } from '$lib/web-browser/web-chapter-store.js';
import { webPageUnavailable } from '$lib/web-browser/web-page-gate.js';
import { sha256Bytes } from '$lib/overlay-layout/canonical.js';
import {
	throwIfPageRequestCancelled,
	type PageRequestOptions,
	type PageSource,
	type PageSourcePurpose
} from './page-source.js';

const LANE = 'web-page-fetch';
const MAX_CACHED_PAGES = 40;

const cache = new Map<string, Blob>();
const inFlight = new Map<string, Promise<Blob>>();

/**
 * The volume whose page a site refused until the person passes a check in the browser (a Cloudflare challenge).
 * The reader shows it and offers the browser; a retry after the check carries the clearance the browser earned.
 */
export const webChallenge = writable<{ volumeUuid: string } | null>(null);

const EXTENSION: Record<string, string> = {
	'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp'
};

/** The image type from its first bytes, as the native fetch decided it. */
function sniffImageType(b: Uint8Array): string | null {
	const ascii = (at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x89 && ascii(1, 'PNG')) return 'image/png';
	if (ascii(0, 'GIF8')) return 'image/gif';
	if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
	if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
	if (ascii(0, 'BM')) return 'image/bmp';
	return null;
}

function remember(key: string, blob: Blob): void {
	cache.delete(key);
	cache.set(key, blob);
	while (cache.size > MAX_CACHED_PAGES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

async function pagesFolder(volumeUuid: string): Promise<string> {
	return join(await appDataDir(), 'web-pages', volumeUuid);
}

/** Forgets a chapter's pages and deletes its temporary folder. */
export async function discardWebChapterPages(volumeUuid: string): Promise<void> {
	for (const key of [...cache.keys()]) if (key.startsWith(`${volumeUuid}:`)) cache.delete(key);
	try {
		await remove(await pagesFolder(volumeUuid), { recursive: true });
	} catch {
		// Nothing was fetched, or the folder is already gone.
	}
}

/**
 * A chapter opened under a provisional id turned out to be a saved one: its pages already fetched move with it, so
 * nothing is fetched twice.
 */
export async function adoptWebChapterPages(from: string, to: string): Promise<void> {
	for (const [key, blob] of [...cache.entries()]) {
		if (!key.startsWith(`${from}:`)) continue;
		cache.delete(key);
		cache.set(`${to}:${key.slice(from.length + 1)}`, blob);
	}
	try {
		await remove(await pagesFolder(to), { recursive: true });
	} catch {
		// Nothing of the saved chapter was on disk.
	}
	try {
		await rename(await pagesFolder(from), await pagesFolder(to));
	} catch {
		// Nothing was fetched under the provisional id.
	}
}

/** Deletes every chapter's temporary pages: at startup, when no chapter can be open. */
export async function discardAllWebChapterPages(): Promise<void> {
	cache.clear();
	try {
		await remove(await join(await appDataDir(), 'web-pages'), { recursive: true });
	} catch {
		// No chapter was ever read.
	}
}

export class WebPageSource implements PageSource {
	constructor(
		private readonly volumeUuid: string,
		private readonly pageUrl: string,
		private readonly pageUrls: string[],
		private readonly purpose: PageSourcePurpose = 'background'
	) {
		appWorkCoordinator.setLaneCapacity(LANE, 2);
	}

	get pageCount(): number {
		return this.pageUrls.length;
	}

	async getPage(index: number, options: PageRequestOptions = {}): Promise<Blob> {
		throwIfPageRequestCancelled(options.signal);
		const url = this.pageUrls[index];
		if (url === undefined) throw new Error(`No page ${index}`);
		const key = `${this.volumeUuid}:${index}`;
		const cached = cache.get(key);
		if (cached) {
			remember(key, cached);
			return cached;
		}
		let pending = inFlight.get(key);
		if (!pending) {
			pending = this.fetch(index, url, key).finally(() => inFlight.delete(key));
			inFlight.set(key, pending);
		}
		const blob = await pending;
		throwIfPageRequestCancelled(options.signal);
		return blob;
	}

	/** The page's temporary copy, if this chapter fetched it before: a long chapter outgrows the memory cache. */
	private async fromDisk(index: number): Promise<Blob | null> {
		try {
			const bytes = await readFile(await join(await pagesFolder(this.volumeUuid), String(index)));
			const type = sniffImageType(bytes);
			return type ? new Blob([bytes], { type }) : null;
		} catch {
			return null;
		}
	}

	private fetch(index: number, url: string, key: string): Promise<Blob> {
		return appWorkCoordinator.submit({
			kind: 'web-page',
			owner: `web-chapter:${this.volumeUuid}`,
			lane: LANE,
			// The page on screen first; a batch translation's pages after it.
			priority: this.purpose === 'reader' ? 0 : this.purpose === 'preview' ? 2 : 1,
			coalescingKey: `web-page:${key}`,
			operation: async ({ signal }) => {
				const kept = await this.fromDisk(index);
				if (kept) {
					await pageFetched(this.volumeUuid, index, await sha256Bytes(await kept.arrayBuffer()), this.pageUrls.length);
					remember(key, kept);
					return kept;
				}
				let fetched: { mime: string };
				try {
					fetched = await browserNative.fetchPage(url, this.pageUrl, `${this.volumeUuid}/${index}`, signal);
				} catch (error) {
					if (error instanceof PageFetchError && error.code === 'challenge') webChallenge.set({ volumeUuid: this.volumeUuid });
					throw error;
				}
				const bytes = await readFile(await join(await pagesFolder(this.volumeUuid), String(index)));
				// The page's fingerprint, as the overlay pipeline takes it: how a saved chapter knows its pages.
				await pageFetched(this.volumeUuid, index, await sha256Bytes(bytes), this.pageUrls.length);
				const blob = new Blob([bytes], { type: fetched.mime });
				remember(key, blob);
				return blob;
			}
		}).promise.catch((error: unknown) => {
			webPageUnavailable(this.volumeUuid, index);
			throw error;
		});
	}

	async getPageAsFile(index: number, options: PageRequestOptions = {}): Promise<File> {
		const blob = await this.getPage(index, options);
		throwIfPageRequestCancelled(options.signal);
		return new File([blob], `page_${index}.${EXTENSION[blob.type] ?? 'jpg'}`, { type: blob.type || 'image/jpeg' });
	}

	dispose(): void {
		// The shared cache belongs to the chapter, not to this source; the chapter's close discards it.
	}
}

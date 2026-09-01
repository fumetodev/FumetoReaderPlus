/**
 * Komga page source — fetches page images from a Komga server.
 *
 * Much simpler than RemotePageSource (YACReader) because Komga serves
 * pages directly via stateless HTTP requests. No archive extraction step,
 * no 412 retry logic, no session-expiry recovery.
 *
 * Note: Komga uses 1-indexed page numbers, while Fumeto uses 0-indexed.
 * This source handles the conversion internally.
 */

import {
	throwIfPageRequestCancelled,
	type PageRequestOptions,
	type PageSource
} from './page-source.js';
import type { KomgaServerClient } from '$lib/komga/komga-server-client.js';

/** Maximum number of pages to keep in the in-memory cache */
const MAX_CACHED_PAGES = 20;

export class KomgaPageSource implements PageSource {
	private client: KomgaServerClient;
	private bookId: string;
	private _pageCount: number;

	/** LRU page cache: index → Blob */
	private pageCache = new Map<number, Blob>();
	/** Track access order for LRU eviction */
	private accessOrder: number[] = [];

	constructor(client: KomgaServerClient, bookId: string, pageCount: number) {
		this.client = client;
		this.bookId = bookId;
		this._pageCount = pageCount;
	}

	get pageCount(): number {
		return this._pageCount;
	}

	async getPage(index: number, options: PageRequestOptions = {}): Promise<Blob> {
		throwIfPageRequestCancelled(options.signal);
		// Check cache first
		const cached = this.pageCache.get(index);
		if (cached) {
			this.touchLRU(index);
			return cached;
		}

		// Fetch from server (convert 0-indexed to 1-indexed)
		const blob = await this.client.fetchPage(this.bookId, index + 1, options.signal);
		throwIfPageRequestCancelled(options.signal);

		// Cache the result
		this.addToCache(index, blob);

		return blob;
	}

	/**
	 * The synthesized `.jpg` name below is load-bearing for the video-pages
	 * feature: remote servers only ever serve raster page images, and
	 * isVideoPageFilename keys on stored/synthesized filenames — so remote
	 * pages are never treated as video by construction. Revisit if a remote
	 * source ever serves non-image page media.
	 */
	async getPageAsFile(index: number, options: PageRequestOptions = {}): Promise<File> {
		const blob = await this.getPage(index, options);
		throwIfPageRequestCancelled(options.signal);
		return new File([blob], `page_${index}.jpg`, { type: blob.type || 'image/jpeg' });
	}

	dispose(): void {
		this.pageCache.clear();
		this.accessOrder = [];
	}

	// ================================================================
	// LRU Cache Helpers
	// ================================================================

	/** Add a page to the cache, evicting the oldest entry if at capacity */
	private addToCache(index: number, blob: Blob): void {
		if (this.pageCache.has(index)) {
			this.touchLRU(index);
			return;
		}

		// Evict oldest if at capacity
		while (this.pageCache.size >= MAX_CACHED_PAGES && this.accessOrder.length > 0) {
			const oldest = this.accessOrder.shift()!;
			this.pageCache.delete(oldest);
		}

		this.pageCache.set(index, blob);
		this.accessOrder.push(index);
	}

	/** Move an index to the end of the access order (most recently used) */
	private touchLRU(index: number): void {
		const pos = this.accessOrder.indexOf(index);
		if (pos !== -1) {
			this.accessOrder.splice(pos, 1);
		}
		this.accessOrder.push(index);
	}
}

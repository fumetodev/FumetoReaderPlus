/**
 * Bounded lazy page source — serves remote pages through a small LRU window.
 *
 * Remote sources now recover expired sessions themselves, so retaining an
 * entire volume is unnecessary. This compatibility-named wrapper fetches on
 * demand and keeps a strictly bounded number of Blob references.
 */

import {
	awaitPageRequest,
	throwIfPageRequestCancelled,
	type PageRequestOptions,
	type PageSource
} from './page-source.js';

export class PrefetchedPageSource implements PageSource {
	private pages = new Map<number, Blob>();
	private pending = new Map<number, Promise<Blob>>();
	private accessOrder: number[] = [];
	private source: PageSource;
	private _pageCount: number;
	private maxResidentPages: number;
	private burstAhead: number;
	private disposed = false;
	private readonly abortController = new AbortController();

	constructor(source: PageSource, maxResidentPages = 2, options: { burstAhead?: number } = {}) {
		this.source = source;
		this._pageCount = source.pageCount;
		this.maxResidentPages = Math.max(1, Math.floor(maxResidentPages));
		this.burstAhead = Math.max(0, Math.floor(options.burstAhead ?? 0));
	}

	get pageCount(): number {
		return this._pageCount;
	}

	async getPage(index: number, options: PageRequestOptions = {}): Promise<Blob> {
		throwIfPageRequestCancelled(options.signal);
		const cached = this.pages.get(index);
		if (cached) {
			this.touch(index);
			return cached;
		}

		const inFlight = this.pending.get(index);
		if (inFlight) return awaitPageRequest(inFlight, options);

		const request = this.fetchInto(index).then((blob) => {
			// Warm burst: batch translation spends minutes on-device between
			// page requests, long enough for a remote server to expire the
			// session — every later miss then reopens the comic and re-runs a
			// full server-side archive extraction. Pulling the next few pages
			// back-to-back while the session is hot makes extraction happen
			// once per window instead of once per page. Sequential, so the
			// per-server single-flight transport stays honest.
			this.burstFrom(index + 1);
			return blob;
		});
		return awaitPageRequest(request, options);
	}

	/** Fetch one page into the cache, deduplicating against in-flight requests. */
	private fetchInto(index: number): Promise<Blob> {
		const inFlight = this.pending.get(index);
		if (inFlight) return inFlight;
		const request = this.source.getPage(index, { signal: this.abortController.signal }).then((blob) => {
			this.pending.delete(index);
			if (!this.disposed) {
				this.pages.set(index, blob);
				this.touch(index);
				this.evict();
			}
			return blob;
		}, (error) => {
			this.pending.delete(index);
			throw error;
		});
		this.pending.set(index, request);
		return request;
	}

	private burstFrom(start: number): void {
		if (this.burstAhead <= 0 || this.disposed) return;
		let chain: Promise<unknown> = Promise.resolve();
		const end = Math.min(start + this.burstAhead, this._pageCount);
		for (let index = start; index < end; index++) {
			if (this.pages.has(index) || this.pending.has(index)) continue;
			// A failed burst page is dropped silently — it is re-requested on
			// demand later, where the caller owns the error.
			chain = chain.then(() => (this.disposed ? undefined : this.fetchInto(index))).catch(() => undefined);
		}
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
		this.disposed = true;
		this.abortController.abort();
		this.pages.clear();
		this.pending.clear();
		this.accessOrder = [];
		this.source.dispose();
	}

	/** Exposed for diagnostics and bounded-residency tests. */
	get residentPageCount(): number {
		return this.pages.size;
	}

	private touch(index: number): void {
		const position = this.accessOrder.indexOf(index);
		if (position >= 0) this.accessOrder.splice(position, 1);
		this.accessOrder.push(index);
	}

	private evict(): void {
		while (this.pages.size > this.maxResidentPages) {
			const oldest = this.accessOrder.shift();
			if (oldest !== undefined) this.pages.delete(oldest);
		}
	}
}

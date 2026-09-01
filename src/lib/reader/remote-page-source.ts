/**
 * Remote page source — fetches page images from a YACReader Library Server.
 *
 * Handles the "open comic" → "fetch pages" protocol:
 * 1. First getPage() call triggers openComic() (tells server to extract archive)
 * 2. Individual pages fetched via HTTP with 412 retry (server may still be extracting)
 * 3. Fetched pages cached in memory (LRU, limited to ~10 entries)
 * 4. Session-expired errors automatically re-open the comic and retry
 *
 * The YACReader server extracts archives into a temporary directory with an
 * inactivity timeout (~60s). During volume translation, LLM API calls can take
 * minutes per page, causing the server to clean up between page requests.
 * The re-open logic handles this transparently.
 */

import {
	awaitPageRequest,
	combinePageRequestSignals,
	throwIfPageRequestCancelled,
	type PageRequestOptions,
	type PageSource
} from './page-source.js';
import type { YACServerClient } from '$lib/yacreader/yac-server-client.js';
import { YACServerError } from '$lib/yacreader/yac-types.js';

/** Maximum number of pages to keep in the in-memory cache */
const MAX_CACHED_PAGES = 20;

/** Maximum number of re-open attempts when the server session expires */
const MAX_REOPEN_ATTEMPTS = 3;

export class RemotePageSource implements PageSource {
	private client: YACServerClient;
	private libraryId: number;
	private comicId: string;
	private _pageCount: number;
	private opened = false;
	private opening: Promise<void> | null = null;
	private readonly abortController = new AbortController();
	private releaseLease: (() => void) | undefined;
	private disposed = false;

	/** LRU page cache: index → Blob */
	private pageCache = new Map<number, Blob>();
	/** Track access order for LRU eviction */
	private accessOrder: number[] = [];

	constructor(
		client: YACServerClient,
		libraryId: number,
		comicId: string,
		pageCount: number,
		options: { sessionClient?: boolean; releaseLease?: () => void } = {}
	) {
		// The server stores only one current remote comic per x-request-id.
		// Give every page source an isolated session token, while the client keeps
		// sharing its per-server request scheduler for transport safety.
		this.client = options.sessionClient ? client : client.createSessionClient();
		this.releaseLease = options.releaseLease;
		this.libraryId = libraryId;
		this.comicId = comicId;
		this._pageCount = pageCount;
	}

	get pageCount(): number {
		return this._pageCount;
	}

	async getPage(index: number, options: PageRequestOptions = {}): Promise<Blob> {
		throwIfPageRequestCancelled(options.signal);
		// Ensure comic is opened for reading
		await this.ensureOpened(options.signal);
		throwIfPageRequestCancelled(options.signal);

		// Check cache first
		const cached = this.pageCache.get(index);
		if (cached) {
			this.touchLRU(index);
			return cached;
		}

		// Fetch from server with session-expiry recovery
		const blob = await this.fetchWithReopen(index, options.signal);
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
		if (this.disposed) return;
		this.disposed = true;
		// A source can leave several serialized page reads queued behind the active
		// request. Abort them on close so a progress write is not delayed by stale
		// prefetch or thumbnail work.
		this.abortController.abort();
		this.pageCache.clear();
		this.accessOrder = [];
		this.releaseLease?.();
		this.releaseLease = undefined;
	}

	// ================================================================
	// Internal Helpers
	// ================================================================

	/**
	 * Fetch a page, automatically re-opening the comic if the server
	 * session has expired (404 no-current-comic, 412 exhaustion, or 424 no_session).
	 *
	 * The YACReader server cleans up extracted archives after an inactivity
	 * timeout. During volume translation, LLM calls can take minutes between
	 * page requests, so we transparently re-open and retry.
	 */
	private async fetchWithReopen(index: number, requestSignal?: AbortSignal): Promise<Blob> {
		for (let attempt = 0; attempt <= MAX_REOPEN_ATTEMPTS; attempt++) {
			throwIfPageRequestCancelled(requestSignal);
			const combined = combinePageRequestSignals(this.abortController.signal, requestSignal);
			try {
				return await awaitPageRequest(
					this.client.fetchPage(
						this.libraryId,
						this.comicId,
						index,
						combined.signal
					),
					{ signal: combined.signal }
				);
			} catch (err) {
				// Depending on server version, an expired or replaced remote-comic
				// session is reported as 404 rather than 424. The requested index is
				// already bounded by this source's metadata, so reopen before treating
				// it as a permanent not-found error.
				if (
					err instanceof YACServerError &&
					(err.type === 'page_loading' || err.type === 'no_session' || err.type === 'not_found') &&
					attempt < MAX_REOPEN_ATTEMPTS
				) {
					// Server session expired — re-open comic and retry
					console.warn(
						`[RemotePageSource] Session expired fetching page ${index} (${err.type}), ` +
						`re-opening comic (attempt ${attempt + 1}/${MAX_REOPEN_ATTEMPTS})...`
					);
					this.opened = false;
					await this.ensureOpened(requestSignal);
					continue;
				}
				throw err;
			} finally {
				combined.cleanup();
			}
		}

		// Should not reach here, but TypeScript needs a return
		throw new YACServerError(
			'connection_failed',
			`Failed to fetch page ${index} after ${MAX_REOPEN_ATTEMPTS} re-open attempts`
		);
	}

	/** Ensure the comic has been opened for remote reading (idempotent) */
	private async ensureOpened(requestSignal?: AbortSignal): Promise<void> {
		throwIfPageRequestCancelled(requestSignal);
		if (this.opened) return;

		// A cancellable one-shot consumer must be able to stop the underlying open
		// without coupling its signal to an unrelated signal-less shared waiter.
		if (requestSignal) {
			const combined = combinePageRequestSignals(this.abortController.signal, requestSignal);
			try {
				await awaitPageRequest(
					this.client.openComic(this.libraryId, this.comicId, combined.signal),
					{ signal: combined.signal }
				);
				throwIfPageRequestCancelled(requestSignal);
				this.opened = true;
				return;
			} finally {
				combined.cleanup();
			}
		}

		// Prevent concurrent open calls
		if (this.opening) {
			await awaitPageRequest(this.opening);
			return;
		}

		this.opening = this.client.openComic(
			this.libraryId,
			this.comicId,
			this.abortController.signal
		).then(() => {
			this.opened = true;
			this.opening = null;
		}).catch((err) => {
			// Reset so the next call can retry instead of awaiting a
			// permanently-rejected promise.
			this.opening = null;
			throw err;
		});

		await awaitPageRequest(this.opening);
	}

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

/**
 * Image cache for preloading and decoding manga pages.
 *
 * Adapted from mokuro-reader's image-cache.ts.
 * Uses a PageSource abstraction so it works with both local files and remote servers.
 * Maintains a sliding window: 2 previous + current + 3 next pages.
 *
 * Video pages (mp4/webm entries in local archives) share the same contract —
 * "index → ready object URL + measured dimensions" — but their ready-path is
 * a metadata-only probe, NOT a decode: the cache never retains a decoding
 * element (Android's hardware video decoder pool is ~2–4 deep; the only live
 * <video> elements are the ones the viewers actually mount).
 */

import type { PageSource } from './page-source.js';

interface CachedMediaBase {
	url: string;
	decoded: boolean;
	loading: Promise<void> | null;
	revoked: boolean;
}

export type CachedImage =
	| (CachedMediaBase & { kind: 'image'; image: HTMLImageElement })
	| (CachedMediaBase & { kind: 'video'; width: number; height: number });

interface InFlightLoad {
	readonly source: PageSource;
	readonly generation: number;
	active: boolean;
	promise: Promise<void>;
}

export class ImageCache {
	private cache = new Map<number, CachedImage>();
	private inFlight = new Map<number, InFlightLoad>();
	private pageSource: PageSource | null = null;
	private sourceGeneration = 0;
	private currentIndex = 0;
	private windowSize = { prev: 2, next: 3 };

	/** Optional callback fired when image dimensions are measured after decode */
	private onDimensionsMeasured?: (
		index: number,
		width: number,
		height: number,
		source: PageSource
	) => void | Promise<void>;

	/** Set the page source. Changing it invalidates all work owned by the old source. */
	setPageSource(source: PageSource): void {
		if (this.pageSource !== source) {
			this.cleanup();
			this.pageSource = source;
		}
	}

	/** Remove the current source and invalidate all cached and in-flight work. */
	clearPageSource(): void {
		this.cleanup();
		this.pageSource = null;
	}

	/**
	 * Set callback for dimension measurement (used for remote pages
	 * where dimensions aren't known until the image is decoded).
	 */
	setDimensionsCallback(
		cb: (index: number, width: number, height: number, source: PageSource) => void | Promise<void>
	): void {
		this.onDimensionsMeasured = cb;
	}

	/**
	 * Update the sliding window around the current page index.
	 * Evicts pages outside the window and preloads pages inside it.
	 */
	updateWindow(currentIndex: number): void {
		if (!this.pageSource) return;

		this.currentIndex = currentIndex;

		const startIndex = Math.max(0, currentIndex - this.windowSize.prev);
		const endIndex = Math.min(this.pageSource.pageCount - 1, currentIndex + this.windowSize.next);

		const windowIndices = new Set<number>();
		for (let i = startIndex; i <= endIndex; i++) {
			windowIndices.add(i);
		}

		// Evict decoded entries and cancel pending entries outside the window.
		const loadedOrLoadingIndices = new Set([...this.cache.keys(), ...this.inFlight.keys()]);
		for (const index of loadedOrLoadingIndices) {
			if (!windowIndices.has(index)) {
				this.removeFromCache(index);
			}
		}

		// Preload all entries in window (non-blocking)
		for (let i = startIndex; i <= endIndex; i++) {
			this.preloadImage(i).catch((err) => {
				console.error(`Failed to preload image at index ${i}:`, err);
			});
		}
	}

	/** Get cached image URL synchronously (null if not yet ready) */
	getImageSync(index: number): string | null {
		const cached = this.cache.get(index);
		if (cached?.decoded && !cached.revoked) {
			return cached.url;
		}
		return null;
	}

	/** Get cached image URL, waiting if necessary */
	async getImage(index: number): Promise<string | null> {
		const cached = this.cache.get(index);
		if (cached) {
			if (cached.loading) await cached.loading;
			return this.cache.get(index) === cached && cached.decoded && !cached.revoked
				? cached.url
				: null;
		}

		await this.preloadImage(index);
		const newCached = this.cache.get(index);
		return newCached?.decoded && !newCached.revoked ? newCached.url : null;
	}

	private async preloadImage(index: number): Promise<void> {
		const cached = this.cache.get(index);
		if (cached) {
			if (cached.loading) await cached.loading;
			return;
		}

		const source = this.pageSource;
		if (!source) return;

		const existingLoad = this.inFlight.get(index);
		if (
			existingLoad &&
			existingLoad.active &&
			existingLoad.source === source &&
			existingLoad.generation === this.sourceGeneration
		) {
			await existingLoad.promise;
			return;
		}

		if (existingLoad) {
			this.cancelLoad(index, existingLoad);
		}

		const request: InFlightLoad = {
			source,
			generation: this.sourceGeneration,
			active: true,
			promise: Promise.resolve()
		};

		// Defer the source call to a microtask so this single-flight entry is visible
		// before getPage() begins. Concurrent getImage/preload calls share this promise.
		request.promise = Promise.resolve().then(() => this.loadImage(index, request));
		this.inFlight.set(index, request);

		try {
			await request.promise;
		} finally {
			if (this.inFlight.get(index) === request) {
				this.inFlight.delete(index);
			}
		}
	}

	private async loadImage(index: number, request: InFlightLoad): Promise<void> {
		const blob = await request.source.getPage(index);
		if (!this.isRequestCurrent(index, request)) return;

		const url = URL.createObjectURL(blob);
		let cached: CachedImage;
		let loading: Promise<void>;
		if (blob.type.startsWith('video/')) {
			// Metadata-only readiness: probe intrinsic dimensions through the
			// serialized video-poster queue and release the probe element —
			// the object URL is "ready" for a viewer-mounted <video> after.
			const videoCached: CachedImage = {
				kind: 'video',
				width: 0,
				height: 0,
				url,
				decoded: false,
				loading: null,
				revoked: false
			};
			cached = videoCached;
			loading = (async () => {
				const { probeVideoDimensions } = await import('$lib/util/video-poster.js');
				const dims = await probeVideoDimensions(blob);
				videoCached.width = dims.width;
				videoCached.height = dims.height;
			})();
		} else {
			const img = new Image();
			loading = this.decodeImage(img, url);
			cached = {
				kind: 'image',
				image: img,
				url,
				decoded: false,
				loading,
				revoked: false
			};
		}
		cached.loading = loading;
		this.cache.set(index, cached);

		try {
			await loading;
		} catch (error) {
			const stillCurrent = this.isRequestCurrent(index, request);
			if (this.cache.get(index) === cached) this.cache.delete(index);
			this.revoke(cached);
			// Revoking an image during cleanup/source replacement may reject its load.
			// That stale failure must not surface as an error for the new page.
			if (stillCurrent) throw error;
			return;
		}

		if (!this.isRequestCurrent(index, request) || this.cache.get(index) !== cached) {
			if (this.cache.get(index) === cached) this.cache.delete(index);
			this.revoke(cached);
			return;
		}

		cached.decoded = true;
		cached.loading = null;

		if (this.onDimensionsMeasured) {
			const width = cached.kind === 'image' ? cached.image.naturalWidth : cached.width;
			const height = cached.kind === 'image' ? cached.image.naturalHeight : cached.height;
			if (width > 0) {
				void this.onDimensionsMeasured(index, width, height, request.source);
			}
		}
	}

	private isRequestCurrent(index: number, request: InFlightLoad): boolean {
		return (
			request.active &&
			request.generation === this.sourceGeneration &&
			request.source === this.pageSource &&
			this.inFlight.get(index) === request
		);
	}

	private async decodeImage(img: HTMLImageElement, url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			img.onload = () => {
				if ('decode' in img) {
					img
						.decode()
						.then(() => resolve())
						.catch(() => resolve());
				} else {
					resolve();
				}
			};
			img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
			img.src = url;
		});
	}

	private cancelLoad(index: number, request = this.inFlight.get(index)): void {
		if (!request) return;
		request.active = false;
		if (this.inFlight.get(index) === request) this.inFlight.delete(index);
	}

	private revoke(cached: CachedImage): void {
		if (cached.revoked) return;
		URL.revokeObjectURL(cached.url);
		cached.revoked = true;
	}

	private removeFromCache(index: number): void {
		this.cancelLoad(index);
		const cached = this.cache.get(index);
		if (cached) {
			this.revoke(cached);
			this.cache.delete(index);
		}
	}

	/** Clean up all cached images, revoke blob URLs, and invalidate pending work. */
	cleanup(): void {
		this.sourceGeneration += 1;
		for (const request of this.inFlight.values()) request.active = false;
		this.inFlight.clear();
		for (const cached of this.cache.values()) this.revoke(cached);
		this.cache.clear();
	}

	/** Debug info */
	getStats() {
		return {
			size: this.cache.size,
			inFlight: this.inFlight.size,
			currentIndex: this.currentIndex,
			pageCount: this.pageSource?.pageCount ?? 0,
			cached: Array.from(this.cache.keys()),
			decoded: Array.from(this.cache.entries())
				.filter(([_, v]) => v.decoded)
				.map(([k]) => k)
		};
	}
}

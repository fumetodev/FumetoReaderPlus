/**
 * Session-scoped LRU cache for thumbnail object URLs.
 *
 * Catalog views call `getThumbnailUrl` synchronously while rendering. Cache hits
 * are promoted so the URLs being used by the current view are not selected for
 * eviction ahead of older, inactive entries. Every URL is revoked exactly once
 * when explicitly removed, evicted, or when the cache is cleared.
 *
 * Eviction never revokes synchronously: a mounted <img> may still hold the URL
 * (the RecentlyRead strip renders alongside the grid whose scrolling causes the
 * eviction), and yanking it produces a permanently broken image in an Android
 * WebView. Evicted URLs are *retired* — revoked only once no live <img>
 * references them, with a bounded wait. Consumers that keep a URL mounted
 * long-term must pin it (`pinThumbnailUrl`) to exempt it from eviction.
 */

/**
 * Capacity is bounded twice: by entry count and by the encoded bytes the URLs
 * pin in memory. Covers are ≤512px WebP/JPEG (~30–80 KB measured), so the byte
 * ceiling is what actually governs realistic libraries; the entry ceiling is a
 * backstop against pathological tiny-blob floods. Sizing is driven by a
 * measured 13k-volume YACReader library: 664 root folder covers at ~51 KB
 * (stored verbatim by design) are ~34 MB before a single volume thumbnail
 * (512 px JPEG q0.92, ~60-110 KB) is added, so the previous 48 MiB budget
 * evicted on exactly the root↔folder navigation users do most. 128 MiB holds
 * root plus roughly three large folders with headroom; both caps remain
 * ordinary constants.
 */
export const THUMBNAIL_CACHE_MAX_ENTRIES = 2048;
export const THUMBNAIL_CACHE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Retirement polls for detachment; past this many attempts the URL is revoked
 * anyway so a leaked <img> reference cannot pin the blob forever. Long-lived
 * consumers must pin instead of relying on staying attached.
 */
export const THUMBNAIL_RETIRE_MAX_ATTEMPTS = 50;

interface ThumbnailCacheEntry {
	url: string;
	revision?: string;
	bytes: number;
}

const cache = new Map<string, ThumbnailCacheEntry>();
const retiringUrls = new Map<string, ReturnType<typeof setTimeout>>();
const pinnedKeys = new Map<string, number>();
let cachedBytes = 0;

function revokeUrl(url: string): void {
	const timer = retiringUrls.get(url);
	if (timer !== undefined) {
		clearTimeout(timer);
		retiringUrls.delete(url);
	}
	URL.revokeObjectURL(url);
}

/**
 * Keep a replaced or evicted URL alive until no mounted <img> references it.
 * Revoking synchronously would leave an already-mounted <img> pointing at a dead
 * URL until the new source is committed, which is visible as a blank frame in an
 * Android WebView. The wait is bounded (THUMBNAIL_RETIRE_MAX_ATTEMPTS × 100 ms);
 * after that the URL is revoked regardless — pinning, not attachment, is the
 * sanctioned way to hold a URL long-term.
 */
function retireUrlAfterRender(url: string): void {
	if (retiringUrls.has(url)) return;
	let attempts = 0;
	const attempt = () => {
		const attached = typeof document !== 'undefined'
			&& Array.from(document.images).some((image) => image.isConnected && image.src === url);
		if (attached && attempts < THUMBNAIL_RETIRE_MAX_ATTEMPTS) {
			attempts += 1;
			retiringUrls.set(url, setTimeout(attempt, 100));
			return;
		}
		if (attached) {
			console.debug('[thumbnail-cache] retiring a URL still attached after bounded wait:', url);
		}
		retiringUrls.delete(url);
		URL.revokeObjectURL(url);
	};
	const timer = setTimeout(attempt, 0);
	retiringUrls.set(url, timer);
}

function dropEntry(key: string, entry: ThumbnailCacheEntry): void {
	cache.delete(key);
	cachedBytes -= entry.bytes;
}

function overBudget(): boolean {
	return cache.size > THUMBNAIL_CACHE_MAX_ENTRIES || cachedBytes > THUMBNAIL_CACHE_MAX_BYTES;
}

function evictOverflow(): void {
	if (!overBudget()) return;
	// Two passes: first the unpinned LRU order; pinned entries are skipped and
	// may push the cache over budget — a deliberate overshoot, since revoking a
	// pinned URL is precisely the breakage pinning exists to prevent.
	for (const [key, entry] of cache) {
		if (!overBudget()) return;
		if ((pinnedKeys.get(key) ?? 0) > 0) continue;
		dropEntry(key, entry);
		retireUrlAfterRender(entry.url);
	}
}

/**
 * Get or create a blob URL for a volume's thumbnail.
 *
 * Cache hits are promoted to most-recently-used without replacing or revoking
 * the URL already returned to the caller. The newly-created entry is also MRU,
 * so an insertion never immediately revokes the URL it returns.
 */
export function getThumbnailUrl(
	uuid: string,
	thumbnail?: Blob,
	revision?: string,
): string | undefined {
	const existing = cache.get(uuid);
	if (existing) {
		// Callers that do not supply a revision retain the historical first-Blob
		// semantics. Revision-aware media owners replace only when they can also
		// provide the new bytes, so a transient metadata/media gap keeps showing
		// the last-good cover.
		if (revision !== undefined && existing.revision !== revision && thumbnail) {
			const replacement: ThumbnailCacheEntry = {
				url: URL.createObjectURL(thumbnail),
				revision,
				bytes: thumbnail.size,
			};
			dropEntry(uuid, existing);
			cache.set(uuid, replacement);
			cachedBytes += replacement.bytes;
			retireUrlAfterRender(existing.url);
			evictOverflow();
			return replacement.url;
		}
		cache.delete(uuid);
		cache.set(uuid, existing);
		return existing.url;
	}
	if (!thumbnail) return undefined;

	const entry: ThumbnailCacheEntry = {
		url: URL.createObjectURL(thumbnail),
		revision,
		bytes: thumbnail.size,
	};
	cache.set(uuid, entry);
	cachedBytes += entry.bytes;
	evictOverflow();
	return entry.url;
}

/**
 * Exempt a key from eviction while at least one pin is held. Refcounted: the
 * returned release undoes exactly one pin. For consumers whose <img> elements
 * outlive the scrolling that drives eviction (e.g. the RecentlyRead strip).
 */
export function pinThumbnailUrl(key: string): () => void {
	pinnedKeys.set(key, (pinnedKeys.get(key) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (pinnedKeys.get(key) ?? 1) - 1;
		if (count <= 0) pinnedKeys.delete(key);
		else pinnedKeys.set(key, count);
	};
}

/** Revoke and remove one cached thumbnail URL. Idempotent. */
export function revokeThumbnailUrl(uuid: string): void {
	const entry = cache.get(uuid);
	if (!entry) return;

	dropEntry(uuid, entry);
	revokeUrl(entry.url);
}

/** Revoke every cached thumbnail URL and reset LRU state. Idempotent. */
export function clearThumbnailUrlCache(): void {
	for (const entry of cache.values()) revokeUrl(entry.url);
	cache.clear();
	cachedBytes = 0;
	for (const url of [...retiringUrls.keys()]) revokeUrl(url);
}

/** Exposed for diagnostics and deterministic capacity tests. */
export function getThumbnailUrlCacheSize(): number {
	return cache.size;
}

/** Exposed for diagnostics and deterministic capacity tests. */
export function getThumbnailUrlCacheBytes(): number {
	return cachedBytes;
}

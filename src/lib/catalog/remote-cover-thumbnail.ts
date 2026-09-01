/**
 * Normalize a remote server's folder/series cover into something worth caching.
 *
 * Why this exists: Kavita serves series covers as PNG. Measured against a real
 * instance, ten covers were 320x455 each — *fewer pixels* than this app's own
 * 362x512 thumbnails — yet totalled 2734 KB, because PNG is a poor container for
 * photographic art. The same covers re-encoded come to 630 KB (JPEG q90) or
 * 270 KB (WebP q80). Those bytes were being re-fetched on scroll and never
 * persisted, which is what made remote grids blank while scrolling.
 *
 * Deliberately *not* reusing `generateImportThumbnail`: it returns the original
 * file untouched whenever the image already fits within the max dimension and is
 * a jpeg/png/webp. A 320x455 PNG satisfies exactly that, so the import recipe
 * would hand the 273 KB PNG straight back. The rule here is different — see
 * `shouldReencodeRemoteCover`.
 */

import { renderableImageBlob } from '$lib/util/image-blob.js';

export const REMOTE_COVER_MAX_SIZE = 512;
export const REMOTE_COVER_WEBP_QUALITY = 0.8;
export const REMOTE_COVER_JPEG_QUALITY = 0.9;

/**
 * Bump when the recipe changes (size, qualities, format preference). The value
 * is folded into every stored cover's revision via `versionedCoverRevision`, so
 * a bump makes every cached cover compare stale and regenerate on next view.
 */
export const REMOTE_COVER_RECIPE_VERSION = 1;

/**
 * The revision string covers are stored under and compared against: the
 * server-derived revision prefixed with the recipe version, so *either* a
 * server-side cover change *or* a recipe change invalidates the cached copy.
 */
export function versionedCoverRevision(serverRevision: string): string {
	return `${REMOTE_COVER_RECIPE_VERSION}:${serverRevision}`;
}

export interface RemoteCoverThumbnail {
	blob: Blob;
	width?: number;
	height?: number;
	/**
	 * False when the source was kept as-is (already compact, or imaging was
	 * unavailable). Diagnostic only — callers store the result either way,
	 * because an untranscoded cover is still worth caching: the bytes were paid
	 * for over the network and the next visit reads them from IndexedDB.
	 */
	transcoded: boolean;
}

/**
 * Split visible-folder cover requests into cache hits (asset present at the
 * versioned revision — render, no fetch) and misses (fetch from the server).
 * Pure so the read-through decision is unit-testable away from the Svelte
 * effect that drives it.
 */
export function partitionFolderCoverRequests<Request extends { folder: { id: string }; revision: string }>(
	requests: readonly Request[],
	cachedAssets: ReadonlyMap<string, { revision: string; blob: Blob }>,
): {
	hits: Array<{ request: Request; asset: { revision: string; blob: Blob } }>;
	misses: Request[];
} {
	const hits: Array<{ request: Request; asset: { revision: string; blob: Blob } }> = [];
	const misses: Request[] = [];
	for (const request of requests) {
		const asset = cachedAssets.get(request.folder.id);
		if (asset && asset.revision === versionedCoverRevision(request.revision)) {
			hits.push({ request, asset });
		} else {
			misses.push(request);
		}
	}
	return { hits, misses };
}

/**
 * Re-encode when the source is oversized, or when it is in a format that is
 * pathological for cover art regardless of size.
 *
 * Already-compact JPEG/WebP are passed through untouched: re-encoding them costs
 * CPU and a generation of quality to save very little. PNG (and anything
 * unrecognised) is always re-encoded — that is the entire point of the module.
 */
export function shouldReencodeRemoteCover(mimeType: string, scale: number): boolean {
	if (scale < 1) return true;
	const type = mimeType.toLowerCase();
	return !(type === 'image/jpeg' || type === 'image/webp');
}

/** Pick the smallest of the encodings the platform actually produced. */
function chooseSmallest(candidates: readonly (Blob | null)[], fallback: Blob): Blob {
	let best = fallback;
	for (const candidate of candidates) {
		if (candidate && candidate.size > 0 && candidate.size < best.size) best = candidate;
	}
	return best;
}

async function encode(
	canvas: OffscreenCanvas,
	type: string,
	quality: number
): Promise<Blob | null> {
	try {
		const blob = await canvas.convertToBlob({ type, quality });
		// A platform that cannot encode the requested type silently substitutes
		// another (usually PNG), which would defeat the whole exercise.
		return blob && blob.type === type ? blob : null;
	} catch {
		return null;
	}
}

/**
 * Returns the source blob unchanged on any failure: a cover that is merely large
 * is far better than a cover that is missing.
 */
export async function transcodeRemoteCover(source: Blob): Promise<RemoteCoverThumbnail> {
	// Normalize the mime type first and use *that* as the fallback everywhere
	// below. Servers do send `application/octet-stream`, and such a blob will not
	// render in an <img>; the caller previously relied on this normalization, so
	// losing it on the failure paths would turn a large cover into a missing one.
	const typed = await renderableImageBlob(source).catch(() => source);
	const untouched: RemoteCoverThumbnail = { blob: typed, transcoded: false };
	if (typeof OffscreenCanvas === 'undefined' || typeof Image === 'undefined') return untouched;

	const url = URL.createObjectURL(typed);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();

		const naturalWidth = image.naturalWidth;
		const naturalHeight = image.naturalHeight;
		if (!naturalWidth || !naturalHeight) return untouched;

		const scale = Math.min(
			REMOTE_COVER_MAX_SIZE / naturalWidth,
			REMOTE_COVER_MAX_SIZE / naturalHeight,
			1
		);
		if (!shouldReencodeRemoteCover(typed.type, scale)) {
			return { blob: typed, width: naturalWidth, height: naturalHeight, transcoded: false };
		}

		const width = Math.max(1, Math.round(naturalWidth * scale));
		const height = Math.max(1, Math.round(naturalHeight * scale));
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return untouched;
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = 'high';
		context.drawImage(image, 0, 0, width, height);

		// WebP is the target; JPEG runs only when WebP is unavailable — `encode`
		// already returns null when the platform silently substitutes another
		// type (the desktop build runs WebKitGTK, where WebP encoding is not
		// guaranteed). Encoding both unconditionally doubled the CPU per cover
		// for a JPEG that WebP beat on every measured cover.
		const webp = await encode(canvas, 'image/webp', REMOTE_COVER_WEBP_QUALITY);
		const jpeg = webp ? null : await encode(canvas, 'image/jpeg', REMOTE_COVER_JPEG_QUALITY);
		const encoded = chooseSmallest([webp, jpeg], typed);
		if (encoded === typed) return { blob: typed, width: naturalWidth, height: naturalHeight, transcoded: false };
		return { blob: encoded, width, height, transcoded: true };
	} catch {
		return untouched;
	} finally {
		URL.revokeObjectURL(url);
	}
}

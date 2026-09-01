/**
 * Image conversion utilities for LLM API calls.
 *
 * Converts image regions to base64 data URIs for off-device vision APIs.
 * Uses OffscreenCanvas for efficient image cropping (adapted from
 * mokuro-reader's cropper.ts).
 */

/**
 * Hard ceiling for one serialized image data URI sent to a vision provider.
 *
 * This includes the `data:image/...;base64,` prefix as well as the base64 body.
 * Four MiB leaves room for prompts and JSON framing while retaining readable
 * manga pages at the default 1536-pixel longest edge.
 */
export const VISION_IMAGE_DATA_URI_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Bounded JPEG fallback ladder. Dimension changes always preserve the source
 * aspect ratio and never upscale. Most images fit on the first attempt; later
 * steps trade a small amount of quality and then resolution for payload safety.
 */
export const VISION_IMAGE_JPEG_LADDER = Object.freeze([
	{ dimensionScale: 1, quality: 0.88 },
	{ dimensionScale: 1, quality: 0.78 },
	{ dimensionScale: 0.875, quality: 0.82 },
	{ dimensionScale: 0.875, quality: 0.72 },
	{ dimensionScale: 0.75, quality: 0.8 },
	{ dimensionScale: 0.75, quality: 0.68 },
	{ dimensionScale: 0.625, quality: 0.76 },
	{ dimensionScale: 0.625, quality: 0.64 },
	{ dimensionScale: 0.5, quality: 0.72 },
	{ dimensionScale: 0.5, quality: 0.6 },
] as const);

const DEFAULT_BLOB_MAX_SIZE = 1536;

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortReason(signal);
}

function validateMaxSize(maxSize: number): void {
	if (!Number.isFinite(maxSize) || maxSize <= 0) {
		throw new RangeError(`maxSize must be a positive finite number; received ${String(maxSize)}`);
	}
}

/** Return the exact UTF-8 byte length of a serialized data URI. */
export function dataUriByteLength(dataUri: string): number {
	return new TextEncoder().encode(dataUri).byteLength;
}

function estimatedBlobDataUriByteLength(blob: Pick<Blob, 'size' | 'type'>): number {
	const mediaType = blob.type || 'application/octet-stream';
	return `data:${mediaType};base64,`.length + 4 * Math.ceil(blob.size / 3);
}

interface DrawableDimensions {
	width: number;
	height: number;
}

type DrawScaledImage = (
	context: OffscreenCanvasRenderingContext2D,
	width: number,
	height: number,
) => void;

async function encodeJpegWithinPayloadLimit(
	source: DrawableDimensions,
	maxSize: number,
	draw: DrawScaledImage,
	signal?: AbortSignal,
): Promise<string> {
	validateMaxSize(maxSize);
	if (
		!Number.isFinite(source.width)
		|| !Number.isFinite(source.height)
		|| source.width <= 0
		|| source.height <= 0
	) {
		throw new Error(`Cannot encode an image with dimensions ${source.width}x${source.height}`);
	}

	const longestEdge = Math.max(source.width, source.height);
	const initialScale = Math.min(1, maxSize / longestEdge);
	let lastAttempt = 'none';

	for (const step of VISION_IMAGE_JPEG_LADDER) {
		throwIfAborted(signal);
		const scale = initialScale * step.dimensionScale;
		const width = Math.max(1, Math.round(source.width * scale));
		const height = Math.max(1, Math.round(source.height * scale));
		lastAttempt = `${width}x${height}@${step.quality}`;

		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Unable to create a 2D canvas for vision-image encoding');

		// JPEG has no alpha channel. A white matte keeps transparent manga panels
		// and speech bubbles readable instead of allowing a black default backdrop.
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, width, height);
		draw(context, width, height);
		throwIfAborted(signal);

		const encoded = await canvas.convertToBlob({
			type: 'image/jpeg',
			quality: step.quality,
		});
		throwIfAborted(signal);
		if (estimatedBlobDataUriByteLength(encoded) > VISION_IMAGE_DATA_URI_MAX_BYTES) {
			continue;
		}

		const dataUri = await blobToBase64(encoded, signal);
		throwIfAborted(signal);
		if (dataUriByteLength(dataUri) <= VISION_IMAGE_DATA_URI_MAX_BYTES) return dataUri;
	}

	throw new Error(
		`Unable to encode image within the ${VISION_IMAGE_DATA_URI_MAX_BYTES}-byte data-URI ceiling `
		+ `after ${VISION_IMAGE_JPEG_LADDER.length} bounded attempts (last=${lastAttempt})`,
	);
}

/**
 * Crop a region from an image file and return as a bounded base64 data URI.
 *
 * PNG is retained when it fits the payload ceiling. An oversized crop falls
 * back to the same bounded, aspect-preserving JPEG ladder used for full pages.
 *
 * @param imageFile - Source image file
 * @param region - Region to crop (in image-space pixel coordinates)
 * @param signal - Optional cancellation signal, checked between decode/encode steps
 * @returns Base64 data URI
 */
export async function cropRegionToBase64(
	imageFile: File,
	region: { x: number; y: number; width: number; height: number },
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	const url = URL.createObjectURL(imageFile);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		throwIfAborted(signal);

		// Clamp region to image bounds
		const x = Math.max(0, Math.round(region.x));
		const y = Math.max(0, Math.round(region.y));
		const width = Math.min(Math.round(region.width), img.naturalWidth - x);
		const height = Math.min(Math.round(region.height), img.naturalHeight - y);

		if (width <= 0 || height <= 0) {
			throw new Error('Invalid region: width or height is zero or negative');
		}

		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Unable to create a 2D canvas for image cropping');
		context.drawImage(img, x, y, width, height, 0, 0, width, height);
		throwIfAborted(signal);

		const png = await canvas.convertToBlob({ type: 'image/png' });
		throwIfAborted(signal);
		if (estimatedBlobDataUriByteLength(png) <= VISION_IMAGE_DATA_URI_MAX_BYTES) {
			const dataUri = await blobToBase64(png, signal);
			if (dataUriByteLength(dataUri) <= VISION_IMAGE_DATA_URI_MAX_BYTES) return dataUri;
		}

		return encodeJpegWithinPayloadLimit(
			{ width, height },
			Math.min(DEFAULT_BLOB_MAX_SIZE, Math.max(width, height)),
			(ctx, targetWidth, targetHeight) => {
				ctx.drawImage(canvas, 0, 0, width, height, 0, 0, targetWidth, targetHeight);
			},
			signal,
		);
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Convert a Blob to a base64 data URI, with optional cancellation. */
export function blobToBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		let settled = false;
		const cleanup = () => signal?.removeEventListener('abort', onSignalAbort);
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onSignalAbort = () => {
			try {
				if (reader.readyState === 1) reader.abort();
			} finally {
				finish(() => reject(signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError')));
			}
		};

		reader.onload = () => finish(() => {
			try {
				throwIfAborted(signal);
				if (typeof reader.result !== 'string') {
					throw new Error('FileReader returned a non-string data URI');
				}
				resolve(reader.result);
			} catch (error) {
				reject(error);
			}
		});
		reader.onerror = () => finish(() => reject(reader.error ?? new Error('Unable to read image data')));
		reader.onabort = () => finish(() => reject(
			signal?.aborted ? abortReason(signal) : new DOMException('The read was aborted', 'AbortError'),
		));

		if (signal?.aborted) {
			finish(() => reject(abortReason(signal)));
			return;
		}
		signal?.addEventListener('abort', onSignalAbort, { once: true });
		try {
			reader.readAsDataURL(blob);
		} catch (error) {
			finish(() => reject(error));
		}
	});
}

/**
 * Resize an image to fit within maxSize on its longest edge and enforce the
 * vision data-URI byte ceiling.
 *
 * A small input is returned unchanged only when its serialized URI also fits.
 * Otherwise it is encoded through the bounded JPEG ladder.
 *
 * @param base64 - Source image as base64 data URI
 * @param maxSize - Maximum dimension in pixels (default 1024)
 * @param signal - Optional cancellation signal, checked between decode/encode steps
 */
export async function resizeBase64Image(
	base64: string,
	maxSize: number = 1024,
	signal?: AbortSignal,
): Promise<string> {
	validateMaxSize(maxSize);
	throwIfAborted(signal);
	const img = new Image();
	img.src = base64;
	await img.decode();
	throwIfAborted(signal);

	if (
		img.naturalWidth <= maxSize
		&& img.naturalHeight <= maxSize
		&& dataUriByteLength(base64) <= VISION_IMAGE_DATA_URI_MAX_BYTES
	) {
		return base64;
	}

	return encodeJpegWithinPayloadLimit(
		{ width: img.naturalWidth, height: img.naturalHeight },
		maxSize,
		(context, width, height) => context.drawImage(img, 0, 0, width, height),
		signal,
	);
}

/**
 * Resize a Blob/File image to fit within maxSize and return a bounded base64
 * data URI.
 *
 * This avoids a full-resolution base64 intermediate. A dimensionally small
 * source is returned directly only if its estimated and actual serialized URI
 * fit the ceiling; an already-small but byte-heavy source is re-encoded.
 *
 * @param blob - Source image Blob or File
 * @param maxSize - Maximum dimension in pixels (default 1536)
 * @param signal - Optional cancellation signal, checked between decode/encode steps
 */
export async function resizeBlobToBase64(
	blob: Blob,
	maxSize: number = DEFAULT_BLOB_MAX_SIZE,
	signal?: AbortSignal,
): Promise<string> {
	validateMaxSize(maxSize);
	throwIfAborted(signal);
	const bitmap = await createImageBitmap(blob);
	try {
		throwIfAborted(signal);
		if (
			bitmap.width <= maxSize
			&& bitmap.height <= maxSize
			&& estimatedBlobDataUriByteLength(blob) <= VISION_IMAGE_DATA_URI_MAX_BYTES
		) {
			const original = await blobToBase64(blob, signal);
			throwIfAborted(signal);
			if (dataUriByteLength(original) <= VISION_IMAGE_DATA_URI_MAX_BYTES) return original;
		}

		return await encodeJpegWithinPayloadLimit(
			{ width: bitmap.width, height: bitmap.height },
			maxSize,
			(context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
			signal,
		);
	} finally {
		bitmap.close();
	}
}

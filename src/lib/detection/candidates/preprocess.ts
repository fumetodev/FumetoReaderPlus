/**
 * Shared image preprocessing for candidate models (model-candidate eval
 * suite). Mirrors the production patterns: letterbox from
 * `bubble-segmenter.ts:130-160`, plain resize + CHW/255 from
 * `anime-head-detector.ts` — parameterized so each candidate picks its
 * input size and normalization.
 */

export interface LetterboxInfo {
	scale: number;
	padLeft: number;
	padTop: number;
	inputSize: number;
}

export async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
	return createImageBitmap(blob);
}

/** Ultralytics-style letterbox: fit inside a square, gray-114 padding. */
export function letterboxImage(
	bitmap: ImageBitmap,
	inputSize: number
): { imageData: ImageData; info: LetterboxInfo } {
	const scale = Math.min(inputSize / bitmap.width, inputSize / bitmap.height);
	const scaledWidth = Math.round(bitmap.width * scale);
	const scaledHeight = Math.round(bitmap.height * scale);
	const padLeft = Math.floor((inputSize - scaledWidth) / 2);
	const padTop = Math.floor((inputSize - scaledHeight) / 2);

	const canvas = new OffscreenCanvas(inputSize, inputSize);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Unable to create letterbox canvas context');
	ctx.fillStyle = 'rgb(114,114,114)';
	ctx.fillRect(0, 0, inputSize, inputSize);
	ctx.drawImage(bitmap, padLeft, padTop, scaledWidth, scaledHeight);
	return {
		imageData: ctx.getImageData(0, 0, inputSize, inputSize),
		info: { scale, padLeft, padTop, inputSize }
	};
}

/** Plain (aspect-squashing) resize — manga-ocr's ViT and RT-DETR both use it. */
export function resizeImage(bitmap: ImageBitmap, width: number, height: number): ImageData {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Unable to create resize canvas context');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(bitmap, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height);
}

/** Crop a region (with margin) from the full-resolution page bitmap. */
export function cropRegion(
	bitmap: ImageBitmap,
	region: { x: number; y: number; width: number; height: number },
	marginPx = 2
): OffscreenCanvas {
	const x = Math.max(0, Math.floor(region.x - marginPx));
	const y = Math.max(0, Math.floor(region.y - marginPx));
	const right = Math.min(bitmap.width, Math.ceil(region.x + region.width + marginPx));
	const bottom = Math.min(bitmap.height, Math.ceil(region.y + region.height + marginPx));
	const width = Math.max(1, right - x);
	const height = Math.max(1, bottom - y);
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Unable to create crop canvas context');
	ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
	return canvas;
}

/**
 * ImageData → CHW Float32Array, RGB order.
 * `normalization: '01'` → pixel/255; `'pm1'` → (pixel/255 − 0.5)/0.5.
 */
export function imageDataToCHW(imageData: ImageData, normalization: '01' | 'pm1'): Float32Array {
	const { data, width, height } = imageData;
	const planeSize = width * height;
	const chw = new Float32Array(3 * planeSize);
	for (let i = 0; i < planeSize; i++) {
		const r = data[i * 4] / 255;
		const g = data[i * 4 + 1] / 255;
		const b = data[i * 4 + 2] / 255;
		if (normalization === '01') {
			chw[i] = r;
			chw[planeSize + i] = g;
			chw[2 * planeSize + i] = b;
		} else {
			chw[i] = (r - 0.5) / 0.5;
			chw[planeSize + i] = (g - 0.5) / 0.5;
			chw[2 * planeSize + i] = (b - 0.5) / 0.5;
		}
	}
	return chw;
}

/** Map a letterboxed-coordinate box back to original image space, clamped. */
export function unletterboxBox(
	box: { x1: number; y1: number; x2: number; y2: number },
	info: LetterboxInfo,
	originalWidth: number,
	originalHeight: number
): { x: number; y: number; width: number; height: number } {
	const x1 = Math.max(0, (box.x1 - info.padLeft) / info.scale);
	const y1 = Math.max(0, (box.y1 - info.padTop) / info.scale);
	const x2 = Math.min(originalWidth, (box.x2 - info.padLeft) / info.scale);
	const y2 = Math.min(originalHeight, (box.y2 - info.padTop) / info.scale);
	return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

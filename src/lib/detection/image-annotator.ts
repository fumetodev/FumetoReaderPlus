/**
 * Image annotator — draws numbered boxes on a page image.
 *
 * Used in the numbered-boxes pipeline: detected text regions get numbered
 * labels drawn on the image before sending to the LLM, so the LLM can
 * return translations keyed by box number.
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import { resizeBlobToBase64 } from '$lib/util/base64.js';

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
	}
}

/**
 * Draw numbered boxes on a copy of the page image.
 *
 * Returns a base64 data URI of the annotated image (JPEG, quality 0.85)
 * suitable for sending to the LLM vision API.
 *
 * @param imageBlob - Original page image
 * @param regions - Detected text regions to annotate
 * @param maxSize - Maximum dimension for the output image (for API cost control)
 * @returns Base64 data URI of the annotated image
 */
export async function annotateImageWithBoxes(
	imageBlob: Blob,
	regions: DetectedTextRegion[],
	maxSize: number = 1536,
	signal?: AbortSignal
): Promise<string> {
	throwIfAborted(signal);
	const bitmap = await createImageBitmap(imageBlob);
	try {
		throwIfAborted(signal);
		const origW = bitmap.width;
		const origH = bitmap.height;

		// Scale down if needed
		const scale = Math.min(1, maxSize / Math.max(origW, origH));
		const outW = Math.round(origW * scale);
		const outH = Math.round(origH * scale);

		const canvas = new OffscreenCanvas(outW, outH);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Unable to create a 2D canvas for image annotation');

		// Draw the original image
		ctx.drawImage(bitmap, 0, 0, outW, outH);

		// Draw numbered boxes
		const lineWidth = Math.max(2, Math.round(Math.min(outW, outH) / 400));
		const fontSize = Math.max(14, Math.round(Math.min(outW, outH) / 50));
		const labelPadding = 3;

		ctx.lineWidth = lineWidth;
		ctx.font = `bold ${fontSize}px sans-serif`;

		for (const region of regions) {
			throwIfAborted(signal);
			const x = Math.round(region.x * scale);
			const y = Math.round(region.y * scale);
			const w = Math.round(region.width * scale);
			const h = Math.round(region.height * scale);
			const label = String(region.boxId);

			// Draw red box outline
			ctx.strokeStyle = 'red';
			ctx.strokeRect(x, y, w, h);

			// Measure label text
			const textMetrics = ctx.measureText(label);
			const labelW = textMetrics.width + labelPadding * 2;
			const labelH = fontSize + labelPadding * 2;

			// Draw label background (red rectangle above the box)
			const labelY = Math.max(0, y - labelH);
			ctx.fillStyle = 'red';
			ctx.fillRect(x, labelY, labelW, labelH);

			// Draw label text (white on red)
			ctx.fillStyle = 'white';
			ctx.textBaseline = 'top';
			ctx.fillText(label, x + labelPadding, labelY + labelPadding);
		}

		// Export through the shared bounded encoder. It preserves this JPEG when
		// it already fits and otherwise uses the finite quality/dimension ladder.
		throwIfAborted(signal);
		const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
		throwIfAborted(signal);
		return await resizeBlobToBase64(blob, maxSize, signal);
	} finally {
		bitmap.close();
	}
}

/**
 * Classical edge density analysis — computes per-pixel edge magnitude
 * using Sobel operators. Used by smart sizing to detect visually complex
 * (artwork-heavy) regions underneath overlay boxes.
 *
 * No ML model required — pure Canvas pixel math.
 */

const DEFAULT_SIZE = 320;

/**
 * Compute an edge density map for an image.
 * Returns a Float32Array where each value is normalized edge magnitude (0-1).
 */
export async function computeEdgeDensity(
	imageBlob: Blob,
	outputW: number = DEFAULT_SIZE,
	outputH: number = DEFAULT_SIZE
): Promise<{ map: Float32Array; width: number; height: number }> {
	const bitmap = await createImageBitmap(imageBlob);
	const canvas = new OffscreenCanvas(outputW, outputH);
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(bitmap, 0, 0, outputW, outputH);
	bitmap.close();

	const imageData = ctx.getImageData(0, 0, outputW, outputH);
	const pixels = imageData.data;

	// Convert to grayscale
	const gray = new Float32Array(outputW * outputH);
	for (let i = 0; i < gray.length; i++) {
		const idx = i * 4;
		gray[i] = (pixels[idx] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx + 2] * 0.114) / 255.0;
	}

	// Apply Sobel edge detection
	const edgeMap = new Float32Array(outputW * outputH);
	let maxMag = 0;

	for (let y = 1; y < outputH - 1; y++) {
		for (let x = 1; x < outputW - 1; x++) {
			// Sobel Gx kernel
			const gx =
				-gray[(y - 1) * outputW + (x - 1)] + gray[(y - 1) * outputW + (x + 1)] +
				-2 * gray[y * outputW + (x - 1)] + 2 * gray[y * outputW + (x + 1)] +
				-gray[(y + 1) * outputW + (x - 1)] + gray[(y + 1) * outputW + (x + 1)];

			// Sobel Gy kernel
			const gy =
				-gray[(y - 1) * outputW + (x - 1)] - 2 * gray[(y - 1) * outputW + x] - gray[(y - 1) * outputW + (x + 1)] +
				gray[(y + 1) * outputW + (x - 1)] + 2 * gray[(y + 1) * outputW + x] + gray[(y + 1) * outputW + (x + 1)];

			const mag = Math.sqrt(gx * gx + gy * gy);
			edgeMap[y * outputW + x] = mag;
			if (mag > maxMag) maxMag = mag;
		}
	}

	// Normalize to 0-1
	if (maxMag > 0) {
		for (let i = 0; i < edgeMap.length; i++) {
			edgeMap[i] /= maxMag;
		}
	}

	return { map: edgeMap, width: outputW, height: outputH };
}

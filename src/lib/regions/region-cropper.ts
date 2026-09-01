/**
 * Region cropper — extract highlighted regions as base64 images.
 *
 * Uses OffscreenCanvas for efficient cropping.
 * Output is a base64 data URI ready for the OpenRouter vision API.
 */

import { cropRegionToBase64 } from '$lib/util/base64.js';
import type { TranslationRegion } from '$lib/types/index.js';

/**
 * Crop a translation region from a page image file.
 *
 * @param imageFile - The full page image file
 * @param region - The region to crop (image-space coordinates)
 * @returns Base64 data URI of the cropped region
 */
export async function cropRegion(
	imageFile: File,
	region: TranslationRegion
): Promise<string> {
	return cropRegionToBase64(imageFile, {
		x: region.x,
		y: region.y,
		width: region.width,
		height: region.height
	});
}

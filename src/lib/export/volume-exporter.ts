import { createPageSource } from '$lib/reader/page-source-factory.js';
import { extensionForPageMediaMime } from '$lib/import/types.js';
import { createCbzWriter } from '$lib/util/cbz-writer.js';
import { settings } from '$lib/settings/settings.js';
import { get } from 'svelte/store';
import type { OverlayRenderPlanV2, VolumeMetadata } from '$lib/types/index.js';
import {
	overlayLayoutSettingsFromApp,
	PageOverlayPlanController,
	pageOverlayRepository
} from '$lib/overlay-layout/index.js';
import type { ExportOptions } from './export-types.js';
import { renderOverlayPlanToCanvas } from './canvas-text-renderer.js';

/** Export uses the same immutable plan as the reader and replacement canvas. */
export async function exportTranslatedVolume(
	volume: VolumeMetadata,
	options: ExportOptions,
	onProgress?: (current: number, total: number) => void,
	signal?: AbortSignal
): Promise<Blob> {
	const appSettings = get(settings);
	const layoutSettings = overlayLayoutSettingsFromApp(appSettings, volume.overlay_font_scale ?? appSettings.overlayFontScaleDefault ?? 1);
	const pageSource = await createPageSource(volume);
	const planController = new PageOverlayPlanController();
	// Stream pages into the archive as they are baked: holding every decoded
	// page until the end (the previous shape) needed ~2-3x the volume's total
	// image bytes in the WebView heap and OOM'd long volumes on Android.
	const cbz = createCbzWriter();
	try {
		for (let pageIndex = 0; pageIndex < pageSource.pageCount; pageIndex += 1) {
			if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
			const pageBlob = await pageSource.getPage(pageIndex);
			let imageData: Uint8Array;
			let extension = options.format === 'png' ? 'png' : 'jpg';
			if (pageBlob.type.startsWith('video/')) {
				// Video pages pass through untranslated, byte-identical, under
				// their real extension (bakePage's createImageBitmap would throw
				// on them; a video named .jpg would break re-import). Our own
				// importer accepts the result, so export→import round-trips.
				imageData = new Uint8Array(await pageBlob.arrayBuffer());
				extension = extensionForPageMediaMime(pageBlob.type) ?? 'bin';
			} else {
				const read = await pageOverlayRepository.load(volume.volume_uuid, pageIndex);
				if (read.status === 'ready' && read.overlay && read.pageTranslation) {
					const plan = await planController.request({
						scopeId: `export:${volume.volume_uuid}`,
						document: read.overlay,
						translations: read.pageTranslation.entries,
						settings: layoutSettings
					}, { volumeUuid: volume.volume_uuid, pageIndex, persist: true, signal });
					imageData = await bakePage(pageBlob, plan, options);
				} else {
					imageData = new Uint8Array(await pageBlob.arrayBuffer());
				}
			}
			await cbz.add(`${String(pageIndex + 1).padStart(4, '0')}.${extension}`, imageData);
			onProgress?.(pageIndex + 1, pageSource.pageCount);
		}
		return await cbz.close();
	} finally {
		pageSource.dispose();
		planController.invalidate(`export:${volume.volume_uuid}`);
	}
}

async function bakePage(pageBlob: Blob, plan: OverlayRenderPlanV2, options: ExportOptions): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(pageBlob);
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas 2D is unavailable');
	context.drawImage(bitmap, 0, 0);
	const scaleX = bitmap.width / plan.sourceImage.width;
	const scaleY = bitmap.height / plan.sourceImage.height;
	bitmap.close();
	// The plan's coordinates live in the source image's pixel space. A remote
	// server can re-encode a page at a different resolution between translation
	// and export: a uniform rescale keeps the overlays registered, but a changed
	// aspect ratio means this is not the same crop, and stamping text over
	// re-framed art is worse than shipping the page untranslated. Dimensions are
	// the load-bearing property here, not the bytes — a lossless re-encode at
	// the same size is harmless and must not disable overlays.
	if (Math.abs(scaleX - scaleY) > 0.01) {
		return new Uint8Array(await pageBlob.arrayBuffer());
	}
	if (scaleX !== 1) context.scale(scaleX, scaleY);
	renderOverlayPlanToCanvas(context, plan);
	const mimeType = options.format === 'png' ? 'image/png' : 'image/jpeg';
	const quality = options.format === 'jpeg' ? options.quality : undefined;
	const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
		(value) => value ? resolve(value) : reject(new Error('canvas.toBlob returned null')),
		mimeType,
		quality
	));
	return new Uint8Array(await blob.arrayBuffer());
}

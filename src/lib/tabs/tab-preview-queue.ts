import type { VolumeMetadata } from '$lib/types/index.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import { db } from '$lib/db/index.js';
import { updateTabPreview, type TabPreviewUpdate } from './comic-tabs.js';
import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';
import { captureVideoPosterFrame } from '$lib/util/video-poster.js';

const MAX_EDGE = 512;
const WEBP_QUALITY = 0.78;

interface PreviewJob {
	key: string;
	controller: AbortController;
}

async function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function downscaleTabPreview(blob: Blob): Promise<TabPreviewUpdate> {
	if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
		return { pageIndex: 0, blob, mimeType: blob.type || 'image/jpeg', width: 0, height: 0 };
	}
	// Video pages preview from a poster frame (serialized decoder queue).
	const bitmap = blob.type.startsWith('video/')
		? await captureVideoPosterFrame(blob)
		: await createImageBitmap(blob);
	try {
		const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		canvas.getContext('2d', { alpha: false })?.drawImage(bitmap, 0, 0, width, height);
		const webp = await canvasBlob(canvas, 'image/webp', WEBP_QUALITY);
		const output = webp ?? await canvasBlob(canvas, 'image/jpeg', 0.82) ?? blob;
		return { pageIndex: 0, blob: output, mimeType: output.type || 'image/jpeg', width, height };
	} finally {
		bitmap.close();
	}
}

class TabPreviewQueue {
	private readonly jobs = new Map<string, PreviewJob>();

	constructor() {
		appWorkCoordinator.setLaneCapacity('image-decode', 2);
	}

	enqueue(volume: VolumeMetadata, pageIndex: number, priority = 0): () => void {
		const key = volume.volume_uuid;
		this.jobs.get(key)?.controller.abort();
		const job: PreviewJob = { key, controller: new AbortController() };
		this.jobs.set(key, job);
		void appWorkCoordinator.submit({
			kind: 'tab-preview',
			owner: priority > 0 ? 'tabs-visible-window' : 'tabs-prefetch',
			lane: 'image-decode',
			priority: priority > 0 ? 1 : 3,
			coalescingKey: `tab-preview:${key}:${pageIndex}`,
			signal: job.controller.signal,
			operation: ({ signal }) => this.run(volume, pageIndex, signal),
		}).promise.catch((error) => {
			if ((error as Error)?.name !== 'AbortError') console.debug('[Tabs] Preview refresh failed:', error);
		}).finally(() => {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
		});
		return () => job.controller.abort();
	}

	cancel(volumeUuid: string): void {
		this.jobs.get(volumeUuid)?.controller.abort();
		this.jobs.delete(volumeUuid);
	}

	private async run(volume: VolumeMetadata, pageIndex: number, signal: AbortSignal): Promise<void> {
		let source: Awaited<ReturnType<typeof createPageSource>> | undefined;
		try {
			if (!await db.comic_tabs.get(volume.volume_uuid)) return;
			source = await createPageSource(volume, { signal, purpose: 'preview' });
			const raw = await source.getPage(pageIndex, { signal });
			const preview = await downscaleTabPreview(raw);
			if (signal.aborted) return;
			await updateTabPreview(volume.volume_uuid, { ...preview, pageIndex });
		} catch (error) {
			if ((error as Error)?.name !== 'AbortError') console.debug('[Tabs] Preview refresh failed:', error);
		} finally {
			source?.dispose();
		}
	}

	inspect(): { active: number; pending: number } {
		const lane = appWorkCoordinator.inspect().lanes['image-decode'];
		return { active: lane?.active ?? 0, pending: lane?.queued ?? 0 };
	}
}

export const tabPreviewQueue = new TabPreviewQueue();

export function queueTabPreview(volume: VolumeMetadata, pageIndex: number, priority = 0): () => void {
	return tabPreviewQueue.enqueue(volume, pageIndex, priority);
}

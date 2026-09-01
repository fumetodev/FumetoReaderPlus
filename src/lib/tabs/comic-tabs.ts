import type { FumetoDB } from '$lib/db/schema.js';
import { db } from '$lib/db/index.js';
import type { ComicTab, VolumeMetadata } from '$lib/types/index.js';
import { makeMediaAsset, tabPreviewAssetId } from '$lib/catalog/catalog-repository.js';

export interface LiveComicTab {
	tab: ComicTab;
	volume: VolumeMetadata;
}

function nowIso(now?: Date): string {
	return (now ?? new Date()).toISOString();
}

/**
 * Create a tab once, or focus the existing tab without changing creation order.
 *
 * Callers own the decision: a tab exists only because the user explicitly asked
 * for one (a Tabs card tap, or "Open in New Tab"). Reading a comic never lands
 * here — Continue Reading carries the current comic instead.
 */
export async function createOrFocusTab(
	volumeUuid: string,
	database: FumetoDB = db,
	now?: Date
): Promise<ComicTab> {
	const timestamp = nowIso(now);
	return database.transaction('rw', database.comic_tabs, async () => {
		const existing = await database.comic_tabs.get(volumeUuid);
		if (existing) {
			const focused = { ...existing, last_active_at: timestamp };
			await database.comic_tabs.put(focused);
			return focused;
		}
		const last = await database.comic_tabs.orderBy('position').last();
		const tab: ComicTab = {
			volume_uuid: volumeUuid,
			position: (last?.position ?? -1) + 1,
			opened_at: timestamp,
			last_active_at: timestamp
		};
		await database.comic_tabs.add(tab);
		return tab;
	});
}

export function closeTab(volumeUuid: string, database: FumetoDB = db): Promise<void> {
	return database.transaction('rw', [database.comic_tabs, database.media_assets], async () => {
		await database.comic_tabs.delete(volumeUuid);
		await database.media_assets.delete(tabPreviewAssetId(volumeUuid));
	});
}

/**
 * Repository entry point for fixture/import batches. Preview bytes follow the
 * same split-media contract as ordinary preview updates.
 */
export async function bulkPutTabs(
	tabs: readonly ComicTab[],
	database: FumetoDB = db
): Promise<void> {
	const metadata = tabs.map((tab) => ({ ...tab, preview_blob: undefined }));
	const assets = tabs.flatMap((tab) => tab.preview_blob ? [makeMediaAsset({
		id: tabPreviewAssetId(tab.volume_uuid),
		ownerType: 'tab',
		ownerId: tab.volume_uuid,
		kind: 'tab-preview',
		blob: tab.preview_blob,
		width: tab.preview_width,
		height: tab.preview_height,
		revision: `${tab.preview_page_index ?? 0}:${tab.preview_updated_at ?? tab.last_active_at}:${tab.preview_blob.size}`
	})] : []);
	await database.transaction('rw', [database.comic_tabs, database.media_assets], async () => {
		await database.comic_tabs.bulkPut(metadata);
		if (assets.length > 0) await database.media_assets.bulkPut(assets);
	});
}

/** Return only tabs with a live volume, pruning stale records in the same call. */
export async function listLiveTabs(database: FumetoDB = db): Promise<LiveComicTab[]> {
	const tabs = await database.comic_tabs.orderBy('position').toArray();
	const volumes = await database.volumes.bulkGet(tabs.map((tab) => tab.volume_uuid));
	const stale: string[] = [];
	const live: LiveComicTab[] = [];
	for (let index = 0; index < tabs.length; index += 1) {
		const volume = volumes[index];
		if (volume) live.push({ tab: tabs[index], volume });
		else stale.push(tabs[index].volume_uuid);
	}
	if (stale.length > 0) await database.comic_tabs.bulkDelete(stale);
	return live;
}

export async function pruneStaleTabs(database: FumetoDB = db): Promise<number> {
	const before = await database.comic_tabs.count();
	await listLiveTabs(database);
	return before - await database.comic_tabs.count();
}

export interface TabPreviewUpdate {
	pageIndex: number;
	blob: Blob;
	mimeType: string;
	width: number;
	height: number;
}

/** Store a preview only if the tab and its successfully committed page still match. */
export async function updateTabPreview(
	volumeUuid: string,
	preview: TabPreviewUpdate,
	database: FumetoDB = db,
	now?: Date
): Promise<boolean> {
	return database.transaction('rw', [database.comic_tabs, database.volumes, database.media_assets], async () => {
		const [tab, volume] = await Promise.all([
			database.comic_tabs.get(volumeUuid),
			database.volumes.get(volumeUuid)
		]);
		if (!tab || !volume || volume.current_page !== preview.pageIndex) return false;
		await database.comic_tabs.update(volumeUuid, {
			preview_page_index: preview.pageIndex,
			preview_blob: undefined,
			preview_mime_type: preview.mimeType,
			preview_width: preview.width,
			preview_height: preview.height,
			preview_updated_at: nowIso(now)
		});
		await database.media_assets.put(makeMediaAsset({
			id: tabPreviewAssetId(volumeUuid),
			ownerType: 'tab',
			ownerId: volumeUuid,
			kind: 'tab-preview',
			blob: preview.blob,
			width: preview.width,
			height: preview.height,
			revision: `${preview.pageIndex}:${nowIso(now)}:${preview.blob.size}`
		}));
		return true;
	});
}

export function deleteTabsForVolumes(volumeUuids: readonly string[], database: FumetoDB = db): Promise<void> {
	return database.comic_tabs.bulkDelete([...volumeUuids]);
}

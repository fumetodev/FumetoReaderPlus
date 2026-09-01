import { liveQuery, type Subscription } from 'dexie';
import type { FumetoDB } from '$lib/db/schema.js';
import { db } from '$lib/db/index.js';
import type { ComicTab, MediaAsset, VolumeMetadata } from '$lib/types/index.js';
import { catalogRowToVolume, makeMediaAsset, tabPreviewAssetId, volumeThumbnailAssetId } from '$lib/catalog/catalog-repository.js';
import type { LiveComicTab } from '$lib/tabs/comic-tabs.js';
import {
	beginLoading,
	errorSnapshot,
	readySnapshot,
	uninitializedSnapshot,
	type LoadableSnapshot
} from './loadable-snapshot.js';

export interface TabsSnapshotData { tabs: LiveComicTab[]; scrollTop: number }
type Listener = (snapshot: LoadableSnapshot<TabsSnapshotData>) => void;

export class TabsController {
	private snapshot: LoadableSnapshot<TabsSnapshotData> = uninitializedSnapshot();
	private readonly listeners = new Set<Listener>();
	private subscription?: Subscription;
	private scrollTop = 0;

	constructor(private readonly database: FumetoDB = db) {}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	getSnapshot(): LoadableSnapshot<TabsSnapshotData> {
		return this.snapshot;
	}

	start(): void {
		if (this.subscription) return;
		this.publish(beginLoading(this.snapshot));
		this.subscription = liveQuery(() => this.query()).subscribe({
			next: (tabs) => this.publish(readySnapshot(this.snapshot, { tabs, scrollTop: this.scrollTop })),
			error: (error) => this.publish(errorSnapshot(this.snapshot, error))
		});
	}

	refresh(): void {
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		this.start();
	}

	setScrollTop(scrollTop: number): void {
		this.scrollTop = Math.max(0, scrollTop);
		if (this.snapshot.data) this.snapshot = { ...this.snapshot, data: { ...this.snapshot.data, scrollTop: this.scrollTop } };
	}

	async loadPreviewAssets(volumeUuids: readonly string[]): Promise<Map<string, MediaAsset>> {
		const tabIds = volumeUuids.map(tabPreviewAssetId);
		const volumeIds = volumeUuids.map(volumeThumbnailAssetId);
		const [previews, thumbnails] = await Promise.all([
			this.database.media_assets.bulkGet(tabIds),
			this.database.media_assets.bulkGet(volumeIds)
		]);
		const result = new Map<string, MediaAsset>();
		for (let index = 0; index < volumeUuids.length; index += 1) {
			const asset = previews[index] ?? thumbnails[index];
			if (asset) result.set(volumeUuids[index], asset);
		}
		const missing = volumeUuids.filter((uuid) => !result.has(uuid));
		if (missing.length > 0) {
			const [tabs, volumes] = await Promise.all([
				this.database.comic_tabs.bulkGet(missing),
				this.database.volumes.bulkGet(missing)
			]);
			for (let index = 0; index < missing.length; index += 1) {
				const blob = tabs[index]?.preview_blob ?? volumes[index]?.thumbnail;
				if (!blob) continue;
				result.set(missing[index], makeMediaAsset({
					id: tabs[index]?.preview_blob ? tabPreviewAssetId(missing[index]) : volumeThumbnailAssetId(missing[index]),
					ownerType: tabs[index]?.preview_blob ? 'tab' : 'volume',
					ownerId: missing[index],
					kind: tabs[index]?.preview_blob ? 'tab-preview' : 'volume-thumbnail',
					blob,
					width: tabs[index]?.preview_width ?? volumes[index]?.thumbnail_width,
					height: tabs[index]?.preview_height ?? volumes[index]?.thumbnail_height,
					revision: 'legacy-visible-fallback'
				}));
			}
		}
		return result;
	}

	destroy(): void {
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	}

	private async query(): Promise<LiveComicTab[]> {
		const tabs = await this.database.comic_tabs.orderBy('position').toArray();
		const rows = await this.database.catalog_rows.bulkGet(tabs.map((tab) => tab.volume_uuid));
		const missing = tabs.filter((_tab, index) => !rows[index]);
		const legacy = missing.length > 0
			? await this.database.volumes.bulkGet(missing.map((tab) => tab.volume_uuid))
			: [];
		const legacyById = new Map<string, VolumeMetadata>();
		for (let index = 0; index < missing.length; index += 1) {
			const volume = legacy[index];
			if (volume) legacyById.set(missing[index].volume_uuid, volume);
		}
		const stale: string[] = [];
		const result: LiveComicTab[] = [];
		for (let index = 0; index < tabs.length; index += 1) {
			const tab: ComicTab = {
				...tabs[index],
				preview_blob: undefined
			};
			const row = rows[index];
			const volume = row ? catalogRowToVolume(row) : legacyById.get(tab.volume_uuid);
			if (volume) result.push({ tab, volume: { ...volume, thumbnail: undefined } });
			else stale.push(tab.volume_uuid);
		}
		if (stale.length > 0) await this.database.comic_tabs.bulkDelete(stale);
		return result;
	}

	private publish(snapshot: LoadableSnapshot<TabsSnapshotData>): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}

export const tabsController = new TabsController();

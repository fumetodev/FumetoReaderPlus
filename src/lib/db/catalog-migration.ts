import type { FumetoDB } from './schema.js';
import { db } from './index.js';
import type {
	CatalogIndexState,
	CatalogProvider,
	ComicTab,
	RemoteFolder,
	VolumeMetadata
} from '$lib/types/index.js';
import {
	UNASSIGNED_LIBRARY_ID,
	folderCoverAssetId,
	makeMediaAsset,
	tabPreviewAssetId,
	toCatalogRow,
	volumeThumbnailAsset,
	volumeThumbnailAssetId
} from '$lib/catalog/catalog-repository.js';
import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';

export interface CatalogMigrationOptions {
	batchSize?: number;
	timeBudgetMs?: number;
	signal?: AbortSignal;
	storageEstimate?: () => Promise<{ quota?: number; usage?: number }>;
	now?: () => number;
	yieldControl?: () => Promise<void>;
}

export interface CatalogMigrationResult {
	status: 'ready' | 'paused' | 'cancelled';
	volumesMigrated: number;
	foldersMigrated: number;
	tabsMigrated: number;
}

function dataUrlToBlob(value: string): Blob | undefined {
	const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(value);
	if (!match) return undefined;
	try {
		const mime = match[1] || 'application/octet-stream';
		const bytes = value.slice(0, value.indexOf(',')).includes(';base64')
			? Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
			: new TextEncoder().encode(decodeURIComponent(match[2]));
		return new Blob([bytes], { type: mime });
	} catch {
		return undefined;
	}
}

function providerForLibrary(volumes: readonly VolumeMetadata[]): CatalogProvider {
	return volumes.find((volume) => volume.source?.type)?.source?.type ?? 'local';
}

function initialState(libraryId: string, provider: CatalogProvider): CatalogIndexState {
	return {
		library_id: libraryId,
		provider,
		completeness: 'migrating',
		generation: 1,
		status: 'idle',
		folders_visited: 0,
		entries_discovered: 0,
		entries_reconciled: 0,
		updated_at: new Date().toISOString()
	};
}

async function isAlreadySplitProjection(
	database: FumetoDB,
	libraryId: string,
	volumeKeys: readonly string[]
): Promise<boolean> {
	const rowKeys = (await database.catalog_rows.where('library_id').equals(libraryId).primaryKeys())
		.map(String).sort((a, b) => a.localeCompare(b));
	if (rowKeys.length !== volumeKeys.length || rowKeys.some((key, index) => key !== volumeKeys[index])) {
		return false;
	}
	const volumes = libraryId === UNASSIGNED_LIBRARY_ID
		? database.volumes.filter((volume) => !volume.library_id)
		: database.volumes.where('library_id').equals(libraryId);
	if (await volumes.filter((volume) => Boolean(volume.thumbnail)).count() > 0) return false;
	const legacyFolders = await database.remote_folders.where('librarySettingsId').equals(libraryId)
		.filter((folder) => Boolean(folder.coverThumbnailDataUrl) || !folder.parentKey)
		.count();
	return legacyFolders === 0;
}

async function validateMedia(
	database: FumetoDB,
	id: string,
	expected: Blob
): Promise<void> {
	const stored = await database.media_assets.get(id);
	if (!stored || stored.id !== id || stored.byte_length !== expected.size) {
		throw new Error(`Media validation failed for ${id}`);
	}
	const expectedMime = expected.type || 'application/octet-stream';
	if (stored.mime_type !== expectedMime || stored.blob.size !== expected.size) {
		throw new Error(`Media MIME/length validation failed for ${id}`);
	}
}

async function enoughSpace(
	records: readonly VolumeMetadata[],
	estimate: () => Promise<{ quota?: number; usage?: number }>
): Promise<boolean> {
	const required = records.reduce((total, volume) => total + (volume.thumbnail?.size ?? 0), 0);
	if (required === 0) return true;
	try {
		const { quota, usage } = await estimate();
		if (quota === undefined || usage === undefined) return true;
		return quota - usage >= Math.ceil(required * 1.1);
	} catch {
		return true;
	}
}

/**
 * Populate v16 stores after Dexie opens. The operation is idempotent, records a
 * checkpoint after every bounded batch. Embedded legacy media is cleared only
 * after key, MIME type, and byte length have been read back successfully.
 */
export async function migrateCatalogV16(
	database: FumetoDB = db,
	options: CatalogMigrationOptions = {}
): Promise<CatalogMigrationResult> {
	const batchSize = Math.max(1, Math.min(100, Math.floor(options.batchSize ?? 100)));
	const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? 8);
	const now = options.now ?? (() => performance.now());
	const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	const storageEstimate = options.storageEstimate ?? (async () => navigator.storage?.estimate?.() ?? {});
	const result: CatalogMigrationResult = { status: 'ready', volumesMigrated: 0, foldersMigrated: 0, tabsMigrated: 0 };

	const libraryIds = new Set<string>();
	await database.volumes.each((volume) => libraryIds.add(volume.library_id ?? UNASSIGNED_LIBRARY_ID));
	await database.remote_folders.each((folder) => libraryIds.add(folder.librarySettingsId));

	for (const libraryId of libraryIds) {
		if (options.signal?.aborted) return { ...result, status: 'cancelled' };
		const volumeKeys = (libraryId === UNASSIGNED_LIBRARY_ID
			? await database.volumes.filter((volume) => !volume.library_id).primaryKeys()
			: await database.volumes.where('library_id').equals(libraryId).primaryKeys()
		).map(String).sort((a, b) => a.localeCompare(b));
		const firstVolume = volumeKeys.length > 0 ? await database.volumes.get(volumeKeys[0]) : undefined;
		const storedState = await database.catalog_index_state.get(libraryId);
		if (!storedState && await isAlreadySplitProjection(database, libraryId, volumeKeys)) {
			const readyState = initialState(libraryId, providerForLibrary(firstVolume ? [firstVolume] : []));
			await database.catalog_index_state.put({
				...readyState,
				completeness: 'ready',
				last_success_at: new Date().toISOString(),
				updated_at: new Date().toISOString()
			});
			continue;
		}
		let state = storedState ?? initialState(libraryId, providerForLibrary(firstVolume ? [firstVolume] : []));
		if (state.completeness === 'ready') continue;
		if (!storedState) await database.catalog_index_state.put(state);
		await database.catalog_index_state.update(libraryId, {
			completeness: 'migrating',
			migration_error: undefined,
			updated_at: new Date().toISOString()
		});

		// v16 prerelease builds stored migration progress in `checkpoint`. Read
		// that shape once for compatibility, but keep all new migration writes in
		// an independent field so a concurrent YAC crawl retains its own durable
		// pending/visited-folder checkpoint and phase diagnostics.
		const legacyMigrationCheckpoint = state.checkpoint?.last_volume_uuid
			|| state.checkpoint?.last_folder_id
			|| state.checkpoint?.last_tab_uuid
			? state.checkpoint
			: undefined;
		let migrationCheckpoint = state.migration_checkpoint ?? legacyMigrationCheckpoint;
		const startAfter = migrationCheckpoint?.last_volume_uuid;
		const startIndex = startAfter
			? Math.max(0, volumeKeys.findIndex((key) => key === startAfter) + 1)
			: 0;
		for (let offset = startIndex; offset < volumeKeys.length;) {
			const batch = (await database.volumes.bulkGet(volumeKeys.slice(offset, offset + batchSize)))
				.filter((volume): volume is VolumeMetadata => Boolean(volume));
			if (batch.length === 0) {
				offset += batchSize;
				continue;
			}
			if (!await enoughSpace(batch, storageEstimate)) {
				await database.catalog_index_state.update(libraryId, {
					completeness: 'paused',
					migration_error: 'Insufficient free storage for catalog media migration',
					updated_at: new Date().toISOString()
				});
				return { ...result, status: 'paused' };
			}
			const started = now();
			let consumed = 0;
			for (const volume of batch) {
				if (options.signal?.aborted) return { ...result, status: 'cancelled' };
				const asset = volumeThumbnailAsset(volume);
				const retainedAsset = asset ?? await database.media_assets.get(volumeThumbnailAssetId(volume.volume_uuid));
				await database.transaction('rw', [database.volumes, database.catalog_rows, database.media_assets], async () => {
					const row = toCatalogRow(volume);
					await database.catalog_rows.put(
						retainedAsset && !row.thumbnail_asset_id
							? { ...row, thumbnail_asset_id: retainedAsset.id }
							: row
					);
					if (asset) {
						await database.media_assets.put(asset);
						await validateMedia(database, asset.id, asset.blob);
						await database.volumes.update(volume.volume_uuid, {
							thumbnail: undefined,
							thumbnail_width: undefined,
							thumbnail_height: undefined,
						});
					}
				});
				consumed += 1;
				result.volumesMigrated += 1;
				migrationCheckpoint = { ...migrationCheckpoint, last_volume_uuid: volume.volume_uuid };
				if (now() - started >= timeBudgetMs) break;
			}
			offset += consumed;
			await database.catalog_index_state.update(libraryId, {
				migration_checkpoint: migrationCheckpoint,
				updated_at: new Date().toISOString()
			});
			await yieldControl();
		}

		const folderKeys = (await database.remote_folders.where('librarySettingsId').equals(libraryId).primaryKeys())
			.map(String).sort((a, b) => a.localeCompare(b));
		for (let offset = 0; offset < folderKeys.length;) {
			const started = now();
			let consumed = 0;
			const folderBatch = (await database.remote_folders.bulkGet(folderKeys.slice(offset, offset + batchSize)))
				.filter((folder): folder is RemoteFolder => Boolean(folder));
			if (folderBatch.length === 0) {
				offset += batchSize;
				continue;
			}
			for (const folder of folderBatch) {
				const blob = folder.coverThumbnailDataUrl ? dataUrlToBlob(folder.coverThumbnailDataUrl) : undefined;
				const assetId = folderCoverAssetId(folder.id);
				const normalized: RemoteFolder = {
					...folder,
					parentKey: folder.parentFolderId == null ? 'root' : `folder:${folder.parentFolderId}`,
					coverAssetId: blob ? assetId : folder.coverAssetId,
					metadataRevision: folder.metadataRevision ?? 1
				};
				await database.transaction('rw', [database.remote_folders, database.media_assets], async () => {
					await database.remote_folders.put(normalized);
					if (blob) {
						await database.media_assets.put(makeMediaAsset({
							id: assetId,
							ownerType: 'folder', ownerId: folder.id, kind: 'folder-cover', blob,
							revision: `${normalized.metadataRevision}:${blob.size}`
						}));
						await validateMedia(database, assetId, blob);
						await database.remote_folders.update(folder.id, { coverThumbnailDataUrl: undefined });
					}
				});
				result.foldersMigrated += 1;
				consumed += 1;
				migrationCheckpoint = { ...migrationCheckpoint, last_folder_id: folder.id };
				if (now() - started >= timeBudgetMs) break;
			}
			offset += consumed;
			await database.catalog_index_state.update(libraryId, {
				migration_checkpoint: migrationCheckpoint,
				updated_at: new Date().toISOString()
			});
			await yieldControl();
		}

		const completedAt = new Date().toISOString();
		await database.catalog_index_state.update(libraryId, {
			completeness: 'ready',
			migration_error: undefined,
			migration_completed_at: completedAt,
			migration_checkpoint: migrationCheckpoint,
			updated_at: completedAt
		});
	}

	const tabKeys = (await database.comic_tabs.orderBy('position').primaryKeys()).map(String);
	for (let offset = 0; offset < tabKeys.length; offset += batchSize) {
		const tabs = (await database.comic_tabs.bulkGet(tabKeys.slice(offset, offset + batchSize)))
			.filter((tab): tab is ComicTab => Boolean(tab));
		for (const tab of tabs) {
			if (options.signal?.aborted) return { ...result, status: 'cancelled' };
			await migrateTabPreview(database, tab);
			result.tabsMigrated += 1;
		}
		await yieldControl();
	}
	return result;
}

async function migrateTabPreview(database: FumetoDB, tab: ComicTab): Promise<void> {
	if (!tab.preview_blob) return;
	const id = tabPreviewAssetId(tab.volume_uuid);
	const asset = makeMediaAsset({
		id,
		ownerType: 'tab',
		ownerId: tab.volume_uuid,
		kind: 'tab-preview',
		blob: tab.preview_blob,
		width: tab.preview_width,
		height: tab.preview_height,
		revision: `${tab.preview_page_index ?? 0}:${tab.preview_updated_at ?? ''}:${tab.preview_blob.size}`
	});
	await database.transaction('rw', [database.media_assets, database.comic_tabs], async () => {
		await database.media_assets.put(asset);
		await validateMedia(database, id, tab.preview_blob!);
		await database.comic_tabs.update(tab.volume_uuid, { preview_blob: undefined });
	});
}

/** Start maintenance without occupying the first-paint call stack. */
export function scheduleCatalogV16Migration(database: FumetoDB = db): () => void {
	const controller = new AbortController();
	const start = () => {
		void appWorkCoordinator.submit({
			kind: 'catalog-v16-migration',
			owner: 'persistence',
			lane: 'indexeddb-maintenance',
			priority: 3,
			coalescingKey: 'catalog-v16-migration',
			signal: controller.signal,
			operation: ({ signal }) => migrateCatalogV16(database, { signal })
		}).promise.catch((error) => {
			if (error instanceof Error && error.name === 'AbortError') return;
			console.warn('[CatalogMigration] v16 migration paused after failure:', error);
		});
	};
	if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 2_000 });
	else setTimeout(start, 0);
	return () => controller.abort('app destroyed');
}

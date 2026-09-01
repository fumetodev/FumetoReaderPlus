import Dexie from 'dexie';
import type { FumetoDB } from '$lib/db/schema.js';
import { db } from '$lib/db/index.js';
import type {
	CatalogParentKey,
	CatalogProvider,
	CatalogRow,
	MediaAsset,
	RemoteFolder,
	VolumeMetadata
} from '$lib/types/index.js';
import { selectNextVolumeInFolder } from '$lib/reader/next-volume.js';

export const UNASSIGNED_LIBRARY_ID = '__fumeto_unassigned__';

export function normalizeCatalogTitle(value: string): string {
	return value.normalize('NFKC').trim().toLocaleLowerCase();
}

export function catalogProviderForVolume(volume: VolumeMetadata): CatalogProvider {
	return volume.source?.type ?? 'local';
}

export function catalogLibraryId(volume: Pick<VolumeMetadata, 'library_id'>): string {
	return volume.library_id ?? UNASSIGNED_LIBRARY_ID;
}

export function catalogParentKey(volume: VolumeMetadata): CatalogParentKey {
	const source = volume.source;
	if (source && source.type !== 'local') {
		const folderId = source.remoteFolderId;
		return !folderId || (source.type === 'yacreader' && folderId === '1')
			? 'root'
			: `folder:${folderId}`;
	}
	const folder = volume.folder_path?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	return folder ? `folder:${folder}` : 'root';
}

export function remoteSourceIdentity(volume: VolumeMetadata): string | undefined {
	const source = volume.source;
	if (!source || source.type === 'local') return undefined;
	if (source.type === 'yacreader') {
		return `yacreader:${source.serverUrl.replace(/\/+$/, '').toLowerCase()}:${source.remoteLibraryId}:${source.remoteComicId}`;
	}
	if (source.type === 'komga') {
		return `komga:${source.serverUrl.replace(/\/+$/, '').toLowerCase()}:${source.komgaLibraryId}:${source.komgaBookId}`;
	}
	return `kavita:${source.serverUrl.replace(/\/+$/, '').toLowerCase()}:${source.kavitaLibraryId}:${source.kavitaChapterId}`;
}

export function volumeThumbnailAssetId(volumeUuid: string): string {
	return `volume-thumbnail:${volumeUuid}`;
}

export function folderCoverAssetId(folderId: string): string {
	return `folder-cover:${folderId}`;
}

export function tabPreviewAssetId(volumeUuid: string): string {
	return `tab-preview:${volumeUuid}`;
}

export function toCatalogRow(volume: VolumeMetadata, revision = Date.now()): CatalogRow {
	return {
		volume_uuid: volume.volume_uuid,
		library_id: catalogLibraryId(volume),
		parent_key: catalogParentKey(volume),
		provider: catalogProviderForVolume(volume),
		title: volume.title,
		normalized_title: normalizeCatalogTitle(volume.title),
		filename: volume.filename,
		page_count: volume.page_count,
		created_at: volume.created_at,
		last_read_at: volume.last_read_at,
		favorited_at: volume.favorited_at,
		current_page: volume.current_page,
		reading_direction: volume.reading_direction,
		author: volume.author,
		tags: volume.tags ? [...volume.tags] : undefined,
		visibility: volume.visibility,
		folder_path: volume.folder_path,
		source: volume.source ? { ...volume.source } : undefined,
		media_kind: volume.media_kind,
		book_locator: volume.book_locator,
		book_progress_fraction: volume.book_progress_fraction,
		// Carried because these mappers are allowlists and this one was missed:
		// the reader read a per-volume overlay text size that the catalog row
		// dropped, while the exporter read the real volumes record and kept it —
		// so an exported CBZ could use a different text size than the page the
		// user was looking at when they exported it.
		overlay_font_scale: volume.overlay_font_scale,
		remote_source_identity: remoteSourceIdentity(volume),
		thumbnail_asset_id: volume.thumbnail ? volumeThumbnailAssetId(volume.volume_uuid) : undefined,
		metadata_revision: revision
	};
}

/**
 * The next comic in the same folder, in reading order, or null at the end.
 *
 * Scoped by the `[library_id+parent_key]` index, so "the current subfolder"
 * means exactly the grouping the catalog already displays — remote provider
 * folders included, not just local `folder_path` strings.
 */
export async function findNextVolumeInFolder(
	volume: VolumeMetadata,
	database: FumetoDB = db
): Promise<VolumeMetadata | null> {
	const siblings = await database.catalog_rows
		.where('[library_id+parent_key]')
		.equals([catalogLibraryId(volume), catalogParentKey(volume)])
		.toArray();
	const next = selectNextVolumeInFolder(volume.volume_uuid, siblings);
	return next ? catalogRowToVolume(next) : null;
}

export function catalogRowToVolume(row: CatalogRow): VolumeMetadata {
	return {
		volume_uuid: row.volume_uuid,
		title: row.title,
		filename: row.filename,
		page_count: row.page_count,
		created_at: row.created_at,
		last_read_at: row.last_read_at,
		favorited_at: row.favorited_at,
		current_page: row.current_page,
		reading_direction: row.reading_direction,
		author: row.author,
		tags: row.tags ? [...row.tags] : undefined,
		library_id: row.library_id === UNASSIGNED_LIBRARY_ID ? undefined : row.library_id,
		folder_path: row.folder_path,
		visibility: row.visibility,
		source: row.source ? { ...row.source } : undefined,
		// Book fields: this mapper is an explicit allowlist — anything not
		// enumerated here silently vanishes between the row and the UI.
		media_kind: row.media_kind,
		book_locator: row.book_locator,
		book_progress_fraction: row.book_progress_fraction,
		overlay_font_scale: row.overlay_font_scale
	};
}

function assetFromBlob(input: {
	id: string;
	ownerType: MediaAsset['owner_type'];
	ownerId: string;
	kind: MediaAsset['kind'];
	blob: Blob;
	width?: number;
	height?: number;
	revision: string;
}): MediaAsset {
	return {
		id: input.id,
		owner_type: input.ownerType,
		owner_id: input.ownerId,
		kind: input.kind,
		blob: input.blob,
		mime_type: input.blob.type || 'application/octet-stream',
		byte_length: input.blob.size,
		width: input.width,
		height: input.height,
		revision: input.revision,
		updated_at: new Date().toISOString()
	};
}

export function volumeThumbnailAsset(volume: VolumeMetadata): MediaAsset | undefined {
	if (!volume.thumbnail) return undefined;
	const sourceRevision = volume.source?.type === 'yacreader'
		? `yacreader:${volume.source.comicHash}`
		: `${volume.source?.type ?? 'local'}:${volume.thumbnail_generation_version ?? 0}`;
	return assetFromBlob({
		id: volumeThumbnailAssetId(volume.volume_uuid),
		ownerType: 'volume',
		ownerId: volume.volume_uuid,
		kind: 'volume-thumbnail',
		blob: volume.thumbnail,
		width: volume.thumbnail_width,
		height: volume.thumbnail_height,
		revision: `${sourceRevision}:${volume.thumbnail.size}`
	});
}

export function volumeWithoutEmbeddedMedia(volume: VolumeMetadata): VolumeMetadata {
	return volume.thumbnail === undefined
		? volume
		: {
			...volume,
			thumbnail: undefined,
			thumbnail_width: undefined,
			thumbnail_height: undefined,
		};
}

export async function putVolume(
	volume: VolumeMetadata,
	database: FumetoDB = db
): Promise<void> {
	const asset = volumeThumbnailAsset(volume);
	await database.transaction(
		'rw',
		[database.volumes, database.catalog_rows, database.media_assets],
		async () => {
			const existingAsset = asset ? undefined : await database.media_assets.get(volumeThumbnailAssetId(volume.volume_uuid));
			await database.volumes.put(volumeWithoutEmbeddedMedia(volume));
			const row = toCatalogRow(volume);
			await database.catalog_rows.put(existingAsset ? { ...row, thumbnail_asset_id: existingAsset.id } : row);
			if (asset) await database.media_assets.put(asset);
		}
	);
}

export async function bulkPutVolumes(
	volumes: readonly VolumeMetadata[],
	database: FumetoDB = db
): Promise<void> {
	const existingAssets = await database.media_assets.bulkGet(
		volumes.map((volume) => volumeThumbnailAssetId(volume.volume_uuid))
	);
	const rows = volumes.map((volume, index) => {
		const row = toCatalogRow(volume);
		const existing = existingAssets[index];
		return !row.thumbnail_asset_id && existing ? { ...row, thumbnail_asset_id: existing.id } : row;
	});
	const assets = volumes.flatMap((volume) => {
		const asset = volumeThumbnailAsset(volume);
		return asset ? [asset] : [];
	});
	await database.transaction('rw', [database.volumes, database.catalog_rows, database.media_assets], async () => {
		await database.volumes.bulkPut(volumes.map(volumeWithoutEmbeddedMedia));
		await database.catalog_rows.bulkPut(rows);
		if (assets.length > 0) await database.media_assets.bulkPut(assets);
	});
}

export async function updateVolume(
	volumeUuid: string,
	changes: Partial<VolumeMetadata>,
	database: FumetoDB = db
): Promise<boolean> {
	return database.transaction(
		'rw',
		[database.volumes, database.catalog_rows, database.media_assets],
		async () => {
			const current = await database.volumes.get(volumeUuid);
			if (!current) return false;
			const next = { ...current, ...changes } as VolumeMetadata;
			const existingAsset = await database.media_assets.get(volumeThumbnailAssetId(volumeUuid));
			await database.volumes.put(volumeWithoutEmbeddedMedia(next));
			const row = toCatalogRow(next);
			await database.catalog_rows.put(
				!row.thumbnail_asset_id && existingAsset ? { ...row, thumbnail_asset_id: existingAsset.id } : row
			);
			const asset = volumeThumbnailAsset(next);
			if (asset) await database.media_assets.put(asset);
			else if (Object.hasOwn(changes, 'thumbnail')) {
				await database.media_assets.delete(volumeThumbnailAssetId(volumeUuid));
			}
			return true;
		}
	);
}

/**
 * Set or clear a volume's favorite mark. Clearing DELETES the key (not
 * `undefined`-assigns it) so the row leaves the sparse `favorited_at` index —
 * the same discipline `last_read_at` follows.
 */
export async function setVolumeFavorited(
	volumeUuid: string,
	favorited: boolean,
	database: FumetoDB = db
): Promise<boolean> {
	return database.transaction('rw', [database.volumes, database.catalog_rows], async () => {
		const [volume, row] = await Promise.all([
			database.volumes.get(volumeUuid),
			database.catalog_rows.get(volumeUuid)
		]);
		if (!volume && !row) return false;
		const stamp = new Date().toISOString();
		const apply = <T extends { favorited_at?: string }>(record: T): T => {
			if (favorited) record.favorited_at = stamp;
			else delete record.favorited_at;
			return record;
		};
		if (volume) await database.volumes.put(apply(volume));
		if (row) await database.catalog_rows.put(apply(row));
		return true;
	});
}

/** Most recently read volumes, newest first (sparse index: unread rows absent). */
export async function listRecentlyRead(
	limit: number,
	database: FumetoDB = db
): Promise<CatalogRow[]> {
	return database.catalog_rows.orderBy('last_read_at').reverse().limit(limit).toArray();
}

/** Favorited volumes, most recently favorited first. */
export async function listFavorites(database: FumetoDB = db): Promise<CatalogRow[]> {
	return database.catalog_rows.orderBy('favorited_at').reverse().toArray();
}

/**
 * Never started: remote sync seeds `current_page`, so `=== 0` alone is wrong —
 * a volume synced at page 0 that was opened (last_read_at set) is not unread.
 */
export function isUnreadVolume(
	volume: Pick<VolumeMetadata, 'current_page' | 'last_read_at'>
): boolean {
	return volume.current_page === 0 && !volume.last_read_at;
}

/** Where the search overlay looks from the user's current location. */
export interface CatalogSearchScope {
	/** Restrict to one library, or null for the All-Libraries root. */
	libraryId: string | null;
	/**
	 * Local subtree root: '' = whole library; a folder path matches itself and
	 * every descendant. Ignored when `remoteParentKeys` is given.
	 */
	folderPrefix?: string;
	/**
	 * Remote subtree: the parent keys of the folder subtree being searched
	 * (from `remoteSubtreeParentKeys`). Remote rows nest by parent_key, not
	 * folder_path, so prefix matching cannot express their subtrees.
	 */
	remoteParentKeys?: readonly string[];
}

/**
 * Subtree-recursive catalog search (the locked search-scope decision): inside
 * a subfolder it searches that subtree, at a library root the whole library,
 * at the All-Libraries root everything. Matches normalized title or filename.
 */
export async function searchCatalogSubtree(
	scope: CatalogSearchScope,
	query: string,
	database: FumetoDB = db
): Promise<CatalogRow[]> {
	const needle = normalizeCatalogTitle(query);
	if (!needle) return [];
	const candidates = scope.libraryId === null
		? database.catalog_rows.toCollection()
		: database.catalog_rows.where('library_id').equals(scope.libraryId);
	const remoteKeys = scope.remoteParentKeys ? new Set(scope.remoteParentKeys) : null;
	const prefix = scope.folderPrefix ?? '';
	const rows = await candidates
		.filter((row) => {
			if (!row.normalized_title.includes(needle)
				&& !row.filename.toLowerCase().includes(needle)) return false;
			if (remoteKeys) return remoteKeys.has(row.parent_key);
			if (prefix === '') return true;
			const path = row.folder_path ?? '';
			return path === prefix || path.startsWith(`${prefix}/`);
		})
		.toArray();
	return rows.sort((a, b) => a.normalized_title.localeCompare(b.normalized_title));
}

/** A folder-name match from `searchCatalogFolders`. */
export type FolderSearchResult =
	| { kind: 'local'; libraryId: string; path: string; name: string }
	| { kind: 'remote'; libraryId: string; remoteFolderId: string; name: string };

/**
 * Folder-name search with the same subtree-recursive scope semantics as
 * `searchCatalogSubtree`: descendants of the current location whose own name
 * matches. Local folders are derived from row folder_paths (every prefix
 * chain is a folder); remote folders come from the remote_folders tree.
 * The folder being stood in is not its own result.
 */
export async function searchCatalogFolders(
	scope: CatalogSearchScope,
	query: string,
	database: FumetoDB = db
): Promise<FolderSearchResult[]> {
	const needle = normalizeCatalogTitle(query);
	if (!needle) return [];
	const results = new Map<string, FolderSearchResult>();

	if (scope.remoteParentKeys) {
		// Inside a remote folder: descendants only — every subtree folder's
		// children carry a parentKey inside the key set; the root itself
		// (whose parentKey lies outside) is correctly excluded.
		const keys = new Set(scope.remoteParentKeys);
		const folders = await database.remote_folders
			.where('librarySettingsId')
			.equals(scope.libraryId ?? '')
			.toArray();
		for (const folder of folders) {
			if (!folder.parentKey || !keys.has(folder.parentKey)) continue;
			if (!normalizeCatalogTitle(folder.name).includes(needle)) continue;
			results.set(`remote:${folder.id}`, {
				kind: 'remote',
				libraryId: folder.librarySettingsId,
				remoteFolderId: folder.remoteFolderId,
				name: folder.name
			});
		}
	} else {
		const prefix = scope.folderPrefix ?? '';
		const rows = scope.libraryId === null
			? await database.catalog_rows.toArray()
			: await database.catalog_rows.where('library_id').equals(scope.libraryId).toArray();
		for (const row of rows) {
			const path = row.folder_path ?? '';
			if (!path) continue;
			if (prefix !== '' && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
			// Every prefix chain of the row's path is a folder; keep the ones
			// strictly below the scope root.
			const segments = path.split('/');
			for (let depth = 1; depth <= segments.length; depth += 1) {
				const folderPath = segments.slice(0, depth).join('/');
				if (prefix !== '' && (folderPath === prefix || !folderPath.startsWith(`${prefix}/`))) continue;
				const name = segments[depth - 1];
				if (!normalizeCatalogTitle(name).includes(needle)) continue;
				results.set(`local:${row.library_id}:${folderPath}`, {
					kind: 'local',
					libraryId: row.library_id,
					path: folderPath,
					name
				});
			}
		}
		// Remote libraries browsed from their root (or the All-Libraries
		// root): their whole folder tree is in scope.
		const remoteFolders = scope.libraryId === null
			? await database.remote_folders.toArray()
			: await database.remote_folders.where('librarySettingsId').equals(scope.libraryId).toArray();
		for (const folder of remoteFolders) {
			if (!normalizeCatalogTitle(folder.name).includes(needle)) continue;
			results.set(`remote:${folder.id}`, {
				kind: 'remote',
				libraryId: folder.librarySettingsId,
				remoteFolderId: folder.remoteFolderId,
				name: folder.name
			});
		}
	}

	return [...results.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The parent keys covering a remote folder's whole subtree (the folder itself
 * plus every descendant), for `searchCatalogSubtree`'s remote scope.
 */
export async function remoteSubtreeParentKeys(
	librarySettingsId: string,
	rootFolderId: string,
	database: FumetoDB = db
): Promise<string[]> {
	const keys: string[] = [`folder:${rootFolderId}`];
	let frontier = [rootFolderId];
	while (frontier.length > 0) {
		const children = await database.remote_folders
			.where('[librarySettingsId+parentFolderId]')
			.anyOf(frontier.map((id) => [librarySettingsId, id]))
			.toArray();
		frontier = children.map((folder) => folder.remoteFolderId);
		keys.push(...frontier.map((id) => `folder:${id}`));
	}
	return keys;
}

/**
 * Record that a remote library finished a crawl with no failures.
 *
 * This is what the startup gate reads. It is deliberately provider-neutral:
 * YACReader had a gate and Komga and Kavita did not, which is how two of three
 * providers ended up re-crawling on every launch against the project's own
 * "manual Scan is the only refresh" contract.
 *
 * Only a clean run stamps it, so a partial sync correctly runs again next
 * launch.
 */
export async function markRemoteIndexComplete(
	libraryId: string,
	provider: CatalogProvider,
	database: FumetoDB = db
): Promise<void> {
	const now = new Date().toISOString();
	const existing = await database.catalog_index_state.get(libraryId);
	// The spread carries forward every counter this function has no opinion
	// about, and the explicit fields after it WIN — including `provider`, which
	// is the argument the caller passed. Written the other way round the spread
	// silently overrode the argument and made every `??` default below it dead
	// code, so the function read as though it set fields it did not.
	await database.catalog_index_state.put({
		...existing,
		library_id: libraryId,
		provider,
		completeness: existing?.completeness ?? 'ready',
		generation: existing?.generation ?? 0,
		status: existing?.status ?? 'ready',
		folders_visited: existing?.folders_visited ?? 0,
		entries_discovered: existing?.entries_discovered ?? 0,
		entries_reconciled: existing?.entries_reconciled ?? 0,
		remote_index_completed_at: now,
		last_success_at: now,
		updated_at: now
	});
}

/**
 * Every table that stores rows keyed to a single volume.
 *
 * Deleting a volume used to be reimplemented at each call site, and the five
 * live implementations touched between 6 and 17 tables. The two YAC prune
 * paths were the worst: they deleted 6 and left every translation table behind,
 * including `inpainted_pages`, whose rows carry a full-page Blob — and YAC
 * volume uuids are random, so a comic that is pruned and later re-added gets a
 * new uuid and the old data is unreachable for the life of the database. That
 * prune runs on every clean full sync.
 *
 * Pass this to `transaction('rw', …)` and delete through
 * `deleteVolumeRowsInTransaction`, so the scope and the deletes can never drift
 * apart again. (Dexie throws if a delete touches a table outside the declared
 * scope, which is the property that makes this safe: forgetting to widen the
 * scope fails loudly rather than silently skipping rows.)
 */
export function volumeScopedTables(database: FumetoDB = db) {
	return [
		database.volumes,
		database.volume_files,
		database.volume_pages,
		database.book_files,
		database.page_dimensions,
		database.regions,
		database.translations,
		database.work_context,
		database.page_translations,
		database.volume_translation_jobs,
		database.inpainted_pages,
		database.library_imports,
		database.comic_tabs,
		database.catalog_rows,
		database.media_assets
	];
}

/**
 * Delete every row belonging to one volume. Must be called inside a
 * transaction whose scope includes `volumeScopedTables()`.
 *
 * Deliberately NOT responsible for: the physical file, orphaned-tag cleanup, or
 * revoking the thumbnail object URL. Those are not row deletions, they cannot
 * participate in the transaction, and two of the three are conditional on the
 * caller — so they stay where the caller can see them.
 */
export async function deleteVolumeRowsInTransaction(
	volumeUuid: string,
	database: FumetoDB = db
): Promise<void> {
	await database.volumes.delete(volumeUuid);
	await database.comic_tabs.delete(volumeUuid);
	await database.catalog_rows.delete(volumeUuid);
	await database.media_assets.delete(volumeThumbnailAssetId(volumeUuid));
	await database.media_assets.delete(tabPreviewAssetId(volumeUuid));
	// Local-only tables. Deleting them for a remote volume is a no-op, and an
	// unconditional delete cannot be wrong the way a stale `isRemote` test can.
	await database.volume_files.delete(volumeUuid);
	await database.volume_pages.where('volume_uuid').equals(volumeUuid).delete();
	await database.book_files.delete(volumeUuid);
	await database.page_dimensions.delete(volumeUuid);
	// Translation data. Every one of these was orphaned by at least one of the
	// old implementations.
	await database.regions.where('volume_uuid').equals(volumeUuid).delete();
	await database.translations
		.where('[volume_uuid+page_index]')
		.between([volumeUuid, Dexie.minKey], [volumeUuid, Dexie.maxKey])
		.delete();
	await database.work_context.delete(volumeUuid);
	await database.page_translations.where('volume_uuid').equals(volumeUuid).delete();
	await database.volume_translation_jobs.where('volume_uuid').equals(volumeUuid).delete();
	await database.inpainted_pages.where('volume_uuid').equals(volumeUuid).delete();
	// Removing the import record is what lets a rescan re-import the file.
	await database.library_imports.where('volume_uuid').equals(volumeUuid).delete();
}

function normalizeRemoteFolder(folder: RemoteFolder): RemoteFolder {
	return {
		...folder,
		parentKey: folder.parentFolderId == null ? 'root' : `folder:${folder.parentFolderId}`,
		metadataRevision: folder.metadataRevision ?? 1
	};
}

export async function putRemoteFolder(
	folder: RemoteFolder,
	database: FumetoDB = db
): Promise<void> {
	await database.remote_folders.put(normalizeRemoteFolder(folder));
}

/**
 * One write for a whole sibling set. A remote folder listing upserted row-by-row
 * fires the catalog liveQuery once per row — at 664 root folders that was
 * hundreds of full re-queries and re-sorts for a single navigation.
 */
export async function bulkPutRemoteFolders(
	folders: readonly RemoteFolder[],
	database: FumetoDB = db
): Promise<void> {
	if (folders.length === 0) return;
	await database.remote_folders.bulkPut(folders.map(normalizeRemoteFolder));
}

export async function queryCatalogLocation(
	libraryId: string | null,
	parentKey: CatalogParentKey,
	database: FumetoDB = db
): Promise<CatalogRow[]> {
	if (libraryId === null) return [];
	return database.catalog_rows
		.where('[library_id+parent_key]')
		.equals([libraryId, parentKey])
		.filter((row) => row.visibility !== 'internal')
		.toArray();
}

export async function loadVolumeMetadataForRows(
	rows: readonly CatalogRow[],
	database: FumetoDB = db
): Promise<VolumeMetadata[]> {
	const [volumes, assets] = await Promise.all([
		database.volumes.bulkGet(rows.map((row) => row.volume_uuid)),
		database.media_assets.bulkGet(rows.map((row) => volumeThumbnailAssetId(row.volume_uuid)))
	]);
	const result: VolumeMetadata[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const volume = volumes[index];
		if (!volume) continue;
		const asset = assets[index];
		result.push(asset ? {
			...volume,
			thumbnail: asset.blob,
			thumbnail_width: asset.width,
			thumbnail_height: asset.height
		} : volume);
	}
	return result;
}

export async function countCatalogLibraries(database: FumetoDB = db): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	await database.catalog_rows.each((row) => {
		if (row.visibility === 'internal') return;
		result.set(row.library_id, (result.get(row.library_id) ?? 0) + 1);
	});
	return result;
}

export function makeMediaAsset(input: Parameters<typeof assetFromBlob>[0]): MediaAsset {
	return assetFromBlob(input);
}

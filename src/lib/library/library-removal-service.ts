import { db } from '$lib/db/index.js';
import {
	deleteVolumeRowsInTransaction,
	folderCoverAssetId,
	volumeScopedTables,
} from '$lib/catalog/catalog-repository.js';
import { beginRemoteLibraryCleanup } from '$lib/catalog/remote-library-fence.js';
import type { VolumeMetadata } from '$lib/types/index.js';

export interface RemovedLibraryData {
	volumes: VolumeMetadata[];
	deletedTags: string[];
}

/** Delete one configured library's domain data through a single owned port. */
export async function deleteLibraryData(libraryId: string): Promise<RemovedLibraryData> {
	// Fence the library first. This path took no lock at all, so a sync or a
	// passive browse could insert rows into a library that was halfway deleted
	// and leave them with a dangling library_id that nothing ever collects.
	const releaseCleanupFence = beginRemoteLibraryCleanup(libraryId);
	try {
		const [volumes, folders] = await Promise.all([
			db.volumes.where('library_id').equals(libraryId).toArray(),
			db.remote_folders.where('librarySettingsId').equals(libraryId).toArray(),
		]);
		const volumeUuids = volumes.map((volume) => volume.volume_uuid);
		await db.transaction('rw', [
			...volumeScopedTables(db), db.remote_folders, db.catalog_index_state,
		], async () => {
			for (const uuid of volumeUuids) {
				await deleteVolumeRowsInTransaction(uuid, db);
			}
			for (const folder of folders) {
				await db.remote_folders.delete(folder.id);
				await db.media_assets.delete(folderCoverAssetId(folder.id));
			}
			await db.catalog_index_state.delete(libraryId);
		});
		return { volumes, deletedTags: volumes.flatMap((volume) => volume.tags ?? []) };
	} finally {
		releaseCleanupFence();
	}
}

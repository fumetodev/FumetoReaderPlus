/**
 * Folder management service for local libraries.
 *
 * Provides create, delete, rename operations on filesystem folders,
 * with IndexedDB synchronization for volumes and library imports.
 */

import { readDir, mkdir, remove, rename, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { db } from '$lib/db/index.js';
import { updateVolume } from '$lib/catalog/catalog-repository.js';
import { deleteVolume } from '$lib/import/import-service.js';
import { sanitizePathSegment } from '$lib/util/file-utils.js';
import { revokeThumbnailUrl } from '$lib/stores/thumbnail-cache.js';

/**
 * Read immediate child directory names from a filesystem path.
 * Returns sorted folder names (excludes hidden dirs starting with '.').
 * Never throws — returns [] if the path doesn't exist or isn't readable.
 */
export async function readFilesystemFolders(dirPath: string): Promise<string[]> {
	try {
		const entries = await readDir(dirPath);
		const folders: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory && entry.name && !entry.name.startsWith('.')) {
				folders.push(entry.name);
			}
		}
		return folders.sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true })
		);
	} catch {
		return [];
	}
}

/**
 * Build the relative folder path from the current subfolder and a folder name.
 */
function buildRelativePath(currentSubfolder: string, folderName: string): string {
	return currentSubfolder ? currentSubfolder + '/' + folderName : folderName;
}

/**
 * Create a new folder in the library filesystem.
 *
 * @param libraryPath - Absolute library root path
 * @param currentSubfolder - Current relative subfolder ('' = root)
 * @param folderName - Name for the new folder (will be sanitized)
 * @returns The sanitized folder name actually created
 * @throws If folder already exists or creation fails
 */
export async function createFolder(
	libraryPath: string,
	currentSubfolder: string,
	folderName: string
): Promise<string> {
	const sanitized = sanitizePathSegment(folderName);
	const parentDir = currentSubfolder
		? await join(libraryPath, currentSubfolder)
		: libraryPath;
	const fullPath = await join(parentDir, sanitized);

	if (await exists(fullPath)) {
		throw new Error(`Folder "${sanitized}" already exists`);
	}

	await mkdir(fullPath, { recursive: true });
	return sanitized;
}

/**
 * Find all volumes that live within a folder (recursively).
 * Matches volumes whose folder_path equals the folder's relative path
 * or starts with folderRelPath + '/'.
 */
async function findVolumesInFolder(
	libraryId: string,
	folderRelPath: string
) {
	const allVols = await db.volumes
		.where('library_id')
		.equals(libraryId)
		.toArray();

	return allVols.filter((v) => {
		const fp = v.folder_path || '';
		return fp === folderRelPath || fp.startsWith(folderRelPath + '/');
	});
}

/**
 * Count volumes recursively within a folder.
 * Used by the delete confirmation dialog to show volume count.
 */
export async function countVolumesInFolder(
	libraryId: string,
	currentSubfolder: string,
	folderName: string
): Promise<number> {
	const relPath = buildRelativePath(currentSubfolder, folderName);
	const vols = await findVolumesInFolder(libraryId, relPath);
	return vols.length;
}

/**
 * Delete a folder and ALL volumes/data within it (recursively).
 *
 * Best-effort: continues deleting remaining volumes if one fails.
 * After volume cleanup, removes the filesystem directory recursively.
 *
 * @returns Count of successfully deleted volumes
 */
export async function deleteFolder(
	libraryPath: string,
	libraryId: string,
	currentSubfolder: string,
	folderName: string
): Promise<{ deletedVolumes: number }> {
	const relPath = buildRelativePath(currentSubfolder, folderName);
	const volumes = await findVolumesInFolder(libraryId, relPath);

	let deletedCount = 0;
	for (const vol of volumes) {
		try {
			revokeThumbnailUrl(vol.volume_uuid);
			await deleteVolume(vol.volume_uuid);
			deletedCount++;
		} catch (err) {
			console.error(`[folder-service] Failed to delete volume ${vol.title}:`, err);
		}
	}

	// Delete the filesystem directory (and any remaining non-archive files)
	const parentDir = currentSubfolder
		? await join(libraryPath, currentSubfolder)
		: libraryPath;
	const fullPath = await join(parentDir, folderName);

	try {
		await remove(fullPath, { recursive: true });
	} catch (err) {
		console.error('[folder-service] Failed to remove directory:', fullPath, err);
	}

	return { deletedVolumes: deletedCount };
}

/**
 * Rename a folder on the filesystem and update all volume folder_path entries
 * and library_imports file_path entries in the database.
 *
 * @returns The sanitized new name
 * @throws If the target name already exists or rename fails
 */
export async function renameFolder(
	libraryPath: string,
	libraryId: string,
	currentSubfolder: string,
	oldName: string,
	newName: string
): Promise<string> {
	const sanitized = sanitizePathSegment(newName);

	if (sanitized === oldName) return sanitized;

	const parentDir = currentSubfolder
		? await join(libraryPath, currentSubfolder)
		: libraryPath;
	const oldFullPath = await join(parentDir, oldName);
	const newFullPath = await join(parentDir, sanitized);

	if (await exists(newFullPath)) {
		throw new Error(`Folder "${sanitized}" already exists`);
	}

	// Step 1: Rename on filesystem
	await rename(oldFullPath, newFullPath);

	// Step 2: Update database records
	const oldRelPath = buildRelativePath(currentSubfolder, oldName);
	const newRelPath = buildRelativePath(currentSubfolder, sanitized);

	try {
		const volumes = await findVolumesInFolder(libraryId, oldRelPath);

		await db.transaction(
			'rw',
			[db.volumes, db.library_imports, db.catalog_rows, db.media_assets],
			async () => {
				for (const vol of volumes) {
					// Update folder_path: replace old prefix with new
					const oldFp = vol.folder_path || '';
					const newFp = oldFp === oldRelPath
						? newRelPath
						: newRelPath + oldFp.slice(oldRelPath.length);
					await updateVolume(vol.volume_uuid, { folder_path: newFp });

					// Update library_imports file_path
					// file_path is the PRIMARY KEY, so we must delete + re-insert
					const imports = await db.library_imports
						.where('volume_uuid')
						.equals(vol.volume_uuid)
						.toArray();

					for (const imp of imports) {
						if (imp.file_path.startsWith(oldFullPath)) {
							const newFilePath = imp.file_path.replace(oldFullPath, newFullPath);
							await db.library_imports.delete(imp.file_path);
							await db.library_imports.put({ ...imp, file_path: newFilePath });
						}
					}
				}
			}
		);
	} catch (err) {
		// DB update failed, but filesystem rename succeeded.
		// The next library scan will reconcile folder_path values.
		console.error('[folder-service] DB update after rename failed (will reconcile on next scan):', err);
	}

	return sanitized;
}

/**
 * Move one or more volumes to a different folder within the same library.
 *
 * Best-effort: each volume is moved independently, errors collected.
 * After filesystem rename, updates folder_path on the volume and
 * re-keys library_imports file_path (PK constraint requires delete+re-insert).
 *
 * If the DB update fails after a successful filesystem rename, the next
 * library scan will reconcile folder_path values automatically.
 *
 * @returns Summary of moved/failed volumes with error messages
 */
export async function moveVolumes(
	libraryPath: string,
	libraryId: string,
	volumeUuids: Set<string>,
	targetSubfolder: string
): Promise<{ moved: number; failed: number; errors: string[]; failedUuids: string[] }> {
	// Ensure target directory exists
	const targetDir = targetSubfolder
		? await join(libraryPath, targetSubfolder)
		: libraryPath;
	await mkdir(targetDir, { recursive: true });

	// Load all volumes to move
	const volumes = await db.volumes
		.where('volume_uuid')
		.anyOf([...volumeUuids])
		.toArray();

	let moved = 0;
	let failed = 0;
	const errors: string[] = [];
	const failedUuids: string[] = [];

	for (const vol of volumes) {
		const currentFolderPath = vol.folder_path || '';

		// Skip if already in the target folder
		if (currentFolderPath === targetSubfolder) continue;

		// Build old and new absolute file paths
		const oldDir = currentFolderPath
			? await join(libraryPath, currentFolderPath)
			: libraryPath;
		const oldFilePath = await join(oldDir, vol.filename);
		const newFilePath = await join(targetDir, vol.filename);

		// Check for filename conflict at destination
		if (await exists(newFilePath)) {
			errors.push(`"${vol.title}" — file already exists in destination`);
			failedUuids.push(vol.volume_uuid);
			failed++;
			continue;
		}

		try {
			// Step 1: Move on filesystem
			await rename(oldFilePath, newFilePath);

			// Step 2: Update database records
			try {
				await db.transaction(
					'rw',
					[db.volumes, db.library_imports, db.catalog_rows, db.media_assets],
					async () => {
						// Update folder_path on volume
						await updateVolume(vol.volume_uuid, { folder_path: targetSubfolder });

						// Update library_imports file_path (PK — must delete + re-insert)
						const imports = await db.library_imports
							.where('volume_uuid')
							.equals(vol.volume_uuid)
							.toArray();

						for (const imp of imports) {
							if (imp.file_path.startsWith(oldFilePath)) {
								const updatedFilePath = imp.file_path.replace(oldFilePath, newFilePath);
								await db.library_imports.delete(imp.file_path);
								await db.library_imports.put({ ...imp, file_path: updatedFilePath });
							}
						}
					}
				);
			} catch (err) {
				// DB update failed, but filesystem rename succeeded.
				// The next library scan will reconcile folder_path values.
				console.error(`[folder-service] DB update after move failed for ${vol.title} (will reconcile on next scan):`, err);
			}

			moved++;
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			errors.push(`"${vol.title}" — ${message}`);
			failedUuids.push(vol.volume_uuid);
			failed++;
		}
	}

	return { moved, failed, errors, failedUuids };
}

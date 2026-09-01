/**
 * Bulk-assign author names to volumes based on their top-level subfolder name.
 *
 * Works for local libraries (path-based), YACReader remote libraries, Komga
 * libraries, and Kavita libraries (folder-hierarchy-based). The first-level subfolder beneath the library
 * root is treated as the author name. Volumes at the library root get their author cleared.
 */

import type { UserMessage } from '$lib/i18n/user-messages.js';
import { db } from '$lib/db/index.js';
import { updateVolume } from '$lib/catalog/catalog-repository.js';
import type { RemoteFolder } from '$lib/types/index.js';
import {
	type Library,
	type LocalLibrary,
	type YACReaderLibrary,
	isLocalLibrary,
	isYACReaderLibrary,
	isKomgaLibrary,
	isKavitaLibrary,
	isRemoteServerLibrary
} from '$lib/settings/settings.js';

export interface AuthorAssignmentProgress {
	stage: 'computing' | 'updating' | 'done';
	current: number;
	total: number;
	message: UserMessage;
}

export interface AuthorAssignmentResult {
	totalVolumes: number;
	updated: number;
	skippedAtRoot: number;
}

/**
 * Assign author names to all volumes in a library based on folder structure.
 *
 * - Local libraries: first path segment after library root = author name
 * - Remote libraries: top-level folder name (parentFolderId === null) = author name
 * - Volumes at the library root get their author cleared to undefined
 */
export async function assignAuthorsFromFolders(
	library: Library,
	onProgress?: (progress: AuthorAssignmentProgress) => void
): Promise<AuthorAssignmentResult> {
	if (isLocalLibrary(library)) {
		return assignAuthorsLocal(library, onProgress);
	}
	if (isYACReaderLibrary(library)) {
		return assignAuthorsRemote(library, onProgress);
	}
	if (isKomgaLibrary(library)) {
		return assignAuthorsRemoteKomga(library, onProgress);
	}
	if (isKavitaLibrary(library)) {
		return assignAuthorsRemoteKavita(library, onProgress);
	}
	throw new Error('Unknown library type');
}

// ================================================================
// Local Library
// ================================================================

async function assignAuthorsLocal(
	library: LocalLibrary,
	onProgress?: (progress: AuthorAssignmentProgress) => void
): Promise<AuthorAssignmentResult> {
	onProgress?.({
		stage: 'computing',
		current: 0,
		total: 0,
		message: { code: 'authors_reading_imports' }
	});

	// Fetch all library imports
	const allImports = await db.library_imports.toArray();
	const normalizedRoot = library.path.replace(/[\\/]+$/, '');

	// Build volume_uuid -> author map
	const authorMap = new Map<string, string | undefined>();

	for (const imp of allImports) {
		if (!imp.file_path.startsWith(normalizedRoot)) continue;

		const relativePath = imp.file_path.slice(normalizedRoot.length + 1).replace(/\\/g, '/');
		const parts = relativePath.split('/');

		if (parts.length < 2) {
			// File is at library root (e.g. "vol.cbz") — no subfolder, clear author
			authorMap.set(imp.volume_uuid, undefined);
		} else {
			// First path segment is the top-level subfolder = author name
			authorMap.set(imp.volume_uuid, parts[0]);
		}
	}

	onProgress?.({
		stage: 'computing',
		current: 0,
		total: authorMap.size,
		message: { code: 'authors_found_updating', params: { n: authorMap.size } }
	});

	// Batch-update in a transaction
	let updated = 0;
	let skippedAtRoot = 0;

	await db.transaction('rw', [db.volumes, db.catalog_rows, db.media_assets], async () => {
		let i = 0;
		for (const [uuid, author] of authorMap) {
			await updateVolume(uuid, { author });
			if (author) {
				updated++;
			} else {
				skippedAtRoot++;
			}
			i++;
			if (i % 50 === 0) {
				onProgress?.({
					stage: 'updating',
					current: i,
					total: authorMap.size,
					message: { code: 'authors_updated_progress', params: { done: i, total: authorMap.size } }
				});
			}
		}
	});

	onProgress?.({
		stage: 'done',
		current: authorMap.size,
		total: authorMap.size,
		message: { code: 'authors_done', params: { updated, root: skippedAtRoot } }
	});

	return {
		totalVolumes: authorMap.size,
		updated,
		skippedAtRoot
	};
}

// ================================================================
// Remote (YACReader) Library
// ================================================================

// ================================================================
// Remote (Komga) Library
// ================================================================

/**
 * For Komga libraries, the series name = folder name = author.
 * Since Komga series are always top-level (parentFolderId === null),
 * the series folder name is used directly as the author name.
 */
async function assignAuthorsRemoteKomga(
	library: Library & { type: 'komga' },
	onProgress?: (progress: AuthorAssignmentProgress) => void
): Promise<AuthorAssignmentResult> {
	onProgress?.({
		stage: 'computing',
		current: 0,
		total: 0,
		message: { code: 'authors_loading_hierarchy' }
	});

	// Fetch all remote folders (series) for this library
	const folders = await db.remote_folders
		.where('librarySettingsId')
		.equals(library.id)
		.toArray();

	// Build lookup map: remoteFolderId -> folder name
	const folderNameMap = new Map<string, string>();
	for (const f of folders) {
		folderNameMap.set(f.remoteFolderId, f.name);
	}

	// Fetch all volumes for this library
	const volumes = await db.volumes
		.where('library_id')
		.equals(library.id)
		.toArray();

	onProgress?.({
		stage: 'computing',
		current: 0,
		total: volumes.length,
		message: { code: 'authors_computing', params: { n: volumes.length } }
	});

	// Build volume_uuid -> author map
	const authorMap = new Map<string, string | undefined>();

	for (const vol of volumes) {
		if (vol.source?.type === 'komga') {
			// For Komga, the remoteFolderId is the series ID
			const author = folderNameMap.get(vol.source.remoteFolderId);
			authorMap.set(vol.volume_uuid, author ?? undefined);
		}
	}

	onProgress?.({
		stage: 'updating',
		current: 0,
		total: authorMap.size,
		message: { code: 'authors_updating', params: { n: authorMap.size } }
	});

	// Batch-update in a transaction
	let updated = 0;
	let skippedAtRoot = 0;

	await db.transaction('rw', [db.volumes, db.catalog_rows, db.media_assets], async () => {
		let i = 0;
		for (const [uuid, author] of authorMap) {
			await updateVolume(uuid, { author });
			if (author) {
				updated++;
			} else {
				skippedAtRoot++;
			}
			i++;
			if (i % 50 === 0) {
				onProgress?.({
					stage: 'updating',
					current: i,
					total: authorMap.size,
					message: { code: 'authors_updated_progress', params: { done: i, total: authorMap.size } }
				});
			}
		}
	});

	onProgress?.({
		stage: 'done',
		current: authorMap.size,
		total: authorMap.size,
		message: { code: 'authors_done', params: { updated, root: skippedAtRoot } }
	});

	return {
		totalVolumes: authorMap.size,
		updated,
		skippedAtRoot
	};
}

// ================================================================
// Remote (Kavita) Library
// ================================================================

/**
 * For Kavita libraries, the series name = folder name = author.
 * Same pattern as Komga — series are always top-level.
 */
async function assignAuthorsRemoteKavita(
	library: Library & { type: 'kavita' },
	onProgress?: (progress: AuthorAssignmentProgress) => void
): Promise<AuthorAssignmentResult> {
	onProgress?.({
		stage: 'computing',
		current: 0,
		total: 0,
		message: { code: 'authors_loading_hierarchy' }
	});

	const folders = await db.remote_folders
		.where('librarySettingsId')
		.equals(library.id)
		.toArray();

	const folderNameMap = new Map<string, string>();
	for (const f of folders) {
		folderNameMap.set(f.remoteFolderId, f.name);
	}

	const volumes = await db.volumes
		.where('library_id')
		.equals(library.id)
		.toArray();

	onProgress?.({
		stage: 'computing',
		current: 0,
		total: volumes.length,
		message: { code: 'authors_computing', params: { n: volumes.length } }
	});

	const authorMap = new Map<string, string | undefined>();

	for (const vol of volumes) {
		if (vol.source?.type === 'kavita') {
			const author = folderNameMap.get(vol.source.remoteFolderId);
			authorMap.set(vol.volume_uuid, author ?? undefined);
		}
	}

	onProgress?.({
		stage: 'updating',
		current: 0,
		total: authorMap.size,
		message: { code: 'authors_updating', params: { n: authorMap.size } }
	});

	let updated = 0;
	let skippedAtRoot = 0;

	await db.transaction('rw', [db.volumes, db.catalog_rows, db.media_assets], async () => {
		let i = 0;
		for (const [uuid, author] of authorMap) {
			await updateVolume(uuid, { author });
			if (author) {
				updated++;
			} else {
				skippedAtRoot++;
			}
			i++;
			if (i % 50 === 0) {
				onProgress?.({
					stage: 'updating',
					current: i,
					total: authorMap.size,
					message: { code: 'authors_updated_progress', params: { done: i, total: authorMap.size } }
				});
			}
		}
	});

	onProgress?.({
		stage: 'done',
		current: authorMap.size,
		total: authorMap.size,
		message: { code: 'authors_done', params: { updated, root: skippedAtRoot } }
	});

	return {
		totalVolumes: authorMap.size,
		updated,
		skippedAtRoot
	};
}


async function assignAuthorsRemote(
	library: YACReaderLibrary,
	onProgress?: (progress: AuthorAssignmentProgress) => void
): Promise<AuthorAssignmentResult> {
	onProgress?.({
		stage: 'computing',
		current: 0,
		total: 0,
		message: { code: 'authors_loading_hierarchy' }
	});

	// Fetch all remote folders for this library
	const folders = await db.remote_folders
		.where('librarySettingsId')
		.equals(library.id)
		.toArray();

	if (folders.length === 0) {
		return {
			totalVolumes: 0,
			updated: 0,
			skippedAtRoot: 0
		};
	}

	// Build lookup map: remoteFolderId -> RemoteFolder
	const folderMap = new Map<string, RemoteFolder>();
	for (const f of folders) {
		folderMap.set(f.remoteFolderId, f);
	}

	/**
	 * Walk up the folder chain to find the top-level folder name.
	 * Top-level folders have parentFolderId === null.
	 * Returns null for volumes at the library root (remoteFolderId === '1').
	 */
	function getTopLevelFolderName(remoteFolderId: string): string | null {
		// Root folder — no author
		if (remoteFolderId === '1') return null;

		const visited = new Set<string>();
		let currentId = remoteFolderId;

		while (currentId) {
			if (visited.has(currentId)) break; // safety: avoid cycles
			visited.add(currentId);

			const folder = folderMap.get(currentId);
			if (!folder) return null; // folder not in cache

			if (folder.parentFolderId === null) {
				// This is a top-level folder
				return folder.name;
			}

			// Walk up to parent
			currentId = folder.parentFolderId;
		}

		return null;
	}

	// Fetch all volumes for this library
	const volumes = await db.volumes
		.where('library_id')
		.equals(library.id)
		.toArray();

	onProgress?.({
		stage: 'computing',
		current: 0,
		total: volumes.length,
		message: { code: 'authors_computing', params: { n: volumes.length } }
	});

	// Build volume_uuid -> author map
	const authorMap = new Map<string, string | undefined>();

	for (const vol of volumes) {
		if (vol.source?.type === 'yacreader') {
			const author = getTopLevelFolderName(vol.source.remoteFolderId);
			authorMap.set(vol.volume_uuid, author ?? undefined);
		}
	}

	onProgress?.({
		stage: 'updating',
		current: 0,
		total: authorMap.size,
		message: { code: 'authors_updating', params: { n: authorMap.size } }
	});

	// Batch-update in a transaction
	let updated = 0;
	let skippedAtRoot = 0;

	await db.transaction('rw', [db.volumes, db.catalog_rows, db.media_assets], async () => {
		let i = 0;
		for (const [uuid, author] of authorMap) {
			await updateVolume(uuid, { author });
			if (author) {
				updated++;
			} else {
				skippedAtRoot++;
			}
			i++;
			if (i % 50 === 0) {
				onProgress?.({
					stage: 'updating',
					current: i,
					total: authorMap.size,
					message: { code: 'authors_updated_progress', params: { done: i, total: authorMap.size } }
				});
			}
		}
	});

	onProgress?.({
		stage: 'done',
		current: authorMap.size,
		total: authorMap.size,
		message: { code: 'authors_done', params: { updated, root: skippedAtRoot } }
	});

	return {
		totalVolumes: authorMap.size,
		updated,
		skippedAtRoot
	};
}

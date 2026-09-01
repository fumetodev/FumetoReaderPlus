/**
 * Library scanner for Fumeto.
 *
 * Recursively scans a designated library folder for manga archive files,
 * determines which ones haven't been imported yet, and imports them.
 * Uses Tauri's fs plugin for directory traversal and the existing
 * import pipeline for processing.
 */

import * as m from '$lib/paraglide/messages.js';
import type { UserMessage } from '$lib/i18n/user-messages.js';
import { readDir, stat, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import Dexie from 'dexie';
import {
	deleteVolumeRowsInTransaction,
	tabPreviewAssetId,
	updateVolume,
	volumeScopedTables,
	volumeThumbnailAssetId,
} from '$lib/catalog/catalog-repository.js';
import { db } from '$lib/db/index.js';
import { filePathToFile } from '$lib/import/tauri-file-bridge.js';
import {
	deleteVolume,
	importArchive,
	IMPORT_THUMBNAIL_GENERATION_VERSION,
	upgradeLegacyImportThumbnail,
} from '$lib/import/import-service.js';
import { isArchiveExtension } from '$lib/import/types.js';
import { isAndroid } from '$lib/util/platform.js';
import { revokeThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
import type { LibraryImport, VolumeMetadata } from '$lib/types/index.js';

/**
 * Why a path could not be scanned. `kind` is what code branches on (the
 * reconciliation must not delete rows under a directory it could not read);
 * `error` is the English detail for logs and the scan report.
 */
export type ScanFailureKind = 'unreadable-directory' | 'unreadable-archive' | 'other';
export interface ScanFailure {
	path: string;
	error: string;
	kind?: ScanFailureKind;
}


/** Progress information emitted during a library scan. */
export interface ScanProgress {
	stage: 'scanning' | 'importing';
	/** Total archive files found so far */
	found: number;
	/** Files that are new (not yet imported) */
	newFiles: number;
	/** Files imported so far in this scan */
	imported: number;
	/** Total new files to import */
	total: number;
	/** Current file being processed */
	currentFile: string;
}

/** Result of a library scan. */
export interface ScanResult {
	totalFound: number;
	newImported: number;
	skippedExisting: number;
	failed: ScanFailure[];
	/** Existing archives whose bytes changed and were safely reimported in-place. */
	updated: number;
	/** Unchanged legacy volumes whose stored cover was regenerated with the current recipe. */
	thumbnailUpgraded: number;
	/** Existing records whose exact path changed without changing volume identity. */
	moved: number;
	/** Records removed after a complete library scan proved the file disappeared. */
	deleted: number;
}

export interface ScannedArchive {
	path: string;
	size?: number;
	modified?: number;
}

export interface LibraryReconciliationPlan {
	newArchives: ScannedArchive[];
	unchanged: Array<{ archive: ScannedArchive; importRecord: LibraryImport }>;
	modified: Array<{ archive: ScannedArchive; importRecord: LibraryImport }>;
	moves: Array<{ archive: ScannedArchive; importRecord: LibraryImport }>;
	deleted: LibraryImport[];
}

function canonicalPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function signature(record: { size?: number; modified?: number }): string | undefined {
	if (record.size === undefined || record.modified === undefined) return undefined;
	return `${record.size}:${record.modified}`;
}

/**
 * Return whether a stored local cover predates the current import recipe.
 *
 * The explicit version marker is more reliable than checking pixel dimensions:
 * a genuinely small source cover may legitimately remain below 512px.
 */
export function needsThumbnailGenerationUpgrade(
	volume: Pick<VolumeMetadata, 'thumbnail_generation_version'> | undefined,
): boolean {
	return volume?.thumbnail_generation_version !== IMPORT_THUMBNAIL_GENERATION_VERSION;
}

/**
 * Build a side-effect-free reconciliation plan. Moves are recognized only when
 * one missing record and one new path have a unique size+mtime signature.
 */
export function planLibraryReconciliation(
	archives: ScannedArchive[],
	existingImports: LibraryImport[],
	fullLibraryScan: boolean,
): LibraryReconciliationPlan {
	const importsByPath = new Map(
		existingImports.map((record) => [canonicalPath(record.file_path), record]),
	);
	const archivePaths = new Set(archives.map((archive) => canonicalPath(archive.path)));
	const unmatchedArchives: ScannedArchive[] = [];
	const unchanged: LibraryReconciliationPlan['unchanged'] = [];
	const modified: LibraryReconciliationPlan['modified'] = [];

	for (const archive of archives) {
		const record = importsByPath.get(canonicalPath(archive.path));
		if (!record) {
			unmatchedArchives.push(archive);
			continue;
		}

		const archiveSignature = signature(archive);
		if (
			archiveSignature === undefined ||
			archiveSignature === signature({ size: record.file_size, modified: record.file_modified })
		) {
			unchanged.push({ archive, importRecord: record });
		} else {
			modified.push({ archive, importRecord: record });
		}
	}

	let missingImports = fullLibraryScan
		? existingImports.filter((record) => !archivePaths.has(canonicalPath(record.file_path)))
		: [];
	const moves: LibraryReconciliationPlan['moves'] = [];
	const movedArchivePaths = new Set<string>();
	const movedImportPaths = new Set<string>();

	if (fullLibraryScan) {
		const newBySignature = new Map<string, ScannedArchive[]>();
		for (const archive of unmatchedArchives) {
			const key = signature(archive);
			if (!key) continue;
			const group = newBySignature.get(key) ?? [];
			group.push(archive);
			newBySignature.set(key, group);
		}

		const missingBySignature = new Map<string, LibraryImport[]>();
		for (const record of missingImports) {
			const key = signature({ size: record.file_size, modified: record.file_modified });
			if (!key) continue;
			const group = missingBySignature.get(key) ?? [];
			group.push(record);
			missingBySignature.set(key, group);
		}

		for (const [key, newGroup] of newBySignature) {
			const missingGroup = missingBySignature.get(key);
			if (newGroup.length !== 1 || missingGroup?.length !== 1) continue;
			moves.push({ archive: newGroup[0], importRecord: missingGroup[0] });
			movedArchivePaths.add(canonicalPath(newGroup[0].path));
			movedImportPaths.add(canonicalPath(missingGroup[0].file_path));
		}

		missingImports = missingImports.filter(
			(record) => !movedImportPaths.has(canonicalPath(record.file_path)),
		);
	}

	return {
		newArchives: unmatchedArchives.filter(
			(archive) => !movedArchivePaths.has(canonicalPath(archive.path)),
		),
		unchanged,
		modified,
		moves,
		deleted: missingImports,
	};
}

/**
 * Recursively find all archive files in a directory.
 */
async function findArchives(
	dirPath: string,
	failures: ScanFailure[],
): Promise<string[]> {
	const archives: string[] = [];

	try {
		const entries = await readDir(dirPath);

		for (const entry of entries) {
			const fullPath = await join(dirPath, entry.name);

			if (entry.isDirectory) {
				// Recurse into subdirectories (skip hidden dirs)
				if (!entry.name.startsWith('.')) {
					const subArchives = await findArchives(fullPath, failures);
					archives.push(...subArchives);
				}
			} else if (entry.isFile && entry.name) {
				const ext = entry.name.split('.').pop()?.toLowerCase() || '';
				if (isArchiveExtension(ext)) {
					archives.push(fullPath);
				}
			}
		}
	} catch (err) {
		console.error(`Failed to read directory: ${dirPath}`, err);
		failures.push({
			path: dirPath,
			kind: 'unreadable-directory',
			error: `Unable to read directory: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	return archives;
}

/**
 * Scan concurrency control.
 *
 * The old design was a single per-library mutex whose loser returned a
 * success-shaped result with one synthetic failure. That silently no-op'd every
 * scan requested while another ran: a subfolder Scan pressed during the startup
 * auto-scan reported "Library is up to date (1 failed)", `importToLibrary`'s
 * indexing scan vanished without a trace, and — worst — `eraseAndRescanLibrary`
 * could erase and then have its rescan bail, leaving the library empty.
 *
 * Scans are now registered per (library, subfolder) *scope*:
 *   - identical scopes coalesce: a second caller joins the running scan's
 *     promise, or a single chained follow-up when the running scan may already
 *     have missed late files (run-after, not attach — `importToLibrary` copies
 *     files and then scans, so attaching could index a traversal from before
 *     the copy);
 *   - different scopes of one library run concurrently (a subfolder refresh no
 *     longer waits behind — or gets eaten by — a whole-library crawl). The
 *     double-import hazard that concurrency opens is closed per-file inside the
 *     import loops, not here (see `importsInFlight`).
 * `eraseAndRescanLibrary` publishes an exclusive gate that drains every scope
 * before the erase and holds new scans until the rescan can begin.
 */
interface ScanScopeState {
	running?: Promise<ScanResult>;
	pending?: Promise<ScanResult>;
}
const scanScopes = new Map<string, ScanScopeState>();
const exclusiveGates = new Map<string, Promise<void>>();

/**
 * Canonical paths currently inside `importArchive` on behalf of a scan. Two
 * overlapping scopes both snapshot `library_imports` before either writes, so
 * without a claim both would see the same file as new and import it twice —
 * the second `library_imports.put` (PK file_path) then orphans the first
 * volume forever.
 */
const importsInFlight = new Set<string>();

function scanScopeKey(libKey: string, subfolder?: string): string {
	return `${libKey}\u0000${subfolder ?? ''}`;
}

async function awaitExclusiveGate(libKey: string): Promise<void> {
	// Loop: a new gate may be published while we waited out the previous one.
	for (;;) {
		const gate = exclusiveGates.get(libKey);
		if (!gate) return;
		await gate.catch(() => undefined);
		if (exclusiveGates.get(libKey) === gate) return;
	}
}

/** Every running/pending scan of the library, across all scopes. */
function scansInFlightFor(libKey: string): Promise<unknown>[] {
	const prefix = `${libKey}\u0000`;
	const waits: Promise<unknown>[] = [];
	for (const [key, scope] of scanScopes) {
		if (!key.startsWith(prefix)) continue;
		if (scope.running) waits.push(scope.running.catch(() => undefined));
		if (scope.pending) waits.push(scope.pending.catch(() => undefined));
	}
	return waits;
}

/**
 * Scan a library folder and import any new archives.
 *
 * Concurrent identical-scope calls resolve with a real `ScanResult` that
 * covered their request — never a synthetic failure.
 *
 * @param libraryPath - Absolute path to the library folder
 * @param onProgress - Optional progress callback
 * @param libraryId - Settings ID of the library being scanned
 * @param subfolder - Optional subfolder to scan (relative to libraryPath)
 * @returns Scan result with counts and any failures
 */
export async function scanLibrary(
	libraryPath: string,
	onProgress?: (progress: ScanProgress) => void,
	libraryId?: string,
	subfolder?: string
): Promise<ScanResult> {
	const libKey = libraryId || libraryPath;
	const scopeKey = scanScopeKey(libKey, subfolder);

	const runOnce = async (): Promise<ScanResult> => {
		await awaitExclusiveGate(libKey);
		// Android: pull user-dropped archives from the USB-visible external
		// folder into the library dir first, so the Settings tip's workflow
		// works (best-effort; a broken drop folder must not block the scan).
		// Inside the scope registration deliberately: it used to run before the
		// mutex, so two concurrent full scans raced copy/remove on the same
		// files — and living here means a chained follow-up re-ingests files
		// dropped while the first scan ran.
		if (isAndroid && !subfolder) {
			try {
				const { ingestAndroidDropFolder } = await import('$lib/import/android-drop-folder.js');
				await ingestAndroidDropFolder(libraryPath);
			} catch (err) {
				console.warn('[library-scanner] Drop-folder ingestion failed:', err);
			}
		}
		return _scanLibraryImpl(libraryPath, onProgress, libraryId, subfolder);
	};

	let scope = scanScopes.get(scopeKey);
	if (!scope) {
		scope = {};
		scanScopes.set(scopeKey, scope);
	}
	if (!scope.running) {
		const running = runOnce();
		scope.running = running;
		void running.finally(() => {
			if (scope.running === running) scope.running = undefined;
			if (!scope.running && !scope.pending) scanScopes.delete(scopeKey);
		}).catch(() => undefined);
		return running;
	}
	if (scope.pending) return scope.pending;

	// Run-after: this caller's request may postdate files the running traversal
	// already passed, so it gets a fresh scan once the current one settles. All
	// further identical-scope callers coalesce onto this one follow-up.
	const predecessor = scope.running;
	const pending = predecessor.catch(() => undefined).then(() => {
		const follower = runOnce();
		scope.running = follower;
		scope.pending = undefined;
		void follower.finally(() => {
			if (scope.running === follower) scope.running = undefined;
			if (!scope.running && !scope.pending) scanScopes.delete(scopeKey);
		}).catch(() => undefined);
		return follower;
	});
	scope.pending = pending;
	return pending;
}

/** Internal implementation — called within the scan lock. */
async function _scanLibraryImpl(
	libraryPath: string,
	onProgress?: (progress: ScanProgress) => void,
	libraryId?: string,
	subfolder?: string
): Promise<ScanResult> {
	// Step 1: Find all archive files
	onProgress?.({
		stage: 'scanning',
		found: 0,
		newFiles: 0,
		imported: 0,
		total: 0,
		currentFile: m.scan_scanning_folder()
	});

	// Scan only the subfolder if specified, otherwise scan the whole library
	const scanRoot = subfolder ? await join(libraryPath, subfolder) : libraryPath;
	const failed: ScanFailure[] = [];
	const archivePaths = Array.from(new Set(await findArchives(scanRoot, failed))).sort();
	const scannedArchives: ScannedArchive[] = [];
	for (const path of archivePaths) {
		try {
			const fileStat = await stat(path);
			scannedArchives.push({
				path,
				size: fileStat.size,
				modified: fileStat.mtime ? new Date(fileStat.mtime).getTime() : 0,
			});
		} catch (err) {
			// Keep the discovered path in the plan so a transient stat failure can
			// never make a complete scan delete its existing volume.
			scannedArchives.push({ path });
			failed.push({
				path,
				error: `Unable to inspect archive: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// Normalize library root for relative path computation
	const normalizedRoot = libraryPath.replace(/[\\/]+$/, '');

	const existingImports = await db.library_imports.toArray();
	const existingVolumes = await db.volumes.toArray();
	const volumeByUuid = new Map(existingVolumes.map((volume) => [volume.volume_uuid, volume]));
	const rootPrefix = `${canonicalPath(normalizedRoot)}/`;
	const scopedImports = existingImports.filter((record) => {
		const volume = volumeByUuid.get(record.volume_uuid);
		if (!volume) return false;
		if (libraryId && volume.library_id) return volume.library_id === libraryId;
		return canonicalPath(record.file_path).startsWith(rootPrefix);
	});
	const traversalComplete = !failed.some((failure) => failure.kind === 'unreadable-directory');
	const plan = planLibraryReconciliation(
		scannedArchives,
		scopedImports,
		!subfolder && traversalComplete,
	);
	if (!subfolder && traversalComplete) {
		for (const orphan of existingImports.filter((record) =>
			!volumeByUuid.has(record.volume_uuid) &&
			canonicalPath(record.file_path).startsWith(rootPrefix),
		)) {
			try {
				await db.library_imports.delete(orphan.file_path);
			} catch (err) {
				failed.push({
					path: orphan.file_path,
					error: `Unable to remove orphaned import record: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}
	}
	const readableNewArchives = plan.newArchives.filter(
		(archive) => archive.size !== undefined && archive.modified !== undefined,
	);
	const legacyThumbnailItems = plan.unchanged.filter(({ importRecord }) => {
		const volume = volumeByUuid.get(importRecord.volume_uuid);
		return needsThumbnailGenerationUpgrade(volume);
	});
	const operationsTotal = readableNewArchives.length + plan.modified.length + legacyThumbnailItems.length;

	onProgress?.({
		stage: 'importing',
		found: archivePaths.length,
		newFiles: operationsTotal,
		imported: 0,
		total: operationsTotal,
		currentFile: ''
	});

	let imported = 0;
	let updated = 0;
	// Files another concurrently running scope reconciled after this scan's
	// snapshot was taken; counted as already-existing rather than failures.
	let raceSkipped = 0;
	let thumbnailUpgraded = 0;
	let moved = 0;
	let deleted = 0;
	let processed = 0;

	const relativeFolder = (filePath: string): string => {
		const relativePath = canonicalPath(filePath).slice(canonicalPath(normalizedRoot).length + 1);
		const lastSlash = relativePath.lastIndexOf('/');
		return lastSlash >= 0 ? relativePath.substring(0, lastSlash) : '';
	};

	// Apply unambiguous moves without re-extracting the archive or changing UUID.
	for (const move of plan.moves) {
		try {
			const volume = volumeByUuid.get(move.importRecord.volume_uuid);
			if (!volume) throw new Error('The moved archive no longer has a volume record');
			await db.transaction(
				'rw',
				[db.library_imports, db.volumes, db.catalog_rows, db.media_assets],
				async () => {
				await db.library_imports.delete(move.importRecord.file_path);
				await db.library_imports.put({
					...move.importRecord,
					file_path: move.archive.path,
					file_size: move.archive.size!,
					file_modified: move.archive.modified!,
				});
				await updateVolume(volume.volume_uuid, {
					filename: move.archive.path.split(/[\\/]/).pop() || volume.filename,
					folder_path: relativeFolder(move.archive.path),
				});
				},
			);
			moved++;
		} catch (err) {
			failed.push({
				path: move.archive.path,
				error: `Unable to reconcile moved archive: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// Changed archives retain identity and user metadata, while page-derived data
	// is reset atomically with the new pages to avoid stale overlays/translations.
	for (const change of plan.modified) {
		const filePath = change.archive.path;
		const existingVolume = volumeByUuid.get(change.importRecord.volume_uuid);
		if (!existingVolume || change.archive.size === undefined || change.archive.modified === undefined) {
			failed.push({ path: filePath, error: 'Unable to safely update archive metadata' });
			continue;
		}

		const claim = canonicalPath(filePath);
		if (importsInFlight.has(claim)) continue;
		importsInFlight.add(claim);
		try {
			// Re-check against live rows: this scan's snapshot predates whatever a
			// concurrently running scope has already reconciled.
			const fresh = await db.library_imports.get(filePath);
			if (fresh && fresh.file_size === change.archive.size && fresh.file_modified === change.archive.modified) {
				raceSkipped++;
				processed++;
				continue;
			}
			const file = await filePathToFile(filePath);
			// Same atomicity as the fresh-import path above. Here the stale
			// size/modified stamps are what a failure leaves behind, so the next
			// scan would re-do the whole reimport.
			await importArchive(file, undefined, libraryId, relativeFolder(filePath), {
				existingMetadata: existingVolume,
				clearDerivedData: true,
				importRecord: {
					...change.importRecord,
					file_size: change.archive.size,
					file_modified: change.archive.modified,
					imported_at: new Date().toISOString(),
				},
			});
			updated++;
			processed++;
		} catch (err) {
			failed.push({
				path: filePath,
				error: `Unable to update changed archive: ${err instanceof Error ? err.message : String(err)}`,
			});
		} finally {
			importsInFlight.delete(claim);
		}
	}

	// Exact-path dedupe deliberately allows identical basenames in different folders.
	for (const archive of readableNewArchives) {
		const filePath = archive.path;
		const filename = filePath.split(/[\\/]/).pop() || '';
		onProgress?.({
			stage: 'importing',
			found: archivePaths.length,
			newFiles: operationsTotal,
			imported: processed,
			total: operationsTotal,
			currentFile: filename
		});

		// Two-layer double-import guard for overlapping scopes (a full scan and a
		// subfolder scan both see this file): the claim closes the in-process
		// race, the fresh get() catches an import the other scope has already
		// finished since this scan's snapshot was taken.
		const claim = canonicalPath(filePath);
		if (importsInFlight.has(claim)) continue;
		importsInFlight.add(claim);
		try {
			if (await db.library_imports.get(filePath)) {
				raceSkipped++;
				processed++;
				continue;
			}
			const file = await filePathToFile(filePath);
			// The import record commits inside importArchive's own transaction.
			// Writing it afterwards left a window where the volume existed with
			// no record — and the next scan re-imports an unmatched archive under
			// a fresh uuid, leaving a permanent catalog duplicate whose file can
			// never be deleted (deleteVolume resolves the path through this very
			// table) and which the deleted-set sweep can never reach.
			await importArchive(file, undefined, libraryId, relativeFolder(filePath), {
				importRecord: {
					file_path: filePath,
					file_size: archive.size!,
					file_modified: archive.modified!,
					imported_at: new Date().toISOString()
				}
			});

			imported++;
			processed++;
		} catch (err) {
			failed.push({
				path: filePath,
				error: err instanceof Error ? err.message : 'Import failed'
			});
		} finally {
			importsInFlight.delete(claim);
		}
	}

	// Deletion reconciliation is intentionally full-scan-only (encoded by the
	// planner). Never infer deletion from a partial subfolder view.
	for (const missing of plan.deleted) {
		try {
			await deleteVolume(missing.volume_uuid, { deletePhysicalFile: false });
			deleted++;
		} catch (err) {
			failed.push({
				path: missing.file_path,
				error: `Unable to remove missing archive record: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// One-time migration for covers generated by the former 200px recipe. Reuse
	// the already-stored first reader page whenever possible and update only the
	// cover fields. If old/incomplete data lacks that page, selectively extract
	// exactly the archive's first image. The helper re-reads metadata inside its
	// write transaction so this scan cannot overwrite concurrent user edits.
	for (const item of legacyThumbnailItems) {
		const filePath = item.archive.path;
		const volumeUuid = item.importRecord.volume_uuid;
		if (!volumeByUuid.has(volumeUuid)) continue;
		onProgress?.({
			stage: 'importing',
			found: archivePaths.length,
			newFiles: operationsTotal,
			imported: processed,
			total: operationsTotal,
			currentFile: filePath.split(/[\\/]/).pop() || '',
		});
		try {
			const didUpgrade = await upgradeLegacyImportThumbnail(
				volumeUuid,
				() => filePathToFile(filePath),
			);
			if (didUpgrade) thumbnailUpgraded++;
			processed++;
		} catch (err) {
			failed.push({
				path: filePath,
				error: `Unable to upgrade legacy thumbnail: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// Keep folder metadata correct even for unchanged files.
	for (const item of plan.unchanged) {
		const volume = volumeByUuid.get(item.importRecord.volume_uuid);
		const folderPath = relativeFolder(item.archive.path);
		if (volume && volume.folder_path !== folderPath) {
			await updateVolume(volume.volume_uuid, { folder_path: folderPath });
		}
	}

	return {
		totalFound: archivePaths.length,
		newImported: imported,
		skippedExisting: Math.max(0, plan.unchanged.length - thumbnailUpgraded) + raceSkipped,
		updated,
		thumbnailUpgraded,
		moved,
		deleted,
		failed,
	};
}

// ============================================================
// Erase & Rescan — drop all data for a library and reimport
// ============================================================

/** Progress information for erase-and-rescan operation. */
export interface EraseRescanProgress {
	stage: 'erasing' | 'scanning' | 'importing';
	message: UserMessage;
}

/**
 * Erase all data for a local library and rescan from scratch.
 *
 * 1. Finds all volumes belonging to the library
 * 2. Revokes their thumbnail cache entries
 * 3. Deletes all related data in a single Dexie transaction:
 *    volumes, volume_files, page_dimensions, regions, translations,
 *    work_context, page_translations, volume_translation_jobs, inpainted_pages,
 *    library_imports
 * 4. Calls scanLibrary() to reimport everything fresh
 */
export async function eraseAndRescanLibrary(
	libraryId: string,
	libraryPath: string,
	onProgress?: (progress: EraseRescanProgress) => void
): Promise<ScanResult> {
	// Phase 0: exclusivity. Erasing while a scan of this library runs would
	// interleave the delete transaction with the scan's imports; and under the
	// old mutex the *rescan* could silently bail against a background scan,
	// leaving the library erased and empty. The gate is published before
	// draining so nothing new can start between drain and erase; queued scans
	// simply wait it out and then re-run against the fresh state.
	const libKey = libraryId || libraryPath;
	let releaseGate!: () => void;
	const previousGate = exclusiveGates.get(libKey);
	const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
	exclusiveGates.set(libKey, gate);
	try {
		if (previousGate) await previousGate.catch(() => undefined);
		onProgress?.({ stage: 'erasing', message: { code: 'scan_erase_waiting' } });
		let draining = scansInFlightFor(libKey);
		while (draining.length > 0) {
			await Promise.all(draining);
			draining = scansInFlightFor(libKey);
		}
		return await eraseAndRescanLibraryExclusively(libraryId, libraryPath, onProgress, () => {
			// Release before the rescan: the rescan itself is an ordinary scan
			// and must be able to pass the gate it would otherwise wait on.
			exclusiveGates.delete(libKey);
			releaseGate();
		});
	} finally {
		// Idempotent: normally released by the callback above; this covers the
		// erase throwing before it got there.
		if (exclusiveGates.get(libKey) === gate) exclusiveGates.delete(libKey);
		releaseGate();
	}
}

async function eraseAndRescanLibraryExclusively(
	libraryId: string,
	libraryPath: string,
	onProgress: ((progress: EraseRescanProgress) => void) | undefined,
	releaseGate: () => void
): Promise<ScanResult> {
	// Phase 1: Erase
	onProgress?.({ stage: 'erasing', message: { code: 'scan_erase_finding' } });

	const volumes = await db.volumes
		.where('library_id')
		.equals(libraryId)
		.toArray();

	const volumeUuids = volumes.map((v) => v.volume_uuid);
	const deletedTags = volumes.flatMap((v) => v.tags || []);

	// Revoke thumbnail blob URLs before deleting data
	for (const uuid of volumeUuids) {
		revokeThumbnailUrl(uuid);
	}

	onProgress?.({
		stage: 'erasing',
		message: { code: 'scan_erase_erasing', params: { n: volumeUuids.length } }
	});

	await db.transaction('rw', volumeScopedTables(db), async () => {
		for (const uuid of volumeUuids) {
			await deleteVolumeRowsInTransaction(uuid, db);
		}
	});

	// Clean up tags no longer referenced by any volume
	if (deletedTags.length > 0) {
		const { cleanupOrphanedTags } = await import('$lib/db/tag-cleanup.js');
		await cleanupOrphanedTags(deletedTags);
	}

	onProgress?.({
		stage: 'erasing',
		message: { code: 'scan_erase_erased_rescanning', params: { n: volumeUuids.length } }
	});

	// Phase 2: Rescan. Erase is committed, so the exclusive gate drops here —
	// the rescan is an ordinary scan and must be able to pass it. It cannot be
	// no-op'd: every path through scanLibrary returns a real scan's promise.
	releaseGate();
	const result = await scanLibrary(libraryPath, (progress) => {
		onProgress?.({
			stage: progress.stage,
			message: progress.stage === 'scanning'
				? { code: 'scan_found_archives', params: { n: progress.found } }
				: { code: 'scan_importing_file', params: { index: progress.imported + 1, total: progress.total, name: progress.currentFile } }
		});
	}, libraryId);

	return result;
}

/**
 * Check if a library path is valid and accessible.
 */
export async function validateLibraryPath(path: string): Promise<boolean> {
	try {
		return await exists(path);
	} catch {
		return false;
	}
}

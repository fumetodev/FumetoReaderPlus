/**
 * Android drop-folder ingestion.
 *
 * The local library lives in app-INTERNAL storage, which nothing outside the
 * app can write — but the Settings tip (correctly) points users at the
 * app-specific EXTERNAL dir, the only app-owned folder reachable over
 * USB/MTP and by file managers. Before every Android scan, archives dropped
 * there are moved into the library dir so the tip's workflow actually works
 * (pre-existing bug found during the 2026-07-20 remediation).
 *
 * Files are moved with the Rust-side `copyFile` (no JS-heap materialization
 * — the report-L2 lesson) and the source is removed only after the copy
 * succeeds.
 */

import { getArchiveType } from './types.js';
import { isAndroid } from '$lib/util/platform.js';

interface AndroidBridgeLike {
	getExternalComicsDir?: () => string;
}

/** The USB-visible drop folder, or null off-Android / bridge unavailable. */
export function getAndroidDropFolderPath(): string | null {
	if (!isAndroid) return null;
	const bridge = (globalThis as { __fumeto_android?: AndroidBridgeLike }).__fumeto_android;
	try {
		const path = bridge?.getExternalComicsDir?.();
		return path && path.length > 0 ? path : null;
	} catch {
		return null;
	}
}

export interface DropFolderIngestResult {
	ingested: number;
	skipped: number;
	failed: number;
}

/**
 * Move supported archives from the drop folder into the scanned library dir.
 * Never throws — a broken drop folder must not block the scan itself.
 */
export async function ingestAndroidDropFolder(libraryPath: string): Promise<DropFolderIngestResult> {
	const result: DropFolderIngestResult = { ingested: 0, skipped: 0, failed: 0 };
	const dropPath = getAndroidDropFolderPath();
	if (!dropPath || dropPath === libraryPath) return result;

	const { readDir, copyFile, remove, exists, stat } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');

	let entries: Awaited<ReturnType<typeof readDir>>;
	try {
		entries = await readDir(dropPath);
	} catch {
		return result;
	}

	for (const entry of entries) {
		const type = entry.isFile ? getArchiveType(entry.name) : null;
		// RAR/CBR never imports on mobile — leave it visible in the drop
		// folder rather than moving it somewhere the user cannot see.
		if (!type || type === 'rar') continue;
		try {
			const source = await join(dropPath, entry.name);
			const destination = await join(libraryPath, entry.name);
			if (await exists(destination)) {
				const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destination)]);
				if (sourceInfo.size === destinationInfo.size) {
					// Same bytes already ingested earlier; clear the leftover copy.
					await remove(source);
					result.skipped++;
					continue;
				}
				// Different size: fall through — the fresh drop wins.
			}
			await copyFile(source, destination);
			await remove(source);
			result.ingested++;
		} catch (err) {
			console.warn(`[drop-folder] Failed to ingest ${entry.name}:`, err);
			result.failed++;
		}
	}
	if (result.ingested > 0 || result.failed > 0) {
		console.info(
			`[drop-folder] ingested ${result.ingested}, skipped ${result.skipped}, failed ${result.failed}`
		);
	}
	return result;
}

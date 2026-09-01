/**
 * Library file system watcher for Fumeto.
 *
 * Watches one or more library folders for new files and triggers
 * a re-scan when changes are detected. Uses Tauri's fs plugin with
 * debouncing to avoid excessive scans. Each library gets its own
 * independent watcher with per-library concurrency guards.
 */

import { watch, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { isMobile } from '$lib/util/platform.js';

/** Per-library watcher state */
interface WatcherState {
	unwatchFn: UnwatchFn;
	scanInProgress: boolean;
	pendingRescan: boolean;
}

/** Active watchers keyed by library ID */
const watchers = new Map<string, WatcherState>();

/**
 * Start watching a library folder for new or modified files.
 *
 * @param libraryId - Unique ID of the library
 * @param libraryPath - Absolute path to the library folder
 * @param onNewFiles - Async callback when new files are detected
 */
export async function startWatchingLibrary(
	libraryId: string,
	libraryPath: string,
	onNewFiles: () => Promise<void>
): Promise<void> {
	// File watching is not available on mobile (Android scoped storage)
	if (isMobile) return;

	// Stop any existing watcher for this library first
	await stopWatchingLibrary(libraryId);

	const state: WatcherState = {
		unwatchFn: null!,
		scanInProgress: false,
		pendingRescan: false
	};

	async function runScan() {
		state.scanInProgress = true;
		state.pendingRescan = false;
		try {
			await onNewFiles();
		} catch (err) {
			console.error(`Library watcher scan failed (${libraryId}):`, err);
		} finally {
			state.scanInProgress = false;
			// If events arrived during the scan, run one more time
			if (state.pendingRescan) {
				runScan();
			}
		}
	}

	try {
		const unwatchFn = await watch(libraryPath, (_event) => {
			if (state.scanInProgress) {
				// A scan is already running — flag for a re-scan after it finishes
				state.pendingRescan = true;
				return;
			}
			runScan();
		}, {
			recursive: true,
			delayMs: 3000 // Debounce: wait 3 seconds after last change
		});

		state.unwatchFn = unwatchFn;
		watchers.set(libraryId, state);
	} catch (err) {
		console.error(`Failed to start library watcher (${libraryId}):`, err);
	}
}

/**
 * Stop the watcher for a specific library.
 */
export async function stopWatchingLibrary(libraryId: string): Promise<void> {
	const state = watchers.get(libraryId);
	if (state) {
		try {
			state.unwatchFn();
		} catch {
			// Ignore cleanup errors
		}
		watchers.delete(libraryId);
	}
}

/**
 * Stop all active library watchers.
 */
export async function stopAllWatching(): Promise<void> {
	for (const [id] of watchers) {
		await stopWatchingLibrary(id);
	}
}

/**
 * Whether a specific library is currently being watched.
 */
export function isWatchingLibrary(libraryId: string): boolean {
	return watchers.has(libraryId);
}

// ── Legacy compatibility aliases ────────────────────────────
// These are kept for any remaining callsites during migration.

/** @deprecated Use startWatchingLibrary instead */
export async function startWatching(
	libraryPath: string,
	onNewFiles: () => Promise<void>
): Promise<void> {
	return startWatchingLibrary('__legacy__', libraryPath, onNewFiles);
}

/** @deprecated Use stopAllWatching instead */
export async function stopWatching(): Promise<void> {
	return stopWatchingLibrary('__legacy__');
}

/** @deprecated Use isWatchingLibrary instead */
export function isWatching(): boolean {
	return isWatchingLibrary('__legacy__');
}

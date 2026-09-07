/**
 * Library file system watcher for Fumeto.
 *
 * Watches one or more library folders for new files and triggers
 * a re-scan when changes are detected. Uses Tauri's fs plugin with
 * debouncing to avoid excessive scans. Each library gets its own
 * independent watcher with per-library concurrency guards.
 *
 * A watcher that could not start is a visible fact, not a log line: the
 * failure is published on `libraryWatchStatus` (Settings → Libraries shows
 * it under the switch) and rethrown to the caller. Desktop only — Android's
 * scoped storage has no folder to watch, and every entry point returns
 * before touching the plugin there.
 */

import { watch, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { writable } from 'svelte/store';
import { isMobile } from '$lib/util/platform.js';
import { desktopLog } from '$lib/util/perf.js';

/** Per-library watcher state */
interface WatcherState {
	unwatchFn: UnwatchFn;
	path: string;
	scanInProgress: boolean;
	pendingRescan: boolean;
}

export interface LibraryWatchStatus {
	state: 'watching' | 'error';
	/** The failure, as the platform reported it — a permission refusal names the permission. */
	detail?: string;
}

/** What each library's watcher is doing, keyed by library id; absent means not watched. */
export const libraryWatchStatus = writable<Record<string, LibraryWatchStatus>>({});

function publishStatus(libraryId: string, status: LibraryWatchStatus | null): void {
	libraryWatchStatus.update((current) => {
		const next = { ...current };
		if (status) next[libraryId] = status;
		else delete next[libraryId];
		return next;
	});
}

/** Active watchers keyed by library ID */
const watchers = new Map<string, WatcherState>();

/**
 * Start watching a library folder for new or modified files.
 *
 * @param libraryId - Unique ID of the library
 * @param libraryPath - Absolute path to the library folder
 * @param onNewFiles - Async callback when new files are detected
 * @throws when the platform refuses the watch (missing permission, unreadable folder)
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
		path: libraryPath,
		scanInProgress: false,
		pendingRescan: false
	};

	async function runScan() {
		state.scanInProgress = true;
		state.pendingRescan = false;
		desktopLog(`[watcher] scan library=${libraryId}`);
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
			desktopLog(`[watcher] event library=${libraryId}`);
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
		publishStatus(libraryId, { state: 'watching' });
		desktopLog(`[watcher] start library=${libraryId}`);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(`Failed to start library watcher (${libraryId}):`, err);
		publishStatus(libraryId, { state: 'error', detail });
		desktopLog(`[watcher] start-failed library=${libraryId}`);
		throw err;
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
		desktopLog(`[watcher] stop library=${libraryId}`);
	}
	publishStatus(libraryId, null);
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

/** The folder the active watcher for a library is bound to, or null when it is not watched. */
export function watchedLibraryPath(libraryId: string): string | null {
	return watchers.get(libraryId)?.path ?? null;
}

/** Ids of every library with an active watcher. */
export function watchedLibraryIds(): string[] {
	return [...watchers.keys()];
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

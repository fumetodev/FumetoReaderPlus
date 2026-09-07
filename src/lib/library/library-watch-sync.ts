/**
 * Keeps the folder watchers in step with the library list.
 *
 * The watcher switch used to take effect on the next launch only: the
 * settings apply stopped every watcher and nothing restarted them. This
 * reconciles instead — start what is enabled and not yet running, stop what
 * is disabled or gone, rebind what moved — and is called from app start and
 * from every settings apply that changed the library set. Calls are queued
 * so two applies in quick succession cannot race a start against a stop.
 *
 * The scan a watcher triggers goes through the maintenance lane with the
 * same key as the library's auto-scan, so a burst of file events and a
 * launch-time scan of the same folder coalesce into one.
 */

import { get } from 'svelte/store';
import { isMobile } from '$lib/util/platform.js';
import { settings, isLocalLibrary, type Library, type LocalLibrary } from '$lib/settings/settings.js';
import { scanLibrary } from './library-scanner.js';
import {
	isWatchingLibrary,
	startWatchingLibrary,
	stopWatchingLibrary,
	watchedLibraryIds,
	watchedLibraryPath
} from './library-watcher.js';
import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';

/** Scan the library as it is configured NOW — a rename or move since the watch began still lands in the right place. */
function scanWatchedLibrary(libraryId: string): Promise<void> {
	const library = get(settings).libraries.find((candidate) => candidate.id === libraryId);
	if (!library || !isLocalLibrary(library)) return Promise.resolve();
	return appWorkCoordinator.submit({
		kind: 'local-library-watch-scan',
		owner: 'app-maintenance',
		lane: 'catalog-maintenance',
		priority: 2,
		coalescingKey: `scan:${library.id}`,
		operation: () => scanLibrary(library.path, undefined, library.id)
	}).promise.then(
		() => undefined,
		(error: unknown) => {
			if ((error as Error)?.name !== 'AbortError') {
				console.error(`Library watcher scan failed for "${library.name}":`, error);
			}
		}
	);
}

async function reconcile(libraries: readonly Library[]): Promise<void> {
	const wanted = new Map<string, LocalLibrary>();
	for (const library of libraries) {
		if (isLocalLibrary(library) && library.watchEnabled) wanted.set(library.id, library);
	}
	for (const id of watchedLibraryIds()) {
		if (!wanted.has(id)) await stopWatchingLibrary(id);
	}
	for (const library of wanted.values()) {
		if (isWatchingLibrary(library.id) && watchedLibraryPath(library.id) === library.path) continue;
		try {
			await startWatchingLibrary(library.id, library.path, () => scanWatchedLibrary(library.id));
		} catch (error) {
			// Already published on libraryWatchStatus; the other libraries still get theirs.
			console.error(`Library watcher failed for "${library.name}":`, error);
		}
	}
}

let queue: Promise<void> = Promise.resolve();

/**
 * Bring the watchers in line with `libraries`. Resolves when the
 * reconciliation has run; never rejects. A no-op on mobile.
 */
export function syncLibraryWatchers(libraries: readonly Library[]): Promise<void> {
	if (isMobile) return Promise.resolve();
	const snapshot = libraries.map((library) => ({ ...library }));
	queue = queue.then(() => reconcile(snapshot)).catch((error: unknown) => {
		console.error('Library watcher reconciliation failed:', error);
	});
	return queue;
}

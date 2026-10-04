/**
 * Keep the desktop folder watchers in step with the library settings.
 *
 * Watchers used to start once, at launch, for the libraries that had "Watch for
 * new files" on — so turning the switch on did nothing until the next launch,
 * turning it off did not stop anything, and a watcher that could not start
 * failed silently. This follows the libraries as settings are applied: a
 * watcher starts when its switch goes on, stops when it goes off or the library
 * is removed, and restarts when the folder changes. A start failure is kept in
 * `libraryWatchErrors` for the Libraries tab to show, and is not retried until
 * the library's folder or switch changes (settings apply on every edit, and the
 * same folder would fail the same way each time).
 */

import { writable, type Readable } from 'svelte/store';
import { isLocalLibrary, type Library } from '$lib/settings/settings.js';
import { isMobile } from '$lib/util/platform.js';
import { startWatchingLibrary, stopWatchingLibrary } from './library-watcher.js';

export interface LibraryWatchPorts {
	start(libraryId: string, path: string, onChange: () => Promise<void>): Promise<void>;
	stop(libraryId: string): Promise<void>;
}

const defaultPorts: LibraryWatchPorts = {
	start: startWatchingLibrary,
	stop: stopWatchingLibrary
};

const errors = writable<ReadonlyMap<string, string>>(new Map());

/** Library id → why its folder could not be watched. */
export const libraryWatchErrors: Readable<ReadonlyMap<string, string>> = { subscribe: errors.subscribe };

function setError(libraryId: string, message: string | null): void {
	errors.update((current) => {
		if (message === null ? !current.has(libraryId) : current.get(libraryId) === message) return current;
		const next = new Map(current);
		if (message === null) next.delete(libraryId);
		else next.set(libraryId, message);
		return next;
	});
}

/** The folders that should be watched: library id → path. */
export function wantedWatches(libraries: readonly Library[]): Map<string, string> {
	const wanted = new Map<string, string>();
	for (const library of libraries) {
		if (isLocalLibrary(library) && library.watchEnabled && library.path) wanted.set(library.id, library.path);
	}
	return wanted;
}

export interface LibraryWatchSyncOptions {
	libraries: Readable<readonly Library[]>;
	/** A watched folder changed; scan that library. */
	onChange(libraryId: string): void;
	ports?: LibraryWatchPorts;
	/** Defaults to the platform: phones and tablets never watch folders. */
	mobile?: boolean;
}

/** Start following the libraries. Returns the uninstall function, which stops every watcher. */
export function installLibraryWatchSync(options: LibraryWatchSyncOptions): () => void {
	if (options.mobile ?? isMobile) return () => {};
	const ports = options.ports ?? defaultPorts;

	/** Watchers that started: id → the path they watch. */
	const active = new Map<string, string>();
	/** Starts that failed: id → the path that failed (not retried while unchanged). */
	const failed = new Map<string, string>();
	let running: Promise<void> | null = null;
	let queued: readonly Library[] | null = null;
	let installed = true;

	async function reconcile(libraries: readonly Library[]): Promise<void> {
		const wanted = wantedWatches(libraries);

		for (const [id, path] of [...active]) {
			if (wanted.get(id) === path) continue;
			active.delete(id);
			await ports.stop(id).catch((error) => console.warn(`[library-watch] could not stop ${id}:`, error));
		}
		for (const [id, path] of [...failed]) {
			if (wanted.get(id) === path) continue;
			failed.delete(id);
			setError(id, null);
		}

		for (const [id, path] of wanted) {
			if (!installed) return;
			if (active.get(id) === path || failed.get(id) === path) continue;
			try {
				await ports.start(id, path, async () => options.onChange(id));
				active.set(id, path);
				failed.delete(id);
				setError(id, null);
			} catch (error) {
				failed.set(id, path);
				if (installed) setError(id, error instanceof Error ? error.message : String(error));
			}
		}
	}

	function schedule(libraries: readonly Library[]): void {
		if (running) {
			queued = libraries;
			return;
		}
		running = (async () => {
			let next: readonly Library[] | null = libraries;
			while (next && installed) {
				queued = null;
				await reconcile(next);
				next = queued;
			}
			running = null;
		})();
	}

	const unsubscribe = options.libraries.subscribe(schedule);

	return () => {
		installed = false;
		unsubscribe();
		failed.clear();
		errors.set(new Map());
		// A start may still be in flight; let the pass finish, then stop
		// everything it left running.
		void (running ?? Promise.resolve()).then(() => {
			const stopping = [...active.keys()];
			active.clear();
			return Promise.all(stopping.map((id) => ports.stop(id).catch(() => undefined)));
		});
	};
}

import type { Library, LocalLibrary } from '$lib/settings/settings.js';
import { isLocalLibrary } from '$lib/settings/settings.js';

export interface LocalLibraryBootstrapPorts {
	appDataDir(): Promise<string>;
	join(...parts: string[]): Promise<string>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	randomUUID(): string;
}

/**
 * Resolve the device-local "Local Comics" library that mobile builds create
 * automatically, creating its folder when missing. Returns the library entry
 * to add, or null when the current list already contains it.
 *
 * Single-flight: concurrent calls share one in-flight resolution. This — plus
 * callers keeping the guard OUTSIDE reactive state — is what prevents the
 * Svelte effect-retrigger loop this module was extracted to fix: the previous
 * inline implementation read and toggled a tracked `$state` guard inside a
 * `$effect`, which re-scheduled the effect on every run for as long as the
 * Libraries tab stayed open.
 */
let inFlight: Promise<LocalLibrary | null> | null = null;

export function resolveMobileLocalLibrary(
	currentLibraries: readonly Library[],
	ports: LocalLibraryBootstrapPorts
): Promise<LocalLibrary | null> {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			const dataDir = await ports.appDataDir();
			const comicsPath = await ports.join(dataDir, 'Comics');
			if (!(await ports.exists(comicsPath))) {
				await ports.mkdir(comicsPath, { recursive: true });
			}
			const alreadyExists = currentLibraries.some(
				(library) => isLocalLibrary(library) && library.path === comicsPath
			);
			if (alreadyExists) return null;
			return {
				id: ports.randomUUID(),
				type: 'local',
				name: 'Local Comics',
				path: comicsPath,
				autoScan: true,
				watchEnabled: false
			};
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

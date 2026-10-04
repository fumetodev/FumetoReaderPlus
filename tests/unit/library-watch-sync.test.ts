import { afterEach, describe, expect, it } from 'vitest';
import { get, writable } from 'svelte/store';
import type { Library, LocalLibrary } from '$lib/settings/settings.js';
import {
	installLibraryWatchSync,
	libraryWatchErrors,
	wantedWatches,
	type LibraryWatchPorts
} from '$lib/library/library-watch-sync.js';

function local(id: string, path: string, watchEnabled: boolean): LocalLibrary {
	return { id, type: 'local', name: id, path, autoScan: false, watchEnabled };
}

/** Ports that record calls; `failPaths` makes those starts reject. */
function fakePorts(failPaths: string[] = []) {
	const calls: string[] = [];
	const handlers = new Map<string, () => Promise<void>>();
	const ports: LibraryWatchPorts = {
		async start(id, path, onChange) {
			calls.push(`start ${id} ${path}`);
			if (failPaths.includes(path)) throw new Error(`cannot watch ${path}`);
			handlers.set(id, onChange);
		},
		async stop(id) {
			calls.push(`stop ${id}`);
			handlers.delete(id);
		}
	};
	return { calls, handlers, ports };
}

/** Let queued reconcile passes finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let uninstall: (() => void) | null = null;
afterEach(() => {
	uninstall?.();
	uninstall = null;
});

describe('wantedWatches', () => {
	it('picks local libraries with the switch on and a folder', () => {
		const remote = { id: 'r', type: 'komga', name: 'r' } as unknown as Library;
		expect([...wantedWatches([local('a', '/a', true), local('b', '/b', false), local('c', '', true), remote])]).toEqual([
			['a', '/a']
		]);
	});
});

describe('installLibraryWatchSync', () => {
	it('starts watchers for enabled libraries and scans the right library on a change', async () => {
		const libraries = writable<Library[]>([local('a', '/a', true), local('b', '/b', false)]);
		const changed: string[] = [];
		const { calls, handlers, ports } = fakePorts();
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: (id) => changed.push(id) });
		await settle();

		expect(calls).toEqual(['start a /a']);
		await handlers.get('a')!();
		expect(changed).toEqual(['a']);
	});

	it('follows the switch and the folder without a restart', async () => {
		const libraries = writable<Library[]>([local('a', '/a', false)]);
		const { calls, ports } = fakePorts();
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: () => {} });
		await settle();
		expect(calls).toEqual([]);

		libraries.set([local('a', '/a', true)]);
		await settle();
		libraries.set([local('a', '/a', true)]); // an unrelated settings apply
		await settle();
		libraries.set([local('a', '/moved', true)]);
		await settle();
		libraries.set([local('a', '/moved', false)]);
		await settle();

		expect(calls).toEqual(['start a /a', 'stop a', 'start a /moved', 'stop a']);
	});

	it('stops the watcher of a removed library', async () => {
		const libraries = writable<Library[]>([local('a', '/a', true), local('b', '/b', true)]);
		const { calls, ports } = fakePorts();
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: () => {} });
		await settle();
		libraries.set([local('b', '/b', true)]);
		await settle();

		expect(calls).toEqual(['start a /a', 'start b /b', 'stop a']);
	});

	it('reports a start failure, does not retry the same folder, and clears it when the folder changes', async () => {
		const libraries = writable<Library[]>([local('a', '/Volumes/Gone', true)]);
		const { calls, ports } = fakePorts(['/Volumes/Gone']);
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: () => {} });
		await settle();

		expect(get(libraryWatchErrors).get('a')).toBe('cannot watch /Volumes/Gone');

		libraries.set([local('a', '/Volumes/Gone', true)]); // settings applied again, same folder
		await settle();
		expect(calls).toEqual(['start a /Volumes/Gone']);

		libraries.set([local('a', '/Users/me/Comics', true)]);
		await settle();
		expect(calls).toEqual(['start a /Volumes/Gone', 'start a /Users/me/Comics']);
		expect(get(libraryWatchErrors).has('a')).toBe(false);
	});

	it('clears the error when the switch goes off', async () => {
		const libraries = writable<Library[]>([local('a', '/bad', true)]);
		const { ports } = fakePorts(['/bad']);
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: () => {} });
		await settle();
		expect(get(libraryWatchErrors).has('a')).toBe(true);

		libraries.set([local('a', '/bad', false)]);
		await settle();
		expect(get(libraryWatchErrors).has('a')).toBe(false);
	});

	it('applies the latest settings after a pass that was still running', async () => {
		const libraries = writable<Library[]>([local('a', '/a', true)]);
		const calls: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const ports: LibraryWatchPorts = {
			async start(id, path) {
				calls.push(`start ${id} ${path}`);
				if (path === '/a') await gate;
			},
			async stop(id) {
				calls.push(`stop ${id}`);
			}
		};
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: () => {} });
		libraries.set([local('a', '/b', true)]);
		libraries.set([local('a', '/c', true)]); // only the latest matters
		release();
		await settle();
		await settle();

		expect(calls).toEqual(['start a /a', 'stop a', 'start a /c']);
	});

	it('stops every watcher on uninstall', async () => {
		const libraries = writable<Library[]>([local('a', '/a', true), local('b', '/b', true)]);
		const { calls, ports } = fakePorts();
		const stop = installLibraryWatchSync({ libraries, ports, mobile: false, onChange: () => {} });
		await settle();
		stop();
		await settle();

		expect(calls.slice(2).sort()).toEqual(['stop a', 'stop b']);
	});

	it('does nothing on a phone or tablet', async () => {
		const libraries = writable<Library[]>([local('a', '/a', true)]);
		const { calls, ports } = fakePorts();
		uninstall = installLibraryWatchSync({ libraries, ports, mobile: true, onChange: () => {} });
		await settle();

		expect(calls).toEqual([]);
	});
});

/**
 * End-to-end wiring of the app-data heal with the real Dexie schema, the real
 * settings store and the real library scanner — only the Tauri filesystem and
 * path plugins are replaced, by an in-memory iOS container that has just moved.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const OLD = '/var/mobile/Containers/Data/Application/1111-OLD/Library/Application Support/com.fumeto.reader';
const NEW = '/var/mobile/Containers/Data/Application/2222-NEW/Library/Application Support/com.fumeto.reader';

const fsState = vi.hoisted(() => {
	const storage = new Map<string, string>();
	(globalThis as Record<string, unknown>).localStorage = {
		get length() {
			return storage.size;
		},
		key: (index: number) => [...storage.keys()][index] ?? null,
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, String(value)),
		removeItem: (key: string) => void storage.delete(key),
		clear: () => storage.clear()
	};
	return {
		files: new Map<string, { data: Uint8Array; mtime: Date }>(),
		dirs: new Set<string>(),
		readDirCalls: [] as string[]
	};
});

vi.mock('@tauri-apps/api/path', () => ({
	appDataDir: async () => NEW,
	join: async (...parts: string[]) => parts.join('/')
}));

vi.mock('@tauri-apps/plugin-fs', () => {
	const APP_DATA = 14;
	const resolve = (path: string, baseDir?: number) =>
		baseDir === APP_DATA ? (path === '' ? NEW : `${NEW}/${path}`) : path;
	const notFound = (path: string) => new Error(`No such file or directory: ${path}`);
	return {
		BaseDirectory: { AppData: APP_DATA },
		exists: async (path: string, options?: { baseDir?: number }) => {
			const resolved = resolve(path, options?.baseDir);
			return fsState.files.has(resolved) || fsState.dirs.has(resolved);
		},
		readTextFile: async (path: string, options?: { baseDir?: number }) => {
			const file = fsState.files.get(resolve(path, options?.baseDir));
			if (!file) throw notFound(path);
			return new TextDecoder().decode(file.data);
		},
		writeTextFile: async (path: string, contents: string, options?: { baseDir?: number }) => {
			fsState.files.set(resolve(path, options?.baseDir), { data: new TextEncoder().encode(contents), mtime: new Date() });
		},
		rename: async (from: string, to: string, options?: { oldPathBaseDir?: number; newPathBaseDir?: number }) => {
			const source = resolve(from, options?.oldPathBaseDir);
			const file = fsState.files.get(source);
			if (!file) throw notFound(from);
			fsState.files.delete(source);
			fsState.files.set(resolve(to, options?.newPathBaseDir), file);
		},
		mkdir: async (path: string, options?: { baseDir?: number }) => void fsState.dirs.add(resolve(path, options?.baseDir)),
		readDir: async (path: string) => {
			fsState.readDirCalls.push(path);
			if (!fsState.dirs.has(path)) throw notFound(path);
			const children = new Map<string, { isDirectory: boolean }>();
			for (const dir of fsState.dirs) {
				if (dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')) {
					children.set(dir.slice(path.length + 1), { isDirectory: true });
				}
			}
			for (const file of fsState.files.keys()) {
				if (file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')) {
					children.set(file.slice(path.length + 1), { isDirectory: false });
				}
			}
			return [...children].map(([name, { isDirectory }]) => ({
				name,
				isDirectory,
				isFile: !isDirectory,
				isSymlink: false
			}));
		},
		stat: async (path: string) => {
			const file = fsState.files.get(path);
			if (!file) throw notFound(path);
			return { size: file.data.byteLength, mtime: file.mtime, isFile: true, isDirectory: false };
		},
		readFile: async (path: string) => {
			const file = fsState.files.get(path);
			if (!file) throw notFound(path);
			return file.data;
		},
		remove: async (path: string) => void fsState.files.delete(path),
		writeFile: async () => undefined,
		copyFile: async () => undefined,
		watch: async () => () => undefined
	};
});

const { db } = await import('$lib/db/index.js');
const { settings } = await import('$lib/settings/settings.js');
const { scanLibrary } = await import('$lib/library/library-scanner.js');
const { ensureAppDataPathsHealed, parseLocationRecord, serializeLocationRecord } = await import(
	'$lib/library/app-data-relocation.js'
);
const { resolveMobileLocalLibrary } = await import('$lib/settings/local-library-bootstrap.js');

afterAll(async () => {
	vi.unstubAllGlobals();
	db.close();
});

describe('an iOS launch after the container moved', () => {
	const archiveMtime = new Date('2026-05-01T10:00:00.000Z');
	const archiveBytes = new Uint8Array(1234);

	it('heals settings and import records, bootstraps no duplicate, and a stale-path scan finds nothing to re-import', async () => {
		// The container as the OS left it: files moved, stored paths did not.
		fsState.files.set(`${NEW}/app-data-location.json`, {
			data: new TextEncoder().encode(serializeLocationRecord([OLD])),
			mtime: new Date()
		});
		for (const dir of [NEW, `${NEW}/Comics`, `${NEW}/Comics/Author`]) fsState.dirs.add(dir);
		fsState.files.set(`${NEW}/Comics/Author/Vol 1.cbz`, { data: archiveBytes, mtime: archiveMtime });

		settings.update((current) => ({
			...current,
			libraries: [{ id: 'local-1', type: 'local', name: 'Local Comics', path: `${OLD}/Comics`, autoScan: true, watchEnabled: false }]
		}));
		await db.volumes.put({
			volume_uuid: 'vol-1',
			library_id: 'local-1',
			title: 'Vol 1',
			filename: 'Vol 1.cbz',
			page_count: 20,
			current_page: 7,
			created_at: '2026-05-01T10:00:00.000Z',
			folder_path: 'Author',
			thumbnail_generation_version: 2
		} as never);
		await db.library_imports.put({
			file_path: `${OLD}/Comics/Author/Vol 1.cbz`,
			volume_uuid: 'vol-1',
			file_size: archiveBytes.byteLength,
			file_modified: archiveMtime.getTime(),
			imported_at: '2026-05-01T10:00:00.000Z'
		});

		vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
		await ensureAppDataPathsHealed();

		const library = get(settings).libraries[0] as { path: string };
		expect(library.path).toBe(`${NEW}/Comics`);
		expect(await db.library_imports.toCollection().primaryKeys()).toEqual([`${NEW}/Comics/Author/Vol 1.cbz`]);
		const record = fsState.files.get(`${NEW}/app-data-location.json`)!;
		expect(parseLocationRecord(new TextDecoder().decode(record.data))).toEqual([NEW, OLD]);

		// The mobile bootstrap now recognises the existing "Local Comics".
		const entry = await resolveMobileLocalLibrary(get(settings).libraries, {
			appDataDir: async () => NEW,
			join: async (...parts: string[]) => parts.join('/'),
			exists: async () => true,
			mkdir: async () => undefined,
			randomUUID: () => 'duplicate-id'
		});
		expect(entry).toBeNull();

		// A caller still holding the pre-move path is carried onto the new one.
		const result = await scanLibrary(`${OLD}/Comics`, undefined, 'local-1');
		expect(fsState.readDirCalls[0]).toBe(`${NEW}/Comics`);
		expect(result).toMatchObject({ totalFound: 1, newImported: 0, deleted: 0, moved: 0, failed: [] });
		expect(result.skippedExisting).toBe(1);

		const volume = await db.volumes.get('vol-1');
		expect(volume?.current_page).toBe(7);
		expect(await db.volumes.count()).toBe(1);
		expect(await db.library_imports.count()).toBe(1);
	});
});

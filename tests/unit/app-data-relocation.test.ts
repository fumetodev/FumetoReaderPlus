import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MAX_REMEMBERED_BASES,
	createPathRebaser,
	ensureAppDataPathsHealed,
	healAppDataPaths,
	normalizeBase,
	parseLocationRecord,
	planImportRebase,
	rebaseImportTable,
	rebaseLibraryPaths,
	rebaseStaleLibraryPaths,
	rebaseStalePath,
	rememberBase,
	resetAppDataRelocationForTests,
	serializeLocationRecord,
	type AppDataRelocationPorts,
	type LocationRecordRead
} from '$lib/library/app-data-relocation.js';
import { resolveMobileLocalLibrary } from '$lib/settings/local-library-bootstrap.js';
import type { Library, LocalLibrary } from '$lib/settings/settings.js';
import type { LibraryImport } from '$lib/types/index.js';

const APP = (uuid: string) =>
	`/var/mobile/Containers/Data/Application/${uuid}/Library/Application Support/com.fumeto.reader`;
const OLD = APP('1111-OLD');
const NEW = APP('2222-NEW');

function importRecord(file_path: string, volume_uuid: string, imported_at = '2026-01-01T00:00:00.000Z'): LibraryImport {
	return { file_path, volume_uuid, file_size: 100, file_modified: 1, imported_at };
}

function localLibrary(path: string, id = 'local-1'): LocalLibrary {
	return { id, type: 'local', name: 'Local Comics', path, autoScan: true, watchEnabled: false };
}

describe('createPathRebaser', () => {
	const rebase = createPathRebaser([OLD], NEW);

	it('moves a path under an old base onto the current one', () => {
		expect(rebase(`${OLD}/Comics/Author/Vol 1.cbz`)).toBe(`${NEW}/Comics/Author/Vol 1.cbz`);
		expect(rebase(OLD)).toBe(NEW);
	});

	it('leaves current, unrelated and look-alike paths alone', () => {
		expect(rebase(`${NEW}/Comics/a.cbz`)).toBeNull();
		expect(rebase('/Users/me/Comics/a.cbz')).toBeNull();
		// A sibling whose name merely starts with the base is not under it.
		expect(rebase(`${OLD}-backup/Comics/a.cbz`)).toBeNull();
	});

	it('handles Windows separators and trailing separators on bases', () => {
		const windows = createPathRebaser(['C:\\Users\\old\\AppData\\Roaming\\com.fumeto.reader\\'], 'C:\\Users\\new\\AppData\\Roaming\\com.fumeto.reader');
		expect(windows('C:\\Users\\old\\AppData\\Roaming\\com.fumeto.reader\\Comics\\a.cbz')).toBe(
			'C:\\Users\\new\\AppData\\Roaming\\com.fumeto.reader\\Comics\\a.cbz'
		);
	});

	it('prefers the longest matching base and never rewrites the current base into itself', () => {
		const nested = createPathRebaser(['/data', '/data/app-old'], '/data/app-new');
		expect(nested('/data/app-old/Comics/a.cbz')).toBe('/data/app-new/Comics/a.cbz');
		expect(nested('/data/app-new/Comics/a.cbz')).toBeNull();
	});

	it('is a no-op with no old bases', () => {
		expect(createPathRebaser([], NEW)(`${OLD}/Comics`)).toBeNull();
		expect(createPathRebaser([NEW], NEW)(`${NEW}/Comics`)).toBeNull();
	});
});

describe('location record', () => {
	it('round-trips and rejects foreign content', () => {
		expect(parseLocationRecord(serializeLocationRecord([NEW, OLD]))).toEqual([NEW, OLD]);
		expect(parseLocationRecord('not json')).toBeNull();
		expect(parseLocationRecord('{"version":2,"bases":[]}')).toBeNull();
		expect(parseLocationRecord('{"version":1,"bases":"x"}')).toBeNull();
	});

	it('remembers the current base first, keeps history, dedupes and caps', () => {
		expect(rememberBase(NEW, [OLD])).toEqual([NEW, OLD]);
		expect(rememberBase(NEW, [NEW, OLD])).toEqual([NEW, OLD]);
		expect(rememberBase(`${NEW}/`, [OLD, NEW])).toEqual([NEW, OLD]);
		const long = Array.from({ length: 20 }, (_, i) => `/base/${i}`);
		expect(rememberBase(NEW, long)).toHaveLength(MAX_REMEMBERED_BASES);
	});

	it('normalizes trailing separators', () => {
		expect(normalizeBase('/a/b/')).toBe('/a/b');
		expect(normalizeBase('/')).toBe('/');
	});
});

describe('rebaseLibraryPaths', () => {
	it('rewrites local libraries only', () => {
		const remote = { id: 'r', type: 'komga', name: 'K', serverUrl: `${OLD}/not-a-path` } as unknown as Library;
		const { libraries, changed } = rebaseLibraryPaths(
			[localLibrary(`${OLD}/Comics`), localLibrary('/elsewhere', 'local-2'), remote],
			createPathRebaser([OLD], NEW)
		);
		expect(changed).toBe(1);
		expect((libraries[0] as LocalLibrary).path).toBe(`${NEW}/Comics`);
		expect((libraries[1] as LocalLibrary).path).toBe('/elsewhere');
		expect(libraries[2]).toBe(remote);
	});
});

describe('planImportRebase', () => {
	const rebase = createPathRebaser([OLD], NEW);

	it('moves every stale record to its new key', () => {
		const plan = planImportRebase([importRecord(`${OLD}/Comics/a.cbz`, 'vol-a')], new Map(), rebase);
		expect(plan.deletes).toEqual([`${OLD}/Comics/a.cbz`]);
		expect(plan.puts).toEqual([importRecord(`${NEW}/Comics/a.cbz`, 'vol-a')]);
		expect(plan.conflicts).toBe(0);
	});

	it('keeps the earlier import when a duplicate already sits at the new path', () => {
		const original = importRecord(`${OLD}/Comics/a.cbz`, 'vol-original', '2026-01-01T00:00:00.000Z');
		const duplicate = importRecord(`${NEW}/Comics/a.cbz`, 'vol-duplicate', '2026-06-01T00:00:00.000Z');
		const plan = planImportRebase([original], new Map([[duplicate.file_path, duplicate]]), rebase);
		expect(plan.conflicts).toBe(1);
		expect(plan.deletes).toEqual([original.file_path]);
		expect(plan.puts).toEqual([{ ...original, file_path: duplicate.file_path }]);
	});

	it('keeps an occupant that is provably older', () => {
		const stale = importRecord(`${OLD}/Comics/a.cbz`, 'vol-new', '2026-06-01T00:00:00.000Z');
		const older = importRecord(`${NEW}/Comics/a.cbz`, 'vol-old', '2026-01-01T00:00:00.000Z');
		const plan = planImportRebase([stale], new Map([[older.file_path, older]]), rebase);
		expect(plan.deletes).toEqual([stale.file_path]);
		expect(plan.puts).toEqual([]);
	});

	it('just drops the stale key when the occupant is the same volume', () => {
		const stale = importRecord(`${OLD}/Comics/a.cbz`, 'vol-a');
		const same = importRecord(`${NEW}/Comics/a.cbz`, 'vol-a');
		const plan = planImportRebase([stale], new Map([[same.file_path, same]]), rebase);
		expect(plan).toEqual({ deletes: [stale.file_path], puts: [], conflicts: 0 });
	});

	it('ignores records that are not under an old base', () => {
		const plan = planImportRebase([importRecord('/elsewhere/a.cbz', 'v')], new Map(), rebase);
		expect(plan).toEqual({ deletes: [], puts: [], conflicts: 0 });
	});
});

describe('rebaseImportTable (IndexedDB)', () => {
	let db: Dexie & { library_imports: Table<LibraryImport, string> };

	afterEach(async () => {
		await db?.delete();
	});

	async function openDb(records: LibraryImport[]) {
		db = new Dexie(`relocation-test-${Math.random()}`) as typeof db;
		db.version(1).stores({ library_imports: 'file_path, volume_uuid' });
		await db.library_imports.bulkPut(records);
		return db;
	}

	it('rewrites the primary key of every record under an old base, in one transaction', async () => {
		await openDb([
			importRecord(`${OLD}/Comics/Author/a.cbz`, 'vol-a'),
			importRecord(`${OLD}/Comics/b.cbz`, 'vol-b'),
			importRecord('/Users/me/Comics/c.cbz', 'vol-c')
		]);
		const moved = await db.transaction('rw', db.library_imports, () =>
			rebaseImportTable(db.library_imports, [OLD], createPathRebaser([OLD], NEW))
		);
		expect(moved).toBe(2);
		const keys = (await db.library_imports.toCollection().primaryKeys()).sort();
		expect(keys).toEqual(['/Users/me/Comics/c.cbz', `${NEW}/Comics/Author/a.cbz`, `${NEW}/Comics/b.cbz`].sort());
		expect((await db.library_imports.get(`${NEW}/Comics/b.cbz`))?.volume_uuid).toBe('vol-b');
	});

	it('does not match a sibling directory that shares the base as a prefix', async () => {
		await openDb([importRecord(`${OLD}-backup/Comics/a.cbz`, 'vol-a')]);
		const moved = await rebaseImportTable(db.library_imports, [OLD], createPathRebaser([OLD], NEW));
		expect(moved).toBe(0);
		expect(await db.library_imports.count()).toBe(1);
	});
});

/** An in-memory stand-in for the file, the settings store and the table. */
function fakePorts(options: {
	appDataDir: string;
	record?: LocationRecordRead;
	libraries: Library[];
	imports: LibraryImport[];
	failImports?: boolean;
}) {
	const state = {
		record: options.record ?? ({ status: 'absent' } as LocationRecordRead),
		written: [] as string[],
		libraries: options.libraries,
		imports: new Map(options.imports.map((record) => [record.file_path, record]))
	};
	const ports: AppDataRelocationPorts = {
		appDataDir: async () => options.appDataDir,
		readLocationRecord: async () => state.record,
		writeLocationRecord: async (contents) => {
			state.written.push(contents);
			state.record = { status: 'ok', raw: contents };
		},
		rebaseImportRecords: async (_oldBases, rebase) => {
			if (options.failImports) throw new Error('IndexedDB unavailable');
			const stale = [...state.imports.values()];
			const plan = planImportRebase(stale, state.imports, rebase);
			for (const key of plan.deletes) state.imports.delete(key);
			for (const record of plan.puts) state.imports.set(record.file_path, record);
			return plan.puts.length;
		},
		rebaseLibraries: async (rebase) => {
			const result = rebaseLibraryPaths(state.libraries, rebase);
			state.libraries = result.libraries;
			return result.changed;
		}
	};
	return { ports, state };
}

describe('healAppDataPaths', () => {
	it('records the base on first run without touching anything', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			libraries: [localLibrary(`${NEW}/Comics`)],
			imports: [importRecord(`${NEW}/Comics/a.cbz`, 'vol-a')]
		});
		const result = await healAppDataPaths(ports);
		expect(result.status).toBe('unchanged');
		expect(state.written).toEqual([serializeLocationRecord([NEW])]);
	});

	it('writes nothing on an ordinary launch where the directory did not move', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'ok', raw: serializeLocationRecord([NEW]) },
			libraries: [localLibrary(`${NEW}/Comics`)],
			imports: []
		});
		expect((await healAppDataPaths(ports)).status).toBe('unchanged');
		expect(state.written).toEqual([]);
	});

	it('heals libraries and import records after the container moves, then remembers both bases', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'ok', raw: serializeLocationRecord([OLD]) },
			libraries: [localLibrary(`${OLD}/Comics`)],
			imports: [importRecord(`${OLD}/Comics/Author/a.cbz`, 'vol-a'), importRecord(`${OLD}/Comics/b.cbz`, 'vol-b')]
		});
		const result = await healAppDataPaths(ports);
		expect(result).toMatchObject({ status: 'healed', importsRebased: 2, librariesRebased: 1, previousBases: [OLD] });
		expect((state.libraries[0] as LocalLibrary).path).toBe(`${NEW}/Comics`);
		expect([...state.imports.keys()].sort()).toEqual([`${NEW}/Comics/Author/a.cbz`, `${NEW}/Comics/b.cbz`]);
		expect(parseLocationRecord(state.written.at(-1)!)).toEqual([NEW, OLD]);

		// Idempotent: the next launch changes nothing and rewrites nothing.
		const writes = state.written.length;
		expect((await healAppDataPaths(ports)).status).toBe('unchanged');
		expect(state.written).toHaveLength(writes);
	});

	it('heals a stale copy written back after an earlier heal', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'ok', raw: serializeLocationRecord([NEW, OLD]) },
			libraries: [localLibrary(`${OLD}/Comics`)],
			imports: []
		});
		expect((await healAppDataPaths(ports)).librariesRebased).toBe(1);
		expect((state.libraries[0] as LocalLibrary).path).toBe(`${NEW}/Comics`);
	});

	it('does nothing when the history cannot be read — never treats it as empty', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'unreadable', reason: 'io error' },
			libraries: [localLibrary(`${OLD}/Comics`)],
			imports: [importRecord(`${OLD}/Comics/a.cbz`, 'vol-a')]
		});
		expect((await healAppDataPaths(ports)).status).toBe('skipped');
		expect(state.written).toEqual([]);
		expect((state.libraries[0] as LocalLibrary).path).toBe(`${OLD}/Comics`);
	});

	it('starts a fresh history over a file that is not a record', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'ok', raw: '{garbage' },
			libraries: [],
			imports: []
		});
		await healAppDataPaths(ports);
		expect(parseLocationRecord(state.written.at(-1)!)).toEqual([NEW]);
	});

	it('leaves libraries on the old base when the import records could not move', async () => {
		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'ok', raw: serializeLocationRecord([OLD]) },
			libraries: [localLibrary(`${OLD}/Comics`)],
			imports: [importRecord(`${OLD}/Comics/a.cbz`, 'vol-a')],
			failImports: true
		});
		await expect(healAppDataPaths(ports)).rejects.toThrow('IndexedDB unavailable');
		// A library on the new base with records on the old one is what makes a
		// scan re-import everything; the pass must stop before that.
		expect((state.libraries[0] as LocalLibrary).path).toBe(`${OLD}/Comics`);
		expect(state.written).toEqual([]);
	});
});

describe('the duplicate "Local Comics" bug', () => {
	it('bootstraps a second library after a move without the heal, and none with it', async () => {
		const makePorts = () => ({
			appDataDir: async () => NEW,
			join: async (...parts: string[]) => parts.join('/'),
			exists: async () => true,
			mkdir: async () => undefined,
			randomUUID: () => 'new-id'
		});
		const stored = [localLibrary(`${OLD}/Comics`)];

		// What an iOS update used to do: a second "Local Comics" at the new path.
		expect(await resolveMobileLocalLibrary(stored, makePorts())).toMatchObject({ path: `${NEW}/Comics` });

		const { ports, state } = fakePorts({
			appDataDir: NEW,
			record: { status: 'ok', raw: serializeLocationRecord([OLD]) },
			libraries: stored,
			imports: []
		});
		await healAppDataPaths(ports);
		expect(await resolveMobileLocalLibrary(state.libraries, makePorts())).toBeNull();
	});
});

describe('session helpers outside a Tauri host', () => {
	afterEach(() => resetAppDataRelocationForTests());

	it('resolve immediately and leave paths untouched', async () => {
		await expect(ensureAppDataPathsHealed()).resolves.toBeUndefined();
		expect(rebaseStalePath(`${OLD}/Comics`)).toBe(`${OLD}/Comics`);
		const libraries = [localLibrary(`${OLD}/Comics`)];
		expect(rebaseStaleLibraryPaths(libraries)).toBe(libraries);
	});
});

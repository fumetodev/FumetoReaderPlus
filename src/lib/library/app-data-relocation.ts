/**
 * Heals the absolute paths this app stores under its own data directory after
 * that directory moves.
 *
 * Two records hold absolute paths: a local library's `path` in settings (the
 * mobile "Local Comics" library is `appDataDir()/Comics`) and every
 * `library_imports.file_path`, which is that table's primary key and what a
 * scan matches archives against. On Android and desktop the data directory
 * never moves. On iOS it can: the container path embeds a per-install UUID
 * that changes across app updates and restores (Apple TN2406). Left alone, the
 * next launch would bootstrap a second "Local Comics" at the new path, and its
 * scan would re-import every archive under a fresh volume UUID — duplicates,
 * with reading progress and translations stranded on the old copies.
 *
 * Paths stay absolute at runtime; far too much code reads them to change their
 * representation. Instead every base the data directory has had is remembered
 * in a small file INSIDE that directory (so it moves along with it), and on
 * launch anything stored under an earlier base is rewritten onto the current
 * one. The rewrite is idempotent and old bases are never forgotten, so a stale
 * copy written back later (an open settings draft) is healed on the next pass.
 */

import type { Table } from 'dexie';
import type { Library } from '$lib/settings/settings.js';
import type { LibraryImport } from '$lib/types/index.js';

export const APP_DATA_LOCATION_FILE = 'app-data-location.json';
const APP_DATA_LOCATION_TEMP_FILE = 'app-data-location.json.tmp';
const LOCATION_RECORD_VERSION = 1;
/** Enough history for any realistic run of updates and restores. */
export const MAX_REMEMBERED_BASES = 8;

/** Returns the path moved onto the current base, or null when it is unaffected. */
export type PathRebaser = (path: string) => string | null;

/** Drop trailing separators so `/a/b/` and `/a/b` name the same base. */
export function normalizeBase(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	return trimmed === '' && /^[\\/]/.test(path) ? path.slice(0, 1) : trimmed;
}

function isUnder(path: string, base: string): boolean {
	return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/**
 * Build the rewrite for one launch. The longest matching base wins, and a path
 * already under the current base is never touched — a current base nested
 * inside an old one must not be rewritten into itself.
 */
export function createPathRebaser(oldBases: readonly string[], currentBase: string): PathRebaser {
	const current = normalizeBase(currentBase);
	const bases = [...new Set(oldBases.map(normalizeBase))]
		.filter((base) => base !== '' && base !== current)
		.sort((a, b) => b.length - a.length);
	return (path) => {
		if (bases.length === 0 || isUnder(path, current)) return null;
		const base = bases.find((candidate) => isUnder(path, candidate));
		return base === undefined ? null : current + path.slice(base.length);
	};
}

/** The remembered bases, most recent first, or null when the file is not ours. */
export function parseLocationRecord(raw: string): string[] | null {
	try {
		const parsed = JSON.parse(raw) as { version?: unknown; bases?: unknown };
		if (parsed?.version !== LOCATION_RECORD_VERSION || !Array.isArray(parsed.bases)) return null;
		return parsed.bases
			.filter((base): base is string => typeof base === 'string' && base.length > 0)
			.map(normalizeBase);
	} catch {
		return null;
	}
}

export function serializeLocationRecord(bases: readonly string[]): string {
	return JSON.stringify({ version: LOCATION_RECORD_VERSION, bases });
}

/** Put the current base first; keep every earlier one, deduplicated and capped. */
export function rememberBase(currentBase: string, history: readonly string[]): string[] {
	const current = normalizeBase(currentBase);
	return [current, ...history.filter((base) => base !== current)]
		.filter((base, index, all) => all.indexOf(base) === index)
		.slice(0, MAX_REMEMBERED_BASES);
}

/** Rewrite local library paths; remote libraries have no local path. */
export function rebaseLibraryPaths<T extends Library>(
	libraries: readonly T[],
	rebase: PathRebaser
): { libraries: T[]; changed: number } {
	let changed = 0;
	const next = libraries.map((library) => {
		if (library.type !== 'local') return library;
		const moved = rebase(library.path);
		if (moved === null || moved === library.path) return library;
		changed++;
		return { ...library, path: moved };
	});
	return { libraries: changed > 0 ? next : [...libraries], changed };
}

export interface ImportRebasePlan {
	/** Keys to remove — every stale record, whether or not it moves. */
	deletes: string[];
	/** Records to write at their new key. */
	puts: LibraryImport[];
	/** Targets that were already occupied by a different volume. */
	conflicts: number;
}

function importedAtMs(record: LibraryImport): number {
	const ms = Date.parse(record.imported_at);
	return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Move stale import records onto the current base.
 *
 * A target can only be occupied already if a scan ran against the new base
 * before this heal did, re-importing the archive as a duplicate. The record
 * that stays is the EARLIER import — the volume carrying the reading progress
 * and translations — unless the occupant is provably older. The loser's
 * volume is left in place without a record; no volume is ever deleted here,
 * because a record left at a stale path would get its volume deleted by the
 * next full scan ("archive missing").
 */
export function planImportRebase(
	stale: readonly LibraryImport[],
	occupants: ReadonlyMap<string, LibraryImport>,
	rebase: PathRebaser
): ImportRebasePlan {
	const deletes: string[] = [];
	const claimed = new Map<string, LibraryImport>(occupants);
	const moved = new Map<string, LibraryImport>();
	let conflicts = 0;

	for (const record of stale) {
		const target = rebase(record.file_path);
		if (target === null || target === record.file_path) continue;
		deletes.push(record.file_path);
		const candidate: LibraryImport = { ...record, file_path: target };
		const occupant = claimed.get(target);
		if (!occupant) {
			claimed.set(target, candidate);
			moved.set(target, candidate);
			continue;
		}
		if (occupant.volume_uuid === record.volume_uuid) continue;
		conflicts++;
		if (importedAtMs(occupant) < importedAtMs(record)) continue;
		claimed.set(target, candidate);
		moved.set(target, candidate);
	}

	return { deletes, puts: [...moved.values()], conflicts };
}

/**
 * Apply `planImportRebase` to the `library_imports` table. The caller owns the
 * transaction, so the reads and the rewrite commit or fail together. Stale
 * records are found by a prefix range on the primary key rather than a table
 * scan, which keeps a launch after the move as cheap as any other.
 */
export async function rebaseImportTable(
	table: Table<LibraryImport, string>,
	oldBases: readonly string[],
	rebase: PathRebaser
): Promise<number> {
	const byKey = new Map<string, LibraryImport>();
	for (const base of oldBases.map(normalizeBase)) {
		for (const prefix of [`${base}/`, `${base}\\`]) {
			for (const record of await table.where('file_path').startsWith(prefix).toArray()) {
				byKey.set(record.file_path, record);
			}
		}
	}
	if (byKey.size === 0) return 0;

	const stale = [...byKey.values()];
	const targets = [
		...new Set(stale.map((record) => rebase(record.file_path)).filter((target): target is string => target !== null))
	];
	const occupants = new Map<string, LibraryImport>();
	(await table.bulkGet(targets)).forEach((record, index) => {
		if (record) occupants.set(targets[index], record);
	});

	const plan = planImportRebase(stale, occupants, rebase);
	if (plan.conflicts > 0) {
		console.warn(
			`[app-data] ${plan.conflicts} import record(s) already existed at the relocated path; kept the earlier import`
		);
	}
	await table.bulkDelete(plan.deletes);
	await table.bulkPut(plan.puts);
	return plan.puts.length;
}

export type LocationRecordRead =
	| { status: 'absent' }
	| { status: 'ok'; raw: string }
	/** Could not look. Never treated as "no history": that would forget bases. */
	| { status: 'unreadable'; reason: string };

export interface AppDataRelocationPorts {
	appDataDir(): Promise<string>;
	readLocationRecord(): Promise<LocationRecordRead>;
	writeLocationRecord(contents: string): Promise<void>;
	/** Rebase every import record under `oldBases`; returns how many moved. */
	rebaseImportRecords(oldBases: readonly string[], rebase: PathRebaser): Promise<number>;
	/** Rebase the persisted library list; returns how many changed. */
	rebaseLibraries(rebase: PathRebaser): Promise<number>;
}

export interface AppDataRelocationResult {
	status: 'healed' | 'unchanged' | 'skipped';
	currentBase: string;
	/** Every earlier base this install is known to have had. */
	previousBases: string[];
	importsRebased: number;
	librariesRebased: number;
}

/**
 * One heal pass. Import records move before library paths: a library pointing
 * at the new base while its records still name the old one is exactly the
 * state that makes a scan re-import everything, so if the records cannot be
 * moved the libraries must not be either (the error propagates). The history
 * file is written last and only ever grows, so an interrupted pass simply runs
 * again next launch.
 */
export async function healAppDataPaths(ports: AppDataRelocationPorts): Promise<AppDataRelocationResult> {
	const currentBase = normalizeBase(await ports.appDataDir());
	const skipped: AppDataRelocationResult = {
		status: 'skipped',
		currentBase,
		previousBases: [],
		importsRebased: 0,
		librariesRebased: 0
	};
	if (currentBase === '') return skipped;

	const read = await ports.readLocationRecord();
	if (read.status === 'unreadable') return skipped;
	const parsed = read.status === 'ok' ? parseLocationRecord(read.raw) : [];
	// A file that exists but is not a record we wrote holds nothing usable;
	// starting a fresh history beats never recording one again.
	const history = parsed ?? [];
	const previousBases = history.filter((base) => base !== currentBase);

	let importsRebased = 0;
	let librariesRebased = 0;
	if (previousBases.length > 0) {
		const rebase = createPathRebaser(previousBases, currentBase);
		importsRebased = await ports.rebaseImportRecords(previousBases, rebase);
		librariesRebased = await ports.rebaseLibraries(rebase);
	}

	const next = rememberBase(currentBase, history);
	const unchanged = parsed !== null && next.length === history.length && next.every((base, i) => base === history[i]);
	if (!unchanged) await ports.writeLocationRecord(serializeLocationRecord(next));

	return {
		status: importsRebased > 0 || librariesRebased > 0 ? 'healed' : 'unchanged',
		currentBase,
		previousBases,
		importsRebased,
		librariesRebased
	};
}

// ── Runtime wiring ──────────────────────────────────────────────────────────

function hasTauriHost(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function tauriRelocationPorts(): Promise<AppDataRelocationPorts> {
	const fs = await import('@tauri-apps/plugin-fs');
	const { appDataDir } = await import('@tauri-apps/api/path');
	const baseDir = fs.BaseDirectory.AppData;

	return {
		appDataDir,
		async readLocationRecord() {
			let present: boolean;
			try {
				present = await fs.exists(APP_DATA_LOCATION_FILE, { baseDir });
			} catch (error) {
				return { status: 'unreadable', reason: `exists check failed: ${String(error)}` };
			}
			if (!present) return { status: 'absent' };
			try {
				return { status: 'ok', raw: await fs.readTextFile(APP_DATA_LOCATION_FILE, { baseDir }) };
			} catch (error) {
				return { status: 'unreadable', reason: `read failed: ${String(error)}` };
			}
		},
		async writeLocationRecord(contents) {
			try {
				await fs.mkdir('', { baseDir, recursive: true });
			} catch {
				// Directory likely already exists.
			}
			await fs.writeTextFile(APP_DATA_LOCATION_TEMP_FILE, contents, { baseDir });
			await fs.rename(APP_DATA_LOCATION_TEMP_FILE, APP_DATA_LOCATION_FILE, {
				oldPathBaseDir: baseDir,
				newPathBaseDir: baseDir
			});
		},
		async rebaseImportRecords(oldBases, rebase) {
			const { db } = await import('$lib/db/index.js');
			return db.transaction('rw', db.library_imports, () =>
				rebaseImportTable(db.library_imports, oldBases, rebase)
			);
		},
		async rebaseLibraries(rebase) {
			const { settings } = await import('$lib/settings/settings.js');
			let changed = 0;
			settings.update((current) => {
				const result = rebaseLibraryPaths(current.libraries, rebase);
				changed = result.changed;
				return result.changed > 0 ? { ...current, libraries: result.libraries } : current;
			});
			return changed;
		}
	};
}

let healing: Promise<void> | null = null;
let sessionRebaser: PathRebaser | null = null;

/**
 * Run the heal once per session; every later call returns the same promise.
 * Never rejects — a failure is logged and the pass retries next launch.
 * Anything that reads or writes local library paths awaits this first.
 */
export function ensureAppDataPathsHealed(): Promise<void> {
	healing ??= (async () => {
		if (!hasTauriHost()) return;
		try {
			const result = await healAppDataPaths(await tauriRelocationPorts());
			if (result.previousBases.length > 0) {
				sessionRebaser = createPathRebaser(result.previousBases, result.currentBase);
			}
			if (result.status === 'healed') {
				console.info(
					`[app-data] data directory moved; rebased ${result.librariesRebased} library path(s) and ${result.importsRebased} import record(s)`
				);
			}
		} catch (error) {
			console.error('[app-data] failed to heal paths after a data-directory move:', error);
		}
	})();
	return healing;
}

/** Move one path off an earlier base, for callers holding a pre-heal copy. */
export function rebaseStalePath(path: string): string {
	return sessionRebaser?.(path) ?? path;
}

/**
 * Rebase a library list someone captured before the heal ran (a settings
 * draft). Returns the same array when nothing moved.
 */
export function rebaseStaleLibraryPaths<T extends Library>(libraries: T[]): T[] {
	if (!sessionRebaser) return libraries;
	const result = rebaseLibraryPaths(libraries, sessionRebaser);
	return result.changed > 0 ? result.libraries : libraries;
}

/** Test seam: forget session state. */
export function resetAppDataRelocationForTests(): void {
	healing = null;
	sessionRebaser = null;
}

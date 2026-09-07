/**
 * v17 post-open migration: split legacy `volume_files` all-pages records into
 * per-page `volume_pages` rows (report L2), then sweep orphaned page rows.
 *
 * Design mirrors the proven v16 catalog migrator:
 * - resumable with no separate state: the remaining legacy records ARE the
 *   work list — a record is deleted only after its split rows are read back
 *   and validated, so a crash resumes exactly where it stopped
 * - dual-read safe: the reader prefers complete `volume_pages` sets and
 *   falls back to the legacy record, so partially-migrated libraries work
 * - pauses on insufficient storage (the split transiently doubles one
 *   volume's bytes) instead of failing
 * - a failing volume is skipped and reported, never wedging the whole
 *   migration in a retry-forever state (fixes the L6 failure mode)
 */

import { db } from './index.js';
import { isVolumeImportInFlight } from '$lib/import/import-registry.js';
import type { FumetoDB } from './schema.js';
import type { PageDimensions, VolumeFiles, VolumePageRecord } from '$lib/types/index.js';
import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';
import { naturalCompare } from '$lib/util/natural-sort.js';
import { distinctKeys } from './unique-keys.js';

export interface VolumePagesMigrationOptions {
	signal?: AbortSignal;
	/** Injectable for tests; defaults to `navigator.storage.estimate()`. */
	storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
	/** Yield between volumes so the UI thread breathes. */
	yieldControl?: () => Promise<void>;
}

export interface VolumePagesMigrationResult {
	status: 'complete' | 'paused' | 'cancelled';
	migratedVolumes: number;
	sweptOrphanRows: number;
	failures: Array<{ volumeUuid: string; error: string }>;
}

const SPACE_SAFETY_FACTOR = 1.1;

function defaultYield(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function hasEnoughSpace(
	record: VolumeFiles,
	estimate?: () => Promise<{ usage?: number; quota?: number }>
): Promise<boolean> {
	const estimator = estimate
		?? (typeof navigator !== 'undefined' && navigator.storage?.estimate
			? () => navigator.storage.estimate()
			: undefined);
	if (!estimator) return true;
	try {
		const { usage, quota } = await estimator();
		if (usage === undefined || quota === undefined) return true;
		const requiredBytes = Object.values(record.files)
			.reduce((sum, file) => sum + (file?.size ?? 0), 0) * SPACE_SAFETY_FACTOR;
		return quota - usage >= requiredBytes;
	} catch {
		return true;
	}
}

/**
 * Page order: page_dimensions is authoritative when present (it is what the
 * reader displayed); otherwise the shared natural-sort of filenames — the
 * exact ordering the legacy LocalPageSource used.
 */
export function orderLegacyPages(
	record: VolumeFiles,
	dimensions: PageDimensions | undefined
): Array<{ filename: string; file: File }> {
	const orderedFromDimensions = dimensions?.pages
		?.slice()
		.sort((a, b) => a.index - b.index)
		.map((page) => page.filename)
		.filter((filename) => record.files[filename] !== undefined);
	const filenames = orderedFromDimensions?.length === Object.keys(record.files).length
		? orderedFromDimensions
		: Object.keys(record.files).sort(naturalCompare);
	return filenames.map((filename) => ({ filename, file: record.files[filename] }));
}

async function migrateOneVolume(
	database: FumetoDB,
	volumeUuid: string,
	record: VolumeFiles,
	dimensions: PageDimensions | undefined
): Promise<void> {
	const ordered = orderLegacyPages(record, dimensions);
	const rows: VolumePageRecord[] = ordered.map((page, index) => ({
		volume_uuid: volumeUuid,
		page_index: index,
		filename: page.filename,
		file: page.file
	}));

	await database.transaction('rw', [database.volume_pages], async () => {
		// Clear partial rows from an interrupted earlier attempt, then write.
		await database.volume_pages.where('volume_uuid').equals(volumeUuid).delete();
		await database.volume_pages.bulkPut(rows);
	});

	// Read-back validation OUTSIDE the write transaction (v16's pattern):
	// only a persisted, complete, size-matching copy justifies deleting the
	// legacy record.
	const persisted = await database.volume_pages
		.where('volume_uuid').equals(volumeUuid).sortBy('page_index');
	if (persisted.length !== rows.length) {
		throw new Error(`Split wrote ${persisted.length} of ${rows.length} pages`);
	}
	for (let i = 0; i < rows.length; i++) {
		if (persisted[i].filename !== rows[i].filename
			|| persisted[i].file.size !== rows[i].file.size) {
			throw new Error(`Split validation mismatch at page ${i}`);
		}
	}

	await database.volume_files.delete(volumeUuid);
}

/**
 * Delete volume_pages rows whose volume no longer exists (crashed fresh
 * imports), and any provisional reimport rows ("<uuid>!reimport") left behind.
 *
 * Those provisional rows used to be kept whenever their base volume still
 * existed, on the reasoning that a reimport might be in flight and that every
 * reimport clears its own provisional rows before streaming. The first half is
 * covered by `isVolumeImportInFlight` below — a reimport registers under the
 * BASE uuid, which is exactly what the guard checks, and this sweep runs at
 * startup where nothing can be in flight from a previous session. The second
 * half only cleans up if the user reimports that same volume again, which may
 * never happen — so a reimport that died mid-stream left a complete duplicate
 * page set, potentially hundreds of MB, sitting indefinitely.
 *
 * A *fresh* import is ownerless for its whole duration: it streams page rows
 * first and writes the `volumes` record last, so "no volume record" alone does
 * not mean "garbage". `isVolumeImportInFlight` distinguishes the two, and
 * skipping those uuids is what stops the startup sweep from emptying a volume
 * that is still being imported (the first-run sample seed hit this every time).
 */
export async function sweepOrphanVolumePages(
	database: FumetoDB = db,
	isImportInFlight: (volumeUuid: string) => boolean = isVolumeImportInFlight
): Promise<number> {
	const pageOwners = await distinctKeys<string>(database.volume_pages.orderBy('volume_uuid'));
	let swept = 0;
	for (const owner of pageOwners) {
		const baseUuid = owner.split('!')[0];
		if (isImportInFlight(baseUuid)) continue;
		// A `!reimport` staging key belongs to a reimport that died mid-stream:
		// the base volume still exists, so the old `volumes.get` guard skipped
		// it and a complete duplicate page set — potentially hundreds of MB —
		// sat there until the volume itself was deleted. The in-flight check
		// above is what makes this safe: a live reimport is never swept.
		if (owner !== baseUuid) {
			swept += await database.volume_pages.where('volume_uuid').equals(owner).delete();
			continue;
		}
		if (await database.volumes.get(baseUuid) !== undefined) continue;
		swept += await database.volume_pages.where('volume_uuid').equals(owner).delete();
	}
	return swept;
}

export async function migrateVolumeFilesToPages(
	database: FumetoDB = db,
	options: VolumePagesMigrationOptions = {}
): Promise<VolumePagesMigrationResult> {
	const yieldControl = options.yieldControl ?? defaultYield;
	const failures: VolumePagesMigrationResult['failures'] = [];
	let migratedVolumes = 0;

	const legacyKeys = (await database.volume_files.toCollection().primaryKeys()) as string[];
	for (const volumeUuid of legacyKeys) {
		if (options.signal?.aborted) {
			return { status: 'cancelled', migratedVolumes, sweptOrphanRows: 0, failures };
		}
		try {
			const record = await database.volume_files.get(volumeUuid);
			if (!record) continue; // deleted concurrently
			const volume = await database.volumes.get(volumeUuid);
			if (!volume) {
				// Legacy record without a volume: stale garbage, not migratable.
				await database.volume_files.delete(volumeUuid);
				continue;
			}
			if (!(await hasEnoughSpace(record, options.storageEstimate))) {
				console.warn('[VolumePagesMigration] paused: insufficient storage for', volumeUuid);
				return { status: 'paused', migratedVolumes, sweptOrphanRows: 0, failures };
			}
			const dimensions = await database.page_dimensions.get(volumeUuid);
			await migrateOneVolume(database, volumeUuid, record, dimensions);
			migratedVolumes++;
		} catch (error) {
			// Skip and continue — one bad volume must not wedge the migration.
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[VolumePagesMigration] skipping ${volumeUuid}: ${message}`);
			failures.push({ volumeUuid, error: message });
		}
		await yieldControl();
	}

	const sweptOrphanRows = await sweepOrphanVolumePages(database);
	if (migratedVolumes > 0 || sweptOrphanRows > 0) {
		console.info(
			`[VolumePagesMigration] complete: ${migratedVolumes} volumes split, ${sweptOrphanRows} orphan rows swept`
		);
	}
	return { status: 'complete', migratedVolumes, sweptOrphanRows, failures };
}

/** Start after first usable paint, on the maintenance lane (v16's pattern). */
export function scheduleVolumePagesMigration(database: FumetoDB = db): () => void {
	const controller = new AbortController();
	const start = () => {
		void appWorkCoordinator.submit({
			kind: 'volume-pages-v17-migration',
			owner: 'persistence',
			lane: 'indexeddb-maintenance',
			priority: 3,
			coalescingKey: 'volume-pages-v17-migration',
			signal: controller.signal,
			operation: ({ signal }) => migrateVolumeFilesToPages(database, { signal })
		}).promise.catch((error) => {
			if (error instanceof Error && error.name === 'AbortError') return;
			console.warn('[VolumePagesMigration] failed:', error);
		});
	};
	if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 4_000 });
	else setTimeout(start, 0);
	return () => controller.abort('app destroyed');
}

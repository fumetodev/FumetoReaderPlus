/**
 * YACReader metadata synchronization and lazy cover hydration.
 *
 * Folder browsing commits only the metadata needed to render and navigate. Comic
 * covers are intentionally hydrated on demand; a full sync may hydrate them in a
 * separate bounded phase. Per-library generations prevent stale work from
 * writing after cleanup or after a newer forced sync supersedes it.
 */

import type { UserMessage } from '$lib/i18n/user-messages.js';
import { db } from '$lib/db/index.js';
import { randomUUID } from '$lib/util/uuid.js';
import type {
	VolumeMetadata,
	VolumeSource,
	PageDimensions,
	PageInfo,
	RemoteFolder,
	YacIndexPhase,
	CatalogIndexState
} from '$lib/types/index.js';
import type { YACServerClient } from './yac-server-client.js';
import { YACServerError, type YACComic, type YACFolder, type YACFolderContentItem } from './yac-types.js';
import { appWorkCoordinator, type WorkPriority } from '$lib/work-coordination/work-coordinator.js';
import {
	folderCoverAssetId,
	makeMediaAsset,
	bulkPutRemoteFolders,
	putRemoteFolder,
	toCatalogRow,
	volumeThumbnailAsset,
	volumeThumbnailAssetId,
	volumeWithoutEmbeddedMedia,
	deleteVolumeRowsInTransaction,
	markRemoteIndexComplete,
	volumeScopedTables
} from '$lib/catalog/catalog-repository.js';
import {
	beginRemoteLibraryCleanup,
	getLibraryGeneration,
	invalidateLibrarySync,
	isLibraryCleanupPending,
	onRemoteLibraryCleanupReleased
} from '$lib/catalog/remote-library-fence.js';

const VOLUME_THUMBNAIL_MAX_SIZE = 512;
const THUMBNAIL_JPEG_QUALITY = 0.92;
const DEFAULT_COVER_CONCURRENCY = 3;
const RECONCILE_BATCH_SIZE = 100;
/** Version 2 stores the original server image instead of a 384 px derivative. */
export const YAC_FOLDER_COVER_CACHE_VERSION = 2;

export interface SyncFailure {
	stage: 'folder' | 'metadata' | 'cover';
	itemId: string;
	message: string;
}

export interface SyncDiagnostics {
	status: 'complete' | 'partial';
	librarySettingsId: string;
	foldersVisited: number;
	comicsDiscovered: number;
	comicsReconciled: number;
	newComicCount: number;
	coversRequested: number;
	coversHydrated: number;
	failures: SyncFailure[];
}

export interface SyncProgress {
	stage: 'scanning' | 'importing' | 'covers' | 'done';
	current: number;
	total: number;
	/** What to show for this step, rendered by the caller in the live locale. */
	message: UserMessage;
	diagnostics?: SyncDiagnostics;
}

export interface FullSyncOptions {
	/** Supersede an active/queued older generation for this configured library. */
	force?: boolean;
	/** Set false for a metadata-only recursive sync. Defaults to true. */
	hydrateCovers?: boolean;
	/** Bounds fetch/decode workers. Values are clamped to 1..8. */
	coverConcurrency?: number;
	/** Injected deterministic source for stable descendant-cover tests. */
	random?: () => number;
	/** Skip update negotiation for startup repair-only work. */
	requestServerUpdate?: boolean;
	/** Test/adapter override; production defaults to one second. */
	updatePollIntervalMs?: number;
}

/**
 * Launch-time crawl policy. Once the initial index is complete there is NO
 * automatic re-crawl (user decision): folder browsing hydrates whatever is
 * visited and manual Scan is the explicit re-index. When the crawl does run
 * (absent or interrupted index) it must be quiet — no server-side disk rescan,
 * no bulk cover flood; manual Scan keeps both behaviours.
 */
/**
 * Should this remote library be crawled at startup?
 *
 * The project's contract is that manual Scan is the only refresh for a remote
 * library. YACReader honoured it through this gate; Komga and Kavita had no
 * equivalent and re-crawled on every launch — for a 500-series Komga library
 * that is one series list plus 500 sequential book requests, roughly fifty
 * seconds of traffic and five hundred folder writes, every cold start, against
 * a library that was already indexed.
 *
 * `completeness` cannot answer this: the catalog migration writes 'ready' for
 * any library that has rows, so it means "the v16 projection finished". The
 * stamp below is written only by a crawl that completed with no failures, so a
 * partial sync correctly runs again.
 */
export function remoteStartupSyncPlan(
	state: { remote_index_completed_at?: string } | undefined
): { run: boolean; options: FullSyncOptions } {
	return {
		run: !state?.remote_index_completed_at,
		options: { requestServerUpdate: false, hydrateCovers: false }
	};
}

export interface FullSyncResult extends SyncDiagnostics {}

export interface BrowseResult {
	folders: RemoteFolder[];
	volumes: VolumeMetadata[];
	newComicCount: number;
	diagnostics: SyncDiagnostics;
}

export interface CoverHydrationResult {
	status: 'cached' | 'hydrated' | 'missing' | 'stale' | 'failed';
	volumeUuid: string;
	comicHash?: string;
	error?: string;
}

export class SyncInvalidatedError extends Error {
	constructor(readonly librarySettingsId: string) {
		super(`YACReader sync for ${librarySettingsId} was superseded`);
		this.name = 'SyncInvalidatedError';
	}
}

// Re-exported so the existing YACReader-flavoured call sites keep working.
// New code should reach for `$lib/catalog/remote-library-fence.js` directly —
// the fence is not YACReader's, it just grew here.
export { beginRemoteLibraryCleanup, invalidateLibrarySync };

// ============================================================
// Per-library operation ordering and invalidation
// ============================================================

const pendingLibraryTasks = new Map<string, Set<string>>();
const lastDiagnostics = new Map<string, SyncDiagnostics>();

// The generation counter and the cleanup-pending set now live in
// `catalog/remote-library-fence.ts`, shared with Komga and Kavita. They were
// born here and only ever read here, which is how `deleteLibraryData` came to
// call the fence for all three providers while protecting exactly one.
const cleanupPending = {
	has: (librarySettingsId: string) => isLibraryCleanupPending(librarySettingsId)
};

// Diagnostics are this module's own per-library memo, so they are dropped
// through the fence's release hook rather than by the fence itself.
onRemoteLibraryCleanupReleased((librarySettingsId) => {
	lastDiagnostics.delete(librarySettingsId);
});

const volumeCoverHydrations = new Map<string, Promise<CoverHydrationResult>>();
const folderCoverHydrations = new Map<string, Promise<string | undefined>>();

export function isSyncInProgress(): boolean {
	return [...pendingLibraryTasks.values()].some((tasks) => tasks.size > 0);
}

export function isLibrarySyncInProgress(librarySettingsId: string): boolean {
	return (pendingLibraryTasks.get(librarySettingsId)?.size ?? 0) > 0;
}

function assertCurrentGeneration(librarySettingsId: string, generation: number): void {
	if (getLibraryGeneration(librarySettingsId) !== generation) {
		throw new SyncInvalidatedError(librarySettingsId);
	}
}

function enqueueLibrarySync<T>(
	librarySettingsId: string,
	operation: (signal?: AbortSignal) => Promise<T>,
	options: { kind?: string; priority?: WorkPriority; coalescingKey?: string; signal?: AbortSignal } = {}
): Promise<T> {
	const handle = appWorkCoordinator.submit({
		kind: options.kind ?? 'yac-library-work',
		owner: 'yacreader',
		lane: `yac-index:${librarySettingsId}:${(options.priority ?? 2) <= 1 ? 'foreground' : 'maintenance'}`,
		priority: options.priority ?? 2,
		coalescingKey: options.coalescingKey,
		// The subscriber signal cancels through the coordinator; the operation
		// receives the task's own context signal so it can stop between batches
		// and release the capacity-1 lane instead of finishing abandoned work.
		signal: options.signal,
		operation: ({ signal }) => operation(signal)
	});
	let tasks = pendingLibraryTasks.get(librarySettingsId);
	if (!tasks) {
		tasks = new Set();
		pendingLibraryTasks.set(librarySettingsId, tasks);
	}
	tasks.add(handle.id);
	return handle.promise.finally(() => {
		const current = pendingLibraryTasks.get(librarySettingsId);
		current?.delete(handle.id);
		if (current?.size === 0) pendingLibraryTasks.delete(librarySettingsId);
	});
}

export interface YacIndexStatusSnapshot {
	librarySettingsId: string;
	status: YacIndexPhase;
	foldersVisited: number;
	entriesDiscovered: number;
	entriesReconciled: number;
	checkpoint?: CatalogIndexState['checkpoint'];
	lastSuccessAt?: string;
	recoverableError?: string;
}

const indexStatuses = new Map<string, YacIndexStatusSnapshot>();
const indexStatusListeners = new Set<(status: YacIndexStatusSnapshot) => void>();

export function getYacIndexStatus(librarySettingsId: string): YacIndexStatusSnapshot {
	return indexStatuses.get(librarySettingsId) ?? {
		librarySettingsId,
		status: 'idle',
		foldersVisited: 0,
		entriesDiscovered: 0,
		entriesReconciled: 0
	};
}

export function subscribeYacIndexStatus(
	listener: (status: YacIndexStatusSnapshot) => void
): () => void {
	indexStatusListeners.add(listener);
	return () => indexStatusListeners.delete(listener);
}

async function publishIndexStatus(
	librarySettingsId: string,
	changes: Partial<Omit<YacIndexStatusSnapshot, 'librarySettingsId'>>
): Promise<void> {
	const next = { ...getYacIndexStatus(librarySettingsId), ...changes, librarySettingsId };
	indexStatuses.set(librarySettingsId, next);
	for (const listener of indexStatusListeners) listener({ ...next });
	const table = (db as unknown as { catalog_index_state?: typeof db.catalog_index_state }).catalog_index_state;
	if (!table?.get || !table?.put) return;
	try {
		const existing = await table.get(librarySettingsId);
		await table.put({
			library_id: librarySettingsId,
			provider: 'yacreader',
			completeness: next.status === 'ready' ? 'ready' : existing?.completeness ?? 'migrating',
			generation: existing?.generation ?? getLibraryGeneration(librarySettingsId),
			checkpoint: next.checkpoint ?? existing?.checkpoint,
			status: next.status,
			folders_visited: next.foldersVisited,
			entries_discovered: next.entriesDiscovered,
			entries_reconciled: next.entriesReconciled,
			last_success_at: next.lastSuccessAt ?? existing?.last_success_at,
			// Written only by markRemoteIndexComplete; this writer must not drop it.
			remote_index_completed_at: existing?.remote_index_completed_at,
			updated_at: new Date().toISOString(),
			recoverable_error: next.recoverableError,
			server_update_supported: existing?.server_update_supported,
			server_update_running: next.status === 'server-updating'
		});
	} catch (error) {
		console.debug('[YACSync] Unable to persist index status:', error);
	}
}

/** Last completed/partial diagnostic snapshot for UI and support tooling. */
export function getLastSyncDiagnostics(librarySettingsId: string): SyncDiagnostics | undefined {
	const value = lastDiagnostics.get(librarySettingsId);
	return value ? { ...value, failures: value.failures.map((failure) => ({ ...failure })) } : undefined;
}

function emptyDiagnostics(librarySettingsId: string): SyncDiagnostics {
	return {
		status: 'complete',
		librarySettingsId,
		foldersVisited: 0,
		comicsDiscovered: 0,
		comicsReconciled: 0,
		newComicCount: 0,
		coversRequested: 0,
		coversHydrated: 0,
		failures: []
	};
}

function finishDiagnostics(diagnostics: SyncDiagnostics): SyncDiagnostics {
	diagnostics.status = diagnostics.failures.length === 0 ? 'complete' : 'partial';
	lastDiagnostics.set(diagnostics.librarySettingsId, {
		...diagnostics,
		failures: diagnostics.failures.map((failure) => ({ ...failure }))
	});
	return diagnostics;
}

function failure(stage: SyncFailure['stage'], itemId: string, error: unknown): SyncFailure {
	return {
		stage,
		itemId,
		message: error instanceof Error ? error.message : String(error)
	};
}

function rethrowIfInvalidated(error: unknown): void {
	if (error instanceof SyncInvalidatedError) throw error;
}

// ============================================================
// Full sync
// ============================================================

/** Compatibility entry point: returns the number of newly imported comics. */
export async function fullSyncLibrary(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: FullSyncOptions = {}
): Promise<number> {
	const result = await scheduleFullSync(
		client,
		librarySettingsId,
		remoteLibraryId,
		serverUrl,
		onProgress,
		options
	);
	return result.newComicCount;
}

/** Detailed entry point for callers that need partial-failure diagnostics. */
export function fullSyncLibraryDetailed(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: FullSyncOptions = {}
): Promise<FullSyncResult> {
	return scheduleFullSync(client, librarySettingsId, remoteLibraryId, serverUrl, onProgress, options);
}

function scheduleFullSync(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	serverUrl: string,
	onProgress: ((progress: SyncProgress) => void) | undefined,
	options: FullSyncOptions
): Promise<FullSyncResult> {
	if (options.force) invalidateLibrarySync(librarySettingsId);
	const generation = getLibraryGeneration(librarySettingsId);
	return enqueueLibrarySync(librarySettingsId, async () => {
		try {
			if (options.requestServerUpdate !== false) {
				await negotiateServerUpdate(
					client, librarySettingsId, remoteLibraryId, generation, onProgress,
					options.updatePollIntervalMs ?? 1_000
				);
			}
			return await _fullSyncLibrary(
				client,
				librarySettingsId,
				remoteLibraryId,
				serverUrl,
				generation,
				onProgress,
				options
			);
		} catch (error) {
			const cancelled = error instanceof SyncInvalidatedError;
			await publishIndexStatus(librarySettingsId, {
				status: cancelled ? 'cancelled' : 'error',
				recoverableError: error instanceof Error ? error.message : String(error)
			});
			throw error;
		}
	}, {
		kind: 'yac-scan-sync',
		priority: 2,
		coalescingKey: `full-sync:${generation}`
	});
}

async function negotiateServerUpdate(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	generation: number,
	onProgress: ((progress: SyncProgress) => void) | undefined,
	pollIntervalMs: number
): Promise<void> {
	assertCurrentGeneration(librarySettingsId, generation);
	if (typeof client.requestLibraryUpdate !== 'function') return;
	await publishIndexStatus(librarySettingsId, { status: 'server-updating', recoverableError: undefined });
	onProgress?.({ stage: 'scanning', current: 0, total: 0, message: { code: 'sync_yac_requesting_update' } });
	let result;
	try {
		result = await client.requestLibraryUpdate(remoteLibraryId);
	} catch (error) {
		// A reachable server may forbid update requests. Treat 403/405 as a
		// capability outcome so the local non-destructive crawl can still run.
		if (error instanceof YACServerError && (error.statusCode === 403 || error.statusCode === 405)) {
			await persistServerCapability(librarySettingsId, false, false);
			await publishIndexStatus(librarySettingsId, {
				status: 'idle',
				recoverableError: 'Server update is not allowed; reconciling the cached server library instead.'
			});
			return;
		}
		throw error;
	}
	assertCurrentGeneration(librarySettingsId, generation);
	if (!result.supported || result.status === 'update_not_allowed') {
		await persistServerCapability(librarySettingsId, result.supported, false);
		await publishIndexStatus(librarySettingsId, {
			status: 'idle',
			recoverableError: result.supported
				? 'Server update is disabled; local reconciliation continued.'
				: 'This YACReader server does not expose remote update; local reconciliation continued.'
		});
		return;
	}
	await persistServerCapability(librarySettingsId, true, result.running);
	if (!result.running || typeof client.getLibraryUpdateStatus !== 'function') return;

	for (;;) {
		assertCurrentGeneration(librarySettingsId, generation);
		// Poll delays do not occupy the serialized HTTP transport lane.
		await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, pollIntervalMs)));
		const status = await client.getLibraryUpdateStatus();
		assertCurrentGeneration(librarySettingsId, generation);
		if (!status.supported || !status.running) {
			await persistServerCapability(librarySettingsId, status.supported, false);
			return;
		}
		await publishIndexStatus(librarySettingsId, { status: 'server-updating' });
	}
}

async function persistServerCapability(
	librarySettingsId: string,
	supported: boolean,
	running: boolean
): Promise<void> {
	const table = (db as unknown as { catalog_index_state?: typeof db.catalog_index_state }).catalog_index_state;
	if (!table?.get || !table?.put) return;
	const existing = await table.get(librarySettingsId);
	if (!existing) return;
	await table.put({
		...existing,
		server_update_supported: supported,
		server_update_running: running,
		updated_at: new Date().toISOString()
	});
}

async function _fullSyncLibrary(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	serverUrl: string,
	generation: number,
	onProgress: ((progress: SyncProgress) => void) | undefined,
	options: FullSyncOptions
): Promise<FullSyncResult> {
	const diagnostics = emptyDiagnostics(librarySettingsId);
	const allComics: { comic: YACComic; parentFolderId: string; ancestorFolderIds: string[] }[] = [];
	const visited = new Set<string>();
	const seenFolderIds = new Set<string>();
	await publishIndexStatus(librarySettingsId, {
		status: 'crawling', foldersVisited: 0, entriesDiscovered: 0,
		entriesReconciled: 0, checkpoint: { pending_folder_ids: ['1'], visited_folder_ids: [] }
	});
	onProgress?.({ stage: 'scanning', current: 0, total: 0, message: { code: 'sync_scanning_folders' } });

	async function walkFolder(folderId: string, ancestorFolderIds: string[]): Promise<void> {
		assertCurrentGeneration(librarySettingsId, generation);
		if (visited.has(folderId)) return;
		visited.add(folderId);

		let items: YACFolderContentItem[];
		try {
			items = await client.fetchFolderContent(remoteLibraryId, folderId, {
				priority: 3,
				owner: 'yac-index'
			});
			assertCurrentGeneration(librarySettingsId, generation);
			diagnostics.foldersVisited++;
		} catch (error) {
			rethrowIfInvalidated(error);
			diagnostics.failures.push(failure('folder', folderId, error));
			console.warn(`[YACSync] Failed to fetch folder ${folderId}:`, error);
			return;
		}

		for (const item of items) {
			assertCurrentGeneration(librarySettingsId, generation);
			if (item.type === 'folder') {
				seenFolderIds.add(String(item.id));
				try {
					await upsertRemoteFolder(
						item,
						librarySettingsId,
						remoteLibraryId,
						folderId,
						generation
					);
				} catch (error) {
					rethrowIfInvalidated(error);
					diagnostics.failures.push(failure('folder', item.id, error));
				}
				await walkFolder(item.id, [...ancestorFolderIds, String(item.id)]);
			} else {
				allComics.push({ comic: item, parentFolderId: folderId, ancestorFolderIds });
			}
		}

		diagnostics.comicsDiscovered = allComics.length;
		onProgress?.({
			stage: 'scanning',
			current: allComics.length,
			total: 0,
			message: { code: 'sync_found_comics', params: { n: allComics.length } }
		});
		if (diagnostics.foldersVisited % 100 === 0 || (allComics.length > 0 && allComics.length % 500 === 0)) {
			await publishIndexStatus(librarySettingsId, {
				status: 'crawling',
				foldersVisited: diagnostics.foldersVisited,
				entriesDiscovered: allComics.length,
				checkpoint: { visited_folder_ids: [...visited], pending_folder_ids: [] }
			});
		}
	}

	await walkFolder('1', []);
	assertCurrentGeneration(librarySettingsId, generation);
	if (typeof client.fetchFolderInfo === 'function') {
		try {
			const recursiveInfo = await client.fetchFolderInfo(remoteLibraryId, '1');
			if (recursiveInfo) {
				const infoComicIds = new Set(
					recursiveInfo.filter((item): item is YACComic => item.type === 'comic').map((item) => String(item.id))
				);
				const crawledComicIds = new Set(allComics.map(({ comic }) => String(comic.id)));
				if (infoComicIds.size !== crawledComicIds.size || [...infoComicIds].some((id) => !crawledComicIds.has(id))) {
					diagnostics.failures.push({
						stage: 'metadata', itemId: 'recursive-folder-info',
						message: 'Recursive folder inventory did not match the completed hierarchy crawl',
					});
				}
			}
		} catch (error) {
			diagnostics.failures.push(failure('metadata', 'recursive-folder-info', error));
		}
	}
	await reconcileDescendantFolderCovers(librarySettingsId, allComics, options.random ?? Math.random);
	await publishIndexStatus(librarySettingsId, {
		status: 'reconciling',
		foldersVisited: diagnostics.foldersVisited,
		entriesDiscovered: allComics.length
	});

	const existingByRemoteId = await loadRemoteVolumesById(librarySettingsId);
	const reconciledVolumes: VolumeMetadata[] = [];
	let processed = 0;
	const seenComicIds = new Set<string>();
	for (let offset = 0; offset < allComics.length; offset += RECONCILE_BATCH_SIZE) {
		const batch = allComics.slice(offset, offset + RECONCILE_BATCH_SIZE);
		await db.transaction('rw', [db.volumes, db.page_dimensions, db.catalog_rows, db.media_assets], async () => {
			// Read this batch's rows FRESH, inside the transaction. The
			// library-wide snapshot above is taken before the loop starts, and
			// the loop yields between batches so the UI stays usable during a
			// long crawl — so a comic read during the user's own Scan had its
			// progress written by the reader and then overwritten from a
			// pre-Scan snapshot by a whole-record put. The browse path documents
			// this hazard on remoteVolumeIdentity and already solves it the same
			// way: the snapshot is for IDENTITY (a comic that moved folders must
			// keep its uuid), never for row data. A bulkGet of ≤100 keys per
			// batch does not reintroduce the per-comic read the 13k work removed.
			const batchUuids = batch
				.map(({ comic }) => existingByRemoteId.get(String(comic.id))?.volume_uuid)
				.filter((uuid): uuid is string => Boolean(uuid));
			const freshRows = new Map<string, VolumeMetadata>();
			if (batchUuids.length > 0) {
				for (const row of await db.volumes.bulkGet(batchUuids)) {
					if (row) freshRows.set(row.volume_uuid, row);
				}
			}
			for (const { comic, parentFolderId } of batch) {
				assertCurrentGeneration(librarySettingsId, generation);
				const remoteId = String(comic.id);
				seenComicIds.add(remoteId);
				const identity = existingByRemoteId.get(remoteId);
				const existing = identity ? freshRows.get(identity.volume_uuid) ?? identity : undefined;
				const isNew = !existing;
				// One publication per durable batch avoids making a large index
				// reconciliation compete with thousands of Svelte DOM updates.
				if (processed === offset) {
					onProgress?.({
						stage: 'importing',
						current: processed,
						total: allComics.length,
						message: { code: isNew ? 'sync_importing_item' : 'sync_updating_item', params: { name: comic.file_name, index: processed + 1, total: allComics.length } }
					});
				}

				try {
					const reconciled = await upsertRemoteVolumeMetadata(
						comic,
						librarySettingsId,
						serverUrl,
						remoteLibraryId,
						parentFolderId,
						existing,
						generation,
						true
					);
					existingByRemoteId.set(remoteId, reconciled);
					reconciledVolumes.push(reconciled);
					diagnostics.comicsReconciled++;
					if (isNew) diagnostics.newComicCount++;
				} catch (error) {
					rethrowIfInvalidated(error);
					diagnostics.failures.push(failure('metadata', remoteId, error));
					console.warn(`[YACSync] Failed to reconcile comic ${comic.file_name}:`, error);
				} finally {
					processed++;
				}
			}
		});
		if (processed % 500 === 0 || processed === allComics.length) {
			await publishIndexStatus(librarySettingsId, {
				status: 'reconciling', entriesReconciled: diagnostics.comicsReconciled
			});
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	// Destructive reconciliation is legal only after every folder and metadata
	// operation in this generation completed successfully.
	if (diagnostics.failures.length === 0) {
		await pruneCompleteYacTraversal(librarySettingsId, seenComicIds, seenFolderIds);
		// The startup gate reads this. Only a clean crawl stamps it, so a partial
		// sync correctly runs again next launch.
		await markRemoteIndexComplete(librarySettingsId, 'yacreader');
	}

	if (options.hydrateCovers !== false) {
		const coverTargets = reconciledVolumes.filter((volume) =>
			volume.source?.type === 'yacreader'
			&& Boolean(volume.source.comicHash)
			&& !volume.thumbnail
		);
		diagnostics.coversRequested = coverTargets.length;
		const concurrency = Math.max(1, Math.min(8, Math.floor(options.coverConcurrency ?? DEFAULT_COVER_CONCURRENCY)));
		let coverProcessed = 0;
		onProgress?.({
			stage: 'covers',
			current: 0,
			total: coverTargets.length,
			message: { code: 'sync_hydrating_covers', params: { n: coverTargets.length } }
		});

		await mapWithConcurrency(coverTargets, concurrency, async (volume) => {
			const result = await hydrateRemoteVolumeCoverAtGeneration(client, volume, generation);
			coverProcessed++;
			if (result.status === 'hydrated' || result.status === 'cached') {
				diagnostics.coversHydrated++;
			} else if (result.status === 'failed') {
				diagnostics.failures.push({
					stage: 'cover',
					itemId: volume.volume_uuid,
					message: result.error ?? 'Cover hydration failed'
				});
			}
			onProgress?.({
				stage: 'covers',
				current: coverProcessed,
				total: coverTargets.length,
				message: { code: 'sync_hydrated_covers', params: { done: coverProcessed, total: coverTargets.length } }
			});
		});
		assertCurrentGeneration(librarySettingsId, generation);
	}

	finishDiagnostics(diagnostics);
	await publishIndexStatus(librarySettingsId, {
		status: diagnostics.status === 'complete' ? 'ready' : 'error',
		foldersVisited: diagnostics.foldersVisited,
		entriesDiscovered: diagnostics.comicsDiscovered,
		entriesReconciled: diagnostics.comicsReconciled,
		lastSuccessAt: diagnostics.status === 'complete' ? new Date().toISOString() : undefined,
		recoverableError: diagnostics.status === 'partial'
			? `${diagnostics.failures.length} crawl item(s) failed; stale records were retained.`
			: undefined,
		checkpoint: { visited_folder_ids: [...visited], pending_folder_ids: [] }
	});
	const partial = diagnostics.status === 'partial';
	onProgress?.({
		stage: 'done',
		current: diagnostics.newComicCount,
		total: diagnostics.comicsDiscovered,
		message: partial
			? { code: 'sync_incomplete_items', params: { n: diagnostics.failures.length } }
			: { code: 'sync_complete_comics', params: { n: diagnostics.newComicCount } },
		diagnostics
	});
	return diagnostics;
}

// ============================================================
// Browse mode — metadata only
// ============================================================

export function fetchRemoteFolderContents(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	folderId: string,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: { manual?: boolean; signal?: AbortSignal } = {}
): Promise<BrowseResult> {
	const generation = getLibraryGeneration(librarySettingsId);
	// A manual Scan must never coalesce onto an in-flight *passive* hydration of
	// the same folder: the press means "refresh now", and the passive task's data
	// predates it. Distinct kind + key give the press its own fresh fetch while
	// passive navigation keeps deduplicating against itself as before.
	return enqueueLibrarySync(librarySettingsId, (signal) =>
		_fetchRemoteFolderContents(
			client,
			librarySettingsId,
			remoteLibraryId,
			folderId,
			serverUrl,
			generation,
			onProgress,
			// Pruning is a manual-Scan behaviour: passive navigation hydration
			// must stay read-mostly against a single-threaded server, and a
			// deletion pass on every folder visit would be both slow and
			// surprising.
			{ prune: options.manual === true, signal }
		), options.manual
			? {
				kind: 'yac-manual-folder-sync',
				priority: 1,
				coalescingKey: `manual:${folderId}`,
				signal: options.signal
			}
			: {
				kind: 'yac-visible-folder',
				priority: 1,
				coalescingKey: `browse:${folderId}`,
				signal: options.signal
			});
}

async function _fetchRemoteFolderContents(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	folderId: string,
	serverUrl: string,
	generation: number,
	onProgress?: (progress: SyncProgress) => void,
	options: { prune?: boolean; signal?: AbortSignal } = {}
): Promise<BrowseResult> {
	const diagnostics = emptyDiagnostics(librarySettingsId);
	// A navigation that moved on genuinely stops this work: the check runs
	// between phases and between write batches (never inside a transaction), so
	// the capacity-1 lane frees within one batch instead of finishing a folder
	// nobody is looking at.
	const throwIfAborted = () => {
		if (options.signal?.aborted) {
			throw new DOMException('Folder browse superseded by navigation', 'AbortError');
		}
	};
	onProgress?.({ stage: 'scanning', current: 0, total: 0, message: { code: 'sync_fetching_folder' } });

	let items: YACFolderContentItem[];
	try {
		items = await client.fetchFolderContent(remoteLibraryId, folderId, { signal: options.signal });
		assertCurrentGeneration(librarySettingsId, generation);
		diagnostics.foldersVisited = 1;
	} catch (error) {
		rethrowIfInvalidated(error);
		diagnostics.failures.push(failure('folder', folderId, error));
		finishDiagnostics(diagnostics);
		throw error;
	}

	// Sibling folders commit as ONE bulk write. Row-by-row upserts made every
	// put re-fire the catalog liveQuery — at 664 root folders, hundreds of full
	// re-queries and 664-item re-sorts for a single navigation.
	throwIfAborted();
	const folderItems = items.filter((item): item is YACFolder => item.type === 'folder');
	const comics = items.filter((item): item is YACComic => item.type !== 'folder');
	const folders: RemoteFolder[] = [];
	if (folderItems.length > 0) {
		const existingRows = await db.remote_folders.bulkGet(
			folderItems.map((item) => `${librarySettingsId}:${item.id}`)
		);
		assertCurrentGeneration(librarySettingsId, generation);
		const orphanedAssetIds: string[] = [];
		for (let index = 0; index < folderItems.length; index += 1) {
			const prepared = prepareRemoteFolderUpsert(
				folderItems[index], librarySettingsId, remoteLibraryId, folderId, existingRows[index]
			);
			folders.push(prepared.entry);
			if (prepared.orphanedCoverAssetId) orphanedAssetIds.push(prepared.orphanedCoverAssetId);
		}
		throwIfAborted();
		await db.transaction('rw', [db.remote_folders, db.media_assets], async () => {
			await bulkPutRemoteFolders(folders);
			for (const assetId of orphanedAssetIds) await db.media_assets.delete(assetId);
		});
	}
	// Stamp the browsed folder's own row. This is the one place in the codebase
	// that knew the difference between "listed" and "fetched"; it now says so in
	// the field name, so freshness can stop trusting `lastFetched` — which every
	// listing writes for folders nobody has opened.
	if (folderId !== '1') {
		const now = new Date().toISOString();
		await db.remote_folders.update(`${librarySettingsId}:${folderId}`, {
			lastFetched: now,
			contentsFetchedAt: now
		});
	}
	diagnostics.comicsDiscovered = comics.length;

	// Identity comes from the per-library cache; row data is read fresh for just
	// this folder's comics (see remoteVolumeIdentity for why identity-only).
	throwIfAborted();
	const identity = await remoteVolumeIdentity(librarySettingsId, generation);
	const knownUuids = comics
		.map((comic) => identity.get(String(comic.id)))
		.filter((uuid): uuid is string => uuid !== undefined);
	const freshRows = knownUuids.length > 0 ? await db.volumes.bulkGet(knownUuids) : [];
	const existingByRemoteId = new Map<string, VolumeMetadata>();
	for (const row of freshRows) {
		if (row?.source?.type === 'yacreader') {
			existingByRemoteId.set(String(row.source.remoteComicId), row);
		}
	}

	const volumes: VolumeMetadata[] = [];
	let processed = 0;
	const COMIC_BATCH = 25;
	for (let start = 0; start < comics.length; start += COMIC_BATCH) {
		throwIfAborted();
		const batch = comics.slice(start, start + COMIC_BATCH);
		onProgress?.({
			stage: 'importing',
			current: processed,
			total: comics.length,
			message: { code: 'sync_reconciling', params: { done: Math.min(processed + batch.length, comics.length), total: comics.length } }
		});
		// One transaction per batch instead of one per comic: 4-table transaction
		// setup was per-row overhead, and batching keeps the abort check able to
		// stop between batches without tearing a half-written row.
		await db.transaction('rw', [db.volumes, db.page_dimensions, db.catalog_rows, db.media_assets], async () => {
			for (const comic of batch) {
				assertCurrentGeneration(librarySettingsId, generation);
				const remoteId = String(comic.id);
				const existing = existingByRemoteId.get(remoteId);
				const isNew = !existing;
				try {
					const reconciled = await upsertRemoteVolumeMetadata(
						comic,
						librarySettingsId,
						serverUrl,
						remoteLibraryId,
						folderId,
						existing,
						generation,
						true
					);
					existingByRemoteId.set(remoteId, reconciled);
					volumes.push(reconciled);
					diagnostics.comicsReconciled++;
					if (isNew) diagnostics.newComicCount++;
				} catch (error) {
					rethrowIfInvalidated(error);
					diagnostics.failures.push(failure('metadata', remoteId, error));
					console.warn(`[YACSync] Failed to reconcile comic ${comic.file_name}:`, error);
				} finally {
					processed++;
				}
			}
		});
	}

	// Manual Scan also reconciles deletions for this folder. Failures here are
	// recorded, never fatal: an add/update pass that succeeded must not be
	// reported as failed because a deletion probe hit a network hiccup.
	let pruned = { volumesRemoved: 0, foldersRemoved: 0 };
	if (options.prune) {
		try {
			pruned = await pruneFolderListing(
				client, librarySettingsId, remoteLibraryId, folderId, items, generation
			);
		} catch (error) {
			rethrowIfInvalidated(error);
			diagnostics.failures.push(failure('folder', folderId, error));
			console.warn('[YACSync] In-folder prune failed:', error);
		}
	}

	finishDiagnostics(diagnostics);
	const removed = pruned.volumesRemoved + pruned.foldersRemoved;
	onProgress?.({
		stage: 'done',
		current: diagnostics.newComicCount,
		total: comics.length,
		message: diagnostics.status === 'partial'
			? { code: 'sync_folder_failed_items', params: { n: diagnostics.failures.length } }
			: removed > 0
				? { code: 'sync_folder_loaded_removed', params: { folders: folders.length, comics: diagnostics.newComicCount, removed } }
				: { code: 'sync_folder_loaded', params: { folders: folders.length, comics: diagnostics.newComicCount } },
		diagnostics
	});

	return { folders, volumes, newComicCount: diagnostics.newComicCount, diagnostics };
}

/**
 * remoteComicId → volume_uuid, cached per (library, generation).
 *
 * A folder browse used to call `loadRemoteVolumesById`, deserializing every
 * volume row in the library — all ~13k of them — to reconcile a folder that
 * might hold three comics, on every single navigation. Identity is the only
 * thing that needs the library-wide view (a comic that moved folders must keep
 * its uuid, and with it the user's reading progress); the actual row data is
 * fetched fresh per folder, because caching rows would hand a later upsert a
 * stale `current_page` and regress progress the reader wrote in between.
 *
 * The cache is maintained by the single writer (`upsertRemoteVolumeMetadata`)
 * and by pruning; a generation bump discards it wholesale.
 */
const volumeIdentityCache = new Map<string, { generation: number; ids: Map<string, string> }>();

/** Test hook: module-level cache must not leak identity across test databases. */
export function __clearVolumeIdentityCacheForTests(): void {
	volumeIdentityCache.clear();
}

async function remoteVolumeIdentity(
	librarySettingsId: string,
	generation: number
): Promise<Map<string, string>> {
	const cached = volumeIdentityCache.get(librarySettingsId);
	if (cached && cached.generation === generation) return cached.ids;
	const ids = new Map<string, string>();
	await db.volumes.where('library_id').equals(librarySettingsId).each((volume) => {
		if (volume.source?.type === 'yacreader') {
			ids.set(String(volume.source.remoteComicId), volume.volume_uuid);
		}
	});
	volumeIdentityCache.set(librarySettingsId, { generation, ids });
	return ids;
}

function rememberVolumeIdentity(librarySettingsId: string, remoteComicId: string, volumeUuid: string): void {
	volumeIdentityCache.get(librarySettingsId)?.ids.set(remoteComicId, volumeUuid);
}

function forgetVolumeIdentities(librarySettingsId: string, remoteComicIds: Iterable<string>): void {
	const cached = volumeIdentityCache.get(librarySettingsId);
	if (!cached) return;
	for (const id of remoteComicIds) cached.ids.delete(id);
}

async function loadRemoteVolumesById(librarySettingsId: string): Promise<Map<string, VolumeMetadata>> {
	const volumes = await db.volumes.where('library_id').equals(librarySettingsId).toArray();
	return new Map(
		volumes
			.filter((volume) => volume.source?.type === 'yacreader')
			.map((volume) => [String((volume.source as Extract<VolumeSource, { type: 'yacreader' }>).remoteComicId), volume])
	);
}

interface IndexedComicCandidate {
	comic: YACComic;
	parentFolderId: string;
	ancestorFolderIds: string[];
}

async function reconcileDescendantFolderCovers(
	librarySettingsId: string,
	comics: readonly IndexedComicCandidate[],
	random: () => number
): Promise<void> {
	const eligibleByFolder = new Map<string, Array<{ comicId: string; hash: string }>>();
	for (const { comic, ancestorFolderIds } of comics) {
		const hash = comic.hash?.trim();
		if (!hash) continue;
		for (const folderId of ancestorFolderIds) {
			let candidates = eligibleByFolder.get(folderId);
			if (!candidates) {
				candidates = [];
				eligibleByFolder.set(folderId, candidates);
			}
			candidates.push({ comicId: String(comic.id), hash });
		}
	}

	const folders = await db.remote_folders.where('librarySettingsId').equals(librarySettingsId).toArray();
	for (const folder of folders) {
		if (folder.customCoverPath) continue;
		const candidates = eligibleByFolder.get(folder.remoteFolderId) ?? [];
		const retained = candidates.find((candidate) =>
			candidate.comicId === folder.coverCandidateComicId
			&& candidate.hash === folder.coverCandidateHash
		);
		const selected = retained ?? (candidates.length > 0
			? candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, Math.min(0.999999999, random())) * candidates.length))]
			: undefined);
		const nextPath = selected ? `${selected.hash}.jpg` : undefined;
		const changed = folder.coverCandidateComicId !== selected?.comicId
			|| folder.coverCandidateHash !== selected?.hash
			|| folder.coverPath !== nextPath;
		if (!changed) continue;
		await putRemoteFolder({
			...folder,
			coverHash: selected?.hash ?? null,
			coverPath: nextPath,
			coverCandidateComicId: selected?.comicId,
			coverCandidateHash: selected?.hash,
			coverState: selected ? 'candidate' : 'missing',
			coverThumbnailDataUrl: undefined,
			coverCacheVersion: undefined,
			coverAssetId: undefined,
			coverRetryAttempt: 0,
			coverRetryAt: undefined,
			coverRetryError: undefined,
			metadataRevision: (folder.metadataRevision ?? 0) + 1
		});
		if (folder.coverAssetId) await db.media_assets?.delete(folder.coverAssetId);
	}
}

async function pruneCompleteYacTraversal(
	librarySettingsId: string,
	seenComicIds: ReadonlySet<string>,
	seenFolderIds: ReadonlySet<string>
): Promise<void> {
	const [volumes, folders] = await Promise.all([
		db.volumes.where('library_id').equals(librarySettingsId).toArray(),
		db.remote_folders.where('librarySettingsId').equals(librarySettingsId).toArray()
	]);
	const staleVolumes = volumes.filter((volume) =>
		volume.source?.type === 'yacreader' && !seenComicIds.has(String(volume.source.remoteComicId))
	);
	const staleFolders = folders.filter((folder) => !seenFolderIds.has(String(folder.remoteFolderId)));
	if (staleVolumes.length === 0 && staleFolders.length === 0) return;
	// Pruning used to delete six tables and leave every translation table
	// behind — including inpainted_pages, whose rows carry a full-page Blob.
	// YAC volume uuids are random, so a comic pruned here and re-added later
	// gets a new uuid and the old rows are unreachable for the life of the
	// database. This path runs on every clean full sync.
	await db.transaction('rw', [...volumeScopedTables(db), db.remote_folders], async () => {
		for (const volume of staleVolumes) {
			await deleteVolumeRowsInTransaction(volume.volume_uuid, db);
		}
		for (const folder of staleFolders) {
			await db.remote_folders.delete(folder.id);
			await db.media_assets.delete(folderCoverAssetId(folder.id));
		}
	});
}

/**
 * Prune a single folder's local rows against the listing just fetched for it.
 *
 * A comic or child folder missing from the listing is NOT proof of deletion —
 * it may merely have moved elsewhere on the server, and deleting a moved
 * comic's row destroys reading progress the server never had. So absence from
 * the listing only *nominates*; deletion requires positive server confirmation:
 *
 *   - comic: `fetchComic` throwing `not_found` (a moved comic answers 200 and
 *     is left alone — its new folder's next listing re-parents it via upsert);
 *   - folder: `fetchFolderContent` on the missing folder throwing `not_found`
 *     (a moved folder still answers, and is left for the full sync to
 *     re-parent). A confirmed-deleted folder's local subtree is walked over
 *     `parentKey`, and its comics get the same per-comic confirmation, so a
 *     comic rescued out of a folder just before the folder was deleted
 *     survives with its progress.
 *
 * Any probe failure that is not `not_found` (network, 5xx, auth) leaves the row
 * untouched: pruning must never act on ambiguity. All network happens before
 * the delete transaction — awaiting a fetch inside an IndexedDB transaction
 * closes it.
 *
 * Runs only for a *manual* folder Scan, never passive browse hydration:
 * navigation should stay read-mostly against a single-threaded server.
 */
async function pruneFolderListing(
	client: YACServerClient,
	librarySettingsId: string,
	remoteLibraryId: number,
	folderId: string,
	serverItems: readonly YACFolderContentItem[],
	generation: number
): Promise<{ volumesRemoved: number; foldersRemoved: number }> {
	const serverComicIds = new Set<string>();
	const serverFolderIds = new Set<string>();
	for (const item of serverItems) {
		if (item.type === 'folder') serverFolderIds.add(String(item.id));
		else serverComicIds.add(String(item.id));
	}

	const [allVolumes, allFolders] = await Promise.all([
		db.volumes.where('library_id').equals(librarySettingsId).toArray(),
		db.remote_folders.where('librarySettingsId').equals(librarySettingsId).toArray()
	]);
	const scannedParentKey = folderId === '1' ? 'root' : `folder:${folderId}`;

	const missingComics = allVolumes.filter((volume) =>
		volume.source?.type === 'yacreader'
		&& String(volume.source.remoteFolderId) === String(folderId)
		&& !serverComicIds.has(String(volume.source.remoteComicId))
	);
	const missingFolders = allFolders.filter((folder) =>
		folder.parentKey === scannedParentKey
		&& !serverFolderIds.has(String(folder.remoteFolderId))
	);
	if (missingComics.length === 0 && missingFolders.length === 0) {
		return { volumesRemoved: 0, foldersRemoved: 0 };
	}

	const confirmedNotFound = async (probe: () => Promise<unknown>): Promise<boolean> => {
		try {
			await probe();
			return false;
		} catch (error) {
			rethrowIfInvalidated(error);
			return error instanceof YACServerError && error.type === 'not_found';
		}
	};

	const volumesToDelete: VolumeMetadata[] = [];
	const foldersToDelete: RemoteFolder[] = [];

	for (const volume of missingComics) {
		assertCurrentGeneration(librarySettingsId, generation);
		const remoteComicId = String((volume.source as Extract<VolumeSource, { type: 'yacreader' }>).remoteComicId);
		if (await confirmedNotFound(() => client.fetchComic(remoteLibraryId, remoteComicId))) {
			volumesToDelete.push(volume);
		}
	}

	for (const folder of missingFolders) {
		assertCurrentGeneration(librarySettingsId, generation);
		const gone = await confirmedNotFound(
			() => client.fetchFolderContent(remoteLibraryId, String(folder.remoteFolderId))
		);
		if (!gone) continue;
		// The folder is confirmed deleted; collect its local subtree by parentKey.
		const subtree: RemoteFolder[] = [folder];
		for (let index = 0; index < subtree.length; index += 1) {
			const childKey = `folder:${subtree[index].remoteFolderId}`;
			for (const candidate of allFolders) {
				if (candidate.parentKey === childKey) subtree.push(candidate);
			}
		}
		foldersToDelete.push(...subtree);
		const subtreeIds = new Set(subtree.map((entry) => String(entry.remoteFolderId)));
		for (const volume of allVolumes) {
			if (volume.source?.type !== 'yacreader') continue;
			const source = volume.source as Extract<VolumeSource, { type: 'yacreader' }>;
			if (!subtreeIds.has(String(source.remoteFolderId))) continue;
			assertCurrentGeneration(librarySettingsId, generation);
			if (await confirmedNotFound(() => client.fetchComic(remoteLibraryId, String(source.remoteComicId)))) {
				volumesToDelete.push(volume);
			}
		}
	}

	if (volumesToDelete.length === 0 && foldersToDelete.length === 0) {
		return { volumesRemoved: 0, foldersRemoved: 0 };
	}
	assertCurrentGeneration(librarySettingsId, generation);
	// Same cascade as the full-sync prune; see pruneCompleteYacTraversal.
	await db.transaction('rw', [...volumeScopedTables(db), db.remote_folders], async () => {
		for (const volume of volumesToDelete) {
			await deleteVolumeRowsInTransaction(volume.volume_uuid, db);
		}
		for (const folder of foldersToDelete) {
			await db.remote_folders.delete(folder.id);
			await db.media_assets.delete(folderCoverAssetId(folder.id));
		}
	});
	forgetVolumeIdentities(
		librarySettingsId,
		volumesToDelete
			.filter((volume) => volume.source?.type === 'yacreader')
			.map((volume) => String((volume.source as Extract<VolumeSource, { type: 'yacreader' }>).remoteComicId))
	);
	return { volumesRemoved: volumesToDelete.length, foldersRemoved: foldersToDelete.length };
}

/** Metadata-only reconciliation. Cover fetch/decode is deliberately separate. */
async function upsertRemoteVolumeMetadata(
	comic: YACComic,
	librarySettingsId: string,
	serverUrl: string,
	remoteLibraryId: number,
	parentFolderId: string,
	existing: VolumeMetadata | undefined,
	generation: number,
	withinTransaction = false
): Promise<VolumeMetadata> {
	assertCurrentGeneration(librarySettingsId, generation);
	const volumeUuid = existing?.volume_uuid ?? randomUUID();
	const title = comic.title || comic.file_name.replace(/\.(cbz|cbr|zip|rar|pdf)$/i, '');
	const existingHash = existing?.source?.type === 'yacreader' ? existing.source.comicHash : undefined;
	const keepThumbnail = Boolean(comic.hash) && existingHash === comic.hash;
	const source: VolumeSource = {
		type: 'yacreader',
		serverUrl,
		remoteLibraryId,
		remoteComicId: String(comic.id),
		comicHash: comic.hash,
		remoteFolderId: parentFolderId
	};
	const seededPage = comic.current_page > 0 ? comic.current_page - 1 : 0;
	const safeSeededPage = Math.max(0, Math.min(Math.max(0, comic.num_pages - 1), seededPage));
	const metadata: VolumeMetadata = {
		...existing,
		volume_uuid: volumeUuid,
		title,
		filename: comic.file_name,
		page_count: comic.num_pages,
		created_at: epochSecondsToIso(comic.added) ?? existing?.created_at ?? new Date().toISOString(),
		current_page: existing?.current_page ?? safeSeededPage,
		thumbnail: keepThumbnail ? existing?.thumbnail : undefined,
		thumbnail_width: keepThumbnail ? existing?.thumbnail_width : undefined,
		thumbnail_height: keepThumbnail ? existing?.thumbnail_height : undefined,
		// Every other user-owned field on this record is guarded with `existing?.`
		// — this one was not, so the server's `manga` flag overwrote whatever the
		// user had chosen. And this upsert is not only reached by a re-sync: it
		// runs from passive folder navigation too, so a pinned direction was
		// erased roughly once per folder per half-day of browsing.
		//
		// The guard is record EXISTENCE, not `existing?.reading_direction ??`.
		// The reader's quick toggle expresses "follow the global default" by
		// writing `undefined`, so a `??` chain would re-stamp 'rtl' onto a volume
		// the user had deliberately un-pinned — inverting the bug rather than
		// fixing it. (There is a test that fails under exactly that mistake.) A
		// comic we have never seen still gets the server's hint, which is what
		// the v18 direction migration depends on.
		reading_direction: existing ? existing.reading_direction : (comic.manga ? 'rtl' : 'ltr'),
		author: existing?.author ?? comic.writer ?? undefined,
		library_id: librarySettingsId,
		source
	};

	const existingDimensions = existing ? await db.page_dimensions.get(volumeUuid) : undefined;
	assertCurrentGeneration(librarySettingsId, generation);
	const pages: PageInfo[] = [];
	const existingPages = new Map(existingDimensions?.pages.map((page) => [page.index, page]) ?? []);
	for (let index = 0; index < comic.num_pages; index++) {
		pages.push(existingPages.get(index) ?? { index, width: 0, height: 0, filename: `page_${index}` });
	}
	const pageDimensions: PageDimensions = { volume_uuid: volumeUuid, pages };

	const existingAsset = keepThumbnail
		? await db.media_assets.get(volumeThumbnailAssetId(volumeUuid))
		: undefined;
	const catalogRowBase = toCatalogRow(metadata);
	const catalogRow = existingAsset && !catalogRowBase.thumbnail_asset_id
		? { ...catalogRowBase, thumbnail_asset_id: existingAsset.id }
		: catalogRowBase;
	const thumbnailAsset = volumeThumbnailAsset(metadata);
	const persistProjection = async () => {
		assertCurrentGeneration(librarySettingsId, generation);
		await db.volumes.put(volumeWithoutEmbeddedMedia(metadata));
		await db.page_dimensions.put(pageDimensions);
		await db.catalog_rows.put(catalogRow);
		if (thumbnailAsset) await db.media_assets.put(thumbnailAsset);
		else if (!keepThumbnail) await db.media_assets.delete(volumeThumbnailAssetId(volumeUuid));
	};
	if (withinTransaction) await persistProjection();
	else await db.transaction('rw', [db.volumes, db.page_dimensions, db.catalog_rows, db.media_assets], persistProjection);
	assertCurrentGeneration(librarySettingsId, generation);
	// Every write path funnels through here, which is what keeps the identity
	// cache trustworthy: browse, crawl and manual scan all register the mapping.
	rememberVolumeIdentity(librarySettingsId, String(comic.id), volumeUuid);
	return metadata;
}

// ============================================================
// Lazy comic cover hydration
// ============================================================

/**
 * Fetch, resize, and attach one comic cover. Identical in-flight requests are
 * coalesced. A response is discarded if the volume hash/remote identity or the
 * library generation changed while it was in flight.
 */
export function hydrateRemoteVolumeCover(
	client: YACServerClient,
	volume: VolumeMetadata
): Promise<CoverHydrationResult> {
	const librarySettingsId = volume.library_id;
	if (!librarySettingsId || cleanupPending.has(librarySettingsId)) {
		return Promise.resolve({ status: 'stale', volumeUuid: volume.volume_uuid });
	}
	return hydrateRemoteVolumeCoverAtGeneration(
		client,
		volume,
		getLibraryGeneration(librarySettingsId)
	);
}

function hydrateRemoteVolumeCoverAtGeneration(
	client: YACServerClient,
	volume: VolumeMetadata,
	generation: number
): Promise<CoverHydrationResult> {
	const source = volume.source;
	const librarySettingsId = volume.library_id;
	if (!librarySettingsId || source?.type !== 'yacreader' || !source.comicHash) {
		return Promise.resolve({
			status: 'missing',
			volumeUuid: volume.volume_uuid,
			comicHash: source?.type === 'yacreader' ? source.comicHash : undefined
		});
	}
	const key = `${librarySettingsId}:${generation}:${volume.volume_uuid}:${source.comicHash}`;
	const existing = volumeCoverHydrations.get(key);
	if (existing) return existing;

	const operation = (async (): Promise<CoverHydrationResult> => {
		const latestBeforeFetch = await db.volumes.get(volume.volume_uuid);
		if (!isSameRemoteCover(latestBeforeFetch, volume) || getLibraryGeneration(librarySettingsId) !== generation) {
			return { status: 'stale', volumeUuid: volume.volume_uuid, comicHash: source.comicHash };
		}
		if (latestBeforeFetch?.thumbnail || await db.media_assets.get(volumeThumbnailAssetId(volume.volume_uuid))) {
			return { status: 'cached', volumeUuid: volume.volume_uuid, comicHash: source.comicHash };
		}

		try {
			const coverBlob = await client.fetchCover(source.remoteLibraryId, source.comicHash);
			const thumbnail = await generateThumbnailFromBlob(coverBlob, VOLUME_THUMBNAIL_MAX_SIZE);
			if (getLibraryGeneration(librarySettingsId) !== generation || cleanupPending.has(librarySettingsId)) {
				return { status: 'stale', volumeUuid: volume.volume_uuid, comicHash: source.comicHash };
			}

			let updated = false;
			await db.transaction('rw', [db.volumes, db.catalog_rows, db.media_assets], async () => {
				if (getLibraryGeneration(librarySettingsId) !== generation) return;
				const latest = await db.volumes.get(volume.volume_uuid);
				if (!isSameRemoteCover(latest, volume)) return;
				if (!latest) return;
				const next = {
					...latest,
					thumbnail: thumbnail.blob,
					thumbnail_width: thumbnail.width,
					thumbnail_height: thumbnail.height
				};
				const asset = volumeThumbnailAsset(next)!;
				await db.volumes.put(volumeWithoutEmbeddedMedia(next));
				await db.catalog_rows.put({ ...toCatalogRow(next), thumbnail_asset_id: asset.id });
				await db.media_assets.put(asset);
				updated = true;
			});

			return {
				status: updated ? 'hydrated' : 'stale',
				volumeUuid: volume.volume_uuid,
				comicHash: source.comicHash
			};
		} catch (error) {
			console.warn(`[YACSync] Failed to fetch cover for ${volume.filename}:`, error);
			return {
				status: 'failed',
				volumeUuid: volume.volume_uuid,
				comicHash: source.comicHash,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	})();

	volumeCoverHydrations.set(key, operation);
	void operation.finally(() => {
		if (volumeCoverHydrations.get(key) === operation) volumeCoverHydrations.delete(key);
	});
	return operation;
}

function isSameRemoteCover(latest: VolumeMetadata | undefined, expected: VolumeMetadata): boolean {
	if (latest?.source?.type !== 'yacreader' || expected.source?.type !== 'yacreader') return false;
	return latest.library_id === expected.library_id
		&& latest.source.serverUrl === expected.source.serverUrl
		&& latest.source.remoteLibraryId === expected.source.remoteLibraryId
		&& latest.source.remoteComicId === expected.source.remoteComicId
		&& latest.source.comicHash === expected.source.comicHash;
}

// ============================================================
// Folder caching and lazy folder covers
// ============================================================

async function upsertRemoteFolder(
	folder: YACFolder,
	librarySettingsId: string,
	remoteLibraryId: number,
	parentFolderId: string,
	generation: number
): Promise<RemoteFolder> {
	assertCurrentGeneration(librarySettingsId, generation);
	const id = `${librarySettingsId}:${folder.id}`;
	const existing = await db.remote_folders.get(id);
	const prepared = prepareRemoteFolderUpsert(folder, librarySettingsId, remoteLibraryId, parentFolderId, existing);
	assertCurrentGeneration(librarySettingsId, generation);
	await putRemoteFolder(prepared.entry);
	if (prepared.orphanedCoverAssetId) await db.media_assets.delete(prepared.orphanedCoverAssetId);
	return prepared.entry;
}

/**
 * The pure half of a folder upsert: merges a server listing item with the
 * locally stored row. Split out so a browse can prepare a whole sibling set
 * and commit it in one `bulkPut` (one liveQuery invalidation) while the crawl
 * keeps its per-folder write.
 */
function prepareRemoteFolderUpsert(
	folder: YACFolder,
	librarySettingsId: string,
	remoteLibraryId: number,
	parentFolderId: string,
	existing: RemoteFolder | undefined
): { entry: RemoteFolder; orphanedCoverAssetId?: string } {
	const id = `${librarySettingsId}:${folder.id}`;
	const hash = folder.first_comic_hash?.trim() || null;
	const customCoverPath = folder.custom_image?.trim() || null;
	const candidateHash = existing?.coverCandidateHash ?? hash;
	const coverPath = customCoverPath ?? (candidateHash ? `${candidateHash}.jpg` : undefined);
	const serverAddedAt = epochSecondsToIso(folder.added);
	const serverUpdatedAt = epochSecondsToIso(folder.updated);
	const existingCoverPath = existing?.coverPath ?? (existing?.coverHash ? `${existing.coverHash}.jpg` : undefined);
	const coverThumbnailDataUrl = existing?.coverThumbnailDataUrl
		&& existing.coverCacheVersion === YAC_FOLDER_COVER_CACHE_VERSION
		&& existingCoverPath === coverPath
		&& existing.serverUpdatedAt === serverUpdatedAt
		? existing.coverThumbnailDataUrl
		: undefined;
	const coverAssetId = existing?.coverAssetId
		&& existingCoverPath === coverPath
		&& existing.serverUpdatedAt === serverUpdatedAt
		? existing.coverAssetId
		: undefined;

	const metadataChanged = existing?.serverUpdatedAt !== serverUpdatedAt
		|| existing?.name !== folder.folder_name
		|| existing?.customCoverPath !== (customCoverPath ?? undefined)
		|| existing?.coverPath !== coverPath;
	const entry: RemoteFolder = {
		id,
		librarySettingsId,
		remoteLibraryId,
		remoteFolderId: folder.id,
		name: folder.folder_name,
		parentFolderId: parentFolderId === '1' ? null : parentFolderId,
		numChildren: folder.num_children,
		coverHash: customCoverPath ?? candidateHash ?? null,
		coverPath,
		customCoverPath: customCoverPath ?? undefined,
		coverCandidateComicId: existing?.coverCandidateComicId,
		coverCandidateHash: candidateHash ?? undefined,
		coverState: customCoverPath ? 'custom' : candidateHash ? 'candidate' : existing?.coverState ?? 'missing',
		coverThumbnailDataUrl,
		coverAssetId,
		coverCacheVersion: coverThumbnailDataUrl ? YAC_FOLDER_COVER_CACHE_VERSION : undefined,
		lastFetched: new Date().toISOString(),
		serverAddedAt,
		serverUpdatedAt,
		metadataRevision: metadataChanged ? (existing?.metadataRevision ?? 0) + 1 : existing?.metadataRevision ?? 1,
		coverRetryAttempt: metadataChanged ? 0 : existing?.coverRetryAttempt,
		coverRetryAt: metadataChanged ? undefined : existing?.coverRetryAt,
		coverRetryError: metadataChanged ? undefined : existing?.coverRetryError
	};
	return {
		entry,
		orphanedCoverAssetId: existing?.coverAssetId && !coverAssetId ? existing.coverAssetId : undefined
	};
}

export async function fetchFolderCover(
	client: YACServerClient,
	folder: RemoteFolder,
	signal?: AbortSignal
): Promise<string | undefined> {
	const coverPath = folder.coverPath ?? (folder.coverHash ? `${folder.coverHash}.jpg` : undefined);
	if (!coverPath) return undefined;
	const cachedCover = await resolveCurrentFolderCover(folder);
	if (cachedCover) return cachedCover;
	if (cleanupPending.has(folder.librarySettingsId)) {
		return undefined;
	}
	const retryAt = folder.coverRetryAt ? Date.parse(folder.coverRetryAt) : 0;
	if (Number.isFinite(retryAt) && retryAt > Date.now()) return undefined;

	const generation = getLibraryGeneration(folder.librarySettingsId);
	const key = `${folder.id}:${generation}:${coverPath}:${folder.metadataRevision ?? folder.serverUpdatedAt ?? ''}`;
	const existing = folderCoverHydrations.get(key);
	if (existing) return existing;
	const operation = hydrateFolderCover(client, folder, coverPath, generation, signal);
	folderCoverHydrations.set(key, operation);
	void operation.finally(() => {
		if (folderCoverHydrations.get(key) === operation) folderCoverHydrations.delete(key);
	});
	return operation;
}

/**
 * Resolve a cached folder image only after validating the separate media row.
 * A retained foreign key is not evidence that IndexedDB still contains usable
 * bytes (for example after an interrupted browser eviction or an old fixture).
 */
async function resolveCurrentFolderCover(folder: RemoteFolder): Promise<string | undefined> {
	if (folder.coverAssetId) {
		const asset = await db.media_assets.get(folder.coverAssetId);
		const blobType = asset?.blob.type.toLowerCase() ?? '';
		const storedType = asset?.mime_type.toLowerCase() ?? '';
		const valid = Boolean(
			asset
			&& asset.kind === 'folder-cover'
			&& asset.owner_id === folder.id
			&& asset.blob.size > 0
			&& asset.byte_length === asset.blob.size
			&& (blobType.startsWith('image/') || (!blobType && storedType === 'application/octet-stream'))
		);
		if (valid) return folder.coverAssetId;

		await db.transaction('rw', [db.remote_folders, db.media_assets], async () => {
			const latest = await db.remote_folders.get(folder.id);
			if (latest && latest.coverAssetId === folder.coverAssetId) {
				await db.remote_folders.update(folder.id, {
					coverAssetId: undefined,
					coverCacheVersion: latest.coverThumbnailDataUrl ? latest.coverCacheVersion : undefined,
					coverState: 'retry',
					coverRetryAt: undefined,
					coverRetryError: 'Cached folder cover bytes were missing or invalid'
				});
			}
			if (asset) await db.media_assets.delete(folder.coverAssetId!);
		});
	}

	return folder.coverThumbnailDataUrl
		&& folder.coverCacheVersion === YAC_FOLDER_COVER_CACHE_VERSION
		? folder.coverThumbnailDataUrl
		: undefined;
}

async function hydrateFolderCover(
	client: YACServerClient,
	folder: RemoteFolder,
	coverPath: string,
	generation: number,
	signal?: AbortSignal
): Promise<string | undefined> {
	void publishFolderRepairStatus(folder.librarySettingsId, { status: 'repairing' });
	try {
		const coverBlob = await client.fetchCoverPath(folder.remoteLibraryId, coverPath, signal);
		if (coverBlob.size <= 0 || (coverBlob.type && !coverBlob.type.toLowerCase().startsWith('image/'))) {
			throw new YACServerError('invalid_response', 'Folder cover is not a valid image');
		}
		// Folder cards can occupy several hundred physical pixels on high-density
		// phones and tablets. Preserve the exact server payload so a low-resolution
		// derivative is never promoted to the full-size grid cover.
		if (
			getLibraryGeneration(folder.librarySettingsId) !== generation
			|| cleanupPending.has(folder.librarySettingsId)
		) return undefined;

		const latest = await db.remote_folders.get(folder.id);
		const latestPath = latest?.coverPath ?? (latest?.coverHash ? `${latest.coverHash}.jpg` : undefined);
		if (!latest || latestPath !== coverPath || latest.metadataRevision !== folder.metadataRevision) return undefined;
		const assetId = folderCoverAssetId(folder.id);
		await db.transaction('rw', [db.remote_folders, db.media_assets], async () => {
			await db.media_assets.put(makeMediaAsset({
				id: assetId,
				ownerType: 'folder', ownerId: folder.id, kind: 'folder-cover', blob: coverBlob,
				revision: `${latest.metadataRevision ?? 0}:${coverPath}:${coverBlob.size}`
			}));
			await db.remote_folders.update(folder.id, {
				coverThumbnailDataUrl: undefined,
				coverCacheVersion: YAC_FOLDER_COVER_CACHE_VERSION,
				coverAssetId: assetId,
				coverState: 'ready',
				coverRetryAttempt: 0,
				coverRetryAt: undefined,
				coverRetryError: undefined
			});
		});
		void publishFolderRepairStatus(folder.librarySettingsId, { status: 'ready', recoverableError: undefined });
		// The asset id, matching resolveCurrentFolderCover's cached path. Every
		// production caller consumes only truthiness; the old return value was a
		// base64 data URL built with a per-byte String.fromCharCode loop over
		// ~50 KB — pure main-thread cost per hydrated cover, rendered by nobody.
		return assetId;
	} catch (error) {
		// A cancelled fetch (viewport exit, navigation, view hidden) is not a
		// server failure: writing retry backoff for it would delay the cover's
		// next legitimate attempt for no reason.
		const cancelled = (error instanceof YACServerError && error.type === 'cancelled')
			|| (error instanceof Error && error.name === 'AbortError');
		if (cancelled) return undefined;
		console.warn(`[YACSync] Failed to fetch folder cover ${folder.id}:`, error);
		const definitive = error instanceof YACServerError
			&& (error.type === 'not_found' || error.type === 'invalid_response');
		if (definitive) {
			const fallback = await selectFallbackFolderCandidate(folder, coverPath);
			if (fallback?.coverPath && fallback.coverPath !== coverPath) {
				return hydrateFolderCover(client, fallback, fallback.coverPath, generation);
			}
			void publishFolderRepairStatus(folder.librarySettingsId, {
				status: 'error', recoverableError: 'The folder cover was invalid; it remains eligible for repair after newer metadata or manual Sync.'
			});
			return undefined;
		}
		await persistFolderCoverRetry(folder, error);
		void publishFolderRepairStatus(folder.librarySettingsId, {
			status: 'error', recoverableError: error instanceof Error ? error.message : String(error)
		});
		return undefined;
	}
}

/**
 * Visible-card repair is an independent media task. It may expose `repairing`
 * while the library is otherwise idle, but it must never replace the durable
 * server-update/crawl/reconcile phase (or that operation's terminal error).
 */
function publishFolderRepairStatus(
	librarySettingsId: string,
	changes: Partial<Omit<YacIndexStatusSnapshot, 'librarySettingsId'>>
): Promise<void> {
	if (isLibrarySyncInProgress(librarySettingsId)) return Promise.resolve();
	return publishIndexStatus(librarySettingsId, changes);
}

const FOLDER_COVER_RETRY_DELAYS = [2_000, 10_000, 60_000, 300_000, 1_800_000] as const;

async function persistFolderCoverRetry(folder: RemoteFolder, error: unknown): Promise<void> {
	const latest = await db.remote_folders.get(folder.id);
	if (!latest || latest.coverPath !== folder.coverPath) return;
	const attempt = Math.min(FOLDER_COVER_RETRY_DELAYS.length, (latest.coverRetryAttempt ?? 0) + 1);
	const delay = FOLDER_COVER_RETRY_DELAYS[attempt - 1];
	await db.remote_folders.update(folder.id, {
		coverState: 'retry',
		coverRetryAttempt: attempt,
		coverRetryAt: new Date(Date.now() + delay).toISOString(),
		coverRetryError: error instanceof Error ? error.message : String(error)
	});
}

async function selectFallbackFolderCandidate(
	folder: RemoteFolder,
	invalidPath: string
): Promise<RemoteFolder | undefined> {
	const [folders, volumes] = await Promise.all([
		db.remote_folders.where('librarySettingsId').equals(folder.librarySettingsId).toArray(),
		db.volumes.where('library_id').equals(folder.librarySettingsId).toArray()
	]);
	const descendantIds = new Set<string>([folder.remoteFolderId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const candidate of folders) {
			if (candidate.parentFolderId && descendantIds.has(candidate.parentFolderId) && !descendantIds.has(candidate.remoteFolderId)) {
				descendantIds.add(candidate.remoteFolderId);
				changed = true;
			}
		}
	}
	const candidates = volumes.flatMap((volume) => {
		if (volume.source?.type !== 'yacreader'
			|| !descendantIds.has(volume.source.remoteFolderId)
			|| !volume.source.comicHash) return [];
		const path = `${volume.source.comicHash}.jpg`;
		if (path === invalidPath) return [];
		return [{ comicId: volume.source.remoteComicId, hash: volume.source.comicHash, path }];
	});
	const selected = candidates.length > 0
		? candidates[Math.floor(Math.random() * candidates.length)]
		: undefined;
	const latest = await db.remote_folders.get(folder.id);
	if (!latest) return undefined;
	const next: RemoteFolder = {
		...latest,
		coverHash: selected?.hash ?? null,
		coverPath: selected?.path,
		coverCandidateComicId: selected?.comicId,
		coverCandidateHash: selected?.hash,
		coverState: selected ? 'candidate' : 'invalid',
		coverThumbnailDataUrl: undefined,
		coverCacheVersion: undefined,
		coverAssetId: undefined,
		coverRetryAttempt: 0,
		coverRetryAt: undefined,
		coverRetryError: `Invalid cover: ${invalidPath}`,
		metadataRevision: (latest.metadataRevision ?? 0) + 1
	};
	await putRemoteFolder(next);
	if (latest.coverAssetId) await db.media_assets.delete(latest.coverAssetId);
	return next;
}

/** True only for original-resolution YACReader folder cover cache entries. */
export function hasCurrentFolderCover(
	folder: RemoteFolder
): boolean {
	return Boolean(
		folder.coverAssetId
		|| (folder.coverThumbnailDataUrl
			&& folder.coverCacheVersion === YAC_FOLDER_COVER_CACHE_VERSION)
	);
}

// ============================================================
// Thumbnail helpers
// ============================================================

async function generateThumbnailFromBlob(
	blob: Blob,
	maxSize: number
): Promise<{ blob: Blob; width: number; height: number }> {
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
		const width = Math.round(img.naturalWidth * scale);
		const height = Math.round(img.naturalHeight * scale);
		if (scale === 1) return { blob, width, height };

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d')!;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(img, 0, 0, width, height);
		return {
			blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_JPEG_QUALITY }),
			width,
			height
		};
	} finally {
		URL.revokeObjectURL(url);
	}
}

function epochSecondsToIso(value: number | undefined): string | undefined {
	if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return undefined;
	return new Date(value * 1000).toISOString();
}

async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (nextIndex < items.length) {
			const item = items[nextIndex++];
			await worker(item);
		}
	});
	await Promise.all(workers);
}

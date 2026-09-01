import type { UserMessage } from '$lib/i18n/user-messages.js';
import { liveQuery, type Subscription } from 'dexie';
import type { FumetoDB } from '$lib/db/schema.js';
import { db } from '$lib/db/index.js';
import type { CatalogParentKey, MediaAsset, RemoteFolder, VolumeMetadata } from '$lib/types/index.js';
import {
	UNASSIGNED_LIBRARY_ID,
	catalogParentKey,
	catalogRowToVolume,
	folderCoverAssetId,
	makeMediaAsset,
	volumeThumbnailAssetId
} from '$lib/catalog/catalog-repository.js';
import {
	isKavitaLibrary,
	isKomgaLibrary,
	isYACReaderLibrary,
	type Library,
} from '$lib/settings/settings.js';
import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';
import { RECOVERED_DOWNLOADS_COLLECTION_ID } from '$lib/stores/catalog-state.js';
import {
	beginLoading,
	errorSnapshot,
	readySnapshot,
	uninitializedSnapshot,
	type LoadableSnapshot
} from './loadable-snapshot.js';

export interface CatalogLocation {
	libraryId: string | null;
	subfolder: string;
	remoteFolderId: string | null;
	/**
	 * Ignore folder scoping and list the whole library's volumes flat. Used by
	 * the category filters (Favorites/Recent/…) so matches buried in
	 * subfolders surface without digging. Reads only locally indexed rows —
	 * never triggers remote fetches (in `browse` sync mode, unvisited remote
	 * folders are simply not represented; of the filters only Unread can
	 * under-report there, since the others all require prior local
	 * interaction).
	 */
	flatten?: boolean;
}

export interface CatalogSnapshotData {
	location: CatalogLocation;
	volumes: VolumeMetadata[];
	/** Immediate local child folders for this location, derived from lightweight rows. */
	localSubfolders: string[];
	remoteFolders: RemoteFolder[];
	collectionCounts: Record<string, number>;
}

export interface RemoteLocationRefreshResult {
	newComicCount: number;
}

export interface CatalogSyncProgress {
	stage: string;
	current: number;
	total: number;
	/** Rendered by the view in the live locale. */
	message: UserMessage;
}

export interface CatalogSyncResult {
	newComicCount: number;
	failureCount: number;
}

type Listener = (snapshot: LoadableSnapshot<CatalogSnapshotData>) => void;

function locationKey(location: CatalogLocation): string {
	return `${location.libraryId ?? '_all'}\u0000${location.remoteFolderId ?? (location.subfolder || '_root')}${location.flatten ? '\u0000flat' : ''}`;
}

function parentKey(location: CatalogLocation): CatalogParentKey {
	const folder = location.remoteFolderId ?? location.subfolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	return folder ? `folder:${folder}` : 'root';
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

function storedLibraryId(libraryId: string | null): string | null {
	if (libraryId === RECOVERED_DOWNLOADS_COLLECTION_ID) return UNASSIGNED_LIBRARY_ID;
	return libraryId;
}

function immediateLocalChild(folderPath: string | undefined, currentSubfolder: string): string | undefined {
	const path = (folderPath ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
	const current = currentSubfolder.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
	if (!path) return undefined;
	if (!current) return path.split('/')[0] || undefined;
	if (!path.startsWith(`${current}/`)) return undefined;
	return path.slice(current.length + 1).split('/')[0] || undefined;
}

/**
 * Library-wide facts the navigation query needs but must not depend on:
 * per-collection counts plus which libraries serve from the projected
 * (`catalog_rows`) path. Computed by its own liveQuery so switching folders
 * does not re-run index-state reads, two `uniqueKeys()` walks and 2×L counts
 * that have nothing to do with the location being entered.
 */
interface CollectionFacts {
	counts: Record<string, number>;
	readyLibraries: Set<string>;
	providerByLibrary: Map<string, string | undefined>;
}

/** Previously-seen locations kept for instant back-navigation repaints. */
const LOCATION_SNAPSHOT_LIMIT = 8;

/**
 * How long a browsed remote listing counts as fresh across app restarts.
 * Within it, navigation renders purely from local rows; manual Scan (force)
 * refreshes regardless — per the user's contract, Scan IS the refresh.
 */
const REMOTE_LOCATION_FRESHNESS_TTL_MS = 12 * 60 * 60 * 1000;

export class CatalogController {
	private snapshot: LoadableSnapshot<CatalogSnapshotData> = uninitializedSnapshot();
	private readonly listeners = new Set<Listener>();
	private querySubscription?: Subscription;
	private factsSubscription?: Subscription;
	private facts?: CollectionFacts;
	private requestRevision = 0;
	private location: CatalogLocation = { libraryId: null, subfolder: '', remoteFolderId: null };
	private remoteLocationController?: AbortController;
	private remoteLocationTaskKey?: string;
	private readonly hydratedRemoteLocations = new Set<string>();
	/**
	 * Last-good data per location. Navigating somewhere already seen publishes
	 * this synchronously as `refreshing`, so the grid never collapses into the
	 * full-height "Loading…" panel for a place whose rows are already known —
	 * previously every navigation destroyed last-good (`clearLastGood`) and the
	 * user watched a spinner to go *back* to a folder that needed no I/O at all.
	 * The live query still replaces the entry on every emission, so this only
	 * bridges the gap between the store write and the fresh result.
	 */
	private readonly locationSnapshots = new Map<string, CatalogSnapshotData>();

	constructor(private readonly database: FumetoDB = db) {}

	private rememberLocation(key: string, data: CatalogSnapshotData): void {
		this.locationSnapshots.delete(key);
		this.locationSnapshots.set(key, data);
		while (this.locationSnapshots.size > LOCATION_SNAPSHOT_LIMIT) {
			const oldest = this.locationSnapshots.keys().next().value as string | undefined;
			if (oldest === undefined) return;
			this.locationSnapshots.delete(oldest);
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	getSnapshot(): LoadableSnapshot<CatalogSnapshotData> {
		return this.snapshot;
	}

	setLocation(location: CatalogLocation): void {
		if (locationKey(location) === locationKey(this.location) && this.querySubscription) return;
		const changed = locationKey(location) !== locationKey(this.location);
		this.location = { ...location };
		this.startQuery(changed);
	}

	start(): void {
		if (!this.querySubscription) this.startQuery();
	}

	refresh(): void {
		this.startQuery();
	}

	/**
	 * Hydrate the selected remote location through a view-owned command. The
	 * controller, rather than a mounted component, owns location cancellation,
	 * request coalescing, and the warm cache marker.
	 */
	async refreshRemoteLocation(
		library: Library,
		remoteFolderId: string | null,
		force = false,
	): Promise<RemoteLocationRefreshResult> {
		if (!isYACReaderLibrary(library) && !isKomgaLibrary(library) && !isKavitaLibrary(library)) {
			return { newComicCount: 0 };
		}
		const providerFolderId = isYACReaderLibrary(library) ? (remoteFolderId ?? '1') : remoteFolderId;
		const key = `${library.id}:${providerFolderId ?? 'root'}`;
		if (!force && this.hydratedRemoteLocations.has(key)) return { newComicCount: 0 };
		// Persisted freshness: the browse that filled this location stamped
		// `lastFetched` on every child row it wrote, so a restart does not need
		// to refetch a folder whose rows are present and recent. The in-memory
		// marker is seeded so the IDB check runs once per location per session.
		// Empty folders have no child rows and naturally refetch — acceptable.
		if (!force && await this.isRemoteLocationFresh(library.id, providerFolderId)) {
			this.hydratedRemoteLocations.add(key);
			return { newComicCount: 0 };
		}

		if (this.remoteLocationTaskKey !== key) {
			this.remoteLocationController?.abort('catalog location changed');
			this.remoteLocationController = new AbortController();
			this.remoteLocationTaskKey = key;
		}
		const controller = this.remoteLocationController ?? new AbortController();
		this.remoteLocationController = controller;

		const handle = appWorkCoordinator.submit({
			kind: 'catalog-location-refresh',
			owner: 'catalog-view',
			lane: `catalog-location:${library.id}`,
			priority: 1,
			coalescingKey: key,
			signal: controller.signal,
			// The operation consumes its context signal — before this, navigating
			// away "aborted" a task whose operation never looked, so the
			// capacity-1 lane stayed occupied until the abandoned folder's full
			// network + IndexedDB run finished and the next navigation queued
			// behind work nobody wanted.
			operation: async ({ signal }) => {
				if (isYACReaderLibrary(library)) {
					const [{ getOrCreateClient }, { fetchRemoteFolderContents }] = await Promise.all([
						import('$lib/yacreader/yac-client-manager.js'),
						import('$lib/yacreader/yac-sync-service.js'),
					]);
					const browse = await fetchRemoteFolderContents(
						getOrCreateClient(library.serverUrl),
						library.id,
						library.remoteLibraryId,
						providerFolderId ?? '1',
						library.serverUrl,
						undefined,
						{ signal },
					);
					// Mark inside the operation: the work is done whether or not
					// the awaiting subscriber is still around. Previously the mark
					// sat after `await handle.promise`, so navigating away threw
					// the marker away and the next visit repaid the whole fetch.
					if (!signal.aborted) this.hydratedRemoteLocations.add(key);
					return browse;
				}
				if (isKomgaLibrary(library)) {
					const [{ loadKomgaCredentials }, { getOrCreateKomgaClient }, { fetchKomgaFolderContents }] = await Promise.all([
						import('$lib/komga/komga-credentials.js'),
						import('$lib/komga/komga-client-manager.js'),
						import('$lib/komga/komga-sync-service.js'),
					]);
					const credentials = await loadKomgaCredentials(library.serverUrl);
					const contents = await fetchKomgaFolderContents(
						getOrCreateKomgaClient(library.serverUrl, credentials.username, credentials.password),
						library.id,
						library.komgaLibraryId,
						providerFolderId,
						library.serverUrl,
						undefined,
						{ signal },
					);
					if (!signal.aborted) this.hydratedRemoteLocations.add(key);
					return contents;
				}
				const [{ loadKavitaApiKey }, { getOrCreateKavitaClient }, { fetchKavitaFolderContents }] = await Promise.all([
					import('$lib/kavita/kavita-credentials.js'),
					import('$lib/kavita/kavita-client-manager.js'),
					import('$lib/kavita/kavita-sync-service.js'),
				]);
				const apiKey = await loadKavitaApiKey(library.serverUrl);
				const contents = await fetchKavitaFolderContents(
					getOrCreateKavitaClient(library.serverUrl, apiKey),
					library.id,
					library.kavitaLibraryId,
					providerFolderId,
					library.serverUrl,
					undefined,
					{ signal },
				);
				if (!signal.aborted) this.hydratedRemoteLocations.add(key);
				return contents;
			},
		});
		const result = await handle.promise;
		return { newComicCount: result.newComicCount };
	}

	/**
	 * Is this location's own content already fetched and recent?
	 *
	 * The distinction that matters: `lastFetched` records when a folder ROW was
	 * written, which is when the folder showed up in some listing — its parent's.
	 * `contentsFetchedAt` records when that folder's own contents were fetched.
	 * Only the second one answers this question.
	 *
	 * Reading `lastFetched` here meant a folder that had only ever been listed
	 * counted as fetched, so entering it showed the generic "This library is
	 * empty — Import a .zip…" state while the user stood in a populated server
	 * folder. For Komga and Kavita it was total rather than occasional: their
	 * series are flat, so a series has no child folder rows to contradict the
	 * stamp, and every root visit re-stamped every series to now — so the TTL
	 * never elapsed and browse mode had no state in which entering a series ever
	 * fetched its books.
	 *
	 * Child rows still count for a location whose children are FOLDERS, because
	 * listing them is exactly what fetching that location means. TTL stays
	 * generous: the user's contract is that manual Scan is the explicit refresh.
	 */
	private async isRemoteLocationFresh(
		libraryId: string,
		providerFolderId: string | null
	): Promise<boolean> {
		try {
			const parent: CatalogParentKey = providerFolderId === null || providerFolderId === '1'
				? 'root'
				: `folder:${providerFolderId}`;
			const children = await this.database.remote_folders
				.where('[librarySettingsId+parentKey]')
				.equals([libraryId, parent])
				.toArray();
			let newest = 0;
			for (const child of children) {
				const stamp = Date.parse(child.lastFetched ?? '');
				if (Number.isFinite(stamp) && stamp > newest) newest = stamp;
			}
			// Leaf folders list only comics, so their freshness lives on their OWN
			// row — and specifically on the stamp that means "contents fetched",
			// never the one that merely means "this row was written".
			if (providerFolderId !== null && providerFolderId !== '1') {
				const own = await this.database.remote_folders.get(`${libraryId}:${providerFolderId}`);
				const stamp = Date.parse(own?.contentsFetchedAt ?? '');
				if (Number.isFinite(stamp) && stamp > newest) newest = stamp;
			}
			if (newest === 0) return false;
			return Date.now() - newest < REMOTE_LOCATION_FRESHNESS_TTL_MS;
		} catch {
			return false;
		}
	}

	invalidateRemoteLocation(libraryId: string, remoteFolderId: string | null): void {
		this.hydratedRemoteLocations.delete(`${libraryId}:${remoteFolderId ?? 'root'}`);
		this.hydratedRemoteLocations.delete(`${libraryId}:${remoteFolderId ?? '1'}`);
	}

	/** Explicit user Scan/Sync. This is app-owned and survives view changes. */
	async syncLibrary(
		library: Library,
		location: { subfolder: string; remoteFolderId: string | null },
		onProgress?: (progress: CatalogSyncProgress) => void,
	): Promise<CatalogSyncResult> {
		return appWorkCoordinator.submit({
			kind: 'catalog-scan-sync',
			owner: 'user-command',
			// Background startup/index work deliberately serializes whole-library
			// maintenance in `catalog-maintenance`. An explicit command must not sit
			// behind a long crawl of another library; provider-specific coordinators
			// below still enforce per-library coalescing, transport serialization,
			// and IndexedDB write safety.
			lane: 'catalog-user-command',
			priority: 2,
			// Scoped and whole-library syncs are different requests and must never
			// coalesce into one another: the coordinator hands back the *existing*
			// task for a matching key, so a shared key would silently answer a
			// "refresh this folder" press with an unrelated crawl's promise.
			coalescingKey: `sync:${library.id}:${location.remoteFolderId ?? (location.subfolder || '*')}`,
			operation: async ({ signal }) => {
				if (isYACReaderLibrary(library)) {
					const [{ getOrCreateClient }, service] = await Promise.all([
						import('$lib/yacreader/yac-client-manager.js'),
						import('$lib/yacreader/yac-sync-service.js'),
					]);
					const client = getOrCreateClient(library.serverUrl);
					// Scope follows location. Pressed inside a folder, this means
					// "refresh what I am looking at" — a whole-library crawl there is
					// slow and leaves the visible folder untouched for most of its
					// run. At the library root there is no narrower scope to honour,
					// so the full reconcile still happens.
					if (location.remoteFolderId !== null) {
						// `manual: true` keeps this press from coalescing onto an
						// in-flight passive browse hydration of the same folder — the
						// likely case is exactly "the folder is slow, so the user
						// presses Scan while it is still loading", and joining that
						// task would resolve with data fetched before the press.
						// Progress and failures flow through: a folder crawl that
						// reconciles nothing must not report "up to date" silently.
						const result = await service.fetchRemoteFolderContents(
							client, library.id, library.remoteLibraryId,
							location.remoteFolderId, library.serverUrl,
							onProgress, { manual: true },
						);
						this.invalidateRemoteLocation(library.id, location.remoteFolderId);
						return {
							newComicCount: result.newComicCount,
							failureCount: result.diagnostics?.failures.length ?? 0,
						};
					}
					// `syncMode: browse` controls passive navigation hydration only; it
					// must not weaken this command.
					const count = await service.fullSyncLibrary(
						client, library.id, library.remoteLibraryId, library.serverUrl, onProgress,
						{ hydrateCovers: false },
					);
					this.invalidateRemoteLocation(library.id, location.remoteFolderId);
					return { newComicCount: count, failureCount: 0 };
				}
				if (isKomgaLibrary(library)) {
					const [{ loadKomgaCredentials }, { getOrCreateKomgaClient }, service] = await Promise.all([
						import('$lib/komga/komga-credentials.js'),
						import('$lib/komga/komga-client-manager.js'),
						import('$lib/komga/komga-sync-service.js'),
					]);
					const credentials = await loadKomgaCredentials(library.serverUrl);
					const client = getOrCreateKomgaClient(library.serverUrl, credentials.username, credentials.password);
					// Scope follows location (see the YACReader branch): a folder the
					// user is standing in wins over `syncMode`, which only expresses
					// what to do when there is no narrower scope.
					// `failureCount: 0` was hardcoded here for both of these
					// providers, so a sync that dropped half a library still told
					// the user "Library is up to date". YACReader always reported
					// its real count; these now do too.
					const outcome = library.syncMode === 'full' && location.remoteFolderId === null
						? await service.fullSyncKomgaLibrary(
							client, library.id, library.komgaLibraryId, library.serverUrl, onProgress,
							{ signal },
						)
						: await service.fetchKomgaFolderContents(
							client, library.id, library.komgaLibraryId,
							location.remoteFolderId, library.serverUrl, onProgress,
							{ signal },
						).then((result) => ({ imported: result.newComicCount, failures: result.failureCount }));
					this.invalidateRemoteLocation(library.id, location.remoteFolderId);
					return { newComicCount: outcome.imported, failureCount: outcome.failures };
				}
				if (isKavitaLibrary(library)) {
					const [{ loadKavitaApiKey }, { getOrCreateKavitaClient }, service] = await Promise.all([
						import('$lib/kavita/kavita-credentials.js'),
						import('$lib/kavita/kavita-client-manager.js'),
						import('$lib/kavita/kavita-sync-service.js'),
					]);
					const client = getOrCreateKavitaClient(library.serverUrl, await loadKavitaApiKey(library.serverUrl));
					// Scope follows location (see the YACReader branch).
					// See the Komga branch on the hardcoded failure count.
					const outcome = library.syncMode === 'full' && location.remoteFolderId === null
						? await service.fullSyncKavitaLibrary(
							client, library.id, library.kavitaLibraryId, library.serverUrl, onProgress,
							{ signal },
						)
						: await service.fetchKavitaFolderContents(
							client, library.id, library.kavitaLibraryId,
							location.remoteFolderId, library.serverUrl, onProgress,
							{ signal },
						).then((result) => ({ imported: result.newComicCount, failures: result.failureCount }));
					this.invalidateRemoteLocation(library.id, location.remoteFolderId);
					return { newComicCount: outcome.imported, failureCount: outcome.failures };
				}
				const { scanLibrary } = await import('$lib/library/library-scanner.js');
				const result = await scanLibrary(library.path, (progress) => onProgress?.({
					stage: progress.stage,
					current: progress.stage === 'scanning' ? progress.found : progress.imported,
					total: progress.stage === 'scanning' ? progress.found : progress.total,
					message: progress.stage === 'scanning'
						? { code: 'scan_found_archives', params: { n: progress.found } }
						: { code: 'scan_importing_file', params: { index: progress.imported + 1, total: progress.total, name: progress.currentFile } },
				}), library.id, location.subfolder || undefined);
				return { newComicCount: result.newImported, failureCount: result.failed.length };
			},
		}).promise;
	}

	destroy(): void {
		this.querySubscription?.unsubscribe();
		this.querySubscription = undefined;
		this.factsSubscription?.unsubscribe();
		this.factsSubscription = undefined;
		this.facts = undefined;
		this.locationSnapshots.clear();
		this.requestRevision += 1;
		this.remoteLocationController?.abort('catalog controller destroyed');
		this.remoteLocationController = undefined;
		this.remoteLocationTaskKey = undefined;
	}

	async loadThumbnailAssets(volumeUuids: readonly string[]): Promise<Map<string, MediaAsset>> {
		const assets = await this.database.media_assets.bulkGet(
			volumeUuids.map((uuid) => volumeThumbnailAssetId(uuid))
		);
		const result = new Map<string, MediaAsset>();
		for (let index = 0; index < volumeUuids.length; index += 1) {
			const asset = assets[index];
			if (asset) result.set(volumeUuids[index], asset);
		}
		const missing = volumeUuids.filter((uuid) => !result.has(uuid));
		if (missing.length > 0) {
			const volumes = await this.database.volumes.bulkGet(missing);
			for (let index = 0; index < missing.length; index += 1) {
				const volume = volumes[index];
				if (!volume?.thumbnail) continue;
				result.set(missing[index], makeMediaAsset({
					id: volumeThumbnailAssetId(missing[index]),
					ownerType: 'volume', ownerId: missing[index], kind: 'volume-thumbnail',
					blob: volume.thumbnail,
					width: volume.thumbnail_width,
					height: volume.thumbnail_height,
					revision: 'legacy-visible-fallback'
				}));
			}
		}
		return result;
	}

	/**
	 * Cache one remote folder cover in `media_assets`.
	 *
	 * YACReader covers are already persisted by its sync service, so the catalog
	 * reads them through `loadFolderCoverAssets`. Kavita and Komga had no
	 * equivalent: their covers were fetched from the server on every visit and
	 * thrown away, so scrolling a series grid re-downloaded PNGs it had already
	 * seen. Writing them to the same store the reader already consults closes
	 * that gap without introducing a second source of truth.
	 *
	 * The caller supplies the revision (derived from the folder's cover hash), so
	 * a server-side cover change still invalidates the cached copy.
	 */
	async storeFolderCoverAsset(input: {
		folderId: string;
		blob: Blob;
		revision: string;
		width?: number;
		height?: number;
	}): Promise<MediaAsset> {
		const asset = makeMediaAsset({
			id: folderCoverAssetId(input.folderId),
			ownerType: 'folder',
			ownerId: input.folderId,
			kind: 'folder-cover',
			blob: input.blob,
			width: input.width,
			height: input.height,
			revision: input.revision,
		});
		await this.database.media_assets.put(asset);
		return asset;
	}

	async loadFolderCoverAssets(folderIds: readonly string[]): Promise<Map<string, MediaAsset>> {
		const assets = await this.database.media_assets.bulkGet(folderIds.map(folderCoverAssetId));
		const result = new Map<string, MediaAsset>();
		for (let index = 0; index < folderIds.length; index += 1) {
			const asset = assets[index];
			if (asset) result.set(folderIds[index], asset);
		}
		const missing = folderIds.filter((id) => !result.has(id));
		if (missing.length > 0) {
			const folders = await this.database.remote_folders.bulkGet(missing);
			for (let index = 0; index < missing.length; index += 1) {
				const dataUrl = folders[index]?.coverThumbnailDataUrl;
				if (!dataUrl) continue;
				const response = await fetch(dataUrl);
				const blob = await response.blob();
				result.set(missing[index], makeMediaAsset({
					id: folderCoverAssetId(missing[index]), ownerType: 'folder', ownerId: missing[index],
					kind: 'folder-cover', blob, revision: 'legacy-visible-fallback',
				}));
			}
		}
		return result;
	}

	async loadLocalFolderCoverAssets(
		libraryId: string,
		currentSubfolder: string,
		folderNames: readonly string[],
	): Promise<Map<string, MediaAsset>> {
		const base = currentSubfolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		const remaining = new Set(folderNames);
		const volumeForFolder = new Map<string, string>();
		await this.database.catalog_rows.where('library_id').equals(libraryId).each((row) => {
			if (remaining.size === 0 || !row.thumbnail_asset_id || !row.folder_path) return;
			const path = row.folder_path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
			for (const folder of remaining) {
				const prefix = base ? `${base}/${folder}` : folder;
				if (path === prefix || path.startsWith(`${prefix}/`)) {
					volumeForFolder.set(folder, row.volume_uuid);
					remaining.delete(folder);
					break;
				}
			}
		});
		const folders = [...volumeForFolder.keys()];
		const assets = await this.database.media_assets.bulkGet(
			folders.map((folder) => volumeThumbnailAssetId(volumeForFolder.get(folder)!))
		);
		const result = new Map<string, MediaAsset>();
		for (let index = 0; index < folders.length; index += 1) {
			const asset = assets[index];
			if (asset) result.set(folders[index], asset);
		}
		return result;
	}

	private startQuery(locationChanged = false): void {
		this.startFactsQuery();
		this.querySubscription?.unsubscribe();
		const revision = ++this.requestRevision;
		const location = { ...this.location };
		const key = locationKey(location);
		if (locationChanged) {
			const cached = this.locationSnapshots.get(key);
			this.publish(cached
				? { phase: 'refreshing', data: cached, revision: this.snapshot.revision }
				: { phase: 'loading', revision: this.snapshot.revision });
		} else {
			this.publish(beginLoading(this.snapshot));
		}
		this.querySubscription = liveQuery(() => this.query(location)).subscribe({
			next: (data) => {
				if (revision !== this.requestRevision) return;
				this.rememberLocation(key, data);
				this.publish(readySnapshot(this.snapshot, data));
			},
			error: (error) => {
				if (revision !== this.requestRevision) return;
				this.publish(errorSnapshot(this.snapshot, error));
			}
		});
	}

	/**
	 * Long-lived companion query for the library-wide facts. Restarting the
	 * location query does not touch it; its emissions refresh the current
	 * location's counts (and restart the location query when a library's
	 * projected-path readiness changed, since that decides which tables the
	 * location query reads).
	 */
	private startFactsQuery(): void {
		if (this.factsSubscription) return;
		this.factsSubscription = liveQuery(() => this.queryCollectionFacts()).subscribe({
			next: (facts) => {
				const readinessChanged = this.facts !== undefined
					&& !setsEqual(this.facts.readyLibraries, facts.readyLibraries);
				this.facts = facts;
				if (readinessChanged) {
					this.startQuery();
					return;
				}
				// Merge fresh counts into whatever is currently published so the
				// library tiles stay live without re-running the location query.
				if (this.snapshot.data) {
					const merged = { ...this.snapshot.data, collectionCounts: facts.counts };
					this.rememberLocation(locationKey(this.snapshot.data.location), merged);
					this.publish({ ...this.snapshot, data: merged });
				}
			},
			error: (error) => {
				console.warn('[CatalogController] collection facts query failed:', error);
			}
		});
	}

	private async queryCollectionFacts(): Promise<CollectionFacts> {
		const counts: Record<string, number> = {};
		const states = await this.database.catalog_index_state.toArray();
		const stateByLibrary = new Map(states.map((state) => [state.library_id, state]));
		const readyLibraries = new Set(
			states.filter((state) => state.completeness === 'ready').map((state) => state.library_id)
		);
		const [projectedKeys, legacyKeys] = await Promise.all([
			this.database.catalog_rows.orderBy('library_id').uniqueKeys(),
			this.database.volumes.orderBy('library_id').uniqueKeys(),
		]);
		const libraryIds = new Set<string>([
			...states.map((state) => state.library_id),
			...projectedKeys.map(String),
			...legacyKeys.map(String),
		]);
		const unassignedState = stateByLibrary.get(UNASSIGNED_LIBRARY_ID);
		const shouldScanUnassignedLegacy = unassignedState?.completeness !== 'ready'
			&& (unassignedState !== undefined
				|| states.length === 0);
		const unassignedLegacyCount = shouldScanUnassignedLegacy
			? await this.database.volumes.filter((volume) => !volume.library_id).count()
			: 0;
		if (unassignedLegacyCount > 0) libraryIds.add(UNASSIGNED_LIBRARY_ID);
		const projectedCounts = new Map<string, number>();
		const legacyCounts = new Map<string, number>();
		await Promise.all([...libraryIds].flatMap((id) => [
			this.database.catalog_rows.where('library_id').equals(id).count()
				.then((count) => projectedCounts.set(id, count)),
			(id === UNASSIGNED_LIBRARY_ID
				? (shouldScanUnassignedLegacy
					? Promise.resolve(unassignedLegacyCount)
					: this.database.catalog_rows.where('library_id').equals(id).count())
				: this.database.volumes.where('library_id').equals(id).count())
				.then((count) => legacyCounts.set(id, count)),
		]));
		// Libraries created after the one-time migration have no migration state.
		// Activate their projection only when its count exactly matches legacy
		// metadata, which cannot accidentally activate a partial v15 migration.
		for (const id of libraryIds) {
			if (stateByLibrary.has(id)) continue;
			if ((legacyCounts.get(id) ?? 0) === (projectedCounts.get(id) ?? 0)) readyLibraries.add(id);
		}
		for (const id of readyLibraries) counts[id] = projectedCounts.get(id) ?? 0;
		// During resumable migration only, incomplete libraries remain on their
		// legacy metadata path. Their media is read separately for visible cards.
		for (const id of libraryIds) {
			if (!readyLibraries.has(id)) counts[id] = legacyCounts.get(id) ?? 0;
		}
		return {
			counts,
			readyLibraries,
			providerByLibrary: new Map(states.map((state) => [state.library_id, state.provider])),
		};
	}

	private async query(location: CatalogLocation): Promise<CatalogSnapshotData> {
		const libraryId = storedLibraryId(location.libraryId);
		// The facts companion query owns these; a navigation must not re-derive
		// them. Reading `this.facts` (a plain field) keeps this liveQuery free of
		// dependencies on the counts tables. Cold start races the two queries —
		// fall back to computing facts inline exactly once so first paint is
		// never blocked on ordering.
		const facts = this.facts ?? await this.queryCollectionFacts();
		const counts = facts.counts;
		const readyLibraries = facts.readyLibraries;

		let volumes: VolumeMetadata[] = [];
		const localSubfolderSet = new Set<string>();
		const flatten = location.flatten === true;
		if (libraryId !== null) {
			const key = parentKey(location);
			if (readyLibraries.has(libraryId)) {
				const rows = (await (flatten
					? this.database.catalog_rows.where('library_id').equals(libraryId)
					: this.database.catalog_rows.where('[library_id+parent_key]').equals([libraryId, key])
				).toArray())
					.filter((row) => row.visibility !== 'internal');
				volumes = rows.map(catalogRowToVolume);
				// Launch-time facts can lack this library entirely on a cold boot
				// (the first location load races the facts query): treat an UNKNOWN
				// provider as possibly-local rather than definitely-remote — the
				// live row count below still gates the scan, and remote rows carry
				// no folder_path so the scan is harmless for them.
				const factsProvider = facts.providerByLibrary.get(libraryId);
				const mayHaveLocalFolders = !flatten
					&& location.remoteFolderId === null
					&& (factsProvider === 'local'
						|| factsProvider === undefined
						|| rows.some((row) => !row.source || row.source.type === 'local'));
				// Live count, not facts.counts: launch-time facts can still read 0
				// on a cold boot (counts race the first location load), and 0 < 0
				// skipped this scan — a folders-only library then published an
				// empty listing that the snapshot cache pinned as last-good until
				// the next navigation. The index count is O(1); the gate's job is
				// only "do any rows live deeper than this level".
				const totalRows = mayHaveLocalFolders
					? await this.database.catalog_rows.where('library_id').equals(libraryId).count()
					: 0;
				if (mayHaveLocalFolders && rows.length < totalRows) {
					await this.database.catalog_rows.where('library_id').equals(libraryId).each((row) => {
						if (row.visibility === 'internal') return;
						const child = immediateLocalChild(row.folder_path, location.subfolder);
						if (child) localSubfolderSet.add(child);
					});
				}
			} else {
				const collection = libraryId === UNASSIGNED_LIBRARY_ID
					? this.database.volumes.filter((volume) => !volume.library_id)
					: this.database.volumes.where('library_id').equals(libraryId);
				await collection.each((volume) => {
					if (volume.visibility === 'internal') return;
					if (flatten || catalogParentKey(volume) === key) volumes.push(volume);
					if (flatten) return;
					const child = immediateLocalChild(volume.folder_path, location.subfolder);
					if (child) localSubfolderSet.add(child);
				});
			}
		}

		let remoteFolders: RemoteFolder[] = [];
		if (libraryId && libraryId !== UNASSIGNED_LIBRARY_ID) {
			const key = parentKey(location);
			// Flat mode lists no child folders — only the ancestor chain below,
			// which Back/breadcrumb resolution still needs.
			remoteFolders = flatten
				? []
				: await this.database.remote_folders
					.where('[librarySettingsId+parentKey]')
					.equals([libraryId, key])
					.toArray();
			// An ancestor is needed for Back/breadcrumb resolution, but unrelated
			// library folders and their embedded legacy media are not loaded.
			let ancestor = location.remoteFolderId;
			while (ancestor) {
				const folder = await this.database.remote_folders.get(`${libraryId}:${ancestor}`);
				if (!folder) break;
				if (!remoteFolders.some((candidate) => candidate.id === folder.id)) remoteFolders.push(folder);
				ancestor = folder.parentFolderId;
			}
		}
		const localSubfolders = [...localSubfolderSet].sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true })
		);
		return { location, volumes, localSubfolders, remoteFolders, collectionCounts: counts };
	}

	private publish(snapshot: LoadableSnapshot<CatalogSnapshotData>): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}

export const catalogController = new CatalogController();

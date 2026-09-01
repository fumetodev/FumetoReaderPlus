/**
 * Kavita sync service — imports metadata and covers from a Kavita server
 * into Fumeto's IndexedDB.
 *
 * Two sync strategies (same as Komga):
 * - Full Sync: fetch all series → volumes → chapters
 * - Browse Mode: fetch series list or chapters in a series on demand
 *
 * Kavita's hierarchy is Library → Series → Volume → Chapter, which maps to:
 * - Series → RemoteFolder entries (series act as "folders" in the catalog)
 * - Chapters → VolumeMetadata entries (chapters are the reading unit)
 *
 * Volumes in Kavita are intermediate grouping. We iterate all chapters across
 * all volumes and create one VolumeMetadata per chapter, with display name
 * combining volume + chapter info.
 */

import type { UserMessage } from '$lib/i18n/user-messages.js';
import { db } from '$lib/db/index.js';
import { markRemoteIndexComplete } from '$lib/catalog/catalog-repository.js';
import { assertLibraryWritable } from '$lib/catalog/remote-library-fence.js';
import { randomUUID } from '$lib/util/uuid.js';
import { putRemoteFolder, toCatalogRow, volumeThumbnailAsset, volumeThumbnailAssetId, volumeWithoutEmbeddedMedia } from '$lib/catalog/catalog-repository.js';
import type {
	VolumeMetadata,
	VolumeSource,
	PageDimensions,
	PageInfo,
	RemoteFolder
} from '$lib/types/index.js';
import type { KavitaServerClient } from './kavita-server-client.js';
import type { KavitaSeriesDto, KavitaVolumeDto, KavitaChapterDto } from './kavita-types.js';

// ============================================================
// Progress callback (same interface as Komga sync)
// ============================================================

export interface SyncProgress {
	stage: 'scanning' | 'importing' | 'covers' | 'done';
	current: number;
	total: number;
	/** What to show for this step, rendered by the caller in the live locale. */
	message: UserMessage;
}

export interface BrowseResult {
	folders: RemoteFolder[];
	newComicCount: number;
	/**
	 * Items that failed to import. Per-item failures used to be console.warn
	 * only, and the catalog controller hardcoded `failureCount: 0` for these two
	 * providers, so a sync that dropped half a library still told the user
	 * "Library is up to date". YACReader has always reported its real count.
	 */
	failureCount: number;
}

// ============================================================
// Full Sync — fetch all series and chapters
// ============================================================

/**
 * Sync an entire Kavita library.
 * Creates RemoteFolder for each series, VolumeMetadata + PageDimensions for each chapter.
 *
 * @returns Number of new chapters imported
 */
export async function fullSyncKavitaLibrary(
	client: KavitaServerClient,
	librarySettingsId: string,
	kavitaLibraryId: number,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: { signal?: AbortSignal } = {}
): Promise<{ imported: number; failures: number }> {
	// See the Komga service: a whole-library crawl runs for minutes, and both
	// user cancellation and a concurrent library delete used to be invisible.
	const checkpoint = () => {
		if (options.signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
		assertLibraryWritable(librarySettingsId);
	};
	checkpoint();
	onProgress?.({ stage: 'scanning', current: 0, total: 0, message: { code: 'sync_fetching_series_list' } });

	// Phase 1: Fetch all series
	let allSeries: KavitaSeriesDto[];
	try {
		allSeries = await client.fetchAllSeries(kavitaLibraryId);
	} catch (err) {
		// Rethrow. Resolving with 0 made an unreachable, misconfigured or
		// expired-credential server indistinguishable from an empty library —
		// and worse, it let the caller report SUCCESS, clearing the very signal
		// remote-sync-status exists to provide. A library with no reachable
		// listing is a failed sync, not an empty one.
		console.warn('[KavitaSync] Failed to fetch series list:', err);
		onProgress?.({ stage: 'done', current: 0, total: 0, message: { code: 'sync_fetch_series_failed' } });
		throw err;
	}

	onProgress?.({
		stage: 'scanning',
		current: allSeries.length,
		total: allSeries.length,
		message: { code: 'sync_found_series_fetching_chapters', params: { n: allSeries.length } }
	});

	// Phase 2: Create RemoteFolder for each series + collect all chapters
	const allChapters: {
		chapter: KavitaChapterDto;
		volume: KavitaVolumeDto;
		series: KavitaSeriesDto;
	}[] = [];

	// Per-series and per-chapter failures were console.warn only, so a sync that
	// dropped half a library still reported success.
	let failures = 0;

	for (const series of allSeries) {
		checkpoint();
		// Upsert series as remote folder
		await upsertKavitaSeriesAsFolder(series, librarySettingsId);

		// Fetch volumes (which contain chapters)
		try {
			const volumes = await client.fetchVolumes(series.id);
			for (const volume of volumes) {
				for (const chapter of volume.chapters) {
					allChapters.push({ chapter, volume, series });
				}
			}
		} catch (err) {
			failures++;
			console.warn(`[KavitaSync] Failed to fetch volumes for series "${series.name}":`, err);
		}

		onProgress?.({
			stage: 'scanning',
			current: allChapters.length,
			total: 0,
			message: { code: 'sync_found_chapters', params: { chapters: allChapters.length, series: allSeries.length } }
		});
	}

	if (allChapters.length === 0) {
		onProgress?.({ stage: 'done', current: 0, total: 0, message: { code: 'sync_no_chapters' } });
		return { imported: 0, failures };
	}

	// Phase 3: Import new chapters (dedup against existing)
	const existingVolumes = await db.volumes
		.where('library_id')
		.equals(librarySettingsId)
		.toArray();

	const existingChapterIds = new Set(
		existingVolumes
			.filter((v) => v.source?.type === 'kavita')
			.map((v) => (v.source as VolumeSource & { type: 'kavita' }).kavitaChapterId)
	);

	const newChapters = allChapters.filter((c) => !existingChapterIds.has(c.chapter.id));

	let imported = 0;

	for (const { chapter, volume, series } of newChapters) {
		const chapterName = buildChapterDisplayName(chapter, volume, series);
		onProgress?.({
			stage: 'importing',
			current: imported,
			total: newChapters.length,
			message: { code: 'sync_importing_item', params: { name: chapterName, index: imported + 1, total: newChapters.length } }
		});

		checkpoint();
		try {
			await syncKavitaChapter(
				client, chapter, volume, series,
				librarySettingsId, serverUrl, kavitaLibraryId, options.signal
			);
			imported++;
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') throw err;
			failures++;
			console.warn(`[KavitaSync] Failed to import chapter "${chapterName}":`, err);
		}
	}

	// Deletion propagation — see the Komga service for the rule and why absence
	// alone is not proof.
	if (failures === 0) {
		checkpoint();
		const seenChapterIds = new Set(allChapters.map(({ chapter }) => chapter.id));
		const stale = (await db.volumes.where('library_id').equals(librarySettingsId).toArray())
			.filter((volume) => volume.source?.type === 'kavita'
				&& !seenChapterIds.has((volume.source as VolumeSource & { type: 'kavita' }).kavitaChapterId));
		if (stale.length > 0) {
			const { pruneConfirmedDeletions } = await import('$lib/catalog/remote-prune.js');
			const { KavitaServerError } = await import('./kavita-types.js');
			// Interruptible and visible — see the Komga service.
			await pruneConfirmedDeletions(
				stale.map((volume) => ({
					volume,
					probe: () => client.fetchChapterInfo(
						(volume.source as VolumeSource & { type: 'kavita' }).kavitaChapterId
					)
				})),
				(error) => error instanceof KavitaServerError && error.type === 'not_found',
				{
					signal: options.signal,
					onProgress: (checked, total) => onProgress?.({
						stage: 'importing',
						current: checked,
						total,
						message: { code: 'sync_checking_removed_chapters', params: { checked, total } }
					})
				}
			);
		}
	}

	// Only a clean crawl stamps the startup gate, so a partial sync runs again.
	if (failures === 0) {
		checkpoint();
		await markRemoteIndexComplete(librarySettingsId, 'kavita');
	}

	onProgress?.({
		stage: 'done',
		current: imported,
		total: newChapters.length,
		message: { code: 'sync_complete_chapters', params: { n: imported } }
	});

	return { imported, failures };
}

// ============================================================
// Browse Mode — fetch series or chapters on demand
// ============================================================

/**
 * Fetch contents for a Kavita "folder" on demand.
 *
 * - folderId === null → root: fetch series list (creates RemoteFolder entries)
 * - folderId === seriesId → fetch volumes+chapters in that series (creates VolumeMetadata entries)
 */
export async function fetchKavitaFolderContents(
	client: KavitaServerClient,
	librarySettingsId: string,
	kavitaLibraryId: number,
	folderId: string | null,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: { signal?: AbortSignal } = {}
): Promise<BrowseResult> {
	// Browse hydration was entirely uncancellable for this provider, and its
	// WorkCoordinator lane has capacity 1 — so backing out of a series queued
	// the next folder behind the abandoned one's complete cover crawl, one HTTP
	// fetch and decode per new chapter. YACReader was fixed for exactly this.
	const throwIfCancelled = () => {
		if (options.signal?.aborted) throw new DOMException('Browse cancelled', 'AbortError');
		// Passive browse writes rows too, so it takes the same delete fence the
		// full sync does — see the Komga service.
		assertLibraryWritable(librarySettingsId);
	};
	throwIfCancelled();
	onProgress?.({
		stage: 'scanning',
		current: 0,
		total: 0,
		message: folderId ? { code: 'sync_fetching_chapters' } : { code: 'sync_fetching_series' }
	});

	if (folderId === null) {
		// Root: list all series as folders
		const series = await client.fetchAllSeries(kavitaLibraryId);
		const folders: RemoteFolder[] = [];

		for (const s of series) {
			// One folder row per series, so the check belongs INSIDE the loop: a
			// 500-series library writes 500 rows, and a delete landing partway
			// through would otherwise leave the tail under a librarySettingsId
			// nothing lists.
			throwIfCancelled();
			const folder = await upsertKavitaSeriesAsFolder(s, librarySettingsId);
			folders.push(folder);
		}

		onProgress?.({
			stage: 'done',
			current: 0,
			total: 0,
			message: { code: 'sync_found_series', params: { n: folders.length } }
		});

		return { folders, newComicCount: 0, failureCount: 0 };
	}

	// Series view: fetch volumes+chapters in the series
	const seriesId = parseInt(folderId, 10);
	const volumes = await client.fetchVolumes(seriesId);

	// Collect all chapters
	const chapters: { chapter: KavitaChapterDto; volume: KavitaVolumeDto }[] = [];
	for (const volume of volumes) {
		for (const chapter of volume.chapters) {
			chapters.push({ chapter, volume });
		}
	}

	// We need series info for building display names
	// Since we're browsing, we can build a minimal series object
	const seriesInfo: KavitaSeriesDto = {
		id: seriesId,
		name: '', // Will be filled from folder name
		localizedName: '',
		sortName: '',
		pages: 0,
		libraryId: kavitaLibraryId,
		pagesRead: 0
	};

	// Try to get the series name from the stored remote folder
	const folder = await db.remote_folders.get(`${librarySettingsId}:${folderId}`);
	if (folder) {
		seriesInfo.name = folder.name;
	}

	// Dedup against existing
	const existingVolumes = await db.volumes
		.where('library_id')
		.equals(librarySettingsId)
		.toArray();

	const existingChapterIds = new Set(
		existingVolumes
			.filter((v) => v.source?.type === 'kavita')
			.map((v) => (v.source as VolumeSource & { type: 'kavita' }).kavitaChapterId)
	);

	const newChapters = chapters.filter((c) => !existingChapterIds.has(c.chapter.id));

	let imported = 0;
	let failures = 0;
	for (const { chapter, volume } of newChapters) {
		const chapterName = buildChapterDisplayName(chapter, volume, seriesInfo);
		onProgress?.({
			stage: 'importing',
			current: imported,
			total: newChapters.length,
			message: { code: 'sync_importing_item', params: { name: chapterName, index: imported + 1, total: newChapters.length } }
		});

		// Outside the try, like the Komga browse loop: cancellation and the
		// delete fence are not per-item failures to be counted and ridden out.
		throwIfCancelled();
		try {
			await syncKavitaChapter(
				client, chapter, volume, seriesInfo,
				librarySettingsId, serverUrl, kavitaLibraryId, options.signal
			);
			imported++;
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') throw err;
			failures++;
			console.warn(`[KavitaSync] Failed to import chapter "${chapterName}":`, err);
		}
	}

	onProgress?.({
		stage: 'done',
		current: imported,
		total: newChapters.length,
		message: { code: 'sync_imported_chapters', params: { n: imported } }
	});

	// Same contract as Komga: the series' chapters are local now, so this
	// folder's contents have been fetched. See the comment there for why
	// `lastFetched` could not carry this.
	await db.remote_folders.update(`${librarySettingsId}:${folderId}`, {
		contentsFetchedAt: new Date().toISOString()
	});

	return { folders: [], newComicCount: imported, failureCount: failures };
}

// ============================================================
// Shared: Create a Fumeto volume from a Kavita chapter
// ============================================================

/**
 * Create a VolumeMetadata + PageDimensions entry for a Kavita chapter.
 * Fetches the chapter cover and generates a thumbnail.
 */
async function syncKavitaChapter(
	client: KavitaServerClient,
	chapter: KavitaChapterDto,
	volume: KavitaVolumeDto,
	series: KavitaSeriesDto,
	librarySettingsId: string,
	serverUrl: string,
	kavitaLibraryId: number,
	signal?: AbortSignal
): Promise<VolumeMetadata> {
	// No existence check here — see the note in komga-sync-service: both callers
	// already dedup against a set built from one read, so this was a per-chapter
	// full-table deserialize of the whole library.

	const volumeUuid = randomUUID();

	// Build display name
	const title = buildChapterDisplayName(chapter, volume, series);

	// Fetch chapter cover
	let thumbnail: Blob | undefined;
	let thumbnailWidth: number | undefined;
	let thumbnailHeight: number | undefined;

	try {
		const coverBlob = await client.fetchChapterCover(chapter.id, signal);
		const result = await generateThumbnailFromBlob(coverBlob);
		thumbnail = result.blob;
		thumbnailWidth = result.width;
		thumbnailHeight = result.height;
	} catch (err) {
		console.warn(`[KavitaSync] Failed to fetch cover for chapter ${chapter.id}:`, err);
	}

	const source: VolumeSource = {
		type: 'kavita',
		serverUrl,
		kavitaLibraryId,
		kavitaSeriesId: series.id,
		kavitaVolumeId: volume.id,
		kavitaChapterId: chapter.id,
		remoteFolderId: String(series.id)
	};

	const metadata: VolumeMetadata = {
		volume_uuid: volumeUuid,
		title,
		filename: title,
		page_count: chapter.pages,
		created_at: new Date().toISOString(),
		current_page: 0,
		thumbnail,
		thumbnail_width: thumbnailWidth,
		thumbnail_height: thumbnailHeight,
		// Kavita's API exposes no per-series direction, so this inherits the
		// user's global default rather than pinning a guess to every volume.
		library_id: librarySettingsId,
		source
	};

	// Create placeholder page dimensions
	const pages: PageInfo[] = [];
	for (let i = 0; i < chapter.pages; i++) {
		pages.push({
			index: i,
			width: 0,
			height: 0,
			filename: `page_${i}`
		});
	}

	const pageDimensions: PageDimensions = {
		volume_uuid: volumeUuid,
		pages
	};

	// Store both in a transaction
	await db.transaction('rw', [db.volumes, db.page_dimensions, db.catalog_rows, db.media_assets], async () => {
		await db.volumes.put(volumeWithoutEmbeddedMedia(metadata));
		await db.page_dimensions.put(pageDimensions);
		await db.catalog_rows.put(toCatalogRow(metadata));
		const asset = volumeThumbnailAsset(metadata);
		if (asset) await db.media_assets.put(asset);
		else await db.media_assets.delete(volumeThumbnailAssetId(volumeUuid));
	});

	return metadata;
}

// ============================================================
// Display name builder
// ============================================================

/**
 * Build a display name for a chapter.
 * - Single-volume series: just chapter title/number
 * - Multi-volume: "Vol. X - Chapter Y" or "Vol. X - Title"
 */
function buildChapterDisplayName(
	chapter: KavitaChapterDto,
	volume: KavitaVolumeDto,
	series: KavitaSeriesDto
): string {
	const chapterLabel = chapter.title
		? chapter.title
		: chapter.number !== '0'
			? `Chapter ${chapter.number}`
			: chapter.range || 'Chapter';

	// If volume name is meaningful (not "0" or empty)
	const hasVolumeName = volume.name && volume.name !== '0';

	if (hasVolumeName) {
		return `${volume.name} - ${chapterLabel}`;
	}

	return chapterLabel;
}

// ============================================================
// Series → RemoteFolder mapping
// ============================================================

/**
 * Upsert a Kavita series as a RemoteFolder entry.
 * Series are flat (no nesting), so parentFolderId is always null.
 */
async function upsertKavitaSeriesAsFolder(
	series: KavitaSeriesDto,
	librarySettingsId: string
): Promise<RemoteFolder> {
	const entry: RemoteFolder = {
		id: `${librarySettingsId}:${series.id}`,
		librarySettingsId,
		remoteLibraryId: 0, // Not used for Kavita (library ID stored on KavitaLibrary)
		remoteFolderId: String(series.id),
		name: series.name || series.localizedName,
		parentFolderId: null, // Series are always top-level
		numChildren: series.pages, // Total pages in series
		coverHash: String(series.id), // Used for thumbnail lookup
		lastFetched: new Date().toISOString()
	};

	await putRemoteFolder(entry);
	return entry;
}

// ============================================================
// Thumbnail generation from Blob
// ============================================================

/**
 * Generate a thumbnail from a cover Blob.
 * Resizes to fit within maxSize while maintaining aspect ratio.
 */
async function generateThumbnailFromBlob(
	blob: Blob,
	maxSize: number = 200
): Promise<{ blob: Blob; width: number; height: number }> {
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();

		const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
		const width = Math.round(img.naturalWidth * scale);
		const height = Math.round(img.naturalHeight * scale);

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0, width, height);

		const result = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
		return { blob: result, width, height };
	} finally {
		URL.revokeObjectURL(url);
	}
}


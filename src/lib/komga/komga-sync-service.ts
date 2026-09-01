/**
 * Komga sync service — imports metadata and covers from a Komga server
 * into Fumeto's IndexedDB.
 *
 * Two sync strategies (same as YACReader):
 * - Full Sync: fetch all series + all books in each series
 * - Browse Mode: fetch series list or books in a series on demand
 *
 * Komga's hierarchy is Library → Series → Book, which maps to:
 * - Series → RemoteFolder entries (series act as "folders" in the catalog)
 * - Books → VolumeMetadata entries
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
import type { KomgaServerClient } from './komga-server-client.js';
import type { KomgaSeries, KomgaBook } from './komga-types.js';

// ============================================================
// Progress callback (reuses same interface shape as YACReader sync)
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
// Full Sync — fetch all series and books
// ============================================================

/**
 * Sync an entire Komga library.
 * Creates RemoteFolder for each series, VolumeMetadata + PageDimensions for each book.
 *
 * @returns Number of new books imported
 */
export async function fullSyncKomgaLibrary(
	client: KomgaServerClient,
	librarySettingsId: string,
	komgaLibraryId: string,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: { signal?: AbortSignal } = {}
): Promise<{ imported: number; failures: number }> {
	// A whole-library crawl runs for minutes. Two things can invalidate it
	// mid-flight and both used to be invisible here: the user cancelling, and
	// the library being deleted underneath it.
	const checkpoint = () => {
		if (options.signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
		assertLibraryWritable(librarySettingsId);
	};
	checkpoint();
	onProgress?.({ stage: 'scanning', current: 0, total: 0, message: { code: 'sync_fetching_series_list' } });

	// Phase 1: Fetch all series
	let allSeries: KomgaSeries[];
	try {
		allSeries = await client.fetchAllSeries(komgaLibraryId);
	} catch (err) {
		// Rethrow. Resolving with 0 made an unreachable, misconfigured or
		// expired-credential server indistinguishable from an empty library —
		// and worse, it let the caller report SUCCESS, clearing the very signal
		// remote-sync-status exists to provide. A library with no reachable
		// listing is a failed sync, not an empty one.
		console.warn('[KomgaSync] Failed to fetch series list:', err);
		onProgress?.({ stage: 'done', current: 0, total: 0, message: { code: 'sync_fetch_series_failed' } });
		throw err;
	}

	onProgress?.({
		stage: 'scanning',
		current: allSeries.length,
		total: allSeries.length,
		message: { code: 'sync_found_series_fetching_books', params: { n: allSeries.length } }
	});

	// Phase 2: Create RemoteFolder for each series + collect all books
	const allBooks: { book: KomgaBook; seriesId: string }[] = [];
	// Per-series and per-book failures were console.warn only, so a sync that
	// dropped half a library still reported success.
	let failures = 0;

	for (const series of allSeries) {
		checkpoint();
		// Upsert series as remote folder
		await upsertKomgaSeriesAsFolder(series, librarySettingsId);

		// Fetch all books in this series
		try {
			const books = await client.fetchAllBooks(series.id);
			for (const book of books) {
				allBooks.push({ book, seriesId: series.id });
			}
		} catch (err) {
			failures++;
			console.warn(`[KomgaSync] Failed to fetch books for series "${series.name}":`, err);
		}

		onProgress?.({
			stage: 'scanning',
			current: allBooks.length,
			total: 0,
			message: { code: 'sync_found_books', params: { books: allBooks.length, series: allSeries.length } }
		});
	}

	if (allBooks.length === 0) {
		onProgress?.({ stage: 'done', current: 0, total: 0, message: { code: 'sync_no_books' } });
		return { imported: 0, failures };
	}

	// Phase 3: Import new books (dedup against existing)
	const existingVolumes = await db.volumes
		.where('library_id')
		.equals(librarySettingsId)
		.toArray();

	const existingBookIds = new Set(
		existingVolumes
			.filter((v) => v.source?.type === 'komga')
			.map((v) => (v.source as VolumeSource & { type: 'komga' }).komgaBookId)
	);

	const newBooks = allBooks.filter((b) => !existingBookIds.has(b.book.id));

	let imported = 0;

	for (const { book, seriesId } of newBooks) {
		onProgress?.({
			stage: 'importing',
			current: imported,
			total: newBooks.length,
			message: { code: 'sync_importing_item', params: { name: book.metadata.title || book.name, index: imported + 1, total: newBooks.length } }
		});

		checkpoint();
		try {
			await syncKomgaBook(client, book, librarySettingsId, serverUrl, komgaLibraryId, seriesId, options.signal);
			imported++;
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') throw err;
			failures++;
			console.warn(`[KomgaSync] Failed to import book "${book.name}":`, err);
		}
	}

	// Deletion propagation, on this whole-library path only. Komga was strictly
	// add-only: a book deleted on the server stayed in the catalog forever and
	// 404'd when opened. Absence from the crawl only nominates — a book that
	// merely moved series is still there — so each candidate is probed and only
	// a confirmed not-found is deleted. Gated on a clean crawl for the same
	// reason the startup stamp is: a partial listing is not evidence of absence.
	if (failures === 0) {
		checkpoint();
		const seenBookIds = new Set(allBooks.map(({ book }) => book.id));
		const stale = (await db.volumes.where('library_id').equals(librarySettingsId).toArray())
			.filter((volume) => volume.source?.type === 'komga'
				&& !seenBookIds.has((volume.source as VolumeSource & { type: 'komga' }).komgaBookId));
		if (stale.length > 0) {
			const { pruneConfirmedDeletions } = await import('$lib/catalog/remote-prune.js');
			const { KomgaServerError } = await import('./komga-types.js');
			// One sequential HTTP probe per candidate, so it must be both
			// interruptible and visible: a library that has drifted far from the
			// server can nominate hundreds, and a silent uncancellable stall at the
			// end of a Scan reads to the user as a hang.
			await pruneConfirmedDeletions(
				stale.map((volume) => ({
					volume,
					probe: () => client.fetchBook(
						(volume.source as VolumeSource & { type: 'komga' }).komgaBookId
					)
				})),
				(error) => error instanceof KomgaServerError && error.type === 'not_found',
				{
					signal: options.signal,
					onProgress: (checked, total) => onProgress?.({
						stage: 'importing',
						current: checked,
						total,
						message: { code: 'sync_checking_removed_books', params: { checked, total } }
					})
				}
			);
		}
	}

	// Only a clean crawl stamps the startup gate, so a partial sync runs again.
	if (failures === 0) {
		checkpoint();
		await markRemoteIndexComplete(librarySettingsId, 'komga');
	}

	onProgress?.({
		stage: 'done',
		current: imported,
		total: newBooks.length,
		message: { code: 'sync_complete_books', params: { n: imported } }
	});

	return { imported, failures };
}

// ============================================================
// Browse Mode — fetch series or books on demand
// ============================================================

/**
 * Fetch contents for a Komga "folder" on demand.
 *
 * - folderId === null → root: fetch series list (creates RemoteFolder entries)
 * - folderId === seriesId → fetch books in that series (creates VolumeMetadata entries)
 */
export async function fetchKomgaFolderContents(
	client: KomgaServerClient,
	librarySettingsId: string,
	komgaLibraryId: string,
	folderId: string | null,
	serverUrl: string,
	onProgress?: (progress: SyncProgress) => void,
	options: { signal?: AbortSignal } = {}
): Promise<BrowseResult> {
	// Browse hydration was entirely uncancellable for this provider, and its
	// WorkCoordinator lane has capacity 1 — so backing out of a series queued
	// the next folder behind the abandoned one's complete cover crawl, one HTTP
	// fetch and decode per new book. YACReader was fixed for exactly this.
	const throwIfCancelled = () => {
		if (options.signal?.aborted) throw new DOMException('Browse cancelled', 'AbortError');
		// Passive browse writes rows too, so it needs the same delete fence the
		// full sync takes. Without it, opening a series while the library is
		// being removed strands volumes under a library_id nothing lists.
		assertLibraryWritable(librarySettingsId);
	};
	throwIfCancelled();
	onProgress?.({
		stage: 'scanning',
		current: 0,
		total: 0,
		message: folderId ? { code: 'sync_fetching_books' } : { code: 'sync_fetching_series' }
	});

	if (folderId === null) {
		// Root: list all series as folders
		const series = await client.fetchAllSeries(komgaLibraryId);
		const folders: RemoteFolder[] = [];

		for (const s of series) {
			// One folder row per series, so the check belongs INSIDE the loop: a
			// 500-series library writes 500 rows, and a delete landing partway
			// through would otherwise leave the tail under a librarySettingsId
			// nothing lists.
			throwIfCancelled();
			const folder = await upsertKomgaSeriesAsFolder(s, librarySettingsId);
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

	// Series view: fetch books in the series
	const books = await client.fetchAllBooks(folderId);

	// Dedup against existing
	const existingVolumes = await db.volumes
		.where('library_id')
		.equals(librarySettingsId)
		.toArray();

	const existingBookIds = new Set(
		existingVolumes
			.filter((v) => v.source?.type === 'komga')
			.map((v) => (v.source as VolumeSource & { type: 'komga' }).komgaBookId)
	);

	const newBooks = books.filter((b) => !existingBookIds.has(b.id));

	let imported = 0;
	let failures = 0;
	for (const book of newBooks) {
		onProgress?.({
			stage: 'importing',
			current: imported,
			total: newBooks.length,
			message: { code: 'sync_importing_item', params: { name: book.metadata.title || book.name, index: imported + 1, total: newBooks.length } }
		});

		throwIfCancelled();
		try {
			await syncKomgaBook(client, book, librarySettingsId, serverUrl, komgaLibraryId, folderId, options.signal);
			imported++;
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') throw err;
			failures++;
			console.warn(`[KomgaSync] Failed to import book "${book.name}":`, err);
		}
	}

	onProgress?.({
		stage: 'done',
		current: imported,
		total: newBooks.length,
		message: { code: 'sync_imported_books', params: { n: imported } }
	});

	// The series' books are now local, so this folder's CONTENTS have been
	// fetched — the thing freshness must key on. `lastFetched` was written for
	// every series the moment the root was listed, so a series nobody had opened
	// looked fetched; for these providers series are flat, so there were also no
	// child rows to contradict it, and browse mode never fetched any books at
	// all. A failed fetch throws above this line and leaves the stamp unset, so
	// the next visit retries.
	await db.remote_folders.update(`${librarySettingsId}:${folderId}`, {
		contentsFetchedAt: new Date().toISOString()
	});

	// No new folders from a series view (series are the leaf folders)
	return { folders: [], newComicCount: imported, failureCount: failures };
}

// ============================================================
// Shared: Create a Fumeto volume from a Komga book
// ============================================================

/**
 * Create a VolumeMetadata + PageDimensions entry for a Komga book.
 * Fetches the book thumbnail and generates a cover.
 */
async function syncKomgaBook(
	client: KomgaServerClient,
	book: KomgaBook,
	librarySettingsId: string,
	serverUrl: string,
	komgaLibraryId: string,
	seriesId: string,
	signal?: AbortSignal
): Promise<VolumeMetadata> {
	// No existence check here. Both callers already filter against an
	// `existingBookIds` set built from ONE read of the library, so this was a
	// second, per-book full-table deserialize of every volume in the library —
	// O(n²) over a sync. `volumes` is indexed on `volume_uuid, library_id` only,
	// with nothing on the source ids, so no index could have rescued it: a
	// 5000-book library meant ~12.5 M row reads, on every sync, not just the
	// first.

	const volumeUuid = randomUUID();

	// Derive title: use metadata title, or book name
	const title = book.metadata.title || book.name;

	// Fetch book thumbnail
	let thumbnail: Blob | undefined;
	let thumbnailWidth: number | undefined;
	let thumbnailHeight: number | undefined;

	try {
		const coverBlob = await client.fetchBookThumbnail(book.id, signal);
		const result = await generateThumbnailFromBlob(coverBlob);
		thumbnail = result.blob;
		thumbnailWidth = result.width;
		thumbnailHeight = result.height;
	} catch (err) {
		console.warn(`[KomgaSync] Failed to fetch cover for "${book.name}":`, err);
	}

	// Komga's book payload carries no reading-direction field. The old
	// heuristic here — "has a series title, therefore manga" — classified
	// essentially every book as RTL and was never actually "refined below".
	// Leaving it unset lets the user's global default apply instead.

	const source: VolumeSource = {
		type: 'komga',
		serverUrl,
		komgaLibraryId,
		komgaBookId: book.id,
		remoteFolderId: seriesId
	};

	// Extract author from book metadata
	const writer = book.metadata.authors?.find(
		(a) => a.role === 'writer' || a.role === 'author'
	);

	const metadata: VolumeMetadata = {
		volume_uuid: volumeUuid,
		title,
		filename: book.name,
		page_count: book.media.pagesCount,
		created_at: new Date().toISOString(),
		current_page: 0,
		thumbnail,
		thumbnail_width: thumbnailWidth,
		thumbnail_height: thumbnailHeight,
		author: writer?.name || undefined,
		library_id: librarySettingsId,
		source
	};

	// Create placeholder page dimensions
	const pages: PageInfo[] = [];
	for (let i = 0; i < book.media.pagesCount; i++) {
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
// Series → RemoteFolder mapping
// ============================================================

/**
 * Upsert a Komga series as a RemoteFolder entry.
 * Series are flat (no nesting), so parentFolderId is always null.
 */
async function upsertKomgaSeriesAsFolder(
	series: KomgaSeries,
	librarySettingsId: string
): Promise<RemoteFolder> {
	const entry: RemoteFolder = {
		id: `${librarySettingsId}:${series.id}`,
		librarySettingsId,
		remoteLibraryId: 0, // Not used for Komga (library ID is string)
		remoteFolderId: series.id,
		name: series.metadata.title || series.name,
		parentFolderId: null, // Series are always top-level
		numChildren: series.booksCount,
		coverHash: series.id, // Used for thumbnail URL construction
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


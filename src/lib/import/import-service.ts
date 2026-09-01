/**
 * Unified import service for Fumeto.
 *
 * Handles the full import pipeline:
 * 1. Detect archive type
 * 2. Extract images
 * 3. Compute page dimensions
 * 4. Generate thumbnail
 * 5. Store in IndexedDB
 */

import * as m from '$lib/paraglide/messages.js';
import type { UserMessage } from '$lib/i18n/user-messages.js';
import Dexie from 'dexie';
import { randomUUID } from '$lib/util/uuid.js';
import { tabPreviewAssetId, toCatalogRow, volumeThumbnailAsset, volumeThumbnailAssetId, volumeWithoutEmbeddedMedia, deleteVolumeRowsInTransaction, volumeScopedTables } from '$lib/catalog/catalog-repository.js';
import { db } from '$lib/db/index.js';
import type { LibraryImport, VolumeMetadata, VolumeFiles, PageDimensions, PageInfo } from '$lib/types/index.js';
import { getArchiveType } from './types.js';
import { beginVolumeImport } from './import-registry.js';
import { extractFirstZipImage, streamZipArchivePages, type StreamedPage } from './archive-extraction.js';
import { isMobile } from '$lib/util/platform.js';
import { copyFileToLibrary, tryDeleteFile } from '$lib/util/file-utils.js';
import { scanLibrary, type ScanResult } from '$lib/library/library-scanner.js';
import { revokeThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
import { naturalCompare } from '$lib/util/natural-sort.js';

export const IMPORT_THUMBNAIL_MAX_SIZE = 512;
export const IMPORT_THUMBNAIL_JPEG_QUALITY = 0.92;
export const IMPORT_THUMBNAIL_GENERATION_VERSION = 2;

interface ImportArchiveOptions {
	/** Reuse a volume identity and user-maintained metadata during a safe reimport. */
	existingMetadata?: VolumeMetadata;
	/** Clear page-content-derived records because the archive bytes changed. */
	clearDerivedData?: boolean;
	/**
	 * Pin a per-volume reading direction instead of following the global
	 * default. Only for callers that genuinely know — the bundled manga sample
	 * does; a user importing an arbitrary file does not.
	 */
	readingDirection?: 'rtl' | 'ltr';
	/**
	 * Commit the library_imports row inside the import's own transaction.
	 *
	 * The scanner used to write it afterwards, in a separate call. Between the
	 * two, the volume exists with no import record — and the next scan matches
	 * archives to imports by path, so an unmatched archive is re-imported under
	 * a FRESH uuid, leaving a permanent duplicate in the catalog. The orphan can
	 * never enter the deleted set (that is derived from import records), and
	 * deleteVolume resolves the physical file through library_imports, so
	 * deleting the duplicate cannot delete the file either. Nothing sweeps in
	 * this direction; the scan only sweeps import records whose volume is gone.
	 * The realistic trigger is not a crash but the put itself throwing — quota
	 * pressure right after writing a volume's worth of page blobs.
	 */
	importRecord?: Omit<LibraryImport, 'volume_uuid'>;
}

/** Generate a UUID v4 */
function generateUUID(): string {
	return randomUUID();
}

/** Natural sort comparator — shared so page order matches reader/migration. */
const naturalSortCompare = naturalCompare;

/** Progress info emitted during import */
export interface ImportProgress {
	stage: 'extracting' | 'processing' | 'storing';
	current: number;
	total: number;
	message: UserMessage;
}

/**
 * Compute page-media dimensions by decoding it. Images go through the
 * browser's Image.decode() API; video pages probe loadedmetadata via the
 * shared (decoder-queue-serialized) video-poster utility.
 */
async function getPageMediaDimensions(file: File): Promise<{ width: number; height: number }> {
	if (file.type.startsWith('video/')) {
		const { probeVideoDimensions } = await import('$lib/util/video-poster.js');
		return probeVideoDimensions(file);
	}
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		return { width: img.naturalWidth, height: img.naturalHeight };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Generate a thumbnail from a page image.
 * Resizes to fit within maxSize while maintaining aspect ratio.
 */
export async function generateImportThumbnail(
	file: File,
	maxSize: number = IMPORT_THUMBNAIL_MAX_SIZE
): Promise<{ blob: Blob; width: number; height: number }> {
	// Video page as the cover source (video-first volume): thumbnail from the
	// poster frame, downscaled through the same canvas path as images.
	if (file.type.startsWith('video/')) {
		const { captureVideoPosterFrame } = await import('$lib/util/video-poster.js');
		const bitmap = await captureVideoPosterFrame(file);
		try {
			const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height, 1);
			const width = Math.round(bitmap.width * scale);
			const height = Math.round(bitmap.height * scale);
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Unable to create thumbnail canvas context');
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(bitmap, 0, 0, width, height);
			const blob = await canvas.convertToBlob({
				type: 'image/jpeg',
				quality: IMPORT_THUMBNAIL_JPEG_QUALITY,
			});
			return { blob, width, height };
		} finally {
			bitmap.close();
		}
	}

	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();

		const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
		const width = Math.round(img.naturalWidth * scale);
		const height = Math.round(img.naturalHeight * scale);
		const preservesUsefulOriginal =
			scale === 1 &&
			(file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp');

		if (preservesUsefulOriginal) {
			return { blob: file, width, height };
		}

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Unable to create thumbnail canvas context');
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(img, 0, 0, width, height);

		const blob = await canvas.convertToBlob({
			type: 'image/jpeg',
			quality: IMPORT_THUMBNAIL_JPEG_QUALITY,
		});
		return { blob, width, height };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Resolve the actual first reader page from the split local-volume records.
 * Page dimensions are authoritative for reader order; natural filename order
 * is used only for old records that predate that table.
 */
export function selectStoredFirstPage(
	volumeFiles: VolumeFiles | undefined,
	pageDimensions: PageDimensions | undefined,
): File | undefined {
	if (!volumeFiles) return undefined;
	const orderedPages = pageDimensions?.pages
		.slice()
		.sort((a, b) => a.index - b.index);
	if (orderedPages?.length) {
		return volumeFiles.files[orderedPages[0].filename];
	}

	const firstFilename = Object.keys(volumeFiles.files).sort(naturalSortCompare)[0];
	return firstFilename ? volumeFiles.files[firstFilename] : undefined;
}

/** Extract exactly one cover page when the stored reader page is unavailable. */
export async function extractArchiveFirstPage(archive: File): Promise<File> {
	const archiveType = getArchiveType(archive.name);
	if (!archiveType) throw new Error(`Unsupported archive format: ${archive.name}`);

	let page: File | undefined;
	switch (archiveType) {
		case 'rar': {
			if (isMobile) {
				throw new Error('RAR/CBR files are not supported on mobile. Please use ZIP/CBZ format.');
			}
			const { extractFirstRarImage } = await import('./archive-extraction-rar.js');
			page = await extractFirstRarImage(archive);
			break;
		}
		case 'pdf': {
			const { extractFirstPdfPage } = await import('./archive-extraction-pdf.js');
			page = await extractFirstPdfPage(archive);
			break;
		}
		case 'epub': {
			const { extractFirstEpubImage } = await import('./archive-extraction-epub.js');
			page = await extractFirstEpubImage(archive);
			break;
		}
		case 'zip':
			page = await extractFirstZipImage(archive);
			break;
	}

	if (!page) throw new Error('No images found in archive.');
	return page;
}

/**
 * Regenerate only a legacy cover, preserving all page and derived records.
 *
 * Thumbnail generation runs outside the write transaction. The transaction
 * then re-reads the current record and performs a field-level update, so a
 * long decode/extraction cannot replace concurrent title, tags, reading
 * progress, folder, source, or other metadata edits with a stale snapshot.
 * A concurrent migration that already wrote the current recipe wins.
 *
 * @returns true only when this call committed the upgrade.
 */
export async function upgradeLegacyImportThumbnail(
	volumeUuid: string,
	getFallbackArchive: () => Promise<File>,
): Promise<boolean> {
	const startingVolume = await db.volumes.get(volumeUuid);
	if (!startingVolume) throw new Error('The legacy thumbnail no longer has a volume record');
	if (startingVolume.thumbnail_generation_version === IMPORT_THUMBNAIL_GENERATION_VERSION) {
		return false;
	}

	const [volumeFiles, pageDimensions, firstPageRow] = await Promise.all([
		db.volume_files.get(volumeUuid),
		db.page_dimensions.get(volumeUuid),
		db.volume_pages.get([volumeUuid, 0]),
	]);
	const storedFirstPage = firstPageRow?.file ?? selectStoredFirstPage(volumeFiles, pageDimensions);
	const sourcePage = storedFirstPage ?? await extractArchiveFirstPage(await getFallbackArchive());
	const thumbnail = await generateImportThumbnail(sourcePage);

	let committed = false;
	await db.transaction('rw', [db.volumes, db.catalog_rows, db.media_assets], async () => {
		const currentVolume = await db.volumes.get(volumeUuid);
		if (!currentVolume) throw new Error('The legacy thumbnail volume was deleted during migration');
		if (currentVolume.thumbnail_generation_version === IMPORT_THUMBNAIL_GENERATION_VERSION) {
			return;
		}

		const coverChanges: Partial<VolumeMetadata> = {
			thumbnail: thumbnail.blob,
			thumbnail_width: thumbnail.width,
			thumbnail_height: thumbnail.height,
			thumbnail_generation_version: IMPORT_THUMBNAIL_GENERATION_VERSION,
		};
		const next: VolumeMetadata = { ...currentVolume, ...coverChanges };
		await db.volumes.update(volumeUuid, {
			...coverChanges,
			thumbnail: undefined,
			thumbnail_width: undefined,
			thumbnail_height: undefined,
		});
		await db.catalog_rows.put(toCatalogRow(next));
		await db.media_assets.put(volumeThumbnailAsset(next)!);
		committed = true;
	});

	if (committed) revokeThumbnailUrl(volumeUuid);
	return committed;
}

/**
 * Import a manga archive (ZIP/CBZ/RAR/CBR/PDF) into Fumeto.
 *
 * @param file - The archive file to import
 * @param onProgress - Optional progress callback
 * @returns The UUID of the imported volume
 */
export async function importArchive(
	file: File,
	onProgress?: (progress: ImportProgress) => void,
	libraryId?: string,
	folderPath?: string,
	options?: ImportArchiveOptions,
): Promise<string> {
	// The uuid is minted here rather than inside the body so the sweep guard is
	// registered before the first page row is written — a guard installed after
	// streaming starts would leave the same hole it exists to close.
	const volumeUuid = options?.existingMetadata?.volume_uuid ?? generateUUID();
	const endImport = beginVolumeImport(volumeUuid);
	try {
		return await runImportArchive(file, volumeUuid, onProgress, libraryId, folderPath, options);
	} finally {
		endImport();
	}
}

async function runImportArchive(
	file: File,
	volumeUuid: string,
	onProgress?: (progress: ImportProgress) => void,
	libraryId?: string,
	folderPath?: string,
	options?: ImportArchiveOptions,
): Promise<string> {
	const archiveType = getArchiveType(file.name);

	if (!archiveType) {
		throw new Error(`Unsupported archive format: ${file.name}`);
	}

	// EPUBs route through a classifier before any extraction: image comics
	// continue through the normal page pipeline; reflowable text ebooks take
	// the book path — stored whole in book_files, no page rows, read by the
	// foliate BookReader. Runs before any streaming so a failed book parse
	// leaves no trace.
	let epubDirection: 'rtl' | 'ltr' | undefined;
	if (archiveType === 'epub') {
		const { classifyEpub } = await import('./epub-metadata.js');
		const classification = await classifyEpub(file);
		if (classification.verdict === 'reflowable') {
			const { importReflowableBook } = await import('./import-book.js');
			return await importReflowableBook(file, volumeUuid, {
				onProgress,
				libraryId,
				folderPath,
				existingMetadata: options?.existingMetadata,
				readingDirection: options?.readingDirection,
				classification
			});
		}
		epubDirection = classification.metadata.pageProgressionDirection;
	}

	// Steps 1+2: Stream pages out of the archive one at a time, persisting a
	// volume_pages row and capturing dimensions per page before the next page
	// is inflated. Peak memory ≈ archive + one page (v17, report L2), instead
	// of archive + every decompressed page.
	onProgress?.({
		stage: 'extracting',
		current: 0,
		total: 1,
		message: { code: 'import_progress_extracting' }
	});

	const existingMetadata = options?.existingMetadata;
	// Reimports stream into a provisional key so a crash mid-reimport cannot
	// leave a half-overwritten page set behind a live volume record; fresh
	// imports write directly (an orphaned uuid is swept at startup).
	const streamKey = existingMetadata ? `${volumeUuid}!reimport` : volumeUuid;

	// A crashed earlier reimport may have left stale provisional rows; the
	// swap loop moves every provisional row, so start from a clean slate.
	if (streamKey !== volumeUuid) {
		await db.volume_pages.where('volume_uuid').equals(streamKey).delete();
	}

	const pages: PageInfo[] = [];
	let firstPageFile: File | null = null;

	const extractionProgress = (extracted: number, total: number) => {
		onProgress?.({
			stage: 'extracting',
			current: extracted,
			total,
			message: { code: 'import_progress_extracting_count', params: { done: extracted, total } }
		});
	};

	const persistStreamedPage = async ({ index, filename, file: pageFile }: StreamedPage) => {
		let dims = { width: 0, height: 0 };
		try {
			dims = await getPageMediaDimensions(pageFile);
		} catch (err) {
			console.error(`Failed to get dimensions for ${filename}:`, err);
		}
		pages.push({ index, width: dims.width, height: dims.height, filename });
		if (index === 0) firstPageFile = pageFile;
		await db.volume_pages.put({
			volume_uuid: streamKey,
			page_index: index,
			filename,
			file: pageFile
		});
	};

	let extraction: { imageCount: number; skippedCount: number };
	switch (archiveType) {
		case 'rar': {
			if (isMobile) {
				throw new Error('RAR/CBR files are not supported on mobile. Please use ZIP/CBZ format.');
			}
			const { streamRarArchivePages } = await import('./archive-extraction-rar.js');
			extraction = await streamRarArchivePages(file, persistStreamedPage, extractionProgress);
			break;
		}
		case 'pdf': {
			const { streamPdfArchivePages } = await import('./archive-extraction-pdf.js');
			extraction = await streamPdfArchivePages(file, persistStreamedPage, extractionProgress);
			break;
		}
		case 'epub': {
			const { streamEpubArchivePages } = await import('./archive-extraction-epub.js');
			extraction = await streamEpubArchivePages(file, persistStreamedPage, extractionProgress);
			break;
		}
		case 'zip':
			extraction = await streamZipArchivePages(file, persistStreamedPage, extractionProgress);
			break;
	}

	if (extraction.imageCount === 0 || pages.length === 0) {
		await db.volume_pages.where('volume_uuid').equals(streamKey).delete();
		throw new Error('No images found in archive.');
	}

	// Reading order: extractors deliver natural-sort indexes, but failed
	// entries can leave gaps and RAR delivers in archive order — compact to a
	// contiguous 0..n-1 sequence the lazy page source can address directly.
	pages.sort((a, b) => a.index - b.index);
	const firstOriginalIndex = pages[0].index;
	const indexMoves = pages
		.map((page, position) => ({ from: page.index, to: position }))
		.filter((move) => move.from !== move.to);
	pages.forEach((page, position) => { page.index = position; });

	// Step 3: Generate thumbnail from the first reading-order page
	const coverSource: File | undefined = firstPageFile
		?? (await db.volume_pages.get([streamKey, firstOriginalIndex]))?.file;
	if (!coverSource) throw new Error('No images found in archive.');
	const thumbnail = await generateImportThumbnail(coverSource);

	// Step 4: Store in IndexedDB
	onProgress?.({
		stage: 'storing',
		current: 0,
		total: 3,
		message: { code: 'import_progress_saving' }
	});

	const title = file.name.replace(/\.(zip|cbz|cbr|rar|pdf|epub)$/i, '');

	const metadata: VolumeMetadata = {
		...existingMetadata,
		volume_uuid: volumeUuid,
		title: existingMetadata?.title ?? title,
		filename: file.name,
		page_count: pages.length,
		created_at: existingMetadata?.created_at ?? new Date().toISOString(),
		current_page: Math.min(existingMetadata?.current_page ?? 0, Math.max(0, pages.length - 1)),
		thumbnail: thumbnail.blob,
		thumbnail_width: thumbnail.width,
		thumbnail_height: thumbnail.height,
		thumbnail_generation_version: IMPORT_THUMBNAIL_GENERATION_VERSION,
		// Left unset unless the caller genuinely knows, or the volume already
		// carries a deliberate override: a local file says nothing about reading
		// direction, and stamping a guess here is what made the global Display
		// setting inert (every volume had an override, so the default could
		// never apply). An EPUB spine's page-progression-direction IS genuine
		// knowledge (publisher-declared) — but it ranks BELOW an existing value:
		// on a reimport, the stored direction is either the same spine stamp
		// (no-op) or a manual per-volume override, and a user's override must
		// survive the file changing on disk.
		reading_direction:
			options?.readingDirection ?? existingMetadata?.reading_direction ?? epubDirection,
		library_id: libraryId ?? existingMetadata?.library_id,
		folder_path: folderPath ?? existingMetadata?.folder_path ?? '',
		// This function writes COMIC pages, so the result is a comic — but the
		// spread above carried `media_kind` forward from the old record. A file
		// that was a reflowable EPUB and is re-imported at the same path as
		// image content kept `media_kind: 'book'`, so the app routed it to
		// BookReader, which loaded the OLD .epub blob for a volume whose comic
		// pages had just been written. Page count, progress and thumbnail all
		// described the new content; the reader showed the old.
		media_kind: undefined,
		book_locator: undefined,
		book_progress_fraction: undefined,
	};

	const pageDimensions: PageDimensions = {
		volume_uuid: volumeUuid,
		pages
	};

	// Final commit: page rows are already streamed to disk; this transaction
	// reconciles their indexes/key, clears superseded data, and writes the
	// volume metadata LAST — a crashed import never shows a half-volume.
	await db.transaction('rw', [
		db.volumes,
		db.catalog_rows,
		db.media_assets,
		db.volume_files,
		db.volume_pages,
		db.page_dimensions,
		db.regions,
		db.translations,
		db.work_context,
		db.page_translations,
		db.volume_translation_jobs,
		db.inpainted_pages,
		db.book_files,
		db.library_imports,
	], async () => {
		// The old .epub blob is what BookReader would have loaded. Even with
		// media_kind cleared it is dead weight — potentially the whole book —
		// that nothing else collects while the volume row still exists.
		if (existingMetadata) await db.book_files.delete(volumeUuid);
		if (options?.clearDerivedData) {
			await db.regions.where('volume_uuid').equals(volumeUuid).delete();
			await db.translations.where('[volume_uuid+page_index]').between(
				[volumeUuid, Dexie.minKey],
				[volumeUuid, Dexie.maxKey],
			).delete();
			await db.work_context.delete(volumeUuid);
			await db.page_translations.where('volume_uuid').equals(volumeUuid).delete();
			await db.volume_translation_jobs.where('volume_uuid').equals(volumeUuid).delete();
			await db.inpainted_pages.where('volume_uuid').equals(volumeUuid).delete();
		}

		// Compact page_index gaps left by skipped/corrupt entries (ascending
		// moves shift strictly downward, so no collisions).
		for (const move of indexMoves) {
			const row = await db.volume_pages.get([streamKey, move.from]);
			if (!row) continue;
			await db.volume_pages.delete([streamKey, move.from]);
			await db.volume_pages.put({ ...row, page_index: move.to });
		}
		if (streamKey !== volumeUuid) {
			// Reimport: swap the provisional page set in for the old one,
			// one row at a time (blob handles, not materialized bytes).
			await db.volume_pages.where('volume_uuid').equals(volumeUuid).delete();
			const provisionalKeys = await db.volume_pages
				.where('volume_uuid').equals(streamKey).primaryKeys();
			for (const key of provisionalKeys) {
				const row = await db.volume_pages.get(key);
				if (!row) continue;
				await db.volume_pages.delete(key);
				await db.volume_pages.put({ ...row, volume_uuid: volumeUuid });
			}
		} else {
			// Drop stale higher-index rows from any previous larger page set.
			await db.volume_pages.where('[volume_uuid+page_index]').between(
				[volumeUuid, pages.length],
				[volumeUuid, Dexie.maxKey],
				true,
				true,
			).delete();
		}
		// A streamed import supersedes the legacy all-pages record.
		await db.volume_files.delete(volumeUuid);
		onProgress?.({ stage: 'storing', current: 1, total: 3, message: { code: 'import_progress_saved_images' } });

		await db.page_dimensions.put(pageDimensions);
		onProgress?.({ stage: 'storing', current: 2, total: 3, message: { code: 'import_progress_saved_pages' } });

		await db.volumes.put(volumeWithoutEmbeddedMedia(metadata));
		await db.catalog_rows.put(toCatalogRow(metadata));
		const thumbnailAsset = volumeThumbnailAsset(metadata);
		if (thumbnailAsset) await db.media_assets.put(thumbnailAsset);
		// Same transaction as the volume, so a scan can never see one without
		// the other.
		if (options?.importRecord) {
			await db.library_imports.put({ ...options.importRecord, volume_uuid: volumeUuid });
		}
		onProgress?.({ stage: 'storing', current: 3, total: 3, message: { code: 'import_progress_done' } });
	});

	if (existingMetadata) revokeThumbnailUrl(volumeUuid);

	return volumeUuid;
}

/**
 * Delete a volume and all associated data from IndexedDB.
 */
export async function deleteVolume(
	volumeUuid: string,
	options: { deletePhysicalFile?: boolean } = {},
): Promise<void> {
	// Check if this is a remote volume (no local files to delete)
	const volume = await db.volumes.get(volumeUuid);
	const volumeTags = volume?.tags || [];

	// Delete physical file from disk if it exists in library_imports
	if (options.deletePhysicalFile !== false) {
		const libraryImports = await db.library_imports.where('volume_uuid').equals(volumeUuid).toArray();
		for (const imp of libraryImports) {
			await tryDeleteFile(imp.file_path);
		}
	}

	await db.transaction('rw', volumeScopedTables(db), async () => {
		await deleteVolumeRowsInTransaction(volumeUuid, db);
	});
	revokeThumbnailUrl(volumeUuid);

	// Clean up tags no longer referenced by any volume
	if (volumeTags.length > 0) {
		const { cleanupOrphanedTags } = await import('$lib/db/tag-cleanup.js');
		await cleanupOrphanedTags(volumeTags);
	}
}

/**
 * Delete all translation-related data for a volume while keeping the volume itself.
 *
 * Removes: regions, translations, work_context, page_translations,
 * volume_translation_jobs, inpainted_pages
 * Preserves: volumes, volume_files, page_dimensions, library_imports, tags
 */
export async function deleteVolumeTranslations(volumeUuid: string): Promise<void> {
	await db.transaction(
		'rw',
		[db.regions, db.translations, db.work_context, db.page_translations, db.volume_translation_jobs, db.inpainted_pages],
		async () => {
			await db.regions.where('volume_uuid').equals(volumeUuid).delete();
			await db.translations.where('[volume_uuid+page_index]').between(
				[volumeUuid, Dexie.minKey],
				[volumeUuid, Dexie.maxKey]
			).delete();
			await db.work_context.delete(volumeUuid);
			await db.page_translations.where('volume_uuid').equals(volumeUuid).delete();
			await db.volume_translation_jobs.where('volume_uuid').equals(volumeUuid).delete();
			await db.inpainted_pages.where('volume_uuid').equals(volumeUuid).delete();
		}
	);
}

/**
 * Check whether a volume has any translation data (regions, page translations, or jobs).
 */
export async function volumeHasTranslationData(volumeUuid: string): Promise<boolean> {
	const [regionCount, pageTranslationCount, jobCount, inpaintedCount] = await Promise.all([
		db.regions.where('volume_uuid').equals(volumeUuid).count(),
		db.page_translations.where('volume_uuid').equals(volumeUuid).count(),
		db.volume_translation_jobs.where('volume_uuid').equals(volumeUuid).count(),
		db.inpainted_pages.where('volume_uuid').equals(volumeUuid).count(),
	]);
	return regionCount > 0 || pageTranslationCount > 0 || jobCount > 0 || inpaintedCount > 0;
}

// ================================================================
// Mobile library import (copy files to organized folder, then scan)
// ================================================================

export interface ImportToLibraryResult {
	succeeded: string[];
	failed: { path: string; error: string }[];
	deleteFailures: string[];
	/**
	 * The indexing scan's outcome, or null when no files were copied. Discarding
	 * this used to hide real failures: with the old scan mutex, an import during
	 * a background scan copied the files, silently skipped indexing, and the
	 * dialog reported success while the comics never appeared.
	 */
	scan: ScanResult | null;
}

/**
 * Import archives into the local library by copying them to organized
 * Author/Series subfolders, then triggering a library scan.
 *
 * This does NOT create IndexedDB entries directly — the scanner handles that.
 */
export async function importToLibrary(
	filePaths: string[],
	libraryPath: string,
	libraryId: string,
	assignments: { author?: string; series?: string }[],
	deleteOriginals: boolean,
	onProgress?: (msg: string) => void,
): Promise<ImportToLibraryResult> {
	const succeeded: string[] = [];
	const failed: { path: string; error: string }[] = [];
	const deleteFailures: string[] = [];

	for (let i = 0; i < filePaths.length; i++) {
		const srcPath = filePaths[i];
		const assignment = assignments[i] || {};
		const filename = srcPath.split(/[\\/]/).pop() || 'archive.cbz';
		onProgress?.(m.import_progress_copying({ index: i + 1, total: filePaths.length, name: filename }));

		try {
			const destPath = await copyFileToLibrary(
				srcPath, libraryPath, assignment.author, assignment.series
			);
			succeeded.push(destPath);

			if (deleteOriginals) {
				const deleted = await tryDeleteFile(srcPath);
				if (!deleted) deleteFailures.push(srcPath);
			}
		} catch (err) {
			failed.push({
				path: srcPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Trigger scan to create IndexedDB entries for the copied files. With the
	// scoped scan registry this cannot be silently swallowed by a concurrent
	// scan: identical scopes chain a follow-up whose traversal postdates the
	// copies above, so the returned result genuinely covers these files.
	let scan: ScanResult | null = null;
	if (succeeded.length > 0) {
		onProgress?.(m.import_progress_scanning());
		scan = await scanLibrary(libraryPath, undefined, libraryId);
	}

	return { succeeded, failed, deleteFailures, scan };
}

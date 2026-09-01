/**
 * Archive extraction for Fumeto.
 *
 * Adapted from mokuro-reader's archive-extraction.ts.
 * Simplified: single-volume extraction, no mokuro file pairing.
 * Extracts images from ZIP/CBZ archives in parallel batches.
 */

import { BlobReader, ZipReader, Uint8ArrayWriter, configure } from '@zip.js/zip.js';
import { isSystemFile, isPageMediaExtension, getPageMediaMimeType } from './types.js';
import { naturalCompare } from '$lib/util/natural-sort.js';

// Configure zip.js for Node.js environments (testing)
const isNode =
	typeof globalThis !== 'undefined' &&
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).process?.versions?.node != null;

if (isNode) {
	configure({ useWebWorkers: false });
}

/** Concurrency limit for parallel extraction */
const EXTRACT_CONCURRENCY = 5;

/** Result of extracting a single archive */
export interface ExtractionResult {
	/** Map of filename → File for all extracted images */
	files: Record<string, File>;
	/** Number of images extracted */
	imageCount: number;
	/** Number of entries skipped (system files, non-images) */
	skippedCount: number;
}

/**
 * Natural sort comparator for filenames.
 * Handles numbered filenames like "page_001.jpg", "page_2.jpg" correctly.
 * Shared util so page order stays identical across import/migration/reader.
 */
const naturalSortCompare = naturalCompare;

/** One page produced by a streaming extractor, in reading order. */
export interface StreamedPage {
	/** Natural-sort position — the durable page_index. */
	index: number;
	/** Full archive path (collision-safe across subdirectories). */
	filename: string;
	file: File;
}

/** Backpressure contract: extraction awaits the callback before continuing. */
export type StreamedPageHandler = (page: StreamedPage) => Promise<void>;

/**
 * Zip/CBZ entries admit video pages (mp4/m4v/webm) alongside images — the
 * only container that does; RAR/PDF/EPUB extraction stays image-only.
 */
function isExtractablePageEntry(entry: { directory?: boolean; filename: string }): boolean {
	if (entry.directory || isSystemFile(entry.filename)) return false;
	const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
	return isPageMediaExtension(ext);
}

/**
 * Extract only the first naturally-sorted image from a ZIP/CBZ archive.
 *
 * This is deliberately separate from the full import extractor: legacy cover
 * migration needs one source image and must not inflate every page merely to
 * regenerate a thumbnail.
 */
export async function extractFirstZipImage(archiveBlob: Blob): Promise<File | undefined> {
	const zipReader = new ZipReader(new BlobReader(archiveBlob));
	try {
		const entries = await zipReader.getEntries();
		const firstEntry = entries
			.filter(isExtractablePageEntry)
			.sort((a, b) => naturalSortCompare(a.filename, b.filename))[0];
		if (!firstEntry) return undefined;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const uint8Array = await (firstEntry as any).getData(new Uint8ArrayWriter());
		const archivePath = firstEntry.filename;
		const basename = archivePath.split('/').pop() || archivePath;
		const ext = basename.split('.').pop()?.toLowerCase() || '';
		return new File([uint8Array.buffer as ArrayBuffer], basename, {
			type: getPageMediaMimeType(ext),
			lastModified: Date.now(),
		});
	} finally {
		await zipReader.close();
	}
}

/**
 * Stream images out of a ZIP/CBZ one page at a time in natural-sort order.
 *
 * The memory contract that motivated v17 page-per-row storage: at most ONE
 * decompressed page is alive at a time (plus the archive blob handle), and
 * `onPage` is awaited so the consumer persists each page before the next is
 * inflated. Returns the number of pages delivered + skipped entries.
 */
export async function streamZipArchivePages(
	archiveBlob: Blob,
	onPage: StreamedPageHandler,
	onProgress?: (extracted: number, total: number) => void
): Promise<{ imageCount: number; skippedCount: number }> {
	const zipReader = new ZipReader(new BlobReader(archiveBlob));
	try {
		const entries = await zipReader.getEntries();
		const toExtract = entries.filter((entry) => !entry.directory && isExtractablePageEntry(entry));
		const skippedCount = entries.filter((entry) => !entry.directory).length - toExtract.length;
		toExtract.sort((a, b) => naturalSortCompare(a.filename, b.filename));

		let delivered = 0;
		let failedCount = 0;
		for (let index = 0; index < toExtract.length; index++) {
			const entry = toExtract[index];
			// One entry that will not decompress used to reject out of this loop
			// and fail the whole import — a single damaged page losing a
			// 200-page volume, permanently, on every rescan. The machinery
			// downstream is already built to absorb gaps: persistStreamedPage
			// tolerates a decode failure, and the import compacts page indexes
			// afterwards precisely because "failed entries can leave gaps".
			// Only this loop was missing the per-entry catch that the
			// non-streaming extractor already has.
			let uint8Array: Uint8Array;
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
			} catch (error) {
				failedCount++;
				console.warn(`[archive] Skipping unreadable entry "${entry.filename}":`, error);
				continue;
			}
			const archivePath = entry.filename;
			const basename = archivePath.split('/').pop() || archivePath;
			const ext = basename.split('.').pop()?.toLowerCase() || '';
			await onPage({
				index,
				filename: archivePath,
				file: new File([uint8Array.buffer as ArrayBuffer], basename, {
					type: getPageMediaMimeType(ext),
					lastModified: Date.now()
				})
			});
			delivered++;
			onProgress?.(delivered, toExtract.length);
		}
		return { imageCount: delivered, skippedCount: skippedCount + failedCount };
	} finally {
		await zipReader.close();
	}
}

/**
 * Extract all images from a ZIP/CBZ archive.
 *
 * - Filters system files (macOS, Windows, Linux metadata)
 * - Keeps only image files
 * - Extracts in parallel batches of 5 for performance
 * - Returns files keyed by natural-sorted filename
 *
 * @param archiveBlob - The ZIP/CBZ file as a Blob
 * @param onProgress - Optional progress callback (extracted, total)
 * @returns Extracted image files and counts
 */
export async function extractZipArchive(
	archiveBlob: Blob,
	onProgress?: (extracted: number, total: number) => void
): Promise<ExtractionResult> {
	const zipReader = new ZipReader(new BlobReader(archiveBlob));
	const entries = await zipReader.getEntries();

	// Filter to extractable image entries
	const toExtract: typeof entries = [];
	let skippedCount = 0;

	for (const entry of entries) {
		if (entry.directory) continue;
		if (!isExtractablePageEntry(entry)) {
			skippedCount++;
			continue;
		}

		toExtract.push(entry);
	}

	// Sort entries by natural filename order
	toExtract.sort((a, b) => naturalSortCompare(a.filename, b.filename));

	// Extract in parallel batches
	const files: Record<string, File> = {};
	let extracted = 0;
	const totalFiles = toExtract.length;

	for (let i = 0; i < toExtract.length; i += EXTRACT_CONCURRENCY) {
		const batch = toExtract.slice(i, i + EXTRACT_CONCURRENCY);

		const results = await Promise.all(
			batch.map(async (entry) => {
				try {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
					// Use the full archive path as the key to avoid collisions when
					// different subdirectories contain identically-named files
					// (e.g. chapter1/page01.jpg vs chapter2/page01.jpg).
					const archivePath = entry.filename;
					const basename = archivePath.split('/').pop() || archivePath;
					const ext = basename.split('.').pop()?.toLowerCase() || '';
					const mimeType = getPageMediaMimeType(ext);

					return {
						filename: archivePath,
						file: new File([uint8Array.buffer as ArrayBuffer], basename, {
							type: mimeType,
							lastModified: Date.now()
						})
					};
				} catch (err) {
					console.error(`Error extracting ${entry.filename}:`, err);
					return null;
				}
			})
		);

		for (const result of results) {
			if (result) {
				files[result.filename] = result.file;
				extracted++;
			}
		}

		onProgress?.(extracted, totalFiles);
	}

	await zipReader.close();

	return {
		files,
		imageCount: extracted,
		skippedCount
	};
}

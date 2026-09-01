/**
 * RAR/CBR archive extraction for Fumeto.
 *
 * Uses node-unrar-js (Emscripten-compiled unrar) for pure-JS extraction.
 * Follows the same ExtractionResult interface as the ZIP extractor.
 *
 * IMPORTANT: node-unrar-js iterators MUST be fully consumed
 * to avoid C++ memory leaks from the Emscripten-compiled code.
 */

import { createExtractorFromData } from 'node-unrar-js';
import { isSystemFile, isImageExtension, getImageMimeType } from './types.js';
import type { ExtractionResult, StreamedPageHandler } from './archive-extraction.js';
import { naturalCompare } from '$lib/util/natural-sort.js';

const naturalSortCompare = naturalCompare;

function toImageFile(name: string, bytes: Uint8Array): File {
	const basename = name.split(/[\\/]/).pop() || name;
	const ext = basename.split('.').pop()?.toLowerCase() || '';
	return new File([bytes.buffer as ArrayBuffer], basename, {
		type: getImageMimeType(ext),
		lastModified: Date.now(),
	});
}

/** Extract only the first naturally-sorted image from a RAR/CBR archive. */
export async function extractFirstRarImage(archiveBlob: Blob): Promise<File | undefined> {
	const arrayBuffer = await archiveBlob.arrayBuffer();
	const extractor = await createExtractorFromData({ data: arrayBuffer });
	const headers = [...extractor.getFileList().fileHeaders];
	const firstName = headers
		.filter((header) => {
			if (header.flags.directory || isSystemFile(header.name)) return false;
			const ext = header.name.split('.').pop()?.toLowerCase() || '';
			return isImageExtension(ext);
		})
		.map((header) => header.name)
		.sort(naturalSortCompare)[0];
	if (!firstName) return undefined;

	// node-unrar-js supports a filename filter. Consume its iterator fully so
	// the Emscripten resources are released while inflating only this one entry.
	const files = [...extractor.extract({ files: [firstName] }).files];
	const first = files.find((file) => file.fileHeader.name === firstName && file.extraction);
	return first?.extraction ? toImageFile(firstName, first.extraction) : undefined;
}

/**
 * Stream images out of a RAR/CBR archive one page at a time.
 *
 * The archive stays fully resident as an ArrayBuffer (node-unrar-js
 * requirement — documented library floor), but the lazy `extract().files`
 * generator inflates one entry per iteration and `onPage` is awaited before
 * the next, so peak memory ≈ archive + one page instead of archive + all
 * pages. Extraction yields in ARCHIVE order; `page_index` comes from a
 * precomputed natural-sort map so reading order never depends on how the
 * archive was packed. The generator is consumed to completion (Emscripten
 * leak requirement) even when entries are skipped.
 */
export async function streamRarArchivePages(
	archiveBlob: Blob,
	onPage: StreamedPageHandler,
	onProgress?: (extracted: number, total: number) => void
): Promise<{ imageCount: number; skippedCount: number }> {
	const arrayBuffer = await archiveBlob.arrayBuffer();
	const extractor = await createExtractorFromData({ data: arrayBuffer });

	const headers = [...extractor.getFileList().fileHeaders];
	const imageNames: string[] = [];
	let skippedCount = 0;
	for (const header of headers) {
		if (header.flags.directory) continue;
		const ext = header.name.split('.').pop()?.toLowerCase() || '';
		if (isSystemFile(header.name) || !isImageExtension(ext)) {
			skippedCount++;
			continue;
		}
		imageNames.push(header.name);
	}
	const indexByName = new Map(
		imageNames.slice().sort(naturalSortCompare).map((name, index) => [name, index])
	);

	let delivered = 0;
	for (const file of extractor.extract().files) {
		const pageIndex = indexByName.get(file.fileHeader.name);
		if (pageIndex === undefined || !file.extraction) continue;
		await onPage({
			index: pageIndex,
			filename: file.fileHeader.name,
			file: toImageFile(file.fileHeader.name, file.extraction)
		});
		delivered++;
		onProgress?.(delivered, indexByName.size);
	}
	return { imageCount: delivered, skippedCount };
}

/**
 * Extract all images from a RAR/CBR archive.
 *
 * - Filters system files (macOS, Windows, Linux metadata)
 * - Keeps only image files
 * - Returns files keyed by filename
 *
 * @param archiveBlob - The RAR/CBR file as a Blob
 * @param onProgress - Optional progress callback (extracted, total)
 * @returns Extracted image files and counts
 */
export async function extractRarArchive(
	archiveBlob: Blob,
	onProgress?: (extracted: number, total: number) => void
): Promise<ExtractionResult> {
	const arrayBuffer = await archiveBlob.arrayBuffer();
	const extractor = await createExtractorFromData({ data: arrayBuffer });

	// 1. Get file list — MUST iterate to completion (memory leak otherwise)
	const list = extractor.getFileList();
	const headers = [...list.fileHeaders];

	// 2. Filter to extractable image entries
	const imageNames = new Set<string>();
	let skippedCount = 0;

	for (const header of headers) {
		if (header.flags.directory) {
			continue;
		}
		if (isSystemFile(header.name)) {
			skippedCount++;
			continue;
		}
		const ext = header.name.split('.').pop()?.toLowerCase() || '';
		if (!isImageExtension(ext)) {
			skippedCount++;
			continue;
		}
		imageNames.add(header.name);
	}

	const totalImages = imageNames.size;

	// 3. Extract all files at once (RAR doesn't support selective batch extraction)
	// MUST iterate to completion to free C++ resources
	const extracted = extractor.extract();
	const allFiles = [...extracted.files];

	// 4. Build result map matching ExtractionResult interface
	const files: Record<string, File> = {};
	let imageCount = 0;

	for (const file of allFiles) {
		if (!imageNames.has(file.fileHeader.name)) continue;
		if (!file.extraction) continue;

		// Use the full archive path as the key to avoid collisions when
		// different subdirectories contain identically-named files
		// (e.g. chapter1/page01.jpg vs chapter2/page01.jpg).
		const archivePath = file.fileHeader.name;
		files[archivePath] = toImageFile(archivePath, file.extraction);

		imageCount++;
		onProgress?.(imageCount, totalImages);
	}

	return {
		files,
		imageCount,
		skippedCount
	};
}

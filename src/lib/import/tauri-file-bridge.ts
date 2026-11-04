/**
 * Bridge between Tauri's path-based filesystem and the browser File API.
 *
 * Tauri's native dialog returns file paths (strings), but the existing
 * import pipeline (importArchive, extractZipArchive, extractRarArchive)
 * expects File/Blob objects. This module converts paths → File objects
 * by reading through the Tauri fs plugin.
 */

import { open } from '@tauri-apps/plugin-fs';

/** How much of a file is held in memory at a time while it is read. */
const READ_CHUNK_BYTES = 16 * 1024 * 1024;

/** MIME types for archive formats */
function getArchiveMime(filename: string): string {
	const ext = filename.split('.').pop()?.toLowerCase() || '';
	switch (ext) {
		case 'zip':
		case 'cbz':
			return 'application/zip';
		case 'rar':
		case 'cbr':
			return 'application/x-rar-compressed';
		case 'pdf':
			return 'application/pdf';
		case 'epub':
			return 'application/epub+zip';
		default:
			return 'application/octet-stream';
	}
}

/**
 * Read a file from the native filesystem and convert to a browser File object.
 *
 * Read in pieces, each added to a Blob, which the browser keeps on disk once it is large. On
 * Android one read crosses the IPC as a single Java array: a file past the 512 MB Java heap threw
 * OutOfMemoryError and took the app down, and again at every launch, since the scan reads whatever
 * is in the library. Read this way a 1.2 GB archive adds about 150 MB to the app's memory.
 *
 * @param filePath - Absolute path to the file on disk
 * @returns A File object compatible with the existing import pipeline
 */
export async function filePathToFile(filePath: string): Promise<File> {
	const filename = filePath.split(/[\\/]/).pop() || 'unknown';
	const mimeType = getArchiveMime(filename);

	const source = await open(filePath, { read: true });
	const chunk = new Uint8Array(READ_CHUNK_BYTES);
	let contents = new Blob([]);
	try {
		for (;;) {
			const read = await source.read(chunk);
			if (read === null) break;
			contents = new Blob([contents, chunk.subarray(0, read)]);
		}
	} finally {
		await source.close();
	}

	return new File([contents], filename, {
		type: mimeType,
		lastModified: Date.now()
	});
}

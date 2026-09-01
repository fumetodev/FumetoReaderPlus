/**
 * Bridge between Tauri's path-based filesystem and the browser File API.
 *
 * Tauri's native dialog returns file paths (strings), but the existing
 * import pipeline (importArchive, extractZipArchive, extractRarArchive)
 * expects File/Blob objects. This module converts paths → File objects
 * by reading through the Tauri fs plugin.
 */

import { readFile } from '@tauri-apps/plugin-fs';

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
 * @param filePath - Absolute path to the file on disk
 * @returns A File object compatible with the existing import pipeline
 */
export async function filePathToFile(filePath: string): Promise<File> {
	const uint8Array = await readFile(filePath);
	const filename = filePath.split(/[\\/]/).pop() || 'unknown';
	const mimeType = getArchiveMime(filename);

	return new File([uint8Array], filename, {
		type: mimeType,
		lastModified: Date.now()
	});
}

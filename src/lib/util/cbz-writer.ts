/**
 * CBZ archive creation utility.
 *
 * Uses @zip.js/zip.js ZipWriter to package images into a .cbz file.
 * Pages are added incrementally so the exporter never holds the whole
 * volume's decoded pages in the JS heap at once; the assembled archive
 * lives in a browser-managed Blob (which Chromium may back with disk)
 * until the caller streams it out.
 */

import { BlobWriter, ZipWriter, Uint8ArrayReader } from '@zip.js/zip.js';

export interface CbzImage {
	name: string;
	data: Uint8Array;
}

export interface CbzStreamWriter {
	add(name: string, data: Uint8Array): Promise<void>;
	/** Finalize the archive. The writer is unusable afterwards. */
	close(): Promise<Blob>;
}

/** Incremental CBZ writer: hand pages over one at a time and drop them. */
export function createCbzWriter(): CbzStreamWriter {
	const zipWriter = new ZipWriter(new BlobWriter('application/zip'));
	return {
		async add(name, data) {
			await zipWriter.add(name, new Uint8ArrayReader(data));
		},
		close() {
			return zipWriter.close();
		}
	};
}

/**
 * Create a .cbz archive from a pre-collected list of images.
 * Prefer createCbzWriter() for anything volume-sized.
 */
export async function createCbz(images: CbzImage[]): Promise<Uint8Array> {
	const writer = createCbzWriter();
	for (const image of images) {
		await writer.add(image.name, image.data);
	}
	const blob = await writer.close();
	return new Uint8Array(await blob.arrayBuffer());
}

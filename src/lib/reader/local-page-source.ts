/**
 * Local page source — wraps VolumeFiles from IndexedDB.
 * Pages are File objects stored in the database during import.
 */

import {
	throwIfPageRequestCancelled,
	type PageRequestOptions,
	type PageSource
} from './page-source.js';
import type { VolumeFiles } from '$lib/types/index.js';
import { naturalCompare } from '$lib/util/natural-sort.js';

export class LocalPageSource implements PageSource {
	private sortedFiles: File[];

	constructor(volumeFiles: VolumeFiles) {
		// Shared comparator: the v17 migration derives page_index from this
		// exact ordering, so migrated volumes keep their page order.
		const keys = Object.keys(volumeFiles.files).sort(naturalCompare);
		this.sortedFiles = keys.map((k) => volumeFiles.files[k]);
	}

	get pageCount(): number {
		return this.sortedFiles.length;
	}

	async getPage(index: number, options: PageRequestOptions = {}): Promise<Blob> {
		throwIfPageRequestCancelled(options.signal);
		const file = this.sortedFiles[index];
		if (!file) throw new Error(`Page ${index} not found`);
		throwIfPageRequestCancelled(options.signal);
		return file; // File extends Blob
	}

	async getPageAsFile(index: number, options: PageRequestOptions = {}): Promise<File> {
		throwIfPageRequestCancelled(options.signal);
		const file = this.sortedFiles[index];
		if (!file) throw new Error(`Page ${index} not found`);
		throwIfPageRequestCancelled(options.signal);
		return file;
	}

	dispose(): void {
		// No cleanup needed — File objects are garbage-collected naturally
	}
}

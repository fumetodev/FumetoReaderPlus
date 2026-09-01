/**
 * Lazy local page source — one IndexedDB row per page (schema v17).
 * Only the requested page's blob handle is materialized, so opening a volume
 * costs O(1) memory instead of the whole archive (report L2). The reader's
 * ImageCache keeps its own small sliding window on top of this.
 */

import { db } from '$lib/db/index.js';
import {
	awaitPageRequest,
	throwIfPageRequestCancelled,
	type PageRequestOptions,
	type PageSource
} from './page-source.js';

export class LazyLocalPageSource implements PageSource {
	constructor(
		private readonly volumeUuid: string,
		readonly pageCount: number
	) {}

	private async getRowFile(index: number, options: PageRequestOptions): Promise<File> {
		throwIfPageRequestCancelled(options.signal);
		const row = await awaitPageRequest(
			db.volume_pages.get([this.volumeUuid, index]),
			options
		);
		if (!row) throw new Error(`Page ${index} not found`);
		return row.file;
	}

	async getPage(index: number, options: PageRequestOptions = {}): Promise<Blob> {
		return this.getRowFile(index, options);
	}

	async getPageAsFile(index: number, options: PageRequestOptions = {}): Promise<File> {
		return this.getRowFile(index, options);
	}

	dispose(): void {
		// Nothing held — rows are fetched per request.
	}
}

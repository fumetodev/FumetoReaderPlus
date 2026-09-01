/**
 * Factory for creating the appropriate PageSource based on volume metadata.
 * Local volumes use IndexedDB; remote volumes use the configured YACReader,
 * Komga, or Kavita server client.
 */

import {
	awaitPageRequest,
	throwIfPageRequestCancelled,
	type PageSourceCreateOptions,
	type PageSource
} from './page-source.js';
import type { VolumeMetadata } from '$lib/types/index.js';
import { db } from '$lib/db/index.js';
import { LocalPageSource } from './local-page-source.js';
import { LazyLocalPageSource } from './lazy-local-page-source.js';
import { RemotePageSource } from './remote-page-source.js';
import { KomgaPageSource } from './komga-page-source.js';
import { KavitaPageSource } from './kavita-page-source.js';
import { getOrCreateClient } from '$lib/yacreader/yac-client-manager.js';
import { getOrCreateKomgaClient } from '$lib/komga/komga-client-manager.js';
import { loadKomgaCredentials } from '$lib/komga/komga-credentials.js';
import { getOrCreateKavitaClient } from '$lib/kavita/kavita-client-manager.js';
import { loadKavitaApiKey } from '$lib/kavita/kavita-credentials.js';
import { getYacSessionPool } from '$lib/yacreader/yac-session-pool.js';

/**
 * Create a PageSource for the given volume.
 * - Local volumes: loads VolumeFiles from IndexedDB
 * - YACReader volumes: creates a RemotePageSource that fetches pages over HTTP
 * - Komga volumes: creates a KomgaPageSource that fetches pages over HTTP
 * - Kavita volumes: creates a KavitaPageSource that fetches pages over HTTP
 */
export async function createPageSource(
	volume: VolumeMetadata,
	options: PageSourceCreateOptions = {}
): Promise<PageSource> {
	throwIfPageRequestCancelled(options.signal);
	if (volume.source?.type === 'yacreader') {
		const client = getOrCreateClient(volume.source.serverUrl);
		const lease = await getYacSessionPool(client).acquire(options.purpose ?? 'background', options.signal);
		if (options.signal?.aborted) {
			lease.release();
			throwIfPageRequestCancelled(options.signal);
		}
		return new RemotePageSource(
			lease.client,
			volume.source.remoteLibraryId,
			volume.source.remoteComicId,
			volume.page_count,
			{ sessionClient: true, releaseLease: lease.release }
		);
	}

	if (volume.source?.type === 'komga') {
		const creds = await awaitPageRequest(loadKomgaCredentials(volume.source.serverUrl), options);
		throwIfPageRequestCancelled(options.signal);
		const client = getOrCreateKomgaClient(volume.source.serverUrl, creds.username, creds.password);
		return new KomgaPageSource(client, volume.source.komgaBookId, volume.page_count);
	}

	if (volume.source?.type === 'kavita') {
		const apiKey = await awaitPageRequest(loadKavitaApiKey(volume.source.serverUrl), options);
		throwIfPageRequestCancelled(options.signal);
		const client = getOrCreateKavitaClient(volume.source.serverUrl, apiKey);
		return new KavitaPageSource(client, volume.source.kavitaChapterId, volume.page_count);
	}

	// Default: local volume. Prefer v17 page-per-row storage (lazy, O(1)
	// memory); a complete row set is required so a crashed reimport with a
	// partial page set falls back to the intact legacy record.
	const pageRowCount = await awaitPageRequest(
		db.volume_pages.where('volume_uuid').equals(volume.volume_uuid).count(),
		options
	);
	throwIfPageRequestCancelled(options.signal);
	if (pageRowCount > 0 && pageRowCount >= volume.page_count) {
		return new LazyLocalPageSource(volume.volume_uuid, pageRowCount);
	}

	// Legacy pre-v17 record (dual-read until the migration validates + deletes it)
	const volumeFiles = await awaitPageRequest(db.volume_files.get(volume.volume_uuid), options);
	throwIfPageRequestCancelled(options.signal);
	if (volumeFiles) {
		return new LocalPageSource(volumeFiles);
	}
	if (pageRowCount > 0) {
		// Partial rows and no legacy fallback — serve what exists.
		return new LazyLocalPageSource(volume.volume_uuid, pageRowCount);
	}
	throw new Error(`Volume files not found for ${volume.volume_uuid}`);
}

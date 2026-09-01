/**
 * "Continue reading" — the single most recently read volume, derived from the
 * sparse `catalog_rows.last_read_at` index rather than stored anywhere.
 *
 * Both the Library strip and the Tabs strip read this one source, so they can
 * never disagree, and nothing has to be kept in sync: `last_read_at` is already
 * maintained by every path that persists progress. There is deliberately no
 * marker, no slot, and no "exactly one" invariant to repair on write.
 *
 * Its liveQuery is deliberately SEPARATE from the tabs projection. An unbounded
 * `orderBy('last_read_at')` registers the whole index range with Dexie's
 * observability, and the reader writes `last_read_at` on every debounced
 * progress checkpoint — folding this read into TabsController.query() would
 * re-run the entire tabs projection twice a second while reading. Here it costs
 * one index-ordered read of a handful of rows.
 */

import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import type { FumetoDB } from '$lib/db/schema.js';
import { db } from '$lib/db/index.js';
import type { VolumeMetadata } from '$lib/types/index.js';
import { catalogRowToVolume, listRecentlyRead } from './catalog-repository.js';

/**
 * Head room for skipping catalog-hidden rows. `listRecentlyRead` is left
 * untouched — filtering in JS keeps that query, and its existing tests, as they
 * are, and a run of internal rows this long does not occur in practice.
 */
const VISIBILITY_SCAN_LIMIT = 8;

/** The newest read volume the catalog would actually show, or null. */
export async function readContinueReadingVolume(
	database: FumetoDB = db
): Promise<VolumeMetadata | null> {
	const rows = await listRecentlyRead(VISIBILITY_SCAN_LIMIT, database);
	const row = rows.find((candidate) => candidate.visibility !== 'internal');
	return row ? catalogRowToVolume(row) : null;
}

/**
 * A Svelte store over that query.
 *
 * The `readable` wrapper is load-bearing, not ceremony: Dexie's observable has
 * no synchronous first value, returns a Subscription rather than an
 * unsubscriber, and — decisively — does not multiplex. The Library and Tabs
 * views are both permanently mounted, so subscribing to a bare observable twice
 * would open two independent liveQueries. `readable`'s start/stop notifier
 * opens one on the first subscriber and closes it after the last.
 */
export function createContinueReadingStore(
	database: FumetoDB = db
): Readable<VolumeMetadata | null> {
	return readable<VolumeMetadata | null>(null, (set) => {
		const subscription = liveQuery(() => readContinueReadingVolume(database)).subscribe({
			next: (volume) => set(volume),
			// Keep the last good value: a transient read failure must never blank a
			// strip that is already showing the right comic, and the next write to
			// the index re-runs the query anyway.
			error: (error) => console.debug('[ContinueReading] query failed:', error)
		});
		return () => subscription.unsubscribe();
	});
}

export const continueReadingVolume = createContinueReadingStore();

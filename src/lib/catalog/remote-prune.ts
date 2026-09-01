/**
 * Deletion propagation for remote libraries, on manual Scan only.
 *
 * Komga and Kavita were strictly add-only: a book deleted on the server stayed
 * in the catalog forever and 404'd when opened. YACReader has had propagation
 * for a while, and this is its confirmation rule extracted so the other two can
 * share it rather than grow a second, subtly different one.
 *
 * The rule, and the reason for it: **absence from a listing is not proof of
 * deletion.** An item may merely have moved — a different series, a different
 * library — and deleting a moved item destroys reading progress and
 * translations the server never had a copy of. So absence only *nominates*;
 * deletion requires the server to positively confirm `not_found` for that exact
 * item. Any other probe outcome — a 200, a network error, a 5xx, an auth
 * failure — leaves the row alone. Pruning must never act on ambiguity.
 *
 * All network happens before the delete transaction: awaiting a fetch inside an
 * IndexedDB transaction closes it.
 *
 * Manual Scan only, never passive browse hydration. Navigation stays
 * read-mostly, and the project's contract is that Scan is the explicit refresh.
 */

import { db } from '$lib/db/index.js';
import { deleteVolumeRowsInTransaction, volumeScopedTables } from './catalog-repository.js';
import type { VolumeMetadata } from '$lib/types/index.js';

export interface RemotePruneCandidate {
	volume: VolumeMetadata;
	/** Probe the server for this item. Must reject with a not-found error when gone. */
	probe: () => Promise<unknown>;
}

export interface RemotePruneResult {
	volumesRemoved: number;
	/** Nominated by absence but NOT confirmed gone — left alone on purpose. */
	unconfirmed: number;
}

/**
 * Delete the candidates the server confirms are gone.
 *
 * @param isNotFound - Narrows a probe rejection to "the server says this does
 *   not exist". Provider-specific because each client has its own error type;
 *   deliberately a parameter rather than a duck-typed check, so a provider that
 *   forgets to model not-found cannot silently prune on every error.
 */
export async function pruneConfirmedDeletions(
	candidates: readonly RemotePruneCandidate[],
	isNotFound: (error: unknown) => boolean,
	options: {
		signal?: AbortSignal;
		/**
		 * Called after each probe. The loop is one sequential HTTP round trip per
		 * candidate and a drifted library can nominate hundreds, so a caller that
		 * shows progress for the crawl and then goes silent here reads as a hang
		 * at the very end of a Scan.
		 */
		onProgress?: (checked: number, total: number) => void;
	} = {}
): Promise<RemotePruneResult> {
	if (candidates.length === 0) return { volumesRemoved: 0, unconfirmed: 0 };

	const confirmed: VolumeMetadata[] = [];
	let unconfirmed = 0;
	let checked = 0;

	for (const candidate of candidates) {
		if (options.signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
		try {
			await candidate.probe();
			// It answered. It exists, it just is not here any more.
			unconfirmed++;
		} catch (error) {
			if (isNotFound(error)) confirmed.push(candidate.volume);
			else unconfirmed++;
		}
		options.onProgress?.(++checked, candidates.length);
	}

	if (confirmed.length === 0) return { volumesRemoved: 0, unconfirmed };

	// One transaction, through the canonical deleter — the same cascade a
	// user-initiated delete gets, so a pruned volume cannot leave orphaned
	// translation rows or a Blob behind.
	await db.transaction('rw', volumeScopedTables(db), async () => {
		for (const volume of confirmed) {
			await deleteVolumeRowsInTransaction(volume.volume_uuid, db);
		}
	});

	const tags = [...new Set(confirmed.flatMap((volume) => volume.tags ?? []))];
	if (tags.length > 0) {
		const { cleanupOrphanedTags } = await import('$lib/db/tag-cleanup.js');
		await cleanupOrphanedTags(tags);
	}

	return { volumesRemoved: confirmed.length, unconfirmed };
}

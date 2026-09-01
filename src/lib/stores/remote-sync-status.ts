import { withUserMessage } from '$lib/i18n/errors.js';
import { writable, type Readable } from 'svelte/store';

/**
 * Last sync outcome per remote library. The catalog renders from the local
 * Dexie cache, so an unreachable server never surfaces as a load error —
 * without this signal an empty remote library is indistinguishable from a
 * server that could not be reached (UX report U3).
 */
export interface RemoteSyncFailure {
	libraryId: string;
	at: number;
	error: unknown;
}

const failures = writable<ReadonlyMap<string, RemoteSyncFailure>>(new Map());

export const remoteSyncFailures: Readable<ReadonlyMap<string, RemoteSyncFailure>> = {
	subscribe: failures.subscribe
};

export function reportRemoteSyncFailure(libraryId: string, error: unknown): void {
	failures.update((current) => {
		const next = new Map(current);
		next.set(libraryId, { libraryId, at: Date.now(), error });
		return next;
	});
}

export function reportRemoteSyncSuccess(libraryId: string): void {
	failures.update((current) => {
		if (!current.has(libraryId)) return current;
		const next = new Map(current);
		next.delete(libraryId);
		return next;
	});
}

/**
 * Record what a crawl actually achieved, rather than that it returned.
 *
 * `reportRemoteSyncSuccess` CLEARS this library's entry — it is the user's only
 * sign that something went wrong. Every startup crawl used to call it the
 * moment the sync resolved, including a crawl that counted failures, so a sync
 * that dropped half a library wiped the warning while the books were still
 * missing.
 *
 * For Komga and Kavita that is doubly wrong: a failed crawl deliberately does
 * NOT write the completion stamp, so the next launch re-crawls the whole
 * library — with nothing on screen to explain why it is doing that again.
 */
export function reportRemoteSyncOutcome(libraryId: string, failureCount: number): void {
	if (failureCount <= 0) {
		reportRemoteSyncSuccess(libraryId);
		return;
	}
	reportRemoteSyncFailure(
		libraryId,
		withUserMessage(new Error(`${failureCount} item(s) could not be indexed`), {
			code: 'sync_items_not_indexed',
			params: { n: failureCount }
		})
	);
}

export function resetRemoteSyncStatusForTests(): void {
	failures.set(new Map());
}

/**
 * The "this library is being deleted, stop writing to it" fence, for every
 * remote provider.
 *
 * This state used to live inside `yac-sync-service.ts`, which is where it was
 * born and where its only readers were. `deleteLibraryData` — the one path a
 * library is actually removed through — imported the fence from there and
 * called it for Komga and Kavita libraries too, so the code read as though all
 * three providers were protected. They were not: nothing outside the YACReader
 * module ever consulted the generation counter or the pending set, so a Komga
 * or Kavita sync running concurrently with a delete could keep inserting rows
 * into a library that was halfway gone.
 *
 * What that leaves behind is worse than a stale row. `deleteLibraryData` reads
 * the volume list once, deletes exactly those uuids, and then drops the
 * library's `catalog_index_state` and every `remote_folders` row. A volume
 * written after that read survives with a `library_id` pointing at a library
 * the settings layer no longer lists — so it renders nowhere, appears in no
 * library's delete path, and nothing sweeps in that direction. It is
 * unreachable for the life of the database, and it can carry a thumbnail Blob.
 *
 * Two mechanisms, deliberately kept separate:
 *
 * - **Generation** is for work that is already in flight. Bumping it makes a
 *   long crawl notice, at its next checkpoint, that its results are stale and
 *   stop rather than write them.
 * - **Pending** is for work that has not started. It refuses new operations
 *   outright for as long as the delete is running.
 *
 * A crawl needs both: the generation alone cannot stop an operation submitted
 * after the bump but before the delete finishes.
 */

/** Raised when a library's rows are being deleted underneath an operation. */
export class RemoteLibraryCleanupError extends Error {
	constructor(readonly librarySettingsId: string) {
		super(`Library ${librarySettingsId} is being removed`);
		this.name = 'RemoteLibraryCleanupError';
	}
}

const libraryGenerations = new Map<string, number>();
const cleanupPending = new Set<string>();

export function getLibraryGeneration(librarySettingsId: string): number {
	return libraryGenerations.get(librarySettingsId) ?? 0;
}

/** Supersede every in-flight operation for this library. Returns the new generation. */
export function invalidateLibrarySync(librarySettingsId: string): number {
	const generation = getLibraryGeneration(librarySettingsId) + 1;
	libraryGenerations.set(librarySettingsId, generation);
	return generation;
}

export function isLibraryCleanupPending(librarySettingsId: string): boolean {
	return cleanupPending.has(librarySettingsId);
}

/**
 * Fence a library while its rows are being deleted.
 *
 * Call this before reading the volume list, and release it only once the
 * delete transaction has committed — releasing early reopens the window this
 * exists to close.
 */
export function beginRemoteLibraryCleanup(librarySettingsId: string): () => void {
	cleanupPending.add(librarySettingsId);
	invalidateLibrarySync(librarySettingsId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		cleanupPending.delete(librarySettingsId);
		onRelease.forEach((listener) => listener(librarySettingsId));
	};
}

/**
 * Providers register here to drop per-library caches when a delete finishes.
 * Keeps the fence from having to know what any one provider memoizes.
 */
const onRelease = new Set<(librarySettingsId: string) => void>();

export function onRemoteLibraryCleanupReleased(
	listener: (librarySettingsId: string) => void
): () => void {
	onRelease.add(listener);
	return () => onRelease.delete(listener);
}

/**
 * Throw unless this library may still be written to.
 *
 * Providers without a generation counter of their own call this at every point
 * where they are about to write — the top of a sync, and inside the per-item
 * loop, since a crawl of a large library runs for minutes and the delete can
 * land at any point during it.
 */
export function assertLibraryWritable(librarySettingsId: string): void {
	if (cleanupPending.has(librarySettingsId)) {
		throw new RemoteLibraryCleanupError(librarySettingsId);
	}
}

/** Test seam: forget fence state between cases. */
export function resetRemoteLibraryFenceForTests(): void {
	libraryGenerations.clear();
	cleanupPending.clear();
	onRelease.clear();
}

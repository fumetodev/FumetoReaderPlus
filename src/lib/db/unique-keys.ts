import type { Collection, IndexableType } from 'dexie';

/**
 * The distinct keys of an ordered collection, without a unique-direction
 * cursor.
 *
 * Dexie's `uniqueKeys()` asks the engine for a cursor that skips duplicate
 * keys ("nextunique"). WebKit's IndexedDB rejects that cursor direction on
 * an index with "Unable to open cursor" — on an empty store as much as a full
 * one — which on the Linux desktop turned the very first catalog query into a
 * load error. A plain key scan is accepted everywhere, and the keys arrive
 * sorted, so dropping each key that compares equal to its predecessor yields
 * the same result. `indexedDB.cmp` is the engine's own key comparison, so
 * array keys dedupe exactly as a unique cursor would have.
 */
export async function distinctKeys<TKey extends IndexableType = IndexableType>(
	collection: Collection<unknown, unknown>
): Promise<TKey[]> {
	const keys = (await collection.keys()) as TKey[];
	const distinct: TKey[] = [];
	for (const key of keys) {
		const previous = distinct[distinct.length - 1];
		if (distinct.length === 0 || indexedDB.cmp(key, previous) !== 0) distinct.push(key);
	}
	return distinct;
}

/**
 * When what is stored at a page of a reopened saved chapter can be shown. A saved chapter's pages are reconciled with
 * its stored translations as they are fetched (`pageFetched`): until a page has been, its position may hold another
 * image's translation (the site moved its pages) or none yet (this image's is still at its old position). The reader
 * looks a page's translation up as it asks for the image, so it showed the other image's translation over the page,
 * or found none and translated the page again. Its lookups wait here for the page's reconciliation.
 *
 * No database and no imports: the reader's stores ask this on every page of every volume.
 */

/** Open saved chapters, with the pages reconciled since they opened. */
const reconciled = new Map<string, Set<number>>();
const waiting = new Map<string, ((known: boolean) => void)[]>();

const pageKey = (volumeUuid: string, index: number) => `${volumeUuid}:${index}`;

function wake(key: string, known: boolean): void {
	const list = waiting.get(key);
	waiting.delete(key);
	for (const resolve of list ?? []) resolve(known);
}

/** A saved chapter opens in the reader: none of its pages is reconciled yet. */
export function guardWebChapter(volumeUuid: string): void {
	releaseWebChapter(volumeUuid);
	reconciled.set(volumeUuid, new Set());
}

/** The chapter closed: anything still waiting is told nothing is known. */
export function releaseWebChapter(volumeUuid: string): void {
	reconciled.delete(volumeUuid);
	for (const key of [...waiting.keys()]) if (key.startsWith(`${volumeUuid}:`)) wake(key, false);
}

export function webPageReconciled(volumeUuid: string, index: number): void {
	const pages = reconciled.get(volumeUuid);
	if (!pages) return;
	pages.add(index);
	wake(pageKey(volumeUuid, index), true);
}

/** The page could not be fetched: what is stored at its position stays unknown. */
export function webPageUnavailable(volumeUuid: string, index: number): void {
	if (reconciled.has(volumeUuid)) wake(pageKey(volumeUuid, index), false);
}

/**
 * Whether what is stored at page `index` belongs to the image there — `true` at once (not a promise, so an ordinary
 * volume's page load keeps its timing) for any volume but a reopened saved chapter, and for one of those once the
 * page is reconciled. False means unknown: show nothing stored for the page.
 */
export function storedPageIsCurrent(volumeUuid: string, index: number): true | Promise<boolean> {
	const pages = reconciled.get(volumeUuid);
	if (!pages || pages.has(index)) return true;
	const key = pageKey(volumeUuid, index);
	return new Promise((resolve) => waiting.set(key, [...(waiting.get(key) ?? []), resolve]));
}

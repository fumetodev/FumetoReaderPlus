import type { CatalogRow } from '$lib/types/index.js';

/** The fields next-volume selection needs; keeps callers free of full rows. */
export type VolumeOrderKey = Pick<CatalogRow, 'volume_uuid' | 'title' | 'filename' | 'visibility'>;

/**
 * Reading order within a folder.
 *
 * Deliberately NOT the catalog's sort: that defaults to `created_at desc`
 * (newest first), so "continue to the next comic" would hand back the volume
 * imported before this one rather than the next chapter. Series are numbered,
 * so natural-numeric title order is the reading order — "Vol. 2" follows
 * "Vol. 1" and sorts before "Vol. 10".
 *
 * Filename then uuid break ties so the order is total and stable; two volumes
 * sharing a title would otherwise be able to swap places between calls and
 * make "next" nondeterministic.
 */
export function compareVolumesForReading(a: VolumeOrderKey, b: VolumeOrderKey): number {
	const byTitle = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
	if (byTitle !== 0) return byTitle;
	const byFilename = a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
	if (byFilename !== 0) return byFilename;
	return a.volume_uuid.localeCompare(b.volume_uuid);
}

/**
 * The volume that follows `currentUuid` in reading order.
 *
 * `siblings` is expected to be the folder's contents including the current
 * volume. Returns null at the end of the folder, when the current volume isn't
 * present, or when it is the only entry — every one of those means "stay put
 * and bump the edge" rather than "wrap around", because silently looping back
 * to the first comic reads as the reader losing your place.
 */
export function selectNextVolumeInFolder<T extends VolumeOrderKey>(
	currentUuid: string,
	siblings: readonly T[]
): T | null {
	const ordered = siblings
		.filter((entry) => entry.visibility !== 'internal')
		.slice()
		.sort(compareVolumesForReading);
	const index = ordered.findIndex((entry) => entry.volume_uuid === currentUuid);
	if (index < 0) return null;
	return ordered[index + 1] ?? null;
}

/**
 * The author and series folders a comic can be filed under: the suggestions Import offers, and the reader's
 * "Add to library" for a comic opened from another app. A volume's folder path is `Author/Series` as the scanner set
 * it, and its author field may name one too.
 */

import { db } from '$lib/db/index.js';

/** Every author the library knows, from folder paths and author fields, sorted. */
export async function libraryAuthors(): Promise<string[]> {
	const volumes = await db.volumes.toArray();
	const authors = new Set<string>();
	for (const volume of volumes) {
		if (volume.author) authors.add(volume.author);
		const first = volume.folder_path?.split('/')[0];
		if (first) authors.add(first);
	}
	return [...authors].sort((a, b) => a.localeCompare(b));
}

/** The series folders under an author, sorted; none for no author. */
export async function librarySeriesFor(author: string): Promise<string[]> {
	if (!author) return [];
	const volumes = await db.volumes.toArray();
	const series = new Set<string>();
	for (const volume of volumes) {
		if (!volume.folder_path) continue;
		const parts = volume.folder_path.split('/');
		if ((parts[0] === author || volume.author === author) && parts.length >= 2) series.add(parts[1]);
	}
	return [...series].sort((a, b) => a.localeCompare(b));
}

/**
 * Sort what the document picker handed back into what the import can take and
 * what it cannot, before a byte of either is read.
 *
 * The picker's type filter is advisory: a provider may ignore it, and a type
 * with no entry in the platform's MIME table switches it off altogether. So a
 * selection can mix comics with anything else on the device, and a pick this
 * leaves in is read whole into memory twice, once to copy it and once to
 * index it.
 *
 * Only a name that says it is something else is turned away. A name with no
 * extension at all is what a provider gives a document it will not name, and
 * that may well be a comic, so it goes through and the archive parser decides.
 */

export interface PickTriage {
	/** Picks to import, in the order they were chosen. */
	accepted: string[];
	/** Display names of the picks left out. */
	unsupported: string[];
}

/**
 * The extension a file name ends in, lower-cased, or null when it has none.
 * At most five characters with a letter among them: `Vol.1` and `Chapter 2.5`
 * end in a number, not a file type.
 */
export function fileExtension(name: string): string | null {
	const match = /\.([a-z0-9]{1,5})$/i.exec(name.trim());
	if (!match || !/[a-z]/i.test(match[1])) return null;
	return match[1].toLowerCase();
}

export function triagePicks(
	paths: readonly string[],
	supportedExtensions: readonly string[],
	displayName: (path: string) => string
): PickTriage {
	const accepted: string[] = [];
	const unsupported: string[] = [];
	for (const path of paths) {
		const name = displayName(path);
		const extension = fileExtension(name);
		if (extension === null || supportedExtensions.includes(extension)) accepted.push(path);
		else unsupported.push(name);
	}
	return { accepted, unsupported };
}

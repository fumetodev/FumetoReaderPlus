/**
 * Desktop import inputs, loaded one file at a time.
 *
 * The desktop import used to turn every picked path into a File up front —
 * picking fifty 200 MB archives held 10 GB in the WebView before the first
 * import began. A source carries only a name until it is its turn; `load()`
 * reads it then, and the previous file can be collected before the next one is
 * read.
 */

import { filePathToFile } from './tauri-file-bridge.js';
import { resolveDisplayName } from '$lib/util/file-utils.js';

export interface ImportSource {
	/** File name shown to the user and used for duplicate detection. */
	name: string;
	load(): Promise<File>;
}

/** A File the browser already holds (HTML5 drop in `npm run dev`). */
export function fileSource(file: File): ImportSource {
	return { name: file.name, load: async () => file };
}

/** A path on disk, read only when it is imported. */
export function pathSource(path: string, read: (path: string) => Promise<File> = filePathToFile): ImportSource {
	return { name: resolveDisplayName(path), load: () => read(path) };
}

export function sourceExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export interface PartitionedSources {
	accepted: ImportSource[];
	/** Names whose extension is not supported. */
	unsupported: string[];
	/** Names already in the library. */
	duplicates: string[];
}

/** Split sources by name alone — nothing is read. */
export function partitionImportSources(
	sources: readonly ImportSource[],
	supportedExtensions: readonly string[],
	existingFilenames: ReadonlySet<string>
): PartitionedSources {
	const accepted: ImportSource[] = [];
	const unsupported: string[] = [];
	const duplicates: string[] = [];
	for (const source of sources) {
		if (!supportedExtensions.includes(sourceExtension(source.name))) unsupported.push(source.name);
		else if (existingFilenames.has(source.name)) duplicates.push(source.name);
		else accepted.push(source);
	}
	return { accepted, unsupported, duplicates };
}

export interface SequentialImportResult {
	/** Whatever `importOne` returned for each success, in order. */
	succeeded: string[];
	failed: Array<{ name: string; error: string }>;
}

/**
 * Import sources one after another, loading each just before its import. A
 * file that cannot be read fails on its own; the rest still import.
 */
export async function importSourcesSequentially(
	sources: readonly ImportSource[],
	importOne: (file: File, index: number) => Promise<string>,
	hooks: { onStart?: (index: number, source: ImportSource) => void; fallbackError?: () => string } = {}
): Promise<SequentialImportResult> {
	const succeeded: string[] = [];
	const failed: Array<{ name: string; error: string }> = [];
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index];
		hooks.onStart?.(index, source);
		try {
			const file = await source.load();
			succeeded.push(await importOne(file, index));
		} catch (error) {
			failed.push({
				name: source.name,
				error: error instanceof Error ? error.message : (hooks.fallbackError?.() ?? String(error))
			});
		}
	}
	return { succeeded, failed };
}

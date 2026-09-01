/**
 * Builds a foliate-js book object from an EPUB blob using the APP's
 * @zip.js/zip.js — never foliate's vendored copy (a throwing stub). The zip
 * reader stays open for the book's lifetime because foliate loads section
 * XHTML and resources lazily; call `close()` when the reader is done with
 * the book (BookReader unmount, or immediately after metadata-only use).
 */

import { BlobReader, BlobWriter, TextWriter, ZipReader, configure, type Entry } from '@zip.js/zip.js';

// Configure zip.js for Node.js environments (testing) — same guard as the
// import extractors.
const isNode =
	typeof globalThis !== 'undefined' &&
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).process?.versions?.node != null;
if (isNode) {
	configure({ useWebWorkers: false });
}

export interface FoliateTocItem {
	label?: string;
	href?: string;
	subitems?: FoliateTocItem[] | null;
}

export interface FoliateResolvedTarget {
	index: number;
	anchor?: unknown;
}

/**
 * The subset of foliate's book interface the app consumes. Kept loose on
 * purpose — upstream is unversioned; the adapter and BookReader must treat
 * everything optional as optional.
 */
export interface FoliateBook {
	sections?: Array<{ linear?: string; size?: number }>;
	toc?: FoliateTocItem[];
	metadata?: {
		title?: unknown;
		author?: unknown;
		language?: unknown;
		[key: string]: unknown;
	};
	dir?: string;
	rendition?: { layout?: string };
	getCover?: () => Promise<Blob | null>;
	resolveHref?: (href: string) => FoliateResolvedTarget | undefined;
	resolveCFI?: (cfi: string) => FoliateResolvedTarget;
	splitTOCHref?: (href: string) => unknown;
	destroy?: () => void;
}

export interface OpenedEpubBook {
	book: FoliateBook;
	/** Releases the underlying zip reader; the book is unusable after. */
	close: () => Promise<void>;
}

/** Titles/names in foliate metadata can be strings or localized objects. */
export function foliateMetadataText(value: unknown): string | undefined {
	if (typeof value === 'string') return value.trim() || undefined;
	if (Array.isArray(value)) return foliateMetadataText(value[0]);
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.name === 'string') return record.name.trim() || undefined;
		for (const entry of Object.values(record)) {
			const text = foliateMetadataText(entry);
			if (text) return text;
		}
	}
	return undefined;
}

/** Open an EPUB blob as a foliate book over the app's zip.js. */
export async function openEpubBook(archive: Blob): Promise<OpenedEpubBook> {
	const zipReader = new ZipReader(new BlobReader(archive));
	let entries: Entry[];
	try {
		entries = await zipReader.getEntries();
	} catch (error) {
		await zipReader.close().catch(() => undefined);
		throw error;
	}
	const byName = new Map(entries.filter((e) => !e.directory).map((e) => [e.filename, e]));
	const findEntry = (name: string): Entry | undefined => {
		const direct = byName.get(name);
		if (direct) return direct;
		// Foliate resolves hrefs percent-decoded; zip entries may differ.
		try {
			return byName.get(decodeURIComponent(name));
		} catch {
			return undefined;
		}
	};

	const loader = {
		loadText: async (name: string) => {
			const entry = findEntry(name);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return entry ? ((await (entry as any).getData(new TextWriter())) as string) : undefined;
		},
		loadBlob: async (name: string) => {
			const entry = findEntry(name);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return entry ? ((await (entry as any).getData(new BlobWriter())) as Blob) : undefined;
		},
		getSize: (name: string) => findEntry(name)?.uncompressedSize ?? 0
	};

	try {
		const { EPUB } = await import('$lib/vendor/foliate-js/epub.js');
		const book = (await new EPUB(loader).init()) as FoliateBook;
		return {
			book,
			close: async () => {
				book.destroy?.();
				await zipReader.close().catch(() => undefined);
			}
		};
	} catch (error) {
		await zipReader.close().catch(() => undefined);
		throw error;
	}
}

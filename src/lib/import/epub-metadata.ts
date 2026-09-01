/**
 * EPUB package parsing and comic-vs-reflowable classification.
 *
 * `classifyEpub` decides how an .epub routes through import: `comic` sends it
 * to the fixed-layout extractor (archive-extraction-epub.ts) so pages flow
 * through the normal comic pipeline; `reflowable` routes to the book import
 * (import-book.ts) — stored whole, read by the foliate BookReader. The
 * verdict + metadata shape (title, author, page-progression-direction,
 * cover href) is consumed by both paths and must stay stable.
 *
 * Classification tiers, in order:
 *   1. Declared fixed layout (`rendition:layout` = pre-paginated, the legacy
 *      Apple `fixed-layout` meta, or every linear spine item carrying the
 *      per-item pre-paginated override) → comic.
 *   2. Content sniff: sample the first few linear spine documents — when
 *      nearly all wrap a single image with almost no text AND image entries
 *      dominate the archive's compressed bytes (read from the central
 *      directory only; nothing is inflated except the sampled documents)
 *      → comic. Catches undeclared/converted comic EPUBs.
 *   3. Otherwise → reflowable.
 *   4. Unparseable container/OPF: raster-dominant bytes → comic (the
 *      extractor's natural-sort fallback will handle it), else reflowable.
 *
 * `classifyEpub` never throws — malformed input degrades to tier 4. All XML
 * handling matches on localName so publisher namespace prefixes don't matter.
 */

import { BlobReader, TextWriter, ZipReader, configure, type Entry } from '@zip.js/zip.js';
import { isImageExtension } from './types.js';

// Configure zip.js for Node.js environments (testing) — same guard as
// archive-extraction.ts; module-level so any entry point is covered.
const isNode =
	typeof globalThis !== 'undefined' &&
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).process?.versions?.node != null;
if (isNode) {
	configure({ useWebWorkers: false });
}

/** Tunable sniff thresholds — pinned by epub-metadata.test.ts. */
export const SPINE_SAMPLE_LIMIT = 8;
export const IMAGE_PAGE_MAX_TEXT_CHARS = 100;
export const IMAGE_SPINE_RATIO = 0.8;
export const IMAGE_BYTES_RATIO = 0.6;

export interface EpubBookMetadata {
	title?: string;
	author?: string;
	pageProgressionDirection?: 'rtl' | 'ltr';
	/** Zip path of the cover image inside the archive, when declared. */
	coverHref?: string;
}

export type EpubVerdictReason =
	| 'pre-paginated'
	| 'image-spine'
	| 'text-content'
	| 'unparseable-fallback';

export interface EpubClassification {
	verdict: 'comic' | 'reflowable';
	reason: EpubVerdictReason;
	metadata: EpubBookMetadata;
}

export interface EpubManifestItem {
	id: string;
	/** Zip path, resolved against the OPF directory and percent-decoded. */
	zipPath: string;
	mediaType: string;
	properties: string;
}

export interface EpubSpineItem {
	idref: string;
	linear: boolean;
	properties: string;
	/** Resolved manifest item, when the idref matched one. */
	item?: EpubManifestItem;
}

export interface EpubPackage {
	opfPath: string;
	/** Directory of the OPF inside the zip ('' when at the root). */
	opfDir: string;
	metadata: EpubBookMetadata;
	prePaginated: boolean;
	manifest: Map<string, EpubManifestItem>;
	spine: EpubSpineItem[];
	/** Zip path of the declared cover image, if any. */
	coverZipPath?: string;
}

/**
 * Resolve an href against a zip directory: strips fragments/queries, applies
 * `.`/`..` segments, percent-decodes. Returns a normalized zip path.
 */
export function resolveZipHref(baseDir: string, href: string): string {
	const withoutFragment = href.split('#')[0].split('?')[0];
	let decoded = withoutFragment;
	try {
		decoded = decodeURIComponent(withoutFragment);
	} catch {
		// Keep the raw form — a literal % in a filename is legal in a zip.
	}
	const segments = (baseDir ? baseDir.split('/') : []).filter(Boolean);
	for (const part of decoded.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	return segments.join('/');
}

function parseXml(text: string): Document | null {
	const doc = new DOMParser().parseFromString(text, 'text/xml');
	return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
}

/** Parse a spine content document leniently (XHTML first, HTML fallback). */
export function parseContentDocument(text: string): Document | null {
	const parser = new DOMParser();
	try {
		const xhtml = parser.parseFromString(text, 'application/xhtml+xml');
		if (xhtml.getElementsByTagName('parsererror').length === 0) return xhtml;
	} catch {
		// fall through to HTML parsing
	}
	try {
		return parser.parseFromString(text, 'text/html');
	} catch {
		return null;
	}
}

function byLocalName(root: Document | Element, localName: string): Element[] {
	const out: Element[] = [];
	const all = root.getElementsByTagName('*');
	for (let i = 0; i < all.length; i++) {
		if (all[i].localName === localName) out.push(all[i]);
	}
	return out;
}

async function readEntryText(entry: Entry): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return await (entry as any).getData(new TextWriter());
}

function findEntry(entries: Entry[], zipPath: string): Entry | undefined {
	return entries.find((entry) => !entry.directory && entry.filename === zipPath);
}

/**
 * Parse container.xml + the OPF into a structured package description.
 * Returns null when the archive is not a parseable EPUB.
 */
export async function parseEpubPackage(entries: Entry[]): Promise<EpubPackage | null> {
	try {
		const container = findEntry(entries, 'META-INF/container.xml');
		if (!container) return null;
		const containerDoc = parseXml(await readEntryText(container));
		if (!containerDoc) return null;
		const rootfile = byLocalName(containerDoc, 'rootfile').find((el) =>
			el.getAttribute('full-path')
		);
		const opfPath = rootfile?.getAttribute('full-path') ?? '';
		if (!opfPath) return null;

		const opfEntry = findEntry(entries, opfPath);
		if (!opfEntry) return null;
		const opfDoc = parseXml(await readEntryText(opfEntry));
		if (!opfDoc) return null;

		const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

		const manifest = new Map<string, EpubManifestItem>();
		for (const item of byLocalName(opfDoc, 'item')) {
			const id = item.getAttribute('id');
			const href = item.getAttribute('href');
			if (!id || !href) continue;
			manifest.set(id, {
				id,
				zipPath: resolveZipHref(opfDir, href),
				mediaType: item.getAttribute('media-type') ?? '',
				properties: item.getAttribute('properties') ?? ''
			});
		}

		const spineEl = byLocalName(opfDoc, 'spine')[0];
		const spine: EpubSpineItem[] = [];
		if (spineEl) {
			for (const itemref of byLocalName(spineEl, 'itemref')) {
				const idref = itemref.getAttribute('idref');
				if (!idref) continue;
				spine.push({
					idref,
					linear: itemref.getAttribute('linear') !== 'no',
					properties: itemref.getAttribute('properties') ?? '',
					item: manifest.get(idref)
				});
			}
		}

		// Metadata — first dc:title / dc:creator, matched by localName.
		const metadata: EpubBookMetadata = {};
		const title = byLocalName(opfDoc, 'title')[0]?.textContent?.trim();
		if (title) metadata.title = title;
		const author = byLocalName(opfDoc, 'creator')[0]?.textContent?.trim();
		if (author) metadata.author = author;
		const direction = spineEl?.getAttribute('page-progression-direction');
		if (direction === 'rtl' || direction === 'ltr') {
			metadata.pageProgressionDirection = direction;
		}

		// Fixed-layout declarations.
		const metas = byLocalName(opfDoc, 'meta');
		const globalPrePaginated = metas.some(
			(meta) =>
				meta.getAttribute('property') === 'rendition:layout' &&
				meta.textContent?.trim() === 'pre-paginated'
		);
		// Legacy (EPUB2 / Apple) declaration: <meta name="fixed-layout" content="true"/>
		const legacyFixedLayout = metas.some(
			(meta) =>
				meta.getAttribute('name')?.toLowerCase() === 'fixed-layout' &&
				meta.getAttribute('content')?.trim().toLowerCase() === 'true'
		);
		const linearItems = spine.filter((item) => item.linear);
		const perItemPrePaginated =
			linearItems.length > 0 &&
			linearItems.every((item) =>
				item.properties.split(/\s+/).includes('rendition:layout-pre-paginated')
			);
		const prePaginated = globalPrePaginated || legacyFixedLayout || perItemPrePaginated;

		// Cover: properties~="cover-image" wins, else the legacy meta[name=cover].
		let coverZipPath: string | undefined;
		for (const item of manifest.values()) {
			if (item.properties.split(/\s+/).includes('cover-image')) {
				coverZipPath = item.zipPath;
				break;
			}
		}
		if (!coverZipPath) {
			const coverMeta = metas.find((meta) => meta.getAttribute('name') === 'cover');
			const coverId = coverMeta?.getAttribute('content');
			if (coverId) coverZipPath = manifest.get(coverId)?.zipPath;
		}
		if (coverZipPath) metadata.coverHref = coverZipPath;

		return { opfPath, opfDir, metadata, prePaginated, manifest, spine, coverZipPath };
	} catch {
		return null;
	}
}

/**
 * The href of the first image in document order — `<img src>` or an SVG
 * `<image href|xlink:href>` — or null when the document wraps no image.
 * Used by the extractor to resolve a fixed-layout spine page to its bitmap.
 */
export function firstImageHrefInDocument(doc: Document): string | null {
	const all = doc.getElementsByTagName('*');
	for (let i = 0; i < all.length; i++) {
		const el = all[i];
		if (el.localName === 'img') {
			const src = el.getAttribute('src');
			if (src) return src;
		} else if (el.localName === 'image') {
			const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
			if (href) return href;
		}
	}
	return null;
}

function extensionOf(zipPath: string): string {
	const basename = zipPath.split('/').pop() ?? zipPath;
	const dot = basename.lastIndexOf('.');
	return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : '';
}

/** Share of the archive's compressed bytes held by raster image entries. */
function imageByteRatio(entries: Entry[]): number {
	let imageBytes = 0;
	let totalBytes = 0;
	for (const entry of entries) {
		if (entry.directory) continue;
		const size = entry.compressedSize ?? 0;
		totalBytes += size;
		if (isImageExtension(extensionOf(entry.filename))) imageBytes += size;
	}
	return totalBytes > 0 ? imageBytes / totalBytes : 0;
}

function countImageElements(doc: Document): number {
	let count = byLocalName(doc, 'img').length;
	// SVG wrappers: <svg><image href|xlink:href/></svg>
	count += byLocalName(doc, 'image').length;
	return count;
}

function visibleTextLength(doc: Document): number {
	const body = byLocalName(doc, 'body')[0] ?? doc.documentElement;
	const text = body?.textContent ?? '';
	return text.replace(/\s+/g, ' ').trim().length;
}

/**
 * Classify an .epub blob as an image comic or a reflowable text ebook.
 * Never throws; malformed input degrades to the 'unparseable-fallback' tier.
 */
export async function classifyEpub(archive: Blob): Promise<EpubClassification> {
	// The reader must stay open until every getData call below has finished.
	const zipReader = new ZipReader(new BlobReader(archive));
	try {
		let entries: Entry[];
		try {
			entries = await zipReader.getEntries();
		} catch {
			// Not a readable zip: let the comic extractor surface the real error.
			return { verdict: 'comic', reason: 'unparseable-fallback', metadata: {} };
		}
		return await classifyEntries(entries);
	} finally {
		try {
			await zipReader.close();
		} catch {
			// close failures are irrelevant to the verdict
		}
	}
}

async function classifyEntries(entries: Entry[]): Promise<EpubClassification> {
	const rasterRatio = imageByteRatio(entries);
	const pkg = await parseEpubPackage(entries);
	if (!pkg) {
		return {
			verdict: rasterRatio >= IMAGE_BYTES_RATIO ? 'comic' : 'reflowable',
			reason: 'unparseable-fallback',
			metadata: {}
		};
	}

	if (pkg.prePaginated) {
		return { verdict: 'comic', reason: 'pre-paginated', metadata: pkg.metadata };
	}

	// Tier 2: sniff the first few linear spine documents.
	let sampled = 0;
	let imageBearing = 0;
	for (const spineItem of pkg.spine) {
		if (sampled >= SPINE_SAMPLE_LIMIT) break;
		if (!spineItem.linear || !spineItem.item) continue;
		const { mediaType, zipPath } = spineItem.item;
		if (mediaType.startsWith('image/') && mediaType !== 'image/svg+xml') {
			// The spine item IS an image — maximally image-bearing.
			sampled++;
			imageBearing++;
			continue;
		}
		if (mediaType !== 'application/xhtml+xml' && mediaType !== 'image/svg+xml') continue;
		const entry = findEntry(entries, zipPath);
		if (!entry) continue;
		sampled++;
		try {
			const doc = parseContentDocument(await readEntryText(entry));
			if (
				doc &&
				countImageElements(doc) === 1 &&
				visibleTextLength(doc) < IMAGE_PAGE_MAX_TEXT_CHARS
			) {
				imageBearing++;
			}
		} catch {
			// Unreadable sample counts as non-image-bearing.
		}
	}
	if (
		sampled > 0 &&
		imageBearing / sampled >= IMAGE_SPINE_RATIO &&
		rasterRatio >= IMAGE_BYTES_RATIO
	) {
		return { verdict: 'comic', reason: 'image-spine', metadata: pkg.metadata };
	}

	return { verdict: 'reflowable', reason: 'text-content', metadata: pkg.metadata };
}

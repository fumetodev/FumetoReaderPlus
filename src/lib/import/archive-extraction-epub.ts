/**
 * EPUB extraction for Fumeto — fixed-layout/image comic EPUBs only.
 *
 * Mirrors the RAR/PDF extractor module shape (extractFirst* + stream*Pages)
 * and produces the same streamed-page output, so EPUB comics flow through the
 * entire existing pipeline (reader, translation, overlay, export) with zero
 * downstream changes. Reflowable EPUBs never reach this module — the
 * classifier (epub-metadata.ts) rejects them at the import-service seam.
 *
 * Page order is OPF SPINE ORDER, never filename sort: the spine is resolved
 * to an ordered image plan first (a text-only pass over the small XHTML
 * wrappers), then images are inflated one at a time with the streaming
 * backpressure contract (`onPage` awaited; at most one decompressed page
 * alive). Spine items that yield no page — `linear="no"`, unresolvable or
 * missing images, and duplicate images (a cover repeated as page 1) — are
 * counted in `skippedCount`; structural files (OPF, XHTML, CSS, fonts) are
 * structure, not skipped pages, and are never counted.
 *
 * When the container/OPF is unparseable, or the spine resolves to zero
 * images while raster entries exist, extraction falls back to the zip
 * extractor's behavior: natural-sorted raster entries.
 */

import { BlobReader, Uint8ArrayWriter, ZipReader, configure, type Entry } from '@zip.js/zip.js';
import { isSystemFile, isImageExtension, getImageMimeType } from './types.js';
import { naturalCompare } from '$lib/util/natural-sort.js';
import {
	firstImageHrefInDocument,
	parseContentDocument,
	parseEpubPackage,
	resolveZipHref,
	type EpubPackage
} from './epub-metadata.js';
import type { StreamedPageHandler } from './archive-extraction.js';

// Configure zip.js for Node.js environments (testing) — same guard as the
// other extractors; this module can be the first zip.js entry point.
const isNode =
	typeof globalThis !== 'undefined' &&
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).process?.versions?.node != null;
if (isNode) {
	configure({ useWebWorkers: false });
}

function extensionOf(zipPath: string): string {
	const basename = zipPath.split('/').pop() ?? zipPath;
	const dot = basename.lastIndexOf('.');
	return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : '';
}

function isRasterImageEntry(entry: Entry): boolean {
	if (entry.directory || isSystemFile(entry.filename)) return false;
	return isImageExtension(extensionOf(entry.filename));
}

/** EPUB skeleton files — structure, never counted as skipped pages. */
const STRUCTURAL_EXTENSIONS = new Set([
	'opf',
	'ncx',
	'xhtml',
	'html',
	'htm',
	'xml',
	'css',
	'js',
	'ttf',
	'otf',
	'woff',
	'woff2'
]);

function isStructuralEntry(entry: Entry): boolean {
	if (entry.filename === 'mimetype') return true;
	if (entry.filename.startsWith('META-INF/')) return true;
	return STRUCTURAL_EXTENSIONS.has(extensionOf(entry.filename));
}

async function readEntryBytes(entry: Entry): Promise<Uint8Array> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return await (entry as any).getData(new Uint8ArrayWriter());
}

async function readEntryText(entry: Entry): Promise<string> {
	const bytes = await readEntryBytes(entry);
	return new TextDecoder().decode(bytes);
}

function findEntry(entries: Entry[], zipPath: string): Entry | undefined {
	return entries.find((entry) => !entry.directory && entry.filename === zipPath);
}

function toImageFile(zipPath: string, bytes: Uint8Array): File {
	const basename = zipPath.split('/').pop() || zipPath;
	return new File([bytes.buffer as ArrayBuffer], basename, {
		type: getImageMimeType(extensionOf(zipPath)),
		lastModified: Date.now()
	});
}

interface SpinePlan {
	/** Image entries in reading (spine) order. */
	plan: Entry[];
	/** Spine items that yielded no page (linear=no / unresolved / duplicate). */
	skippedCount: number;
}

/**
 * Resolve the spine to an ordered list of image entries. Text-only pass:
 * inflates the small XHTML/SVG wrappers, never the images themselves.
 */
async function resolveSpineImages(entries: Entry[], pkg: EpubPackage): Promise<SpinePlan> {
	const plan: Entry[] = [];
	const seenImagePaths = new Set<string>();
	let skippedCount = 0;

	for (const spineItem of pkg.spine) {
		if (!spineItem.linear || !spineItem.item) {
			skippedCount++;
			continue;
		}
		const { mediaType, zipPath } = spineItem.item;
		let imageZipPath: string | undefined;
		if (mediaType.startsWith('image/') && mediaType !== 'image/svg+xml') {
			// Some comic EPUBs put images directly in the spine.
			imageZipPath = zipPath;
		} else {
			const docEntry = findEntry(entries, zipPath);
			if (docEntry) {
				try {
					const doc = parseContentDocument(await readEntryText(docEntry));
					const href = doc ? firstImageHrefInDocument(doc) : null;
					if (href) {
						// Hrefs resolve against the referencing document's directory.
						const docDir = zipPath.includes('/')
							? zipPath.slice(0, zipPath.lastIndexOf('/'))
							: '';
						imageZipPath = resolveZipHref(docDir, href);
					}
				} catch {
					// Unreadable wrapper: counted as skipped below.
				}
			}
		}

		const imageEntry = imageZipPath ? findEntry(entries, imageZipPath) : undefined;
		if (!imageEntry || !imageZipPath) {
			skippedCount++;
			continue;
		}
		if (seenImagePaths.has(imageZipPath)) {
			// Typical case: the cover image repeated as a spine page.
			skippedCount++;
			continue;
		}
		seenImagePaths.add(imageZipPath);
		plan.push(imageEntry);
	}

	return { plan, skippedCount };
}

/** Natural-sort fallback plan, mirroring the plain zip extractor. */
function fallbackPlan(entries: Entry[]): SpinePlan {
	const plan = entries
		.filter(isRasterImageEntry)
		.sort((a, b) => naturalCompare(a.filename, b.filename));
	const skippedCount = entries.filter(
		(entry) =>
			!entry.directory &&
			!isRasterImageEntry(entry) &&
			!isStructuralEntry(entry) &&
			!isSystemFile(entry.filename)
	).length;
	return { plan, skippedCount };
}

async function buildExtractionPlan(entries: Entry[]): Promise<SpinePlan> {
	const pkg = await parseEpubPackage(entries);
	if (pkg) {
		const spinePlan = await resolveSpineImages(entries, pkg);
		if (spinePlan.plan.length > 0) return spinePlan;
	}
	return fallbackPlan(entries);
}

/**
 * Extract only the cover/first image from an EPUB.
 *
 * Priority: the OPF-declared cover (cover-image property, then the legacy
 * meta[name=cover]) → the first spine-resolved image → the first
 * natural-sorted raster entry. Used by cover-only flows (legacy thumbnail
 * regeneration) that must not inflate every page.
 */
export async function extractFirstEpubImage(archiveBlob: Blob): Promise<File | undefined> {
	const zipReader = new ZipReader(new BlobReader(archiveBlob));
	try {
		const entries = await zipReader.getEntries();
		const pkg = await parseEpubPackage(entries);
		if (pkg?.coverZipPath) {
			const coverEntry = findEntry(entries, pkg.coverZipPath);
			if (coverEntry) {
				return toImageFile(pkg.coverZipPath, await readEntryBytes(coverEntry));
			}
		}
		const { plan } = await buildExtractionPlan(entries);
		const first = plan[0];
		if (!first) return undefined;
		return toImageFile(first.filename, await readEntryBytes(first));
	} finally {
		await zipReader.close();
	}
}

/**
 * Stream images out of an EPUB one page at a time in spine order.
 *
 * Same contract as streamZipArchivePages: at most ONE decompressed page is
 * alive at a time, and `onPage` is awaited so the consumer persists each page
 * before the next is inflated.
 */
export async function streamEpubArchivePages(
	archiveBlob: Blob,
	onPage: StreamedPageHandler,
	onProgress?: (extracted: number, total: number) => void
): Promise<{ imageCount: number; skippedCount: number }> {
	const zipReader = new ZipReader(new BlobReader(archiveBlob));
	try {
		const entries = await zipReader.getEntries();
		const { plan, skippedCount } = await buildExtractionPlan(entries);

		let delivered = 0;
		for (const entry of plan) {
			const bytes = await readEntryBytes(entry);
			await onPage({
				index: delivered,
				filename: entry.filename,
				file: toImageFile(entry.filename, bytes)
			});
			delivered++;
			onProgress?.(delivered, plan.length);
		}
		return { imageCount: delivered, skippedCount };
	} finally {
		await zipReader.close();
	}
}

/**
 * Reflowable-EPUB ("book") import: the consume path behind the classifier's
 * `reflowable` verdict, replacing the Phase-1 reject.
 *
 * Books are stored WHOLE — one book_files row with the original .epub — and
 * never touch volume_pages/page_dimensions; foliate reads sections lazily
 * from the archive at reading time. Coarse progress stays page-shaped
 * (page_count = spine section count, current_page = section index) so every
 * existing consumer (tabs, catalog progress, openingPageFor) remains
 * coherent; exact resume uses book_locator (EPUB CFI) + fraction, written by
 * the BookReader.
 *
 * The parser is an injectable parameter (node tests have no DOM; the default
 * parses via the foliate loader over the app's zip.js). Everything lands in
 * ONE transaction — a crashed import shows nothing.
 */

import { db } from '$lib/db/index.js';
import type { VolumeMetadata } from '$lib/types/index.js';
import {
	toCatalogRow,
	volumeThumbnailAsset,
	volumeWithoutEmbeddedMedia
} from '$lib/catalog/catalog-repository.js';
import { revokeThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
import type { EpubClassification } from './epub-metadata.js';
import {
	generateImportThumbnail,
	IMPORT_THUMBNAIL_GENERATION_VERSION,
	type ImportProgress
} from './import-service.js';

/** What the book pipeline needs from an EPUB parse. */
export interface ParsedBookInfo {
	/** Spine section count; must be ≥ 1 for a readable book. */
	sectionCount: number;
	title?: string;
	author?: string;
	/** Publisher-declared page progression; only 'rtl' is ever stamped. */
	direction?: string;
	cover?: Blob | null;
}

export type BookParser = (archive: Blob) => Promise<ParsedBookInfo>;

/** Default parser: foliate's epub.js over the app zip loader. */
export async function parseEpubForImport(archive: Blob): Promise<ParsedBookInfo> {
	const { foliateMetadataText, openEpubBook } = await import('$lib/book/foliate-loader.js');
	const { book, close } = await openEpubBook(archive);
	try {
		return {
			sectionCount: book.sections?.length ?? 0,
			title: foliateMetadataText(book.metadata?.title),
			author: foliateMetadataText(book.metadata?.author),
			direction: book.dir,
			cover: (await book.getCover?.().catch(() => null)) ?? null
		};
	} finally {
		await close();
	}
}

export interface ImportBookOptions {
	onProgress?: (progress: ImportProgress) => void;
	libraryId?: string;
	folderPath?: string;
	existingMetadata?: VolumeMetadata;
	readingDirection?: 'rtl' | 'ltr';
	/** Classifier output — metadata fallback/cross-check for the parse. */
	classification?: EpubClassification;
	/** Test seam; defaults to the foliate parse. */
	parse?: BookParser;
}

export async function importReflowableBook(
	file: File,
	volumeUuid: string,
	options: ImportBookOptions = {}
): Promise<string> {
	const { onProgress, existingMetadata, classification } = options;
	onProgress?.({ stage: 'processing', current: 0, total: 1, message: { code: 'import_progress_reading_book' } });

	const parse = options.parse ?? parseEpubForImport;
	const parsed = await parse(file);
	if (!parsed.sectionCount || parsed.sectionCount < 1) {
		throw new Error('This EPUB has no readable sections.');
	}

	const classifierMeta = classification?.metadata;
	const stem = file.name.replace(/\.epub$/i, '');
	const title = parsed.title ?? classifierMeta?.title ?? existingMetadata?.title ?? stem;
	const author = parsed.author ?? classifierMeta?.author ?? existingMetadata?.author;
	// Publisher-declared rtl is genuine knowledge, but ranks below the caller
	// and below an existing (possibly user-overridden) value — the same rule
	// as comic EPUBs.
	const parsedRtl =
		parsed.direction === 'rtl' || classifierMeta?.pageProgressionDirection === 'rtl'
			? ('rtl' as const)
			: undefined;

	let thumbnail: { blob: Blob; width: number; height: number } | undefined;
	if (parsed.cover) {
		try {
			thumbnail = await generateImportThumbnail(
				new File([parsed.cover], 'cover', { type: parsed.cover.type || 'image/jpeg' })
			);
		} catch (err) {
			console.warn('Book cover thumbnail generation failed:', err);
		}
	}

	const metadata: VolumeMetadata = {
		...existingMetadata,
		volume_uuid: volumeUuid,
		media_kind: 'book',
		title,
		author,
		filename: file.name,
		page_count: parsed.sectionCount,
		created_at: existingMetadata?.created_at ?? new Date().toISOString(),
		current_page: Math.min(existingMetadata?.current_page ?? 0, parsed.sectionCount - 1),
		book_locator: existingMetadata?.book_locator,
		book_progress_fraction: existingMetadata?.book_progress_fraction,
		thumbnail: thumbnail?.blob,
		thumbnail_width: thumbnail?.width,
		thumbnail_height: thumbnail?.height,
		thumbnail_generation_version: thumbnail ? IMPORT_THUMBNAIL_GENERATION_VERSION : undefined,
		reading_direction:
			options.readingDirection ?? existingMetadata?.reading_direction ?? parsedRtl,
		library_id: options.libraryId ?? existingMetadata?.library_id,
		folder_path: options.folderPath ?? existingMetadata?.folder_path ?? ''
	};

	onProgress?.({ stage: 'storing', current: 0, total: 1, message: { code: 'import_progress_saving_book' } });

	await db.transaction(
		'rw',
		[db.volumes, db.catalog_rows, db.media_assets, db.book_files],
		async () => {
			await db.book_files.put({ volume_uuid: volumeUuid, file });
			await db.volumes.put(volumeWithoutEmbeddedMedia(metadata));
			await db.catalog_rows.put(toCatalogRow(metadata));
			const asset = volumeThumbnailAsset(metadata);
			if (asset) await db.media_assets.put(asset);
		}
	);
	if (existingMetadata) revokeThumbnailUrl(volumeUuid);

	return volumeUuid;
}

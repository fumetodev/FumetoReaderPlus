import Dexie, { type Table } from 'dexie';
import type {
	VolumeMetadata,
	VolumeFiles,
	VolumePageRecord,
	BookFileRecord,
	PageDimensions,
	TranslationRegion,
	Translation,
	WorkContext,
	PageTranslation,
	VolumeTranslationJob,
	Tag,
	LibraryImport,
	RemoteFolder,
	InpaintedPage,
	ComicTab,
	CatalogRow,
	MediaAsset,
	CatalogIndexState,
	CatalogProvider,
	VolumeSource
} from '$lib/types/index.js';
import { shouldClearStampedReadingDirection } from './reading-direction-migration.js';

interface LegacyOnlineChapterRecord {
	id: string;
	volume_uuid?: string;
}

function isRetiredOnlineVolume(volume: VolumeMetadata): boolean {
	const legacySource = volume.source as { type?: string } | undefined;
	return (
		legacySource?.type === 'online' ||
		(volume.visibility === 'internal' && volume.volume_uuid.startsWith('online:'))
	);
}

function isNonEmptyStoredFile(value: unknown): boolean {
	if (!(value instanceof Blob)) return false;
	const size = value.size;
	return typeof size === 'number' && Number.isSafeInteger(size) && size > 0;
}

/**
 * The legacy downloader persisted these three records before updating the
 * chapter's `downloaded`/`volume_uuid` fields. Treat that completion marker as
 * advisory and verify the durable page payload instead, including a one-to-one
 * mapping between file names and dimension rows.
 */
function hasCompleteLocalPagePayload(
	volume: VolumeMetadata,
	volumeFiles: VolumeFiles | undefined,
	pageDimensions: PageDimensions | undefined
): boolean {
	const pageCount = volume.page_count;
	if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return false;

	const files = volumeFiles?.files;
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
	const filenames = Object.keys(files);
	if (
		filenames.length !== pageCount ||
		filenames.some(name => name.length === 0 || !isNonEmptyStoredFile(files[name]))
	)
		return false;

	const pages = pageDimensions?.pages;
	if (!Array.isArray(pages) || pages.length !== pageCount) return false;

	const filenameSet = new Set(filenames);
	const dimensionFilenames = new Set<string>();
	const dimensionIndexes = new Set<number>();
	for (const page of pages) {
		if (
			typeof page?.filename !== 'string' ||
			!filenameSet.has(page.filename) ||
			!Number.isSafeInteger(page.index) ||
			page.index < 0 ||
			page.index >= pageCount
		)
			return false;
		dimensionFilenames.add(page.filename);
		dimensionIndexes.add(page.index);
	}

	return dimensionFilenames.size === pageCount && dimensionIndexes.size === pageCount;
}

async function deleteRetiredOnlineVolumeData(
	tx: import('dexie').Transaction,
	volumeUuid: string
): Promise<void> {
	await tx.table('volumes').delete(volumeUuid);
	await tx.table('volume_files').delete(volumeUuid);
	await tx.table('page_dimensions').delete(volumeUuid);
	await tx.table('regions').where('volume_uuid').equals(volumeUuid).delete();
	await tx
		.table('translations')
		.where('[volume_uuid+page_index]')
		.between([volumeUuid, Dexie.minKey], [volumeUuid, Dexie.maxKey])
		.delete();
	await tx.table('work_context').delete(volumeUuid);
	await tx.table('page_translations').where('volume_uuid').equals(volumeUuid).delete();
	await tx.table('volume_translation_jobs').where('volume_uuid').equals(volumeUuid).delete();
	await tx.table('inpainted_pages').where('volume_uuid').equals(volumeUuid).delete();
	await tx.table('library_imports').where('volume_uuid').equals(volumeUuid).delete();
}

/**
 * Preserve demonstrably complete local page payloads as ordinary local books
 * before removing the retired online-source stores. The legacy completion
 * marker could lag behind these durable records if the app stopped in a small
 * crash window. Partial/streamed entries are removed with their derived data.
 */
async function migrateRetiredOnlineSourceData(tx: import('dexie').Transaction): Promise<void> {
	const chapters = (await tx.table('manga_chapters').toArray()) as LegacyOnlineChapterRecord[];
	const retiredVolumeIds = new Set<string>();
	for (const chapter of chapters) {
		if (chapter.volume_uuid) retiredVolumeIds.add(chapter.volume_uuid);
		retiredVolumeIds.add(`online:${chapter.id}`);
	}

	const volumes = (await tx.table('volumes').toArray()) as VolumeMetadata[];
	for (const volume of volumes) {
		if (isRetiredOnlineVolume(volume)) retiredVolumeIds.add(volume.volume_uuid);
	}

	const preservedVolumeIds = new Set<string>();
	for (const volumeUuid of retiredVolumeIds) {
		const [volume, volumeFiles, pageDimensions] = await Promise.all([
			tx.table('volumes').get(volumeUuid) as Promise<VolumeMetadata | undefined>,
			tx.table('volume_files').get(volumeUuid) as Promise<VolumeFiles | undefined>,
			tx.table('page_dimensions').get(volumeUuid) as Promise<PageDimensions | undefined>
		]);
		if (!volume || !hasCompleteLocalPagePayload(volume, volumeFiles, pageDimensions)) continue;

		await tx.table('volumes').update(volumeUuid, {
			visibility: 'normal',
			source: { type: 'local' },
			// Keep recovered books independent of configured libraries so a later
			// library removal/rescan cannot delete their only remaining copy.
			library_id: undefined,
			folder_path: undefined
		});
		preservedVolumeIds.add(volumeUuid);
	}

	for (const volumeUuid of retiredVolumeIds) {
		if (preservedVolumeIds.has(volumeUuid)) continue;
		await deleteRetiredOnlineVolumeData(tx, volumeUuid);
	}
}

/**
 * Fumeto IndexedDB database.
 *
 * Uses Dexie.js with a split-table design (adapted from mokuro-reader's db-v3):
 * - volumes: small metadata, fast to query for catalog listing
 * - volume_files: large binary image data, loaded only when reading
 * - page_dimensions: medium data for coordinate transforms
 * - regions: user-defined highlight rectangles
 * - translations: LLM translation results
 * - work_context: rolling story summaries for Mode 3
 * - page_translations: full-page translation results (ordered entries)
 * - volume_translation_jobs: 2-pass volume translation jobs
 * - tags: user-created tags for organizing volumes
 * - library_imports: tracks files imported from the home comic library folder
 */

/**
 * Newest Dexie schema version — the native IndexedDB version is this × 10.
 * The final `this.version(...)` call below uses this constant, and migration
 * tests import it, so adding a version means bumping this in the same change.
 */
export const CATALOG_DB_VERSION = 20;

/**
 * Renamed from the pre-release codename at 0.7.0. The rename deliberately
 * starts every install fresh (accepted: the app had no external users); a
 * migration from the old DB was explicitly declined.
 */
export const DB_NAME = 'fumetoreaderplus';

export class FumetoDB extends Dexie {
	volumes!: Table<VolumeMetadata>;
	/** Legacy pre-v17 all-pages-in-one records; kept for dual-read until migrated. */
	volume_files!: Table<VolumeFiles>;
	/** v17: one row per page — streamed imports, lazy reader loads (report L2). */
	volume_pages!: Table<VolumePageRecord>;
	page_dimensions!: Table<PageDimensions>;
	regions!: Table<TranslationRegion>;
	translations!: Table<Translation>;
	work_context!: Table<WorkContext>;
	page_translations!: Table<PageTranslation>;
	volume_translation_jobs!: Table<VolumeTranslationJob>;
	tags!: Table<Tag>;
	library_imports!: Table<LibraryImport>;
	remote_folders!: Table<RemoteFolder>;
	inpainted_pages!: Table<InpaintedPage>;
	comic_tabs!: Table<ComicTab>;
	catalog_rows!: Table<CatalogRow>;
	media_assets!: Table<MediaAsset>;
	catalog_index_state!: Table<CatalogIndexState>;
	/** v20: whole .epub blobs for media_kind:'book' volumes. */
	book_files!: Table<BookFileRecord>;

	constructor() {
		super(DB_NAME);

		this.version(1).stores({
			volumes: 'volume_uuid',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid'
		});

		this.version(2)
			.stores({
				volumes: 'volume_uuid',
				volume_files: 'volume_uuid',
				page_dimensions: 'volume_uuid',
				regions: 'id, [volume_uuid+page_index], volume_uuid',
				translations: 'id, region_id, [volume_uuid+page_index]',
				work_context: 'volume_uuid',
				page_translations: 'id, [volume_uuid+page_index], volume_uuid',
				volume_translation_jobs: 'id, volume_uuid, status'
			})
			.upgrade(tx => {
				// Backfill source field on existing regions
				return tx
					.table('regions')
					.toCollection()
					.modify(region => {
						if (!region.source) {
							region.source = 'user-drawn';
						}
					});
			});

		this.version(3).stores({
			volumes: 'volume_uuid',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name'
		});

		this.version(4).stores({
			volumes: 'volume_uuid',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name',
			library_imports: 'file_path, volume_uuid'
		});

		this.version(5)
			.stores({
				volumes: 'volume_uuid, library_id',
				volume_files: 'volume_uuid',
				page_dimensions: 'volume_uuid',
				regions: 'id, [volume_uuid+page_index], volume_uuid',
				translations: 'id, region_id, [volume_uuid+page_index]',
				work_context: 'volume_uuid',
				page_translations: 'id, [volume_uuid+page_index], volume_uuid',
				volume_translation_jobs: 'id, volume_uuid, status',
				tags: 'name',
				library_imports: 'file_path, volume_uuid'
			})
			.upgrade(async tx => {
				// Backfill library_id on existing volumes from library_imports + settings
				const settingsStr = localStorage.getItem('fumetoreaderplus-settings');
				if (!settingsStr) return;

				let libraries: Array<{ id: string; path: string }> = [];
				try {
					const parsed = JSON.parse(settingsStr);
					libraries = parsed.libraries || [];
				} catch {
					return;
				}

				if (libraries.length === 0) return;

				const imports = await tx.table('library_imports').toArray();
				for (const imp of imports) {
					const matchingLib = libraries.find(lib => imp.file_path.startsWith(lib.path));
					if (matchingLib) {
						await tx.table('volumes').update(imp.volume_uuid, {
							library_id: matchingLib.id
						});
					}
				}
			});

		// v6: Add remote_folders table for YACReader server folder hierarchy caching
		this.version(6).stores({
			volumes: 'volume_uuid, library_id',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name',
			library_imports: 'file_path, volume_uuid',
			remote_folders: 'id, librarySettingsId, [librarySettingsId+parentFolderId]'
		});

		// v7: 2-pass volume translation pipeline (replaces 3-pass)
		// Schema indexes unchanged, but migrate any old in-progress jobs to 'failed'
		this.version(7)
			.stores({
				volumes: 'volume_uuid, library_id',
				volume_files: 'volume_uuid',
				page_dimensions: 'volume_uuid',
				regions: 'id, [volume_uuid+page_index], volume_uuid',
				translations: 'id, region_id, [volume_uuid+page_index]',
				work_context: 'volume_uuid',
				page_translations: 'id, [volume_uuid+page_index], volume_uuid',
				volume_translation_jobs: 'id, volume_uuid, status',
				tags: 'name',
				library_imports: 'file_path, volume_uuid',
				remote_folders: 'id, librarySettingsId, [librarySettingsId+parentFolderId]'
			})
			.upgrade(async tx => {
				// Mark old 3-pass in-progress jobs as failed since they can't
				// be resumed under the new 2-pass architecture
				const jobs = await tx.table('volume_translation_jobs').toArray();
				for (const job of jobs) {
					if (job.status === 'pass1' || job.status === 'pass2' || job.status === 'pass3') {
						job.status = 'failed';
						job.error =
							'Job was in progress during pipeline upgrade (3-pass → 2-pass). Please restart.';
						job.updated_at = new Date().toISOString();
						await tx.table('volume_translation_jobs').put(job);
					}
				}
			});

		// v8: Online manga source extension system
		// Adds tables for source metadata, tracked manga, chapters, and download queue
		this.version(8).stores({
			volumes: 'volume_uuid, library_id',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name',
			library_imports: 'file_path, volume_uuid',
			remote_folders: 'id, librarySettingsId, [librarySettingsId+parentFolderId]',
			manga_sources: 'id, lang',
			tracked_manga: 'id, source_id, [source_id+status]',
			manga_chapters: 'id, manga_id, [manga_id+chapter_number]',
			download_queue: 'id, chapter_id, status'
		});

		// v9: Add serverAddedAt/serverUpdatedAt to remote_folders (no index changes)
		this.version(9).stores({
			volumes: 'volume_uuid, library_id',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name',
			library_imports: 'file_path, volume_uuid',
			remote_folders: 'id, librarySettingsId, [librarySettingsId+parentFolderId]',
			manga_sources: 'id, lang',
			tracked_manga: 'id, source_id, [source_id+status]',
			manga_chapters: 'id, manga_id, [manga_id+chapter_number]',
			download_queue: 'id, chapter_id, status'
		});

		this.version(10).stores({
			volumes: 'volume_uuid, library_id',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name',
			library_imports: 'file_path, volume_uuid',
			remote_folders: 'id, librarySettingsId, [librarySettingsId+parentFolderId]',
			manga_sources: 'id, lang',
			tracked_manga: 'id, source_id, [source_id+status]',
			manga_chapters: 'id, manga_id, [manga_id+chapter_number]',
			download_queue: 'id, chapter_id, status',
			inpainted_pages: '[volume_uuid+page_index], volume_uuid'
		});

		this.version(11).stores({
			volumes: 'volume_uuid, library_id',
			volume_files: 'volume_uuid',
			page_dimensions: 'volume_uuid',
			regions: 'id, [volume_uuid+page_index], volume_uuid',
			translations: 'id, region_id, [volume_uuid+page_index]',
			work_context: 'volume_uuid',
			page_translations: 'id, [volume_uuid+page_index], volume_uuid',
			volume_translation_jobs: 'id, volume_uuid, status',
			tags: 'name',
			library_imports: 'file_path, volume_uuid',
			remote_folders: 'id, librarySettingsId, [librarySettingsId+parentFolderId]',
			manga_sources: 'id, lang',
			tracked_manga: 'id, source_id, [source_id+status]',
			manga_chapters: 'id, manga_id, [manga_id+chapter_number]',
			download_queue: 'id, chapter_id, status',
			inpainted_pages: '[volume_uuid+page_index], volume_uuid',
			provider_series_index:
				'id, source_id, normalized_title, provider_lang, content_rating, [source_id+normalized_title], last_seen_at',
			provider_series_aliases:
				'id, series_id, source_id, normalized_alias, [source_id+normalized_alias]',
			provider_refresh_state: 'source_id, status, last_success_at',
			provider_fetch_failures: 'id, source_id, created_at'
		});

		// v12: Retire built-in online website providers. Dexie keeps removed
		// stores available to this upgrader, then drops them after it completes.
		this.version(12)
			.stores({
				manga_sources: null,
				tracked_manga: null,
				manga_chapters: null,
				download_queue: null,
				provider_series_index: null,
				provider_series_aliases: null,
				provider_refresh_state: null,
				provider_fetch_failures: null
			})
			.upgrade(migrateRetiredOnlineSourceData);

		// v13-v14: Defensive repair for a database advanced to native version 120
		// without executing the Dexie v12 callback. v13 temporarily describes the
		// legacy stores so Dexie can expose any unexpectedly retained records to
		// the same safety migration. v14 removes the stores. Correct v12 databases
		// create only empty temporary stores inside this one upgrade transaction.
		this.version(13)
			.stores({
				manga_sources: 'id, lang',
				tracked_manga: 'id, source_id, [source_id+status]',
				manga_chapters: 'id, manga_id, [manga_id+chapter_number]',
				download_queue: 'id, chapter_id, status',
				provider_series_index:
					'id, source_id, normalized_title, provider_lang, content_rating, [source_id+normalized_title], last_seen_at',
				provider_series_aliases:
					'id, series_id, source_id, normalized_alias, [source_id+normalized_alias]',
				provider_refresh_state: 'source_id, status, last_success_at',
				provider_fetch_failures: 'id, source_id, created_at'
			})
			.upgrade(migrateRetiredOnlineSourceData);

		this.version(14).stores({
			manga_sources: null,
			tracked_manga: null,
			manga_chapters: null,
			download_queue: null,
			provider_series_index: null,
			provider_series_aliases: null,
			provider_refresh_state: null,
			provider_fetch_failures: null
		});

		// v15: lightweight persistent mobile comic tabs. The preview payload is
		// intentionally not indexed; volume_uuid is both the identity and the
		// uniqueness constraint.
		this.version(15).stores({
			comic_tabs: 'volume_uuid, position, opened_at, last_active_at'
		});

		// v16: Blob-free catalog projections, separately-windowed media, and
		// resumable per-library migration/index state. Existing embedded media is
		// deliberately retained until the post-open migrator validates its copy.
		this.version(16)
			.stores({
				catalog_rows:
					'volume_uuid, library_id, [library_id+parent_key], normalized_title, created_at, last_read_at, page_count, &remote_source_identity',
				media_assets: 'id, owner_id, [owner_type+owner_id], kind, [kind+owner_id]',
				catalog_index_state: 'library_id, provider, completeness, status, updated_at',
				remote_folders:
					'id, librarySettingsId, [librarySettingsId+parentFolderId], [librarySettingsId+parentKey]'
			})
			.upgrade(async tx => {
				await tx.table('remote_folders').toCollection().modify((folder: RemoteFolder) => {
					folder.parentKey = folder.parentFolderId == null
						? 'root'
						: `folder:${folder.parentFolderId}`;
					folder.metadataRevision ??= 1;
				});
			});

		// v17: page-per-row local storage. Store creation only — splitting the
		// legacy volume_files blobs is heavy work that belongs to the resumable
		// post-open migrator (db/volume-pages-migration.ts), mirroring v16's
		// media split. Legacy records are dual-read until validated + deleted.
		this.version(17).stores({
			volume_pages: '[volume_uuid+page_index], volume_uuid'
		});

		// v18: `reading_direction` becomes an OVERRIDE — undefined means "follow
		// the global Display setting". Every sync path used to stamp a direction
		// onto every volume, so the global setting could never apply to anything
		// and the reader's quick toggle never survived a reopen. Drop the stamps
		// (see shouldClearStampedReadingDirection for which ones are genuine).
		this.version(18).upgrade(async tx => {
			const providerFor = (source: VolumeSource | undefined): CatalogProvider =>
				source?.type ?? 'local';
			await tx.table('volumes').toCollection().modify((volume: VolumeMetadata) => {
				if (shouldClearStampedReadingDirection(providerFor(volume.source), volume.reading_direction)) {
					delete volume.reading_direction;
				}
			});
			await tx.table('catalog_rows').toCollection().modify((row: CatalogRow) => {
				if (shouldClearStampedReadingDirection(row.provider, row.reading_direction)) {
					delete row.reading_direction;
				}
			});
		});

		// v19: sparse favorites. `favorited_at` joins catalog_rows' indexes for
		// the library Favorites filter — set while favorited, deleted when not,
		// exactly the last_read_at sparse-index pattern. Index-only change; no
		// backfill.
		this.version(19).stores({
			catalog_rows:
				'volume_uuid, library_id, [library_id+parent_key], normalized_title, created_at, last_read_at, favorited_at, page_count, &remote_source_identity'
		});

		// v20: ebook (reflowable EPUB) support. book_files holds the original
		// .epub blob for media_kind:'book' volumes — books are read by
		// foliate-js straight from the archive and never exploded into
		// volume_pages. Store creation only (v17 pattern); no backfill. The
		// media_kind/book_locator/book_progress_fraction fields on volumes and
		// catalog_rows are unindexed and need no schema entry.
		this.version(CATALOG_DB_VERSION).stores({
			book_files: 'volume_uuid'
		});

		// ── Hooks: enforce lowercase tag names ──────────────────────────

		// Tags table: lowercase the name (primary key) on create
		this.tags.hook('creating', function (_primKey, obj) {
			if (obj.name) obj.name = obj.name.toLowerCase();
			return obj.name;
		});

		// Volumes table: lowercase all tag entries on create and update
		this.volumes.hook('creating', function (_primKey, obj) {
			if (obj.tags) obj.tags = obj.tags.map((t: string) => t.toLowerCase());
		});
		this.volumes.hook('updating', function (modifications: object) {
			const mods = modifications as Record<string, unknown>;
			if ('tags' in mods && Array.isArray(mods.tags)) {
				return { tags: (mods.tags as string[]).map(t => t.toLowerCase()) };
			}
		});
	}
}

import type { UserMessage } from '$lib/i18n/user-messages.js';
// ============================================================
// Core Types for Fumeto
// ============================================================

/** Identifies where a volume's pages come from */
export type VolumeSource =
	| { type: 'local' }
	| {
			type: 'yacreader';
			serverUrl: string;
			remoteLibraryId: number;
			remoteComicId: string;
			comicHash: string;
			remoteFolderId: string;
		}
	| {
			type: 'komga';
			serverUrl: string;
			komgaLibraryId: string;
			komgaBookId: string;
			remoteFolderId: string;
		}
	| {
			type: 'kavita';
			serverUrl: string;
			kavitaLibraryId: number;
			kavitaSeriesId: number;
			kavitaVolumeId: number;
			kavitaChapterId: number;
			remoteFolderId: string;
		};

/** Metadata for an imported manga volume */
export interface VolumeMetadata {
	volume_uuid: string;
	title: string;
	filename: string;
	page_count: number;
	created_at: string;
	last_read_at?: string;
	/** Set while the volume is favorited; absent otherwise (sparse index, like last_read_at). */
	favorited_at?: string;
	current_page: number;
	thumbnail?: Blob;
	thumbnail_width?: number;
	thumbnail_height?: number;
	/** Import thumbnail recipe version; absent records are upgraded on the next local scan. */
	thumbnail_generation_version?: number;
	/**
	 * Per-volume override. `undefined` = follow `defaultReadingDirection` from
	 * settings. Resolve with `effectiveReadingDirection()` — never read directly.
	 */
	reading_direction?: 'rtl' | 'ltr';
	/** Per-volume translated-overlay scale shared by reader, export, and replacement rendering. */
	overlay_font_scale?: number;
	author?: string;
	tags?: string[];
	/** ID of the library this volume was imported from (undefined = manual import) */
	library_id?: string;
	/** Relative folder path within the library (e.g. "Author/Series"). undefined = root level */
	folder_path?: string;
	/** Internal volumes are hidden from the normal library/catalog UI */
	visibility?: 'normal' | 'internal';
	/** Source of this volume's page data. undefined = local (backward-compatible) */
	source?: VolumeSource;
	/**
	 * Media kind discriminator. Absent ≡ comic (page-image volume) — the
	 * source?/reading_direction? "undefined means default" convention.
	 * 'book' = reflowable EPUB stored whole in book_files and read by the
	 * foliate BookReader: no volume_pages/page_dimensions rows; page_count is
	 * the spine section count and current_page the section index, so every
	 * existing page-based consumer (tabs, progress bars, openingPageFor)
	 * stays coherent.
	 */
	media_kind?: 'book';
	/** Exact book resume position (foliate EPUB CFI); books only. */
	book_locator?: string;
	/** 0..1 whole-book progress from the last relocate; books only. */
	book_progress_fraction?: number;
}

/**
 * v20: the original .epub blob for media_kind:'book' volumes — books are
 * read by foliate from the archive and never exploded into volume_pages.
 */
export interface BookFileRecord {
	volume_uuid: string;
	file: File;
}

/** Durable lightweight browser-style tab. Reading progress remains on VolumeMetadata. */
export interface ComicTab {
	volume_uuid: string;
	position: number;
	opened_at: string;
	last_active_at: string;
	preview_page_index?: number;
	preview_blob?: Blob;
	preview_mime_type?: string;
	preview_width?: number;
	preview_height?: number;
	preview_updated_at?: string;
}

export type CatalogProvider = 'local' | 'yacreader' | 'komga' | 'kavita';
export type CatalogParentKey = 'root' | `folder:${string}`;

/** Blob-free projection used for catalog sorting, filtering, and cards. */
export interface CatalogRow {
	volume_uuid: string;
	library_id: string;
	parent_key: CatalogParentKey;
	provider: CatalogProvider;
	title: string;
	normalized_title: string;
	filename: string;
	page_count: number;
	created_at: string;
	last_read_at?: string;
	/** Set while the volume is favorited; absent otherwise (sparse index, like last_read_at). */
	favorited_at?: string;
	current_page: number;
	/** Per-volume override; `undefined` = follow the global default. */
	reading_direction?: 'rtl' | 'ltr';
	author?: string;
	tags?: string[];
	visibility?: 'normal' | 'internal';
	folder_path?: string;
	source?: VolumeSource;
	/** Mirrors VolumeMetadata.media_kind — copied by BOTH catalog mappers. */
	media_kind?: 'book';
	/** Mirrors VolumeMetadata.book_locator (books only). */
	book_locator?: string;
	/** Mirrors VolumeMetadata.book_progress_fraction (books only). */
	book_progress_fraction?: number;
	/** Per-volume overlay text size, so the reader and the exporter agree. */
	overlay_font_scale?: number;
	remote_source_identity?: string;
	thumbnail_asset_id?: string;
	metadata_revision: number;
}

export type MediaAssetKind = 'folder-cover' | 'volume-thumbnail' | 'tab-preview';

export interface MediaAsset {
	id: string;
	owner_type: 'folder' | 'volume' | 'tab';
	owner_id: string;
	kind: MediaAssetKind;
	blob: Blob;
	mime_type: string;
	byte_length: number;
	width?: number;
	height?: number;
	revision: string;
	updated_at: string;
}

export type CatalogCompleteness = 'legacy' | 'migrating' | 'ready' | 'paused';
export type YacIndexPhase =
	| 'idle'
	| 'server-updating'
	| 'crawling'
	| 'reconciling'
	| 'repairing'
	| 'ready'
	| 'error'
	| 'cancelled';

export interface CatalogIndexCheckpoint {
	last_volume_uuid?: string;
	last_folder_id?: string;
	last_tab_uuid?: string;
	pending_folder_ids?: string[];
	visited_folder_ids?: string[];
}

/** Per-library migration and remote-index state. */
export interface CatalogIndexState {
	library_id: string;
	provider: CatalogProvider;
	completeness: CatalogCompleteness;
	generation: number;
	/** Remote-provider crawl checkpoint. Migration must never overwrite it. */
	checkpoint?: CatalogIndexCheckpoint;
	/** Independent projection/media migration checkpoint. */
	migration_checkpoint?: Pick<CatalogIndexCheckpoint, 'last_volume_uuid' | 'last_folder_id' | 'last_tab_uuid'>;
	migration_error?: string;
	migration_completed_at?: string;
	status: YacIndexPhase;
	folders_visited: number;
	entries_discovered: number;
	entries_reconciled: number;
	last_success_at?: string;
	/**
	 * When a remote crawl last finished with zero failures.
	 *
	 * Distinct from `completeness`, which the catalog migration writes as
	 * 'ready' for any library that has rows — it means "the v16 projection
	 * finished", not "the crawl finished", so reusing it would freeze a
	 * half-synced library. Unindexed, so it needs no Dexie version; absent
	 * everywhere today, which costs exactly one more full sync per library
	 * after the upgrade and then never again.
	 */
	remote_index_completed_at?: string;
	updated_at: string;
	recoverable_error?: string;
	server_update_supported?: boolean;
	server_update_running?: boolean;
}

/** A user-created tag for organizing volumes */
export interface Tag {
	name: string;
	color: string;
	created_at: string;
}

/** Tracks a file imported from the home comic library folder */
export interface LibraryImport {
	/** Absolute path on disk (primary key) */
	file_path: string;
	/** UUID of the imported volume */
	volume_uuid: string;
	/** File size at import time (for change detection) */
	file_size: number;
	/** Last modified timestamp at import time */
	file_modified: number;
	/** When the file was imported */
	imported_at: string;
}

/** Cached folder from a remote server (YACReader or Komga) */
export interface RemoteFolder {
	/** Compound key: `${librarySettingsId}:${remoteFolderId}` */
	id: string;
	/** Matches Library.id in settings */
	librarySettingsId: string;
	remoteLibraryId: number;
	remoteFolderId: string;
	name: string;
	/** null = child of root folder */
	parentFolderId: string | null;
	/** Non-null IndexedDB parent convention. */
	parentKey?: CatalogParentKey;
	numChildren: number;
	coverHash: string | null;
	/** Server-relative cover path. Supports YACReader custom folder images. */
	coverPath?: string;
	/** Server-declared custom cover retained even while a fallback candidate is displayed. */
	customCoverPath?: string;
	/**
	 * Pre-fetched folder cover image as a data URL (avoids headerless <img src>
	 * requests). The historical property name is retained for IndexedDB
	 * compatibility, but current YACReader entries contain the original server
	 * image rather than a downscaled thumbnail.
	 */
	coverThumbnailDataUrl?: string;
	/** Format/version of the cached cover payload, used to replace legacy low-resolution entries. */
	coverCacheVersion?: number;
	coverAssetId?: string;
	coverCandidateComicId?: string;
	coverCandidateHash?: string;
	coverState?: 'missing' | 'custom' | 'candidate' | 'ready' | 'retry' | 'invalid';
	coverRetryAttempt?: number;
	coverRetryAt?: string;
	coverRetryError?: string;
	metadataRevision?: number;
	/**
	 * When this row was last WRITTEN — which is when the folder appeared in some
	 * listing, not when its own contents were fetched. A folder the user has
	 * never opened carries a fresh `lastFetched` purely because its parent was
	 * listed.
	 */
	lastFetched: string;
	/**
	 * When this folder's own contents were last fetched. Unindexed, so it needs
	 * no Dexie version (the v20 precedent). Absent on every pre-existing row,
	 * which reads as "never fetched" and costs exactly one hydration on first
	 * visit.
	 *
	 * Freshness for a non-root location must key on THIS, not `lastFetched`.
	 * Trusting the latter meant a folder that had only ever been listed counted
	 * as fetched — and for Komga and Kavita, whose series are flat and so have
	 * no child folder rows at all, it meant browse mode had no state in which
	 * entering a series ever fetched its books.
	 */
	contentsFetchedAt?: string;
	/** When the folder was added on the YACReader server (ISO string) */
	serverAddedAt?: string;
	/** When the folder was last updated on the YACReader server (ISO string) */
	serverUpdatedAt?: string;
}

/** Binary image files for a volume, stored separately for performance */
export interface VolumeFiles {
	volume_uuid: string;
	files: Record<string, File>;
}

/**
 * One stored page (schema v17). Replaces the all-pages-in-one `volume_files`
 * record so imports stream page-by-page and the reader loads pages lazily —
 * the whole-volume-in-memory design was the app's main OOM risk (report L2).
 * `page_index` follows natural filename order assigned at import/migration.
 */
export interface VolumePageRecord {
	volume_uuid: string;
	page_index: number;
	/** Full archive path (matches legacy `VolumeFiles.files` keys). */
	filename: string;
	file: File;
}

/** Page dimension data for coordinate transforms */
export interface PageInfo {
	index: number;
	width: number;
	height: number;
	filename: string;
}

export interface PageDimensions {
	volume_uuid: string;
	pages: PageInfo[];
}

/** How a translation region was created */
export type RegionSource = 'user-drawn' | 'full-page' | 'auto-detected';

/** A user-defined highlight region on a manga page (image-space coordinates) */
export interface TranslationRegion {
	id: string;
	volume_uuid: string;
	page_index: number;
	/** Left edge in original image pixels */
	x: number;
	/** Top edge in original image pixels */
	y: number;
	/** Width in original image pixels */
	width: number;
	/** Height in original image pixels */
	height: number;
	created_at: string;
	/** Display order within the page (for side panel listing) */
	sort_order: number;
	/** How this region was created */
	source: RegionSource;
}

/** Translation result from LLM */
export interface Translation {
	id: string;
	region_id: string;
	volume_uuid: string;
	page_index: number;
	/** Translation mode used: 1=isolated, 2=page context, 3=work context */
	mode: 1 | 2 | 3;
	/** Model identifier (e.g. "google/gemini-3.1-flash-lite") */
	model: string;
	/** OCR'd source text from the LLM response */
	original_text?: string;
	/** Translated text (target language) */
	translated_text: string;
	/** Token usage for cost tracking */
	prompt_tokens: number;
	completion_tokens: number;
	created_at: string;
	/** Hash of context used (for cache invalidation in modes 2/3) */
	context_hash?: string;
}

/** Running story context for Mode 3 translation */
export interface WorkContext {
	volume_uuid: string;
	/** Rolling summary of the story so far */
	summary: string;
	/** Page index up to which the summary covers */
	summarized_through_page: number;
	/** Full translations for recent pages (not yet summarized) */
	recent_translations: Array<{
		page_index: number;
		translations: Array<{
			region_id: string;
			original_text: string;
			translated_text: string;
		}>;
	}>;
	updated_at: string;
	/** Running total for cost estimation */
	total_tokens_used: number;
}

// ============================================================
// UI / State Types
// ============================================================

export type AppView = 'catalog' | 'tabs' | 'settings' | 'reader';

export type ReaderReturnView = 'catalog' | 'tabs';

export type PageViewMode = 'single' | 'dual' | 'auto';

export type TranslationMode = 1 | 2 | 3;

export interface ReaderState {
	volume_uuid: string | null;
	current_page: number;
	page_view_mode: PageViewMode;
	reading_direction: 'rtl' | 'ltr';
}

/** Region being drawn (in-progress, not yet saved) */
export interface DrawingRegion {
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
}

/** Visual state for a region on the canvas */
export type RegionVisualState = 'untranslated' | 'translated' | 'hovered' | 'translating';

// ============================================================
// Full Page Translation Types
// ============================================================

/** A single text element identified by full-page translation */
export interface PageTranslationEntry {
	/** Stable durable identity. Assigned at the producer adapter boundary. */
	id: string;
	/** Reading order index (0-based) */
	order: number;
	/** Original text (source language) */
	original_text: string;
	/** Translated text (target language) */
	translated_text: string;
	/** Bubble/element type */
	type?: 'speech' | 'narration' | 'sfx' | 'thought' | 'sign' | 'unknown';
	/** Character attribution */
	speaker?: string;
	/** Box ID from numbered-boxes pipeline (links to spatial coordinates) */
	/** @deprecated Diagnostic adapter input only. Repositories never persist this field. */
	boxId?: number;
	/** Stable link to the durable V2 overlay item. */
	overlayItemId?: string;
}

/** Transient provider/parser result. It must pass an adapter before persistence. */
export type PageTranslationEntryDraft = Omit<PageTranslationEntry, 'id'> & { id?: string };

// ============================================================
// Text Detection & Overlay Types
// ============================================================

export type DetectedTextWritingMode = 'horizontal-tb' | 'vertical-rl' | 'rotated';

export type DetectedTextGroupKind =
	| 'speech'
	| 'thought'
	| 'narration'
	| 'sign'
	| 'sfx'
	| 'borderless'
	| 'unknown';

/** One accepted PP-OCR probability-map component before logical grouping. */
export interface DetectedTextComponent {
	/** Stable scan-order detector label. It may contain gaps after filtering. */
	componentId: number;
	/** Tight oriented component polygon in image-space coordinates. */
	polygon: [number, number][];
	x: number;
	y: number;
	width: number;
	height: number;
	confidence: number;
	meanConfidence?: number;
	maxConfidence?: number;
	foregroundPixelCount?: number;
	orientationDegrees: number;
}

/** A detected text region from PP-OCR or other detector */
export interface DetectedTextRegion {
	/** Box ID (1-based, used as key in numbered-boxes approach) */
	boxId: number;
	/** Bounding box in image-space pixels */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Detection confidence (0-1) */
	confidence: number;
	/** Tight source polygon. Bubble/container geometry belongs in `contour`. */
	polygon?: [number, number][];
	/** Dominant source baseline/column angle, normalized to [-90, 90). */
	orientationDegrees?: number;
	/** Every accepted raw component contributing to this logical group. */
	sourceComponents?: DetectedTextComponent[];
	/** Stable detector labels for `sourceComponents`, in source reading order. */
	sourceComponentIds?: number[];
	/** Estimated writing mode derived from component geometry. */
	writingMode?: DetectedTextWritingMode;
	/** Explainable geometry/text classification. `borderless` remains a free container. */
	groupKind?: DetectedTextGroupKind;
	classificationConfidence?: number;
	classificationReasons?: string[];
	/**
	 * Length-weighted mean of the recognizer's normalized (softmax) line
	 * confidences for this group. Low values mean the OCR text is shaky;
	 * coverage demotes such groups to optional so providers are never forced
	 * to translate garbage (report T5).
	 */
	recognitionConfidence?: number;
	/** Bubble and inferred-panel attribution from the grouping stage. */
	bubbleId?: number;
	panelId?: string;
	bubbleOverlap?: number;
	bubbleAssignmentAmbiguous?: boolean;
	/** Raw component evidence retained by native and WASM detector adapters. */
	foregroundPixelCount?: number;
	meanConfidence?: number;
	maxConfidence?: number;
	/** Whether this region is inside a detected speech bubble */
	inBubble?: boolean;
	/** Simplified bubble contour polygon (image-space [x,y] pairs) */
	contour?: [number, number][];
	/** Grouping split one utterance at its span cap; this region continues the previous one in reading order. */
	continuesPrevious?: boolean;
}

/** A translation entry with spatial coordinates for overlay rendering */
export interface OverlayEntry {
	/** Box ID matching DetectedTextRegion.boxId */
	boxId: number;
	original_text: string;
	translated_text: string;
	type: 'speech' | 'narration' | 'sfx' | 'thought' | 'sign' | 'unknown';
	speaker?: string;
	/** Spatial coordinates from the detector (image-space pixels) */
	x: number;
	y: number;
	width: number;
	height: number;

	/** Whether this text is inside a detected speech bubble */
	inBubble?: boolean;
	/** Simplified bubble contour for clip-path rendering (image-space [x,y] pairs) */
	contour?: [number, number][];

	/** User overrides — persisted with overlay data */
	customX?: number;
	customY?: number;
	customWidth?: number;
	customHeight?: number;
	customFontSize?: number;
	customTranslation?: string;
	/** @deprecated Opacity is no longer user-configurable; kept for data compat */
	customOpacity?: number;
	customRotation?: number;
	/** Per-box vertical text override. undefined = use global setting. */
	customVerticalText?: boolean;
	/** Box is immune to comic-wide display settings (min font size, vertical text for tall boxes) */
	settingsImmune?: boolean;
	isHidden?: boolean;

	// Vision LLM layout hints (populated during off-device volume translation)
	/** vLLM-estimated font size ratio relative to default (0.5-1.5). 1.0 = no change. */
	vllmFontSizeRatio?: number;
	/** vLLM-estimated visual priority for overlap resolution. */
	vllmVisualPriority?: 'high' | 'medium' | 'low';
}

/** Detector/LLM adapter payload. This shape is never durable or renderable. */
export interface PageOverlayDraft {
	regions: DetectedTextRegion[];
	entries: OverlayEntry[];
}

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type OverlayWritingMode = 'horizontal-tb' | 'vertical-rl';
export type OverlayDirection = 'ltr' | 'rtl';

export interface PageOverlayDataV2 {
	schemaVersion: 2;
	documentRevision: number;
	sourceImage: {
		width: number;
		height: number;
		fingerprint: string;
	};
	locale: string;
	baseDirection: OverlayDirection | 'auto';
	sources: OverlaySourceV2[];
	containers: OverlayContainerV2[];
	items: OverlayItemV2[];
	cachedPlan?: OverlayPlanCacheV1;
}

/** V2 is the only production overlay document. */
export type PageOverlayData = PageOverlayDataV2;

export interface OverlaySourceV2 {
	id: string;
	detectorRef?: {
		pipeline: string;
		label: string;
	};
	polygon: Point[];
	bounds: Rect;
	confidence: number;
	orientationDegrees: number;
}

export interface OverlayContainerV2 {
	id: string;
	kind: 'speech' | 'thought' | 'narration' | 'sign' | 'panel' | 'free';
	origin: 'detected' | 'inferred' | 'manual';
	polygon: Point[];
	tailPolygon?: Point[];
	sourceIds: string[];
	confidence?: number;
}

export interface OverlayItemV2 {
	id: string;
	translationEntryId: string;
	sourceIds: string[];
	containerId?: string;
	type: 'speech' | 'thought' | 'narration' | 'sign' | 'sfx' | 'unknown';
	order: number;
	styleKey: string;
	/** Production grouping direction. Missing on V2 records created before policy 10. */
	sourceWritingMode?: OverlayWritingMode;
	/**
	 * How sure the detector's classifier was about `type`, quantized to 0.01.
	 *
	 * `type` alone cannot say this: `'unknown'` is what BOTH `borderless`
	 * (ordinary unenclosed narration, confidence 0.66) and a genuine
	 * classification failure (`insufficient-class-margin`, 0.45) launder into,
	 * and the reader needs to tell them apart to decide how loudly to ask for
	 * help. Quantized because it enters the layout input hash.
	 *
	 * Missing on V2 records created before policy 29, and on any item whose
	 * type did not come from the production classifier.
	 */
	classificationConfidence?: number;
	/**
	 * This item is the continuation of the item before it in reading order
	 * inside the same container: one utterance the grouper had to split at its
	 * span cap. The planner stacks such members top to bottom instead of
	 * carving the balloon side by side, so a sentence never reads left half
	 * first. Absent on every record written before policy 30.
	 */
	continuesPrevious?: boolean;
	manual: OverlayManualConstraintsV2;
}

export interface OverlayManualConstraintsV2 {
	rect?: Rect;
	rotationDegrees?: number;
	referenceFontSize?: number;
	writingMode?: OverlayWritingMode;
	pinGeometry?: boolean;
	pinTypography?: boolean;
	textOverride?: string;
	hidden?: boolean;
	/**
	 * Deleted by the reader. The item, its translation entry and its sources
	 * stay on the record so the deletion is undoable and survives a
	 * re-translation; nothing renders it and no export paints it.
	 */
	removed?: boolean;
}

export interface OverlayPlanCacheV1 {
	inputHash: string;
	plan: OverlayRenderPlanV2;
}

export type OverlayUnplacedReason =
	| 'invalid-geometry'
	| 'font-unavailable'
	| 'unsupported-runtime'
	| 'below-readability-floor'
	| 'protected-art-conflict'
	| 'collision-conflict'
	| 'manual-constraint-conflict'
	| 'prominence-limit'
	| 'text-does-not-fit'
	| 'cancelled';

export interface OverlayCandidateScore {
	total: number;
	emergencyBreaks: number;
	protectedArtOverlap: number;
	fontPreference: number;
	/** Small preference cost for bounded compact in-contour typography. */
	typographyCompression?: number;
	/**
	 * Fraction of the item's own source region the painted card leaves showing.
	 * Unbounded items only — a balloon's whitewash is its contour, which covers
	 * every source inside it by construction.
	 */
	sourceUncovered?: number;
	/** Lines ending in a soft-hyphen break. A tie-breaker, not a hard limit. */
	hyphenatedBreaks?: number;
	occupancyPenalty: number;
	raggedness: number;
	orphanPenalty: number;
	displacement: number;
	boxGrowth: number;
	/**
	 * How much flatter (width/height) the painted card is than its own source's
	 * shape permits. Unbounded non-SFX items only — `boxGrowth` measures area,
	 * which cannot see the wide flat bar horizontal English makes of a short
	 * vertical utterance.
	 */
	widthGrowth?: number;
	collisionPenalty: number;
	styleConsistency: number;
}

export interface OverlayPlanSummary {
	placed: number;
	unplaced: number;
	candidatesEvaluated: number;
	cacheHit: boolean;
	warnings: string[];
	operationCount: number;
}

export interface OverlayBackgroundPlan {
	fill: string;
	polygon?: Point[];
	/**
	 * Regions this item replaces, each erased with a soft edge. Unbounded items
	 * only: a balloon's whitewash is its own contour, which already covers every
	 * source inside it. Absent ⇒ the item paints `polygon` or `rect` hard-edged,
	 * which is what every bounded and manual placement does.
	 *
	 * A list, not one rectangle, so the gutters BETWEEN a run's columns keep
	 * their artwork instead of disappearing under one slab.
	 */
	erasureRects?: Rect[];
	/** Feather width in page pixels, for both the erasure and the text plates. */
	softEdgePx?: number;
	/** Corner radius for the per-line text plates, in page pixels. */
	plateRadius?: number;
	/** Padding around each line box before it becomes a plate, in page pixels. */
	platePadding?: number;
}

export interface OverlayRenderRunV2 {
	text: string;
	sourceRange: { startUtf16: number; endUtf16: number };
	fontKey: string;
	origin: Point;
	rotationDegrees: number;
	direction: OverlayDirection;
}

export interface OverlayRenderLineV2 {
	text: string;
	sourceRange: {
		startUtf16: number;
		endUtf16: number;
		startGrapheme: number;
		endGrapheme: number;
	};
	breakAfter: 'explicit' | 'legal' | 'hyphenated' | 'emergency' | 'end';
	origin: Point;
	baseline: number;
	advance: number;
	bounds: Rect;
	availableInterval: { start: number; end: number };
	direction: OverlayDirection;
	runs: OverlayRenderRunV2[];
}

export interface PlannedOverlayItemV2 {
	itemId: string;
	status: 'placed' | 'unplaced';
	unplacedReason?: OverlayUnplacedReason;
	/**
	 * Standard is preferred; compact preserves readability when bubble geometry
	 * is tight; degraded marks last-resort whitespace/font shrink rungs; reveal
	 * paints only the whitewashed balloon with a highlight — the text renders in
	 * a tap-to-reveal popover because even the last-resort floor could not fit.
	 */
	fitMode?: 'standard' | 'compact' | 'degraded' | 'reveal';
	rect?: Rect;
	rotationDegrees?: number;
	writingMode?: OverlayWritingMode;
	background?: OverlayBackgroundPlan;
	clipPolygon?: Point[];
	font?: {
		fontKey: string;
		family: string;
		weight: number;
		size: number;
		lineHeight: number;
	};
	lines?: OverlayRenderLineV2[];
	winningCandidateId?: string;
	score?: OverlayCandidateScore;
}

export interface OverlayRenderPlanV2 {
	renderPlanVersion: 1;
	planId: string;
	inputHash: string;
	algorithmVersion: string;
	documentRevision: number;
	sourceImage: { width: number; height: number };
	fontSetFingerprint: string;
	settingsFingerprint: string;
	items: PlannedOverlayItemV2[];
	diagnostics: OverlayPlanSummary;
}

/** Data produced by the smart sizing pipeline for overlay box adjustment */
export interface SmartSizingData {
	/** Enable type-based sizing multipliers (speech/sfx/narration/sign) */
	typeMultipliers?: boolean;
	/** Per-pixel edge density map (normalized 0-1) */
	edgeDensityMap?: Float32Array;
	edgeDensityW?: number;
	edgeDensityH?: number;
	/** Per-pixel saliency map from U2NetP or IS-Net (normalized 0-1) */
	saliencyMap?: Float32Array;
	saliencyW?: number;
	saliencyH?: number;
	/** Detected anime character head bounding boxes (image-space pixels) */
	headRegions?: Array<{ x: number; y: number; w: number; h: number; confidence: number }>;
}

/** Cached inpainted page image (text-replacement mode) */
export interface InpaintedPage {
	volume_uuid: string;
	page_index: number;
	/** The final composited image (inpainted + typeset text) */
	image: Blob;
	created_at: string;
	/** Hash of overlay data used to generate this image — for cache invalidation */
	overlay_hash: string;
}

/** Full page translation result */
export interface PageTranslation {
	id: string;
	volume_uuid: string;
	page_index: number;
	/** Ordered list of translations */
	entries: PageTranslationEntry[];
	/** True when PP-OCR detected no text and LLM call was skipped. */
	no_text_detected?: boolean;
	/** Model used */
	model: string;
	/** Token usage */
	prompt_tokens: number;
	completion_tokens: number;
	created_at: string;
	/** Persisted overlay data (detected regions + spatial translations) */
	overlay_data?: PageOverlayData;
	/**
	 * Manual edits a re-translation could not carry forward: their source
	 * columns no longer exist on the page as detected. Kept so the reader can
	 * see what was lost and discard it deliberately, never dropped in silence.
	 */
	orphaned_edits?: OrphanedOverlayEdit[];
}

/** A reader's edit whose overlay item did not survive a re-translation. */
export interface OrphanedOverlayEdit {
	/** The item the edit belonged to on the record that was replaced. */
	itemId: string;
	/** Source column identities the edit was keyed on (content-hashed). */
	sourceIds: string[];
	manual: OverlayManualConstraintsV2;
	/** What the box said, so the list can name it. */
	translatedText: string;
	originalText: string;
}

// ============================================================
// Volume Translation (2-Pass System) Types
// ============================================================

/** Rolling context built incrementally during the translation pass */
export interface RollingContext {
	/** LLM-generated summary covering pages 0 through summarized_through_page */
	summary: string;
	/** The last page index included in the summary (-1 if no summary yet) */
	summarized_through_page: number;
	/** Raw translations for the most recent pages (sliding window) */
	recent_pages: Array<{
		page_index: number;
		entries: PageTranslationEntry[];
	}>;
	/** Known characters accumulated through translation and review */
	characters: Array<{
		name: string;
		description: string;
		first_appearance: number;
	}>;
}

/** Per-page translation result */
export interface VolumePageTranslation {
	page_index: number;
	entries: PageTranslationEntry[];
	/** True when PP-OCR detected no text and LLM call was skipped. */
	no_text_detected?: boolean;
	prompt_tokens: number;
	completion_tokens: number;
	/** Overlay data generated during translation (if overlay pipeline was used) */
	overlay_data?: PageOverlayData;
}

/** Per-page review result */
export interface PageReview {
	page_index: number;
	issues: Array<{
		type: 'attribution' | 'bubble_assignment' | 'colloquial' | 'hallucination' | 'missing' | 'consistency';
		severity: 'info' | 'warning' | 'error';
		description: string;
		entry_order?: number;
		suggested_fix?: string;
	}>;
	revised_entries?: PageTranslationEntry[];
}

/** Job status for a volume translation */
export type VolumeTranslationStatus = 'translating' | 'reviewing' | 'revising' | 'completed' | 'failed' | 'cancelled';

/** The kind of error state a job is in; `retry` is transient and cleared on the next success. */
export type JobErrorKind = 'retry' | 'warning' | 'cancelled' | 'interrupted' | 'failure';

/** Durable metadata for a page that could not be processed. */
export interface VolumeTranslationPageFailure {
	page_index: number;
	phase: 'translation' | 'review' | 'prefetch';
	error: string;
	attempts: number;
	/** Stable coarse category; drives retry disposition (page-retry-policy.ts). */
	category?: 'cancelled' | 'auth' | 'invalid_request' | 'insufficient_credit' | 'rate_limit' | 'timeout' | 'network' | 'server' | 'content_filter' | 'page_source' | 'parse' | 'coverage' | 'unknown';
	failed_at: string;
}

/** Small, backward-compatible diagnostic snapshot stored with a job. */
export interface VolumeTranslationDiagnostics {
	provider_id?: string;
	provider_type?: string;
	request_attempts: number;
	last_checkpoint_at?: string;
	last_error_category?: VolumeTranslationPageFailure['category'];
}

/** Complete volume translation job record */
export interface VolumeTranslationJob {
	id: string;
	volume_uuid: string;
	status: VolumeTranslationStatus;
	/** Current page being processed */
	current_page: number;
	total_pages: number;
	/** Rolling context built during translation pass */
	rolling_context?: RollingContext;
	/** Translation pass results */
	translations?: VolumePageTranslation[];
	/** Durable page payloads live in page_translations for lightweight checkpoints. */
	results_storage?: 'page_translations';
	/** Review pass results */
	reviews?: PageReview[];
	/** Total token usage across all passes */
	total_prompt_tokens: number;
	total_completion_tokens: number;
	/**
	 * Current activity, English, for logs and the Android notification. The
	 * message a person sees is `activity_message`; this is its English shadow
	 * (and the only field on records written before localization).
	 */
	activity?: string;
	/** The activity as a message code, rendered in the live locale. */
	activity_message?: UserMessage;
	/** Raw error text (developer detail) for a failure; undefined for cancellations and warnings. */
	error?: string;
	/** What to show for the job's error state, in the live locale. */
	error_message?: UserMessage;
	/** Why `error_message` is set — what the old code inferred by reading the prose. */
	error_kind?: JobErrorKind;
	/** Pass-level warnings accumulated across a run, newest last. */
	warnings?: UserMessage[];
	/** Pages a run could not use. Recorded, not fatal: re-running retries them. */
	failed_pages?: VolumeTranslationPageFailure[];
	/**
	 * Which pass was in progress when a run ended abnormally, so resuming a
	 * failed or cancelled job re-enters the right one instead of re-translating
	 * pages the review pass had already moved past.
	 */
	interrupted_phase?: 'translation' | 'review';
	/** Durable summary diagnostics; intentionally small so checkpoints stay cheap. */
	diagnostics?: VolumeTranslationDiagnostics;
	/** Timestamps */
	started_at: string;
	updated_at: string;
	completed_at?: string;
	/** Model used */
	model: string;
	/** Offset of the first page in the source volume (for page range support) */
	start_page_offset?: number;
	/** If true, skip rolling context and review pass (gallery/collection mode) */
	gallery_mode?: boolean;
	/** Source language override for this specific job */
	source_language?: string;
	/** Target language override for this specific job */
	target_language?: string;
	/** Whether to generate overlay data during translation */
	generate_overlays?: boolean;
	/** When true, skip the review pass (story mode only; gallery always skips) */
	skip_review?: boolean;
	/** User-provided revision instructions (for revision jobs) */
	revision_instructions?: string;
}

/** Options for custom volume translation runs */
export interface VolumeTranslationOptions {
	/** Comic type: 'story' uses rolling context + review; 'gallery' translates each page independently */
	mode: 'story' | 'gallery';
	/** Optional initial story summary to seed rolling context (story mode only) */
	initialSummary?: string;
	/** Start page (0-indexed inclusive). If omitted, starts from page 0. */
	startPage?: number;
	/** End page (0-indexed exclusive). If omitted, translates through last page. */
	endPage?: number;
	/** Source language override (if omitted, uses global setting) */
	sourceLanguage?: string;
	/** Target language override (if omitted, uses global setting) */
	targetLanguage?: string;
	/** Whether to generate overlay data for each page */
	generateOverlays?: boolean;
	/** When true, skip the review pass even in story mode */
	skipReview?: boolean;
}

/**
 * Catalog-specific state stores.
 *
 * Controls the left sidebar, library/subfolder selection,
 * search, tag filtering, and sort order in the catalog view.
 */

import { get, writable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types/index.js';
import type { CatalogAnchor } from '$lib/catalog/virtual-window.js';

/**
 * Virtual catalog collection for complete, locally-backed books recovered when
 * the retired website-source feature was removed. It is deliberately not a
 * settings Library: removing or changing a configured library must not affect
 * these books.
 */
export const RECOVERED_DOWNLOADS_COLLECTION_ID = '__fumeto_recovered_downloads__';

export function isRecoveredDownloadsCollectionId(id: string | null | undefined): boolean {
	return id === RECOVERED_DOWNLOADS_COLLECTION_ID;
}

/**
 * Completed downloads created by the retired feature used stable `online:`
 * UUIDs. The v12 migration makes them visible, locally-backed and unassigned;
 * requiring all of those traits prevents streamed or ordinary manual volumes
 * from appearing in the recovery collection.
 */
export function isRecoveredDownloadVolume(
	volume: Pick<VolumeMetadata, 'volume_uuid' | 'library_id' | 'source' | 'visibility'>,
): boolean {
	return volume.volume_uuid.startsWith('online:')
		&& !volume.library_id
		&& volume.visibility !== 'internal'
		&& (volume.source === undefined || volume.source.type === 'local');
}

/** Match a volume against either a configured library or a virtual collection. */
export function volumeBelongsToCatalogCollection(
	volume: Pick<VolumeMetadata, 'volume_uuid' | 'library_id' | 'source' | 'visibility'>,
	collectionId: string | null,
): boolean {
	if (isRecoveredDownloadsCollectionId(collectionId)) {
		return isRecoveredDownloadVolume(volume);
	}
	if (collectionId === null) return !volume.library_id;
	return volume.library_id === collectionId;
}

/** Whether the catalog left sidebar is open */
export const catalogSidebarOpen = writable<boolean>(true);

/** ID of the currently selected library (null = show all libraries) */
export const selectedLibraryId = writable<string | null>(null);

/** Current subfolder path relative to library root (empty string = root) — local libraries */
export const currentSubfolder = writable<string>('');

/** Current remote folder ID for YACReader libraries (null = root level) */
export const currentRemoteFolderId = writable<string | null>(null);

/**
 * True while the catalog location should be flattened (a category filter is
 * active AND the catalog is the visible view). Written only by CatalogView —
 * the single authority — and read by every other component that feeds the
 * shared CatalogController a location (CatalogSidebar on desktop), so two
 * writers can never fight over the flatten flag. Gated on visibility so a
 * filter left active while reading doesn't keep a whole-library liveQuery
 * range observed for every progress checkpoint.
 */
export const catalogFlattenActive = writable(false);

/** Search query for filtering volumes by name */
export const catalogSearchQuery = writable<string>('');

/**
 * The last local library that root-level Import / + Folder targeted, so the
 * pickers default to where the user last put things (locked decision:
 * "only/last-used local library").
 */
const LAST_LOCAL_TARGET_KEY = 'fumeto-last-local-target';
export function recallLocalTarget(): string | null {
	return typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_LOCAL_TARGET_KEY) : null;
}
export function rememberLocalTarget(libraryId: string): void {
	if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_LOCAL_TARGET_KEY, libraryId);
}

/** Search mode: search comics (volumes) or folders — persisted to localStorage */
export type SearchMode = 'comics' | 'folders';
const savedSearchMode = (typeof localStorage !== 'undefined'
	? localStorage.getItem('catalogSearchMode') as SearchMode | null
	: null) ?? 'comics';
export const catalogSearchMode = writable<SearchMode>(savedSearchMode);
catalogSearchMode.subscribe((v) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('catalogSearchMode', v);
});

/** Active tag filters — multi-select with AND logic */
export const activeTagFilters = writable<string[]>([]);

/** Available sort fields */
export type SortField = 'name' | 'created_at' | 'last_read_at' | 'page_count';

/** Sort direction */
export type SortDirection = 'asc' | 'desc';

// ── Per-folder preference persistence ──────────────────────────────
// Sort field, sort direction, and view mode are persisted per-folder
// in localStorage so each folder "remembers" its settings.

/** Build a localStorage key for the current folder context */
function folderPrefKey(libraryId: string | null, subfolder: string, remoteFolderId: string | null): string {
	const lib = libraryId ?? '_all';
	const folder = remoteFolderId ?? subfolder ?? '_root';
	return `catalog-prefs:${lib}:${folder}`;
}

interface FolderPrefs {
	sortField?: SortField;
	sortDirection?: SortDirection;
	viewMode?: ViewMode;
}

function loadFolderPrefs(key: string): FolderPrefs {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : {};
	} catch { return {}; }
}

function saveFolderPrefs(key: string, prefs: FolderPrefs): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(key, JSON.stringify(prefs));
}

// Global defaults (used when a folder has no saved prefs)
const DEFAULT_SORT_FIELD: SortField = 'created_at';
const DEFAULT_SORT_DIRECTION: SortDirection = 'desc';
const DEFAULT_VIEW_MODE: ViewMode = 'grid-3';

/** Current sort field */
export const catalogSortField = writable<SortField>(DEFAULT_SORT_FIELD);

/** Current sort direction */
export const catalogSortDirection = writable<SortDirection>(DEFAULT_SORT_DIRECTION);

/** View mode: dense scrim grid, larger panel grid, or compact rows. */
export type ViewMode = 'grid-3' | 'grid-2' | 'list';

/** Legacy folder prefs stored 'grid'; unknown values fall back to default. */
export function normalizeViewMode(value: unknown): ViewMode {
	if (value === 'grid' || value === 'grid-3') return 'grid-3';
	if (value === 'grid-2') return 'grid-2';
	if (value === 'list') return 'list';
	return DEFAULT_VIEW_MODE;
}

/** Current catalog view mode */
export const catalogViewMode = writable<ViewMode>(DEFAULT_VIEW_MODE);

// Track current folder context for saving prefs
let _currentPrefKey = '';

/** Save current sort/view prefs for the active folder */
function saveCurrentPrefs(): void {
	if (!_currentPrefKey) return;
	let sf: SortField = DEFAULT_SORT_FIELD;
	let sd: SortDirection = DEFAULT_SORT_DIRECTION;
	let vm: ViewMode = DEFAULT_VIEW_MODE;
	catalogSortField.subscribe(v => { sf = v; })();
	catalogSortDirection.subscribe(v => { sd = v; })();
	catalogViewMode.subscribe(v => { vm = v; })();
	saveFolderPrefs(_currentPrefKey, { sortField: sf, sortDirection: sd, viewMode: vm });
}

// Auto-save when sort/view settings change
catalogSortField.subscribe(() => saveCurrentPrefs());
catalogSortDirection.subscribe(() => saveCurrentPrefs());
catalogViewMode.subscribe(() => saveCurrentPrefs());

/**
 * Restore saved sort/view preferences for the current folder context.
 * Call this when the folder changes (library, subfolder, or remote folder).
 */
export function restoreFolderPrefs(libraryId: string | null, subfolder: string, remoteFolderId: string | null): void {
	_currentPrefKey = folderPrefKey(libraryId, subfolder, remoteFolderId);
	const prefs = loadFolderPrefs(_currentPrefKey);
	// Temporarily disable save while restoring to avoid writing back defaults.
	// Each store is written only when its value actually differs: an
	// unconditional set() invalidates every derived that reads the store, and
	// this runs on every folder navigation — on a 13k-volume library the
	// resulting no-op re-sort was a measurable part of navigation latency.
	const prevKey = _currentPrefKey;
	_currentPrefKey = '';
	const nextSortField = prefs.sortField ?? DEFAULT_SORT_FIELD;
	const nextSortDirection = prefs.sortDirection ?? DEFAULT_SORT_DIRECTION;
	const nextViewMode = normalizeViewMode(prefs.viewMode);
	if (get(catalogSortField) !== nextSortField) catalogSortField.set(nextSortField);
	if (get(catalogSortDirection) !== nextSortDirection) catalogSortDirection.set(nextSortDirection);
	if (get(catalogViewMode) !== nextViewMode) catalogViewMode.set(nextViewMode);
	_currentPrefKey = prevKey;
}

// ── Per-folder scroll position cache ───────────────────────────────
// Keeps the scroll offset for each folder context (library + subfolder
// or remote folder id) so navigating back to a previously-visited folder
// restores where the user was instead of snapping to the top. In-memory
// only — scroll state isn't worth persisting across app restarts.

const _folderScrollPositions = new Map<string, CatalogAnchor>();

export function folderScrollKey(
	libraryId: string | null,
	subfolder: string,
	remoteFolderId: string | null,
): string {
	const lib = libraryId ?? '_all';
	const folder = remoteFolderId ?? (subfolder || '_root');
	return `${lib}::${folder}`;
}

export function saveFolderScroll(key: string, anchor: CatalogAnchor): void {
	if (anchor.fallbackTop > 0 || anchor.anchorKey) _folderScrollPositions.set(key, anchor);
	else _folderScrollPositions.delete(key);
}

export function getFolderScroll(key: string): CatalogAnchor | undefined {
	return _folderScrollPositions.get(key);
}

export function clearFolderScroll(key: string): void {
	_folderScrollPositions.delete(key);
}

export function clearAllFolderScrolls(): void {
	_folderScrollPositions.clear();
}

/** Incremented after folder create/delete/rename to trigger filesystem re-reads in CatalogView + CatalogSidebar */
export const folderRefreshToken = writable<number>(0);

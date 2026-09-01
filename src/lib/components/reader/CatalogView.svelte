<script lang="ts">
	import { fadeOnDecode } from '$lib/util/fade-on-decode.js';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { onMount, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { fade, scale, slide } from 'svelte/transition';
	import { db } from '$lib/db/index.js';
	import { appView, openReader } from '$lib/stores/reader-state.js';
	import { importDialogOpen, catalogContextMenuOpen, catalogTransientCloseHandler } from '$lib/stores/ui-state.js';
	import { activeTranslationJobs, getJobForVolume, startTranslationJobsFeed, updateJob, removeJob } from '$lib/stores/volume-translation-state.js';
	import {
		selectedLibraryId,
		currentSubfolder,
		currentRemoteFolderId,
		catalogFlattenActive,
		catalogSearchQuery,
		catalogSearchMode,
		activeTagFilters,
		catalogSortField,
		catalogSortDirection,
		catalogViewMode,
		folderScrollKey,
		saveFolderScroll,
		getFolderScroll,
		folderRefreshToken,
		restoreFolderPrefs,
		RECOVERED_DOWNLOADS_COLLECTION_ID,
		isRecoveredDownloadsCollectionId,
		volumeBelongsToCatalogCollection,
	} from '$lib/stores/catalog-state.js';
	import { startVolumeTranslation, isJobActive, registerVolumeCancelHandle } from '$lib/translation/volume-translation-service.js';
	import { reviseVolume, isRevisionActive } from '$lib/translation/revision-service.js';
	import { deleteVolume, deleteVolumeTranslations, volumeHasTranslationData } from '$lib/import/import-service.js';
	import { validateLibraryPath } from '$lib/library/library-scanner.js';
	import { deriveSubfoldersFromVolumes, mergeSubfolderSources, buildBreadcrumbs, normalizeSubfolderPath } from '$lib/library/subfolder-utils.js';
	import { describeErrorForUser } from '$lib/util/friendly-errors.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import * as m from '$lib/paraglide/messages.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';

	/** Pass-level warnings of a finished job as one string, or the legacy error text. */
	const jobWarningText = (job: { warnings?: import('$lib/i18n/user-messages.js').UserMessage[]; error?: string; error_message?: import('$lib/i18n/user-messages.js').UserMessage }): string =>
		(job.warnings ?? []).map((warning) => renderUserMessage(warning)).join('\n') || renderUserMessage(job.error_message) || job.error || '';
	import { remoteSyncFailures, reportRemoteSyncFailure, reportRemoteSyncSuccess } from '$lib/stores/remote-sync-status.js';
	import { readFilesystemFolders, createFolder, deleteFolder, renameFolder, countVolumesInFolder, moveVolumes } from '$lib/library/folder-service.js';
	import { settings, isLocalLibrary, isYACReaderLibrary, isKomgaLibrary, isKavitaLibrary, isRemoteServerLibrary } from '$lib/settings/settings.js';
	import { effectiveReadingDirection } from '$lib/reader/reading-direction.js';
	import { REMOTE_SERVER_TYPE_LABELS } from '$lib/settings/server-address.js';
	import { getOrCreateClient } from '$lib/yacreader/yac-client-manager.js';
	import { fetchFolderCover, hydrateRemoteVolumeCover } from '$lib/yacreader/yac-sync-service.js';
	import { loadKomgaCredentials } from '$lib/komga/komga-credentials.js';
	import { getOrCreateKavitaClient } from '$lib/kavita/kavita-client-manager.js';
	import { loadKavitaApiKey } from '$lib/kavita/kavita-credentials.js';
	import { fetchKavitaFolderCoverBlobs } from '$lib/kavita/kavita-folder-covers.js';
	import { getThumbnailUrl, revokeThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
	import VolumeDetailsDialog from '$lib/components/catalog/VolumeDetailsDialog.svelte';
	import CustomTranslationDialog from '$lib/components/catalog/CustomTranslationDialog.svelte';
	import ReviseVolumeDialog from '$lib/components/catalog/ReviseVolumeDialog.svelte';
	import TranslationProgress from './TranslationProgress.svelte';
	import ContinueReadingStrip from '$lib/components/catalog/ContinueReadingStrip.svelte';
	import { continueReadingVolume } from '$lib/catalog/continue-reading.js';
	import { createLongPressController } from '$lib/catalog/card-long-press.js';
	import SearchOverlay from '$lib/components/catalog/SearchOverlay.svelte';
	import { isMobile } from '$lib/util/platform.js';
	import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
	import { exportTranslatedVolume } from '$lib/export/volume-exporter.js';
	import { sanitizePathSegment } from '$lib/util/file-utils.js';
	import type { VolumeMetadata, VolumeTranslationJob, VolumeTranslationOptions, RemoteFolder } from '$lib/types/index.js';
	import { calculateVirtualWindow, captureCatalogAnchor, restoreCatalogAnchor } from '$lib/catalog/virtual-window.js';
	import { createOrFocusTab } from '$lib/tabs/comic-tabs.js';
	import { queueTabPreview } from '$lib/tabs/tab-preview-queue.js';
	import { renderableImageBlob } from '$lib/util/image-blob.js';
	import {
		partitionFolderCoverRequests,
		transcodeRemoteCover,
		versionedCoverRevision,
	} from '$lib/catalog/remote-cover-thumbnail.js';
	import type { MediaAsset } from '$lib/types/index.js';
	import { catalogController } from '$lib/controllers/catalog-controller.js';
	import type { LoadablePhase } from '$lib/controllers/loadable-snapshot.js';
	import { UNASSIGNED_LIBRARY_ID, isUnreadVolume, setVolumeFavorited } from '$lib/catalog/catalog-repository.js';
	import { recallLocalTarget, rememberLocalTarget } from '$lib/stores/catalog-state.js';
	import { pushKeyedToast, dismissKeyedToast } from '$lib/stores/toasts.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';

	/**
	 * False while this view is mounted but hidden (see the layer stack in
	 * +page.svelte). Cheap IndexedDB-backed work keeps running so returning is
	 * instant; anything that costs network or main-thread decode is gated, and
	 * so is ownership of the Android back gesture.
	 */
	let { active = true }: { active?: boolean } = $props();

	// One collator per comparison style, constructed once. `localeCompare` with
	// an options object builds a fresh collator per call — a 13k-volume sort was
	// paying ~177k collator constructions per navigation.
	const numericCollator = new Intl.Collator(undefined, { numeric: true });
	const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

	const initialCatalogSnapshot = catalogController.getSnapshot();
	let volumes = $state<VolumeMetadata[]>(initialCatalogSnapshot.data?.volumes ?? []);
	let projectedLocalSubfolders = $state<string[]>(initialCatalogSnapshot.data?.localSubfolders ?? []);
	let remoteFolders = $state<RemoteFolder[]>(initialCatalogSnapshot.data?.remoteFolders ?? []);
	let collectionCounts = $state<Record<string, number>>(initialCatalogSnapshot.data?.collectionCounts ?? {});
	let catalogPhase = $state<LoadablePhase>(initialCatalogSnapshot.phase);
	let catalogLoadError = $state<Error | undefined>(initialCatalogSnapshot.error);
	let thumbnailUrls = $state<Map<string, string>>(new Map());
	let catalogHasLastGood = $state(Boolean(initialCatalogSnapshot.data));
	let catalogColdLoading = $derived(!catalogHasLastGood && (catalogPhase === 'uninitialized' || catalogPhase === 'loading'));

	type RemoteCoverTarget =
		| { kind: 'folder'; id: string; revision: string }
		| { kind: 'volume'; id: string; revision: string };
	type RemoteFolderSyncState = {
		key: string | null;
		loading: boolean;
		error: string | null;
	};

	let remoteFolderSyncState = $state<RemoteFolderSyncState>({
		key: null,
		loading: false,
		error: null
	});

	// Search bar visibility (persisted)
	// Fresh key on purpose: the old 'showCatalogSearch' was written by a row
	// that did nothing visible on mobile, so a persisted 'false' there carries
	// no intent — honoring it would make the search button vanish on update.
	let showSearchBar = $state(localStorage.getItem('showCatalogSearchButton') !== 'false');
	function toggleSearchBar() {
		showSearchBar = !showSearchBar;
		localStorage.setItem('showCatalogSearchButton', String(showSearchBar));
		if (!showSearchBar) catalogSearchQuery.set('');
	}

	// Context menu state
	let contextMenuVolume = $state<VolumeMetadata | null>(null);
	let contextMenuPosition = $state<{ x: number; y: number } | null>(null);
	let contextMenuEl = $state<HTMLDivElement | null>(null);

	// Close context menu when store is cleared externally (e.g. Android back button)
	$effect(() => {
		if (!$catalogContextMenuOpen && contextMenuVolume) {
			contextMenuVolume = null;
			contextMenuPosition = null;
		}
	});

	// Close folder context menu when store is cleared externally
	$effect(() => {
		if (!$catalogContextMenuOpen && folderContextMenuName) {
			folderContextMenuName = null;
			folderContextMenuPosition = null;
		}
	});

	// Read filesystem folders for the current library/subfolder
	let fsFolderVersion = 0;
	$effect(() => {
		const libId = $selectedLibraryId;
		const sub = $currentSubfolder;
		const _ = $folderRefreshToken;
		if (!libId) { filesystemFolders = []; return; }
		const lib = $settings.libraries.find(l => l.id === libId);
		if (!lib || !isLocalLibrary(lib)) { filesystemFolders = []; return; }
		const dirPath = sub ? lib.path + '/' + sub : lib.path;
		const version = ++fsFolderVersion;
		readFilesystemFolders(dirPath)
			.then(folders => { if (version === fsFolderVersion) filesystemFolders = folders; })
			.catch(() => { if (version === fsFolderVersion) filesystemFolders = []; });
	});

	// Folder context menu state (separate from volume context menu)
	let folderContextMenuName = $state<string | null>(null);
	let folderContextMenuPosition = $state<{ x: number; y: number } | null>(null);
	let folderContextMenuEl = $state<HTMLDivElement | null>(null);

	// Mobile sort control: an icon button plus a menu, so the row of toolbar
	// controls fits without the Select button running off the right edge.
	const SORT_FIELDS = [
		{ value: 'created_at', label: () => m.catalog_sort_date_added(), icon: 'calendar' },
		{ value: 'name', label: () => m.catalog_sort_name(), icon: 'alphabet' },
		{ value: 'last_read_at', label: () => m.catalog_sort_last_read(), icon: 'clock' },
		{ value: 'page_count', label: () => m.catalog_sort_page_count(), icon: 'pages' }
	] as const;
	let sortMenuOpen = $state(false);
	// Library overflow (the app bar's third control): scan/import/folder/
	// select/search actions at library level.
	let libraryMenuOpen = $state(false);
	let searchOverlayOpen = $state(false);
	function openLibraryMenu() { libraryMenuOpen = true; }
	function closeLibraryMenu() { libraryMenuOpen = false; }
	function cycleViewMode() {
		playReaderHaptic('selection');
		const current = get(catalogViewMode);
		catalogViewMode.set(current === 'grid-3' ? 'grid-2' : current === 'grid-2' ? 'list' : 'grid-3');
	}
	const viewModeTitle = (mode: 'grid-3' | 'grid-2' | 'list'): string =>
		mode === 'grid-3' ? m.catalog_view_grid() : mode === 'grid-2' ? m.catalog_view_grid_large() : m.catalog_view_list();
	let hasLocalLibrary = $derived($settings.libraries.some(isLocalLibrary));
	// Root-level Import/+Folder target: the only local library, else the
	// remembered last target, else the selected library when local.
	let newFolderTargetLibraryId = $state<string | null>(null);
	function defaultLocalTargetId(): string | null {
		const locals = $settings.libraries.filter(isLocalLibrary);
		if (locals.length === 0) return null;
		if (locals.length === 1) return locals[0].id;
		const remembered = recallLocalTarget();
		if (remembered && locals.some((lib) => lib.id === remembered)) return remembered;
		const selected = get(selectedLibraryId);
		if (selected && locals.some((lib) => lib.id === selected)) return selected;
		return locals[0].id;
	}
	const activeSortField = $derived(SORT_FIELDS.find((field) => field.value === $catalogSortField) ?? SORT_FIELDS[0]);

	function openSortMenu(): void {
		sortMenuOpen = true;
		catalogContextMenuOpen.set(true);
	}
	function closeSortMenu(): void {
		sortMenuOpen = false;
		catalogContextMenuOpen.set(false);
	}

	// Close the sort menu when the store is cleared externally (Android back)
	$effect(() => {
		if (!$catalogContextMenuOpen && sortMenuOpen) sortMenuOpen = false;
	});

	// Folder management dialogs
	let deleteFolderConfirm = $state<{ name: string; volumeCount: number } | null>(null);
	let isDeletingFolder = $state(false);
	let deleteFolderError = $state('');
	let renameFolderTarget = $state<string | null>(null);
	let renameFolderInput = $state('');
	let renameFolderError = $state('');
	let isRenamingFolder = $state(false);
	let showNewFolderDialog = $state(false);
	let newFolderInput = $state('');
	let newFolderError = $state('');

	// Filesystem-derived folders (for showing empty folders)
	let filesystemFolders = $state<string[]>([]);

	// Selection mode
	let selectionMode = $state(false);
	let selectedVolumeUuids = $state<Set<string>>(new Set());
	let selectedCount = $derived(selectedVolumeUuids.size);
	let deleteSelectedConfirm = $state(false);
	let isDeletingSelected = $state(false);

	// Move dialog
	let showMoveDialog = $state(false);
	let moveDialogPath = $state('');
	let moveDialogFolders = $state<string[]>([]);
	let moveDialogShowNewFolder = $state(false);
	let moveDialogNewFolderInput = $state('');
	let moveDialogNewFolderError = $state('');
	let isMovingVolumes = $state(false);
	let moveError = $state('');
	let moveDialogBreadcrumbs = $derived(buildBreadcrumbs(moveDialogPath));

	// Delete confirmation state
	let deleteConfirmVolume = $state<VolumeMetadata | null>(null);

	// Clear translations confirmation state
	let clearTranslationsConfirmVolume = $state<VolumeMetadata | null>(null);

	// Track whether the context menu volume has translation data
	let contextMenuHasTranslations = $state(false);

	// Volume details dialog state
	let detailsVolume = $state<VolumeMetadata | null>(null);

	// Custom translation dialog state
	let customTranslationVolume = $state<VolumeMetadata | null>(null);

	// Revise volume dialog state
	let reviseVolumeTarget = $state<VolumeMetadata | null>(null);

	// Export translated CBZ state
	let exportingVolume = $state<VolumeMetadata | null>(null);
	let exportProgress = $state({ current: 0, total: 0 });
	let exportError = $state<string | null>(null);
	let exportAbortController = $state<AbortController | null>(null);

	// Translation error notification
	let translationNotification = $state<{ volumeUuid: string; message: string; isError: boolean } | null>(null);

	// Library scan state
	let isScanning = $state(false);
	let scanMessage = $state<string | null>(null);
	// Mobile: scan progress floats as a toast above the dock instead of
	// reflowing the header (the message stream replaces one keyed toast).
	$effect(() => {
		if (!isMobile) return;
		if (scanMessage) pushKeyedToast('library-scan', { message: scanMessage });
		else dismissKeyedToast('library-scan');
	});
	let libraryPathValid = $state(true);
	let libraryValidationGeneration = 0;

	function dismissLibraryAccessWarning() {
		// Persist the dismissal so navigating away from and back to the catalog
		// does not make the same warning repeatedly interrupt the user.
		settings.patch({ showLibraryAccessWarnings: false });
		libraryPathValid = true;
	}

	// Whether the active library is a local library (for showing "+ Import")
	let activeLibraryIsLocal = $derived.by(() => {
		if (!$selectedLibraryId) return false;
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		return lib ? isLocalLibrary(lib) : false;
	});
	/**
	 * Scan is scoped to the folder the user is standing in (catalog-controller
	 * honours location over syncMode), so the button must say which scope it
	 * will act on *before* being pressed — a user inside a folder pressing
	 * "Scan/Sync" expecting a whole-library reconcile would silently get a
	 * one-folder refresh otherwise.
	 */
	let scanScopeIsFolder = $derived(
		$selectedLibraryId !== null && ($currentRemoteFolderId !== null || $currentSubfolder !== '')
	);
	let scanTargetsIncludeRemote = $derived(
		($selectedLibraryId
			? $settings.libraries.filter((library) => library.id === $selectedLibraryId)
			: $settings.libraries
		).some(isRemoteServerLibrary)
	);

	let visibleLibraries = $derived($settings.libraries);
	let recoveredDownloadCount = $derived(collectionCounts[UNASSIGNED_LIBRARY_ID] ?? 0);
	let hasRecoveredDownloads = $derived(recoveredDownloadCount > 0);
	let visibleCollectionCount = $derived(
		visibleLibraries.length + (hasRecoveredDownloads ? 1 : 0)
	);
	let recoveredDownloadsSelected = $derived(
		isRecoveredDownloadsCollectionId($selectedLibraryId)
	);

	// Category filters flatten to the whole library: a favorite buried in a
	// subfolder must surface without digging folder by folder. Gated on the
	// catalog being the visible view — a filter left active while reading
	// would otherwise keep the controller's liveQuery observing the entire
	// library index, re-materializing 13k rows on every reader progress
	// checkpoint. The store is the single authority every location writer
	// (CatalogSidebar on desktop) reads, so writers can't fight over it.
	$effect(() => {
		catalogFlattenActive.set(categoryFilterActive && $appView === 'catalog');
	});
	$effect(() => {
		catalogController.setLocation({
			libraryId: $selectedLibraryId,
			subfolder: $currentSubfolder,
			remoteFolderId: $currentRemoteFolderId,
			flatten: $catalogFlattenActive
		});
	});
	let selectedCollectionName = $derived(
		recoveredDownloadsSelected
			? 'Recovered Downloads'
			: ($selectedLibraryId
				? ($settings.libraries.find((library) => library.id === $selectedLibraryId)?.name ?? 'Library')
				: 'All Libraries')
	);

	// Guard: only auto-select a library once on initial mount
	let hasAutoSelected = false;

	// ── Category filter (the pill filter row) ─────────────────────────
	type CatalogFilter = 'all' | 'favorites' | 'recent' | 'translated' | 'unread';
	type TranslatedSubFilter = 'all' | 'translating' | 'done';
	const CATALOG_FILTERS: Array<{ id: CatalogFilter; label: () => string }> = [
		{ id: 'all', label: () => m.catalog_filter_all() },
		{ id: 'favorites', label: () => m.catalog_filter_favorites() },
		{ id: 'recent', label: () => m.catalog_filter_recent() },
		{ id: 'translated', label: () => m.catalog_filter_translated() },
		{ id: 'unread', label: () => m.catalog_filter_unread() }
	];
	let catalogFilter = $state<CatalogFilter>('all');
	/** Single authority for "a category filter is narrowing the catalog" — the
	 *  flatten feed, the folder-scoping skip, and the subfolder-card gates must
	 *  stay in lockstep or a flat feed gets folder-scoped (empty listings) or
	 *  a scoped feed skips scoping (duplicates). */
	let categoryFilterActive = $derived(catalogFilter !== 'all');
	let translatedSubFilter = $state<TranslatedSubFilter>('all');
	const jobIsTranslating = (status: string) =>
		status === 'translating' || status === 'reviewing' || status === 'revising';

	// Whether any filters are active (for showing filter status)
	let hasActiveFilters = $derived(
		catalogFilter !== 'all' ||
		$selectedLibraryId !== null ||
		$currentSubfolder !== '' ||
		$currentRemoteFolderId !== null ||
		$catalogSearchQuery.trim() !== '' ||
		$activeTagFilters.length > 0
	);

	// Filters the user actually applied, excluding the library selection — which
	// the app makes for them on mobile. Without this distinction an empty
	// library reads as "No volumes match the current filters / Clear all
	// filters" on a fresh install where the user has set no filters at all.
	let hasNarrowingFilters = $derived(
		catalogFilter !== 'all' ||
		$currentSubfolder !== '' ||
		$currentRemoteFolderId !== null ||
		$catalogSearchQuery.trim() !== '' ||
		$activeTagFilters.length > 0
	);

	// Derive inline subfolders for the current library/folder level
	// Merges volume-derived folders with actual filesystem folders (so empty folders appear too)
	let inlineSubfolders = $derived.by(() => {
		if (!$selectedLibraryId) return [];
		// Category filters show one flat list of matching comics — folder
		// cards would just be dead ends that ignore the filter.
		if (categoryFilterActive) return [];
		const lib = $settings.libraries.find((l) => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) return [];
		let folders = mergeSubfolderSources(
			projectedLocalSubfolders,
			filesystemFolders
		);
		if ($catalogSearchMode === 'folders' && $catalogSearchQuery.trim()) {
			const q = $catalogSearchQuery.toLowerCase();
			folders = folders.filter((f) => f.toLowerCase().includes(q));
		}
		return folders;
	});

	// Derive inline remote subfolders for YACReader/Komga libraries
	let remoteInlineSubfolders = $derived.by(() => {
		if (!$selectedLibraryId) return [];
		if (categoryFilterActive) return [];
		const lib = $settings.libraries.find((l) => l.id === $selectedLibraryId);
		if (!lib || !isRemoteServerLibrary(lib)) return [];
		const parentId = $currentRemoteFolderId;
		let folders = remoteFolders.filter(
			(f) =>
				f.librarySettingsId === $selectedLibraryId &&
				f.parentFolderId === parentId
		);
		// Apply catalog sort setting to subfolders
		const field = $catalogSortField;
		const dir = $catalogSortDirection === 'asc' ? 1 : -1;
		folders = [...folders].sort((a, b) => {
			if (field === 'created_at') {
				const aDate = a.serverAddedAt ?? '';
				const bDate = b.serverAddedAt ?? '';
				if (aDate || bDate) return dir * aDate.localeCompare(bDate);
			}
			return dir * numericCollator.compare(a.name, b.name);
		});
		if ($catalogSearchMode === 'folders' && $catalogSearchQuery.trim()) {
			const q = $catalogSearchQuery.toLowerCase();
			folders = folders.filter((f) => f.name.toLowerCase().includes(q));
		}
		return folders;
	});

	// Folder cover rendering is windowed, but the render handles are not owned by
	// one scroll event. Retaining the last-good per-folder handle prevents a
	// virtual-window update from removing a mounted image while its IndexedDB or
	// authenticated replacement is still loading.
	let folderCoverUrls = $state<Map<string, string>>(new Map());
	let folderCoverLocation = '';
	let folderCoverAbortController = new AbortController();
	let nextFolderCoverRequestToken = 0;
	const folderCoverRequestTokens = new Map<string, number>();
	const folderCoverRequestRevisions = new Map<string, string>();

	type FolderCoverRequest = {
		folder: RemoteFolder;
		revision: string;
		token: number;
	};

	function folderCoverCacheKey(folderId: string): string {
		return `folder-cover:${folderId}`;
	}

	function folderCoverRevision(folder: RemoteFolder): string {
		return [
			folder.metadataRevision ?? 0,
			folder.coverAssetId ?? '',
			folder.coverPath ?? '',
			folder.coverHash ?? '',
			folder.coverCandidateHash ?? '',
			folder.serverUpdatedAt ?? ''
		].join(':');
	}

	function resetFolderCoverLocation(location: string): void {
		if (folderCoverLocation === location) return;
		folderCoverAbortController.abort('catalog location changed');
		folderCoverAbortController = new AbortController();
		folderCoverLocation = location;
		folderCoverRequestTokens.clear();
		folderCoverRequestRevisions.clear();
		satisfiedFolderCovers.clear();
		folderCoverUrls = new Map();
	}

	function publishVisibleFolderCoverUrls(location: string): void {
		if (folderCoverLocation !== location) return;
		const next = new Map<string, string>();
		for (const folder of visibleRemoteSubfolders) {
			const url = getThumbnailUrl(folderCoverCacheKey(folder.id));
			if (url) next.set(folder.id, url);
		}
		folderCoverUrls = next;
	}

	/**
	 * Folders already satisfied at their current revision, so window churn does
	 * not re-run the (IDB) read-through for them. Unlike the request maps this
	 * survives scroll-out — that is its purpose — but only trusts itself while
	 * the URL LRU still holds the entry; after eviction the folder re-requests.
	 */
	const satisfiedFolderCovers = new Map<string, string>();

	function beginFolderCoverRequests(folders: readonly RemoteFolder[]): FolderCoverRequest[] {
		const visibleIds = new Set(folders.map((folder) => folder.id));
		for (const id of folderCoverRequestTokens.keys()) {
			if (visibleIds.has(id)) continue;
			folderCoverRequestTokens.delete(id);
			folderCoverRequestRevisions.delete(id);
		}
		const requests: FolderCoverRequest[] = [];
		for (const folder of folders) {
			const revision = folderCoverRevision(folder);
			if (folderCoverRequestRevisions.get(folder.id) === revision) continue;
			if (satisfiedFolderCovers.get(folder.id) === revision
				&& getThumbnailUrl(folderCoverCacheKey(folder.id)) !== undefined) {
				continue;
			}
			satisfiedFolderCovers.delete(folder.id);
			const token = ++nextFolderCoverRequestToken;
			folderCoverRequestRevisions.set(folder.id, revision);
			folderCoverRequestTokens.set(folder.id, token);
			requests.push({ folder, revision, token });
		}
		return requests;
	}

	function currentFolderCoverRequest(
		request: FolderCoverRequest,
		location: string,
	): RemoteFolder | undefined {
		if (
			folderCoverLocation !== location
			|| folderCoverRequestTokens.get(request.folder.id) !== request.token
		) return undefined;
		const current = visibleRemoteSubfolders.find((folder) => folder.id === request.folder.id);
		return current && folderCoverRevision(current) === request.revision ? current : undefined;
	}

	function failFolderCoverRequests(requests: readonly FolderCoverRequest[], location: string): void {
		if (folderCoverLocation !== location) return;
		for (const request of requests) {
			if (folderCoverRequestTokens.get(request.folder.id) !== request.token) continue;
			folderCoverRequestTokens.delete(request.folder.id);
			folderCoverRequestRevisions.delete(request.folder.id);
		}
	}

	$effect(() => {
		const libId = $selectedLibraryId;
		const remoteFolderId = $currentRemoteFolderId;
		const lib = libId ? $settings.libraries.find((l) => l.id === libId) : null;
		const location = `${libId ?? '_none'}:${remoteFolderId ?? '_root'}:${lib?.type ?? '_none'}`;
		resetFolderCoverLocation(location);
		if (!lib || !isRemoteServerLibrary(lib)) {
			folderCoverUrls = new Map();
			return;
		}

		const folders = visibleRemoteSubfolders;
		publishVisibleFolderCoverUrls(location);
		const requests = beginFolderCoverRequests(folders);
		if (requests.length === 0) return;
		const signal = folderCoverAbortController.signal;

		if (isYACReaderLibrary(lib)) {
			void catalogController.loadFolderCoverAssets(requests.map(({ folder }) => folder.id))
				.then(async (assets) => {
					await Promise.all(requests.map(async (request) => {
						const asset = assets.get(request.folder.id);
						if (!asset || signal.aborted) return;
						const renderableBlob = await renderableImageBlob(asset.blob);
						if (!currentFolderCoverRequest(request, location) || signal.aborted) return;
						getThumbnailUrl(
							folderCoverCacheKey(request.folder.id),
							renderableBlob,
							`${request.revision}:${asset.revision}`,
						);
						// Record satisfaction, matching the Kavita/Komga path. This
						// was omitted for YAC, so on a 664-folder root every window
						// change re-ran the bulkGet + per-folder normalization for
						// covers the LRU already held.
						satisfiedFolderCovers.set(request.folder.id, request.revision);
					}));
					publishVisibleFolderCoverUrls(location);
				})
				.catch((error) => {
					if (!signal.aborted) {
						failFolderCoverRequests(requests, location);
						console.debug('[CatalogView] Failed to read visible YACReader folder-cover assets:', error);
					}
				});
			return;
		}

		const coverRequests = requests.filter(({ folder }) => Boolean(folder.coverHash));
		if (coverRequests.length === 0) return;

		const fetchCovers = async () => {
			// Read through the cache first. Kavita/Komga covers used to be fetched
			// from the server on every visit and never stored, so scrolling a
			// series grid re-downloaded PNGs it had already seen (measured at
			// ~273 KB each). Anything already in `media_assets` at the requested
			// revision costs an IndexedDB read instead of a round trip.
			// An IndexedDB failure degrades to an all-miss cache read: the network
			// fallback below must still run. (Previously the rejection escaped to
			// the outer catch and failed every request — IDB trouble was punished
			// harder than the server being down.)
			const cached = await catalogController.loadFolderCoverAssets(
				coverRequests.map(({ folder }) => folder.id),
			).catch((error) => {
				console.debug('[CatalogView] Folder cover cache read failed; fetching instead:', error);
				return new Map<string, MediaAsset>();
			});
			if (signal.aborted || folderCoverLocation !== location) return;

			const { hits, misses: uncached } = partitionFolderCoverRequests(coverRequests, cached);
			for (const { request, asset } of hits) {
				if (!currentFolderCoverRequest(request, location)) continue;
				// Normalize like every other render path: a blob persisted before
				// type-sniffing (or served as octet-stream) must not render on the
				// network visit and then fail on every cache hit after.
				const renderable = await renderableImageBlob(asset.blob);
				if (!currentFolderCoverRequest(request, location) || signal.aborted) continue;
				getThumbnailUrl(folderCoverCacheKey(request.folder.id), renderable, asset.revision);
				satisfiedFolderCovers.set(request.folder.id, request.revision);
			}
			publishVisibleFolderCoverUrls(location);
			if (uncached.length === 0) return;

			let blobs = new Map<string, Blob>();
			try {
				if (isKomgaLibrary(lib)) {
					const creds = await loadKomgaCredentials(lib.serverUrl);
					const authHeader = 'Basic ' + btoa(`${creds.username}:${creds.password}`);
					await Promise.all(uncached.map(async ({ folder }) => {
						try {
							const url = `${lib.serverUrl}/api/v1/series/${encodeURIComponent(folder.coverHash!)}/thumbnail`;
							const response = await tauriFetch(url, {
								method: 'GET',
								headers: { Authorization: authHeader },
								signal,
							});
							if (response.ok) blobs.set(folder.id, await response.blob());
						} catch {
							// Keep only this folder on fallback art.
						}
					}));
				} else if (isKavitaLibrary(lib)) {
					const apiKey = await loadKavitaApiKey(lib.serverUrl);
					const client = getOrCreateKavitaClient(lib.serverUrl, apiKey);
					blobs = await fetchKavitaFolderCoverBlobs(uncached.map(({ folder }) => folder), client);
				}
			} catch {
				// Missing credentials or a server-wide failure leaves folder fallback art.
			}

			if (signal.aborted || folderCoverLocation !== location) return;
			for (const request of uncached) {
				const blob = blobs.get(request.folder.id);
				if (!currentFolderCoverRequest(request, location)) continue;
				if (!blob) {
					// Release the bookkeeping so a later effect run retries this
					// folder; keeping the token pinned meant one failed fetch left
					// the cover missing for as long as it stayed on screen.
					folderCoverRequestTokens.delete(request.folder.id);
					folderCoverRequestRevisions.delete(request.folder.id);
					continue;
				}
				// Servers hand back whatever they stored — Kavita serves PNG, which
				// costs several times what the same pixels cost as WebP/JPEG. Store
				// the normalized form so the bytes are paid for once, under the
				// recipe-versioned revision so a future recipe change regenerates.
				const thumbnail = await transcodeRemoteCover(blob);
				if (!currentFolderCoverRequest(request, location) || signal.aborted) continue;
				const storedRevision = versionedCoverRevision(request.revision);
				getThumbnailUrl(
					folderCoverCacheKey(request.folder.id),
					thumbnail.blob,
					storedRevision,
				);
				satisfiedFolderCovers.set(request.folder.id, request.revision);
				void catalogController.storeFolderCoverAsset({
					folderId: request.folder.id,
					blob: thumbnail.blob,
					revision: storedRevision,
					width: thumbnail.width,
					height: thumbnail.height,
				}).catch((error) => {
					// A cache write failure must never cost the user the cover they
					// can already see.
					console.debug('[CatalogView] Failed to cache remote folder cover:', error);
				});
			}
			publishVisibleFolderCoverUrls(location);
		};
		void fetchCovers().catch((error) => {
			if (!signal.aborted) {
				failFolderCoverRequests(coverRequests, location);
				console.debug('[CatalogView] Failed to read visible remote folder covers:', error);
			}
		});
	});

	// YACReader is a single-threaded server, so cover hydration is driven by
	// viewport proximity and serialized per server. A failed request remains
	// retryable with bounded exponential backoff; leaving the viewport cancels
	// its pending retry and prevents queued off-screen work from starting.
	const observedRemoteCoverTargets = new Map<Element, RemoteCoverTarget>();
	const visibleRemoteCoverTargets = new Map<string, RemoteCoverTarget>();
	/** In-flight hydrations by key; the controller aborts the network fetch. */
	const pendingRemoteCoverHydrations = new Map<string, AbortController>();

	function abortRemoteCoverHydration(key: string, reason: string): void {
		const controller = pendingRemoteCoverHydrations.get(key);
		if (!controller) return;
		pendingRemoteCoverHydrations.delete(key);
		controller.abort(reason);
	}
	const remoteCoverRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let remoteCoverObserver: IntersectionObserver | null = null;
	let catalogDestroyed = false;

	function remoteCoverKey(target: RemoteCoverTarget): string {
		return `${target.kind}:${target.id}`;
	}

	function remoteCoverTargetIdentity(target: RemoteCoverTarget): string {
		return `${remoteCoverKey(target)}:${target.revision}`;
	}

	function volumeCoverRevision(volume: VolumeMetadata): string {
		const source = volume.source;
		if (!source) return `local:${volume.thumbnail_generation_version ?? 0}`;
		if (source.type === 'yacreader') return `yacreader:${source.comicHash ?? ''}`;
		if (source.type === 'komga') return `komga:${source.komgaBookId}`;
		if (source.type === 'kavita') return `kavita:${source.kavitaChapterId}`;
		return `local:${volume.thumbnail_generation_version ?? 0}`;
	}

	function isRemoteCoverTargetVisible(target: RemoteCoverTarget): boolean {
		const current = visibleRemoteCoverTargets.get(remoteCoverKey(target));
		return current?.kind === target.kind && current.id === target.id;
	}

	function clearRemoteCoverRetryTimer(key: string) {
		const timer = remoteCoverRetryTimers.get(key);
		if (timer) clearTimeout(timer);
		remoteCoverRetryTimers.delete(key);
	}

	function scheduleRemoteCoverRetry(target: RemoteCoverTarget, delay: number) {
		const key = remoteCoverKey(target);
		clearRemoteCoverRetryTimer(key);
		const timer = setTimeout(() => {
			remoteCoverRetryTimers.delete(key);
			if (!catalogDestroyed && isRemoteCoverTargetVisible(target)) {
				queueRemoteCoverHydration(target);
			}
		}, Math.max(0, delay));
		remoteCoverRetryTimers.set(key, timer);
	}

	async function hydrateVisibleRemoteCover(target: RemoteCoverTarget, signal?: AbortSignal): Promise<boolean> {
		if (!isRemoteCoverTargetVisible(target) || catalogDestroyed) return true;
		const libId = get(selectedLibraryId);
		const lib = libId ? get(settings).libraries.find((candidate) => candidate.id === libId) : null;
		if (!lib || !isYACReaderLibrary(lib)) return true;

		const client = getOrCreateClient(lib.serverUrl);
		if (target.kind === 'folder') {
			const folder = remoteFolders.find((candidate) => candidate.id === target.id);
			if (!folder || folder.librarySettingsId !== lib.id) return true;
			if (!folder.coverHash && !folder.coverPath) return true;
			return Boolean(await fetchFolderCover(client, folder, signal));
		}

		const volume = volumes.find((candidate) => candidate.volume_uuid === target.id);
		if (!volume || volume.library_id !== lib.id || volume.source?.type !== 'yacreader') return true;
		if (volume.thumbnail) return true;
		const result = await hydrateRemoteVolumeCover(client, volume);
		const status = typeof result === 'string' ? result : result.status;
		return status === 'cached' || status === 'hydrated' || status === 'missing';
	}

	function queueRemoteCoverHydration(target: RemoteCoverTarget) {
		// `visibility: hidden` elements still intersect geometrically, so without
		// this the hidden catalog would keep pulling covers from a (single-
		// threaded, for YACReader) server while the user is reading. Targets stay
		// registered and are flushed on activation.
		if (!active) return;
		const key = remoteCoverKey(target);
		if (pendingRemoteCoverHydrations.has(key) || !isRemoteCoverTargetVisible(target)) return;

		const folderRetryAt = target.kind === 'folder'
			? Date.parse(remoteFolders.find((folder) => folder.id === target.id)?.coverRetryAt ?? '')
			: 0;
		if (Number.isFinite(folderRetryAt) && folderRetryAt > Date.now()) {
			scheduleRemoteCoverRetry(target, folderRetryAt - Date.now());
			return;
		}

		const libId = get(selectedLibraryId);
		const lib = libId ? get(settings).libraries.find((candidate) => candidate.id === libId) : null;
		if (!lib || !isYACReaderLibrary(lib)) return;

		const controller = new AbortController();
		pendingRemoteCoverHydrations.set(key, controller);
		void (async () => {
			if (!isRemoteCoverTargetVisible(target) || catalogDestroyed || controller.signal.aborted) return;
			try {
				const settled = await hydrateVisibleRemoteCover(target, controller.signal);
				if (settled && target.kind === 'volume') invalidateVisibleVolumeThumbnail(target.id);
			} catch (err) {
				console.debug(`[CatalogView] YACReader ${target.kind} cover hydration failed:`, err);
			}
			})()
			.finally(() => {
				if (pendingRemoteCoverHydrations.get(key) === controller) {
					pendingRemoteCoverHydrations.delete(key);
				}
			});
	}

	// A metadata/candidate revision must retry an already-visible card; it must
	// not wait for another IntersectionObserver transition.
	$effect(() => {
		remoteFolders.map((folder) => `${folder.id}:${folder.metadataRevision ?? 0}:${folder.coverRetryAt ?? ''}`).join('|');
		for (const target of visibleRemoteCoverTargets.values()) {
			if (target.kind === 'folder') queueRemoteCoverHydration(target);
		}
	});

	// Hydration requested while hidden was declined, not queued, so flush every
	// still-visible target when the view comes back. Going hidden also aborts
	// whatever is currently in flight — the reader is about to need that
	// connection.
	$effect(() => {
		if (!active) {
			for (const key of [...pendingRemoteCoverHydrations.keys()]) {
				abortRemoteCoverHydration(key, 'catalog hidden');
			}
			return;
		}
		for (const target of visibleRemoteCoverTargets.values()) queueRemoteCoverHydration(target);
	});

	function getRemoteCoverObserver(): IntersectionObserver | null {
		if (typeof IntersectionObserver === 'undefined') return null;
		if (!remoteCoverObserver) {
			remoteCoverObserver = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const target = observedRemoteCoverTargets.get(entry.target);
					if (!target) continue;
					const key = remoteCoverKey(target);
					if (entry.isIntersecting) {
						visibleRemoteCoverTargets.set(key, target);
						queueRemoteCoverHydration(target);
					} else {
						visibleRemoteCoverTargets.delete(key);
						clearRemoteCoverRetryTimer(key);
						// The card left the viewport: stop paying the single-threaded
						// server for a cover nobody can see. Previously the fetch was
						// uncancellable and kept the one connection busy while the
						// user's next folder browse waited behind it.
						abortRemoteCoverHydration(key, 'cover target left viewport');
					}
				}
			}, { root: scrollContainer ?? null, rootMargin: '600px 0px', threshold: 0 });
		}
		return remoteCoverObserver;
	}

	function observeRemoteCover(node: HTMLElement, target: RemoteCoverTarget) {
		observedRemoteCoverTargets.set(node, target);
		const observer = getRemoteCoverObserver();
		if (observer) {
			observer.observe(node);
		} else {
			visibleRemoteCoverTargets.set(remoteCoverKey(target), target);
			queueMicrotask(() => queueRemoteCoverHydration(target));
		}

		return {
			update(next: RemoteCoverTarget) {
				const previous = observedRemoteCoverTargets.get(node);
				let wasVisible = false;
				if (previous) {
					const previousKey = remoteCoverKey(previous);
					wasVisible = visibleRemoteCoverTargets.has(previousKey);
					if (previousKey !== remoteCoverKey(next)) {
						visibleRemoteCoverTargets.delete(previousKey);
						clearRemoteCoverRetryTimer(previousKey);
					}
				}
				observedRemoteCoverTargets.set(node, next);
				if (previous && remoteCoverTargetIdentity(previous) === remoteCoverTargetIdentity(next)) {
					return;
				}
				// A live catalog query replaces the folder object when its cover
				// candidate/revision changes, but the keyed card node remains mounted.
				// IntersectionObserver does not emit a second entry for that in-place
				// action update, so retain the node's visibility and explicitly requeue
				// the new revision. Otherwise an already-visible card can remain blank
				// until the user scrolls it out of view and back again.
				if (wasVisible) {
					visibleRemoteCoverTargets.set(remoteCoverKey(next), next);
					queueMicrotask(() => queueRemoteCoverHydration(next));
				}
			},
			destroy() {
				observer?.unobserve(node);
				const previous = observedRemoteCoverTargets.get(node);
				if (previous) {
					const previousKey = remoteCoverKey(previous);
					visibleRemoteCoverTargets.delete(previousKey);
					clearRemoteCoverRetryTimer(previousKey);
				}
				observedRemoteCoverTargets.delete(node);
			}
		};
	}

	// Local folder cover URLs — picks a thumbnail from the first volume in each subfolder
	let localFolderCoverUrls = $state<Map<string, string>>(new Map());
	$effect(() => {
		const libId = $selectedLibraryId;
		const lib = libId ? $settings.libraries.find((l) => l.id === libId) : null;
		if (!lib || !isLocalLibrary(lib)) {
			localFolderCoverUrls = new Map();
			return;
		}
		const folders = visibleLocalSubfolders;
		if (folders.length === 0) { localFolderCoverUrls = new Map(); return; }

		const libraryId = lib.id;
		const prefix = normalizeSubfolderPath($currentSubfolder);
		// Carry forward every still-relevant URL synchronously: this was the one
		// cover path with no republish before its async load, so local subfolder
		// covers blanked for a full IDB round trip on every window change.
		// (untrack: this effect writes the same state — a tracked read loops it.)
		const previous = untrack(() => localFolderCoverUrls);
		const carried = new Map<string, string>();
		for (const folder of folders) {
			const url = previous.get(folder);
			if (url) carried.set(folder, url);
		}
		localFolderCoverUrls = carried;
		let current = true;
		void catalogController.loadLocalFolderCoverAssets(libraryId, prefix, folders).then((assets) => {
			if (!current) return;
			const newUrls = new Map<string, string>();
			for (const folder of folders) {
				const asset = assets.get(folder);
				if (!asset) continue;
				const url = getThumbnailUrl(asset.owner_id, asset.blob, asset.revision);
				if (url) newUrls.set(folder, url);
			}
			localFolderCoverUrls = newUrls;
		});
		return () => { current = false; };
	});

	/**
	 * Continue-reading strip: every browse level of a selected library.
	 * Subfolders used to hide it, which made resuming depend on where you
	 * happened to be standing; the strip's own tap already navigates to the
	 * comic's folder, so location is irrelevant to it.
	 */
	let showRecentlyRead = $derived($selectedLibraryId !== null);

	/** Current folder name for display in header (empty at root) */
	let currentFolderName = $derived.by(() => {
		if ($currentSubfolder) {
			const parts = $currentSubfolder.split('/').filter(Boolean);
			return parts[parts.length - 1] || '';
		}
		if ($currentRemoteFolderId) {
			const folder = remoteFolders.find(
				(f) => f.remoteFolderId === $currentRemoteFolderId && f.librarySettingsId === $selectedLibraryId
			);
			return folder?.name || '';
		}
		return '';
	});
	let mobileCollectionHeading = $derived(
		currentFolderName || ($selectedLibraryId && selectedCollectionName !== 'Library' ? selectedCollectionName : '')
	);

	function navigateUpFolder(): void {
		if ($currentRemoteFolderId !== null) {
			void db.remote_folders
				.where('id')
				.equals(`${$selectedLibraryId}:${$currentRemoteFolderId}`)
				.first()
				.then((folder) => currentRemoteFolderId.set(folder?.parentFolderId ?? null));
			return;
		}
		if ($currentSubfolder !== '') {
			const parts = $currentSubfolder.replace(/\\/g, '/').split('/');
			parts.pop();
			currentSubfolder.set(parts.join('/'));
			return;
		}
		if ($selectedLibraryId) {
			currentRemoteFolderId.set(null);
			selectedLibraryId.set(null);
		}
	}

	/**
	 * The resume card, from the global most-recently-read query rather than the
	 * current location's rows — which could only ever surface a comic sitting at
	 * the level you were already looking at, making a comic in a subfolder
	 * invisible. Display stays scoped to the selected library, and the
	 * All-Libraries picker has no library context to resume within.
	 */
	let continueReadingForLibrary = $derived(
		showRecentlyRead
			&& $selectedLibraryId !== null
			&& $continueReadingVolume
			&& volumeBelongsToCatalogCollection($continueReadingVolume, $selectedLibraryId)
				? $continueReadingVolume
				: null
	);

	// Full filter + sort pipeline
	/** Steps 0–4 of the old pipeline: everything but the category filter and sort. */
	let scopedVolumes = $derived.by(() => {
		let result = volumes;

		// 0. Filter out orphaned volumes (library was removed)
		const libraryIds = new Set($settings.libraries.map(l => l.id));
		result = result.filter((v) => !v.library_id || libraryIds.has(v.library_id));

		// 1. Filter by library
		if ($selectedLibraryId) {
			result = result.filter((v) => volumeBelongsToCatalogCollection(v, $selectedLibraryId));
		}

		// 2. Filter by subfolder (local) or remote folder (YACReader/Komga).
		// Skipped while a category filter is active: the controller then feeds
		// the whole library flat, and folder scoping would hide every match
		// outside the current level (including all Komga/Kavita books at root).
		if ($selectedLibraryId && !categoryFilterActive) {
			const lib = $settings.libraries.find((l) => l.id === $selectedLibraryId);
			if (lib && isRemoteServerLibrary(lib)) {
				// Remote: filter by remoteFolderId in the volume's source
				if (isKomgaLibrary(lib) || isKavitaLibrary(lib)) {
					// Komga/Kavita: at root show nothing (series are folders), inside a series show its books/chapters
					const targetFolderId = $currentRemoteFolderId;
					const sourceType = isKomgaLibrary(lib) ? 'komga' : 'kavita';
					if (targetFolderId) {
						result = result.filter((v) =>
							v.source?.type === sourceType &&
							v.source.remoteFolderId === targetFolderId
						);
					} else {
						// At root level, don't show any volumes (only series folders)
						result = [];
					}
				} else {
					// YACReader: At root ($currentRemoteFolderId is null), show comics with remoteFolderId '1'
					const targetFolderId = $currentRemoteFolderId ?? '1';
					result = result.filter((v) =>
						v.source?.type === 'yacreader' &&
						v.source.remoteFolderId === targetFolderId
					);
				}
			} else if (lib && isLocalLibrary(lib)) {
				// Local: only show volumes at the current folder level
				result = result.filter((v) =>
					(v.folder_path || '') === $currentSubfolder
				);
			}
		}

		// 3. Filter by search query (only in comics mode — folders mode filters folders in CatalogSidebar)
		if ($catalogSearchQuery.trim() && $catalogSearchMode === 'comics') {
			const q = $catalogSearchQuery.toLowerCase();
			result = result.filter((v) => v.title.toLowerCase().includes(q));
		}

		// 4. Filter by tags (AND logic — volume must have ALL selected tags)
		if ($activeTagFilters.length > 0) {
			result = result.filter((v) =>
				$activeTagFilters.every((tag) => v.tags?.includes(tag))
			);
		}

		return result;
	});

	/**
	 * Sub-filter counts, computed on the scope BEFORE the category filter.
	 * Iterates the (small) jobs map against a set of scoped uuids rather than
	 * the scope against the map: the jobs map gets a new identity on every
	 * ≤100ms publication during a run, and with a flattened scope the old
	 * direction re-walked the whole library ~10×/s for a count that changes
	 * at most once per page.
	 */
	let scopedVolumeUuids = $derived(new Set(scopedVolumes.map((volume) => volume.volume_uuid)));
	let translatedCounts = $derived.by(() => {
		let translating = 0;
		let done = 0;
		for (const [uuid, job] of $activeTranslationJobs) {
			if (!scopedVolumeUuids.has(uuid)) continue;
			if (jobIsTranslating(job.status)) translating += 1;
			else if (job.status === 'completed') done += 1;
		}
		return { translating, done, all: translating + done };
	});

	let filteredVolumes = $derived.by(() => {
		let result = scopedVolumes;

		// Category filter (the pill row under the app bar).
		if (catalogFilter === 'favorites') {
			result = result.filter((volume) => Boolean(volume.favorited_at));
		} else if (catalogFilter === 'recent') {
			result = result.filter((volume) => Boolean(volume.last_read_at));
		} else if (catalogFilter === 'unread') {
			result = result.filter(isUnreadVolume);
		} else if (catalogFilter === 'translated') {
			result = result.filter((volume) => {
				const job = $activeTranslationJobs.get(volume.volume_uuid);
				if (!job) return false;
				if (translatedSubFilter === 'translating') return jobIsTranslating(job.status);
				if (translatedSubFilter === 'done') return job.status === 'completed';
				return jobIsTranslating(job.status) || job.status === 'completed';
			});
		}

		// Sort. Recent means recent: it orders by last read, newest first,
		// regardless of the folder's sort preference.
		if (catalogFilter === 'recent') {
			return [...result].sort((a, b) => (b.last_read_at || '').localeCompare(a.last_read_at || ''));
		}
		const field = $catalogSortField;
		const dir = $catalogSortDirection === 'asc' ? 1 : -1;
		return [...result].sort((a, b) => {
			switch (field) {
				case 'name':
					return dir * titleCollator.compare(a.title, b.title);
				case 'created_at':
					return dir * a.created_at.localeCompare(b.created_at);
				case 'last_read_at':
					return dir * (a.last_read_at || '').localeCompare(b.last_read_at || '');
				case 'page_count':
					return dir * (a.page_count - b.page_count);
				default:
					return 0;
			}
		});
	});

	// ── One continuous measured virtual stream ──────────────────────────
	let activeLibraryIsRemote = $derived.by(() => {
		if (!$selectedLibraryId) return false;
		const lib = $settings.libraries.find((candidate) => candidate.id === $selectedLibraryId);
		return lib ? isRemoteServerLibrary(lib) : false;
	});
	let catalogItemCount = $derived(inlineSubfolders.length + remoteInlineSubfolders.length + filteredVolumes.length);
	let catalogKeys = $derived([
		...inlineSubfolders.map((folder) => `local-folder:${folder}`),
		...remoteInlineSubfolders.map((folder) => `remote-folder:${folder.id}`),
		...filteredVolumes.map((volume) => `volume:${volume.volume_uuid}`)
	]);
	let scrollContainer: HTMLDivElement | undefined = $state();
	let catalogScrollTop = $state(0);
	let catalogViewportHeight = $state(640);
	let catalogContainerWidth = $state(360);
	let catalogColumns = $derived.by(() => {
		if ($catalogViewMode === 'list') return 1;
		const width = catalogContainerWidth;
		if (width >= 1280) return 8;
		if (width >= 1024) return 6;
		if (width >= 768) return 5;
		if (width >= 640) return 4;
		const landscape = typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches;
		if ($catalogViewMode === 'grid-2') return landscape ? 4 : 2;
		return landscape ? 5 : 3;
	});
	let catalogGap = $derived($catalogViewMode === 'list' ? 4 : (catalogContainerWidth >= 640 ? 16 : 8));
	let measuredCatalogRowHeight = $state(0);
	let catalogRowHeight = $derived.by(() => {
		if (measuredCatalogRowHeight > 0) return measuredCatalogRowHeight;
		if ($catalogViewMode === 'list') return 76;
		const horizontalPadding = isMobile ? 24 : 48;
		const cardWidth = Math.max(60, (catalogContainerWidth - horizontalPadding - catalogGap * (catalogColumns - 1)) / catalogColumns);
		return cardWidth * 1.5 + 62 + catalogGap;
	});
	let previousMeasureSignature = '';
	$effect(() => {
		const signature = `${$catalogViewMode}:${catalogColumns}:${Math.round(catalogContainerWidth)}:${catalogGap}`;
		if (signature !== previousMeasureSignature) {
			previousMeasureSignature = signature;
			measuredCatalogRowHeight = 0;
		}
	});

	function measureCatalogRow(node: HTMLElement) {
		const measure = () => {
			const height = node.getBoundingClientRect().height + catalogGap;
			if (height > measuredCatalogRowHeight) {
				const anchor = captureCurrentCatalogAnchor();
				measuredCatalogRowHeight = height;
				void tick().then(() => {
					if (!scrollContainer) return;
					const top = restoreCatalogAnchor(anchor, catalogKeys, catalogColumns, catalogRowHeight);
					scrollContainer.scrollTop = top;
					catalogScrollTop = top;
				});
			}
		};
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		requestAnimationFrame(measure);
		return { destroy: () => observer.disconnect() };
	}
	let catalogWindow = $derived(calculateVirtualWindow({
		itemCount: catalogItemCount,
		columns: catalogColumns,
		rowHeight: catalogRowHeight,
		scrollTop: catalogScrollTop,
		viewportHeight: catalogViewportHeight,
		overscanRows: 4
	}));
	// Keep media effects tied to virtual row boundaries, not to every pixel of
	// scrollTop. Derived primitives preserve equality while the user moves
	// within one row even though calculateVirtualWindow returns a new object.
	let catalogWindowStartIndex = $derived(catalogWindow.startIndex);
	let catalogWindowEndIndex = $derived(catalogWindow.endIndex);
	let visibleLocalSubfolders = $derived(inlineSubfolders.slice(
		Math.max(0, catalogWindowStartIndex),
		Math.max(0, Math.min(inlineSubfolders.length, catalogWindowEndIndex))
	));
	let remoteStart = $derived(inlineSubfolders.length);
	let visibleRemoteSubfolders = $derived(remoteInlineSubfolders.slice(
		Math.max(0, catalogWindowStartIndex - remoteStart),
		Math.max(0, Math.min(remoteInlineSubfolders.length, catalogWindowEndIndex - remoteStart))
	));
	let volumeStart = $derived(inlineSubfolders.length + remoteInlineSubfolders.length);
	let visibleVolumes = $derived(filteredVolumes.slice(
		Math.max(0, catalogWindowStartIndex - volumeStart),
		Math.max(0, Math.min(filteredVolumes.length, catalogWindowEndIndex - volumeStart))
	));

	function captureCurrentCatalogAnchor() {
		return captureCatalogAnchor(catalogKeys, scrollContainer?.scrollTop ?? catalogScrollTop, catalogColumns, catalogRowHeight);
	}

	/**
	 * Last size seen while hidden, applied on activation. On desktop the catalog
	 * sidebar unmounts when the reader opens, which widens `<main>` and fires the
	 * observer on the still-mounted (hidden) catalog; applying that immediately
	 * would re-anchor scroll against a width that reverts the moment the sidebar
	 * comes back. Deliberately a plain variable, not `$state`: recording it must
	 * not invalidate anything.
	 */
	let deferredCatalogSize: { width: number; height: number } | null = null;

	function applyCatalogSize(width: number, height: number): void {
		const anchor = captureCurrentCatalogAnchor();
		const widthChanged = Math.abs(catalogContainerWidth - width) > 0.5;
		catalogContainerWidth = width;
		catalogViewportHeight = height;
		if (widthChanged) void tick().then(() => {
			if (!scrollContainer) return;
			const top = restoreCatalogAnchor(anchor, catalogKeys, catalogColumns, catalogRowHeight);
			scrollContainer.scrollTop = top;
			catalogScrollTop = top;
		});
	}

	$effect(() => {
		if (!scrollContainer) return;
		const observer = new ResizeObserver(([entry]) => {
			if (!active) {
				deferredCatalogSize = { width: entry.contentRect.width, height: entry.contentRect.height };
				return;
			}
			applyCatalogSize(entry.contentRect.width, entry.contentRect.height);
		});
		observer.observe(scrollContainer);
		return () => observer.disconnect();
	});

	// Flush a size observed while hidden, but only if it still differs — the
	// common case (sidebar leaves and returns with the view switch) nets to zero
	// and must not churn the window on every return.
	$effect(() => {
		if (!active) return;
		const pending = deferredCatalogSize;
		deferredCatalogSize = null;
		if (!pending) return;
		if (Math.abs(catalogContainerWidth - pending.width) < 0.5
			&& Math.abs(catalogViewportHeight - pending.height) < 0.5) return;
		applyCatalogSize(pending.width, pending.height);
	});

	// Restore per-folder sort/view preferences when the folder context changes.
	let folderPrefsInitialized = false;
	$effect(() => {
		const libId = $selectedLibraryId;
		const sub = $currentSubfolder;
		const remote = $currentRemoteFolderId;
		if (folderPrefsInitialized) {
			restoreFolderPrefs(libId, sub, remote);
		}
		folderPrefsInitialized = true;
	});

	// ── Scroll position preservation ───────────────────────────────
	// Remember the scroll offset for each folder the user visits so that
	// navigating up/down the hierarchy or returning from the reader restores
	// the previous scroll position instead of snapping to the top.

	let prevFolderKey = folderScrollKey(
		get(selectedLibraryId),
		get(currentSubfolder),
		get(currentRemoteFolderId),
	);
	// Key for which we've already performed a scroll restore in this render cycle.
	// Reset to null whenever the folder key changes so a new restore can fire
	// once the new folder's content has loaded.
	let restoredKey: string | null = null;

	// Save outgoing folder's scroll and arm a restore for the incoming folder
	// whenever the folder context changes. Uses $effect.pre so scrollTop is
	// read before the DOM updates — once the new folder's content renders, the
	// browser can clamp scrollTop to the new shorter scrollHeight, which would
	// otherwise lose the user's real position.
	$effect.pre(() => {
		const newKey = folderScrollKey($selectedLibraryId, $currentSubfolder, $currentRemoteFolderId);
		if (newKey === prevFolderKey) return;
		if (scrollContainer) {
			saveFolderScroll(prevFolderKey, captureCurrentCatalogAnchor());
		}
		prevFolderKey = newKey;
		restoredKey = null;
		// Aim the virtual window at the destination immediately: until the
		// anchor restore runs, `catalogScrollTop` still holds the *previous*
		// folder's offset, so the window would slice the new list at the old
		// position for a flush — visible as the wrong rows flashing in.
		catalogScrollTop = getFolderScroll(newKey)?.fallbackTop ?? 0;
	});

	// Scroll to top when filter/sort/search changes *within the same folder*.
	// Gated on `restoredKey === prevFolderKey`: on a folder transition,
	// restoreFolderPrefs loads the new folder's sort prefs which would
	// otherwise trigger this effect and wipe the scroll we're about to
	// restore. Once the folder's restore has run, restoredKey catches up
	// to prevFolderKey and subsequent user-driven filter changes land here.
	let filterScrollInitialized = false;
	$effect(() => {
		$catalogSearchQuery;
		$catalogSearchMode;
		$activeTagFilters;
		$catalogSortField;
		$catalogSortDirection;
		void catalogFilter;
		void translatedSubFilter;
		if (filterScrollInitialized && scrollContainer && restoredKey === prevFolderKey) {
			scrollContainer.scrollTo({ top: 0, behavior: 'instant' });
			// Filter/sort changes invalidate the saved position since the
			// list content has changed — clear so we don't restore to a
			// stale offset on later revisits.
			saveFolderScroll(prevFolderKey, { anchorKey: null, offsetWithinRow: 0, fallbackTop: 0 });
		}
		filterScrollInitialized = true;
	});

	// Restore the saved scroll offset once the folder's content has rendered.
	// Covers both same-session folder navigation and returning from the reader
	// (where CatalogView unmounts and remounts — prevFolderKey/restoredKey
	// re-initialize, so the first run of this effect performs the restore).
	$effect(() => {
		const key = folderScrollKey($selectedLibraryId, $currentSubfolder, $currentRemoteFolderId);
		const hasContent =
			volumes.length > 0 || inlineSubfolders.length > 0 || remoteInlineSubfolders.length > 0;
		if (!scrollContainer || !hasContent || restoredKey === key) return;
		const savedAnchor = getFolderScroll(key);
		restoredKey = key;
		tick().then(() => {
			if (!scrollContainer) return;
			const top = restoreCatalogAnchor(savedAnchor, catalogKeys, catalogColumns, catalogRowHeight);
			scrollContainer.scrollTo({ top, behavior: 'instant' });
			catalogScrollTop = top;
		});
	});

	// Mobile remote hydration is view-owned, while its cache/coalescing and
	// cancellation live in the app-scoped controller.
	let mobileRemoteFetchGeneration = 0;

	function fetchSelectedRemoteFolder(force = false) {
		if (!isMobile) return;
		const folderId = get(currentRemoteFolderId);
		const libId = get(selectedLibraryId);
		if (!libId) return;
		const lib = get(settings).libraries.find((candidate) => candidate.id === libId);
		if (!lib || !isRemoteServerLibrary(lib)) return;

		const providerFolderId = isYACReaderLibrary(lib) ? (folderId ?? '1') : folderId;
		const key = `${libId}:${providerFolderId ?? 'root'}`;
		const generation = ++mobileRemoteFetchGeneration;
		remoteFolderSyncState = { key, loading: true, error: null };
		catalogController.refreshRemoteLocation(lib, folderId, force)
			.then(() => {
				if (generation === mobileRemoteFetchGeneration) {
					remoteFolderSyncState = { key, loading: false, error: null };
				}
			})
			.catch((err) => {
				if ((err as Error)?.name === 'AbortError') return;
				const message = err instanceof Error ? err.message : m.catalog_unable_to_sync_this();
				console.warn(`[CatalogView] Failed to refresh remote folder ${providerFolderId ?? 'root'}:`, err);
				if (generation === mobileRemoteFetchGeneration) {
					remoteFolderSyncState = { key, loading: false, error: message };
				}
			});
	}

	function retrySelectedRemoteFolder() {
		const libId = get(selectedLibraryId);
		const folderId = get(currentRemoteFolderId);
		if (libId) catalogController.invalidateRemoteLocation(libId, folderId);
		fetchSelectedRemoteFolder(true);
	}

	// Depends only on the location and the *identity* of the selected remote
	// library — not on `$settings` as a whole. Reading the full settings store
	// here made every unrelated settings write re-run the effect, which flipped
	// `remoteFolderSyncState.loading` on for a frame before the (deduplicated)
	// refresh short-circuited: a visible flicker on every toggle in Settings.
	let selectedRemoteLibrarySignature = $derived.by(() => {
		const libId = $selectedLibraryId;
		if (!libId) return null;
		const lib = $settings.libraries.find((l) => l.id === libId);
		if (!lib || !isRemoteServerLibrary(lib)) return null;
		// Fields the fetch actually uses; anything else changing must not re-run.
		return `${lib.id}\u0000${lib.type}\u0000${lib.serverUrl}\u0000${'syncMode' in lib ? lib.syncMode : ''}`;
	});
	$effect(() => {
		if (!isMobile) return;
		void $currentRemoteFolderId;
		if (selectedRemoteLibrarySignature === null) {
			mobileRemoteFetchGeneration += 1;
			remoteFolderSyncState = { key: null, loading: false, error: null };
			return;
		}
		fetchSelectedRemoteFolder();
	});

	// Manage thumbnail Blob URLs through per-id requests. Requests started for an
	// overscan window are allowed to finish while scrolling continues; their
	// results are merged only for ids that are still in the current window. This
	// avoids the old whole-window cancellation loop where newly visible cards
	// stayed as pulsing placeholders until the user stopped scrolling.
	type VolumeThumbnailRequest = {
		volume: VolumeMetadata;
		revision: string;
		token: number;
	};
	let thumbnailMediaLocation = '';
	let nextVolumeThumbnailRequestToken = 0;
	let thumbnailMediaRevision = $state(0);
	const volumeThumbnailRequestTokens = new Map<string, number>();
	const volumeThumbnailRequestRevisions = new Map<string, string>();

	function resetThumbnailMediaLocation(location: string): void {
		if (thumbnailMediaLocation === location) return;
		thumbnailMediaLocation = location;
		volumeThumbnailRequestTokens.clear();
		volumeThumbnailRequestRevisions.clear();
		thumbnailUrls = new Map();
	}

	function publishVisibleThumbnailUrls(location: string): void {
		if (thumbnailMediaLocation !== location) return;
		const next = new Map<string, string>();
		for (const volume of visibleVolumes) {
			const url = getThumbnailUrl(volume.volume_uuid)
				?? getThumbnailUrl(
					volume.volume_uuid,
					volume.thumbnail,
					volume.thumbnail ? `embedded:${volumeCoverRevision(volume)}:${volume.thumbnail.size}` : undefined,
				);
			if (url) next.set(volume.volume_uuid, url);
		}
		thumbnailUrls = next;
	}

	function invalidateVisibleVolumeThumbnail(volumeUuid: string): void {
		volumeThumbnailRequestTokens.delete(volumeUuid);
		volumeThumbnailRequestRevisions.delete(volumeUuid);
		thumbnailMediaRevision += 1;
	}

	$effect(() => {
		thumbnailMediaRevision;
		const location = `${$selectedLibraryId ?? '_all'}:${$currentSubfolder}:${$currentRemoteFolderId ?? '_root'}`;
		resetThumbnailMediaLocation(location);
		const visible = visibleVolumes;
		publishVisibleThumbnailUrls(location);
		const visibleIds = new Set(visible.map((volume) => volume.volume_uuid));
		for (const volumeUuid of volumeThumbnailRequestTokens.keys()) {
			if (visibleIds.has(volumeUuid)) continue;
			volumeThumbnailRequestTokens.delete(volumeUuid);
			volumeThumbnailRequestRevisions.delete(volumeUuid);
		}
		const requests: VolumeThumbnailRequest[] = [];
		for (const volume of visible) {
			const revision = volumeCoverRevision(volume);
			if (volumeThumbnailRequestRevisions.get(volume.volume_uuid) === revision) continue;
			const token = ++nextVolumeThumbnailRequestToken;
			volumeThumbnailRequestTokens.set(volume.volume_uuid, token);
			volumeThumbnailRequestRevisions.set(volume.volume_uuid, revision);
			requests.push({ volume, revision, token });
		}
		if (requests.length === 0) return;

		void catalogController.loadThumbnailAssets(requests.map(({ volume }) => volume.volume_uuid)).then((assets) => {
			if (thumbnailMediaLocation !== location) return;
			for (const request of requests) {
				if (volumeThumbnailRequestTokens.get(request.volume.volume_uuid) !== request.token) continue;
				const current = visibleVolumes.find((volume) => volume.volume_uuid === request.volume.volume_uuid);
				if (!current || volumeCoverRevision(current) !== request.revision) continue;
				const asset = assets.get(request.volume.volume_uuid);
				if (asset) {
					getThumbnailUrl(
						request.volume.volume_uuid,
						asset.blob,
						asset.revision,
					);
				} else if (current.thumbnail) {
					getThumbnailUrl(
						request.volume.volume_uuid,
						current.thumbnail,
						`embedded:${request.revision}:${current.thumbnail.size}`,
					);
				}
			}
			publishVisibleThumbnailUrls(location);
		}).catch((error) => {
			if (thumbnailMediaLocation !== location) return;
			for (const request of requests) {
				if (volumeThumbnailRequestTokens.get(request.volume.volume_uuid) !== request.token) continue;
				volumeThumbnailRequestTokens.delete(request.volume.volume_uuid);
				volumeThumbnailRequestRevisions.delete(request.volume.volume_uuid);
			}
			console.debug('[CatalogView] Failed to read visible volume thumbnails:', error);
		});
	});

	// Live queries
	// Android Back closes the topmost catalog dialog before any navigation.
	// Order matters: sub-dialogs first, then modals, then selection mode.
	function closeTopCatalogDialog(): boolean {
		// The handler stays registered for the lifetime of the app now that the
		// view is never torn down, so it must decline while hidden — otherwise
		// Back pressed in the tabs view would close a catalog dialog nobody can
		// see instead of navigating.
		if (get(appView) !== 'catalog') return false;
		if (moveDialogShowNewFolder) { moveDialogShowNewFolder = false; moveDialogNewFolderInput = ''; moveDialogNewFolderError = ''; return true; }
		if (showMoveDialog) { showMoveDialog = false; return true; }
		if (deleteFolderConfirm) { if (!isDeletingFolder) { deleteFolderConfirm = null; deleteFolderError = ''; } return true; }
		if (renameFolderTarget !== null) { if (!isRenamingFolder) { renameFolderTarget = null; renameFolderInput = ''; renameFolderError = ''; } return true; }
		if (showNewFolderDialog) { showNewFolderDialog = false; newFolderInput = ''; newFolderError = ''; return true; }
		if (searchOverlayOpen) { searchOverlayOpen = false; return true; }
		if (libraryMenuOpen) { closeLibraryMenu(); return true; }
		if (sortMenuOpen) { closeSortMenu(); return true; }
		if (deleteSelectedConfirm) { if (!isDeletingSelected) deleteSelectedConfirm = false; return true; }
		if (deleteConfirmVolume) { deleteConfirmVolume = null; return true; }
		if (reviseVolumeTarget) { reviseVolumeTarget = null; return true; }
		if (customTranslationVolume) { customTranslationVolume = null; return true; }
		if (detailsVolume) { detailsVolume = null; return true; }
		if (exportError) { exportError = null; return true; }
		if (selectionMode) { selectionMode = false; selectedVolumeUuids = new Set(); return true; }
		return false;
	}

	onMount(() => {
		catalogDestroyed = false;
		catalogTransientCloseHandler.set(closeTopCatalogDialog);
		const unsubscribeCatalog = catalogController.subscribe((snapshot) => {
			catalogPhase = snapshot.phase;
			catalogLoadError = snapshot.error;
			if (!snapshot.data && (snapshot.phase === 'loading' || snapshot.phase === 'uninitialized')) {
				catalogHasLastGood = false;
				volumes = [];
				projectedLocalSubfolders = [];
				remoteFolders = [];
			}
			if (snapshot.data) {
				catalogHasLastGood = true;
				volumes = snapshot.data.volumes;
				projectedLocalSubfolders = snapshot.data.localSubfolders;
				remoteFolders = snapshot.data.remoteFolders;
				collectionCounts = snapshot.data.collectionCounts;
				// Auto-select library if only one exists, none is selected, and we haven't auto-selected before
				if (
					!hasAutoSelected &&
					!$selectedLibraryId &&
					visibleLibraries.length === 1 &&
					!hasRecoveredDownloads
				) {
					hasAutoSelected = true;
					selectedLibraryId.set(visibleLibraries[0].id);
					currentSubfolder.set('');
				}
			}
		});

		// Job rows feed the store as a liveQuery — creations, checkpoints, and
		// deletions from any path keep the map (and the filters derived from
		// it) live. Persisted translating/reviewing rows that are not actively
		// running here are resumable checkpoints, not failures: keep their
		// status and explain how to resume.
		const stopTranslationJobsFeed = startTranslationJobsFeed({
			annotate: (job) => {
				if (
					(job.status === 'translating' || job.status === 'reviewing' || job.status === 'revising') &&
					!isJobActive(job.volume_uuid) &&
					!isRevisionActive(job.volume_uuid)
				) {
					// Interrupted revisions can't be resumed mid-way — reviseVolume
					// always starts a fresh pass — so don't promise a resume there.
					return {
						...job,
						paused: true,
						activity_message: job.status === 'revising'
							? { code: 'job_activity_interrupted_revise' }
							: { code: 'job_activity_paused' }
					};
				}
				return job;
			}
		});

		return () => {
			catalogDestroyed = true;
			stopTranslationJobsFeed();
			if (get(catalogTransientCloseHandler) === closeTopCatalogDialog) catalogTransientCloseHandler.set(null);
			folderCoverAbortController.abort('catalog view destroyed');
			remoteCoverObserver?.disconnect();
			remoteCoverObserver = null;
			visibleRemoteCoverTargets.clear();
			observedRemoteCoverTargets.clear();
			for (const timer of remoteCoverRetryTimers.values()) clearTimeout(timer);
			remoteCoverRetryTimers.clear();
			// Fallback: persist current scroll on unmount (e.g. entering the
			// reader) in case something unmounted before openVolume's save ran.
			// Gated on `restoredKey === prevFolderKey` — if they differ, a folder
			// transition is mid-flight (see openFromHistory), prevFolderKey was
			// already updated to the destination, and scrollContainer.scrollTop
			// no longer reflects user-driven scroll for that folder. Saving here
			// would clobber any previously-saved position for the destination.
			if (scrollContainer && restoredKey === prevFolderKey) {
				saveFolderScroll(prevFolderKey, captureCurrentCatalogAnchor());
			}
			unsubscribeCatalog();
			// Don't revoke thumbnail URLs — the persistent cache
			// keeps them alive across mount/unmount cycles
		};
	});

	async function openVolume(vol: VolumeMetadata) {
		// Save scroll position so we can restore it when the user comes back.
		// Gated on `restoredKey === prevFolderKey` for the same reason as the
		// unmount fallback: in the openFromHistory path the folder stores
		// mutate before openVolume runs, so by the time we get here scrollTop
		// reflects the destination folder (post-clamp) rather than the source.
		// The source folder's real scroll was already captured by $effect.pre
		// when the stores changed.
		if (scrollContainer && restoredKey === prevFolderKey) {
			saveFolderScroll(prevFolderKey, captureCurrentCatalogAnchor());
		}

		await openReader(vol, 'catalog');
	}

	async function openInNewTab(vol: VolumeMetadata): Promise<void> {
		await createOrFocusTab(vol.volume_uuid);
		queueTabPreview(vol, vol.current_page || 0, 5);
		closeContextMenu();
		if ($settings.switchToNewTabsImmediately) await openReader(vol, 'tabs');
	}

	/** Open a volume from the history bar, navigating to its home folder first */
	async function openFromHistory(vol: VolumeMetadata) {
		currentSubfolder.set(normalizeSubfolderPath(vol.folder_path));
		if (vol.source?.type === 'yacreader' || vol.source?.type === 'komga' || vol.source?.type === 'kavita') {
			currentRemoteFolderId.set(vol.source.remoteFolderId);
		} else {
			currentRemoteFolderId.set(null);
		}
		await openVolume(vol);
	}

	// Context menu handlers

	/** Clamp the context menu so it doesn't extend below the visible viewport. */
	function clampContextMenuPosition() {
		// The mobile menu is a centered modal — no pointer-anchored clamping.
		if (isMobile) return;
		tick().then(() => {
			if (contextMenuEl && contextMenuPosition) {
				const styles = getComputedStyle(document.documentElement);
				const sat = parseFloat(styles.getPropertyValue('--sat') || '0');
				const sab = parseFloat(styles.getPropertyValue('--sab') || '0');
				const sal = parseFloat(styles.getPropertyValue('--sal') || '0');
				const sar = parseFloat(styles.getPropertyValue('--sar') || '0');
				const menuHeight = contextMenuEl.offsetHeight;
				const menuWidth = contextMenuEl.offsetWidth;
				const maxY = window.innerHeight - menuHeight - 8 - sab;
				contextMenuPosition = {
					x: Math.max(8 + sal, Math.min(contextMenuPosition.x, window.innerWidth - menuWidth - 8 - sar)),
					y: Math.max(8 + sat, Math.min(contextMenuPosition.y, maxY))
				};
			}
		});
	}

	function openContextMenuAt(x: number, y: number, vol: VolumeMetadata) {
		// Close any open folder context menu first
		folderContextMenuName = null;
		folderContextMenuPosition = null;

		const clampedX = Math.max(8, Math.min(x, window.innerWidth - 290));
		// Place at click position initially; clampContextMenuPosition will adjust after render
		contextMenuVolume = vol;
		contextMenuPosition = { x: clampedX, y };
		catalogContextMenuOpen.set(true);

		// Async check for translation data (hides option until resolved)
		contextMenuHasTranslations = false;
		volumeHasTranslationData(vol.volume_uuid).then(has => {
			if (contextMenuVolume?.volume_uuid === vol.volume_uuid) {
				contextMenuHasTranslations = has;
				// Re-clamp after new items are added to the menu
				clampContextMenuPosition();
			}
		});

		// Clamp after initial render
		clampContextMenuPosition();
	}

	function openContextMenu(e: MouseEvent, vol: VolumeMetadata) {
		e.stopPropagation();
		e.preventDefault();
		openContextMenuAt(e.clientX, e.clientY, vol);
	}

	// Long-press → context menu, for cards and folders alike. The controller
	// owns the timer, the system-gesture edge refusal and the trailing-tap
	// suppression; see card-long-press.ts for why touchcancel is load-bearing.
	const cardLongPress = createLongPressController<VolumeMetadata>((x, y, vol) =>
		openContextMenuAt(x, y, vol)
	);

	const handleCardTouchStart = (e: TouchEvent, vol: VolumeMetadata) => cardLongPress.start(e, vol);
	const handleCardTouchMove = () => cardLongPress.move();
	const handleCardTouchCancel = () => cardLongPress.cancel();
	const handleCardTouchEnd = (e: TouchEvent) => cardLongPress.end(e);

	function closeContextMenu() {
		contextMenuVolume = null;
		contextMenuPosition = null;
		catalogContextMenuOpen.set(false);
	}

	// ── Folder context menu ───────────────────────────────────

	function openFolderContextMenuAt(x: number, y: number, folderName: string) {
		// Close any open volume context menu first
		contextMenuVolume = null;
		contextMenuPosition = null;

		const clampedX = Math.max(8, Math.min(x, window.innerWidth - 220));
		folderContextMenuName = folderName;
		folderContextMenuPosition = { x: clampedX, y };
		catalogContextMenuOpen.set(true);

		// Clamp after render
		tick().then(() => {
			if (folderContextMenuEl && folderContextMenuPosition) {
				const styles = getComputedStyle(document.documentElement);
				const sat = parseFloat(styles.getPropertyValue('--sat') || '0');
				const sab = parseFloat(styles.getPropertyValue('--sab') || '0');
				const sal = parseFloat(styles.getPropertyValue('--sal') || '0');
				const sar = parseFloat(styles.getPropertyValue('--sar') || '0');
				const menuHeight = folderContextMenuEl.offsetHeight;
				const menuWidth = folderContextMenuEl.offsetWidth;
				const maxY = window.innerHeight - menuHeight - 8 - sab;
				folderContextMenuPosition = {
					x: Math.max(8 + sal, Math.min(folderContextMenuPosition.x, window.innerWidth - menuWidth - 8 - sar)),
					y: Math.max(8 + sat, Math.min(folderContextMenuPosition.y, maxY))
				};
			}
		});
	}

	function openFolderContextMenu(e: MouseEvent, folderName: string) {
		e.stopPropagation();
		e.preventDefault();
		openFolderContextMenuAt(e.clientX, e.clientY, folderName);
	}

	function closeFolderContextMenu() {
		folderContextMenuName = null;
		folderContextMenuPosition = null;
		catalogContextMenuOpen.set(false);
	}

	// Long-press for folder context menu (mobile)
	const folderLongPress = createLongPressController<string>((x, y, folderName) =>
		openFolderContextMenuAt(x, y, folderName)
	);

	const handleFolderTouchStart = (e: TouchEvent, folderName: string) =>
		folderLongPress.start(e, folderName);
	const handleFolderTouchMove = () => folderLongPress.move();
	const handleFolderTouchCancel = () => folderLongPress.cancel();
	const handleFolderTouchEnd = (e: TouchEvent) => folderLongPress.end(e);

	// ── Folder action handlers ────────────────────────────────

	async function handleCreateFolder() {
		const targetId = $selectedLibraryId ?? newFolderTargetLibraryId;
		const lib = $settings.libraries.find(l => l.id === targetId);
		if (!lib || !isLocalLibrary(lib)) return;
		if (!$selectedLibraryId && targetId) rememberLocalTarget(targetId);
		newFolderError = '';
		try {
			await createFolder(lib.path, $selectedLibraryId ? $currentSubfolder : '', newFolderInput.trim());
			showNewFolderDialog = false;
			newFolderInput = '';
			folderRefreshToken.update(n => n + 1);
		} catch (err) {
			newFolderError = err instanceof Error ? err.message : m.catalog_failed_to_create_folder();
		}
	}

	async function handleDeleteFolder(folderName: string) {
		closeFolderContextMenu();
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) return;
		const count = await countVolumesInFolder(lib.id, $currentSubfolder, folderName);
		deleteFolderConfirm = { name: folderName, volumeCount: count };
	}

	async function confirmDeleteFolder() {
		if (!deleteFolderConfirm) return;
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) return;
		isDeletingFolder = true;
		deleteFolderError = '';
		try {
			await deleteFolder(lib.path, lib.id, $currentSubfolder, deleteFolderConfirm.name);
			deleteFolderConfirm = null;
			deleteFolderError = '';
			folderRefreshToken.update(n => n + 1);
		} catch (err) {
			console.error('[CatalogView] Failed to delete folder:', err);
			deleteFolderError = err instanceof Error ? err.message : m.catalog_failed_to_delete_folder();
		} finally {
			isDeletingFolder = false;
		}
	}

	function handleRenameFolder(folderName: string) {
		closeFolderContextMenu();
		renameFolderTarget = folderName;
		renameFolderInput = folderName;
		renameFolderError = '';
	}

	async function confirmRenameFolder() {
		if (!renameFolderTarget || !renameFolderInput.trim() || isRenamingFolder) return;
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) return;
		isRenamingFolder = true;
		renameFolderError = '';
		try {
			await renameFolder(lib.path, lib.id, $currentSubfolder, renameFolderTarget, renameFolderInput.trim());
			renameFolderTarget = null;
			folderRefreshToken.update(n => n + 1);
		} catch (err) {
			renameFolderError = err instanceof Error ? err.message : m.catalog_failed_to_rename_folder();
		} finally {
			isRenamingFolder = false;
		}
	}

	// ── Selection mode ────────────────────────────────────────

	// Auto-exit selection mode when library, subfolder, or library type changes.
	// Compare against the previous values: Svelte stores notify on same-value
	// set() too, and dependency pings without a real navigation were instantly
	// killing selection mode right after it was entered.
	let selectionScope: string | null = null;
	$effect(() => {
		const scope = JSON.stringify([$selectedLibraryId, $currentSubfolder, activeLibraryIsLocal]);
		const changed = selectionScope !== null && selectionScope !== scope;
		selectionScope = scope;
		if (changed) untrack(() => {
			if (!selectionMode) return;
			selectionMode = false;
			selectedVolumeUuids = new Set();
			if (showMoveDialog) {
				showMoveDialog = false;
				moveError = '';
			}
		});
	});

	function toggleVolumeSelection(uuid: string) {
		const next = new Set(selectedVolumeUuids);
		if (next.has(uuid)) next.delete(uuid);
		else next.add(uuid);
		selectedVolumeUuids = next;
	}

	function selectAllVisible() {
		const next = new Set(selectedVolumeUuids);
		for (const vol of filteredVolumes) next.add(vol.volume_uuid);
		selectedVolumeUuids = next;
	}

	function exitSelectionMode() {
		selectionMode = false;
		selectedVolumeUuids = new Set();
	}

	// ── Move dialog ──────────────────────────────────────────

	async function openMoveDialog() {
		moveDialogPath = '';
		moveError = '';
		moveDialogShowNewFolder = false;
		moveDialogNewFolderInput = '';
		moveDialogNewFolderError = '';
		await loadMoveDialogFolders('');
		showMoveDialog = true;
	}

	async function loadMoveDialogFolders(relativePath: string) {
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) { moveDialogFolders = []; return; }

		const dirPath = relativePath ? lib.path + '/' + relativePath : lib.path;
		const fsFolders = await readFilesystemFolders(dirPath);
		const libraryVolumes = volumes.filter(v => v.library_id === $selectedLibraryId);
		const volFolders = deriveSubfoldersFromVolumes(libraryVolumes, relativePath);
		moveDialogFolders = mergeSubfolderSources(volFolders, fsFolders);
	}

	async function moveDialogNavigateTo(folderName: string) {
		moveDialogPath = moveDialogPath ? moveDialogPath + '/' + folderName : folderName;
		moveDialogShowNewFolder = false;
		moveDialogNewFolderInput = '';
		moveDialogNewFolderError = '';
		moveError = '';
		await loadMoveDialogFolders(moveDialogPath);
	}

	async function moveDialogNavigateUp() {
		const parts = moveDialogPath.split('/').filter(Boolean);
		parts.pop();
		moveDialogPath = parts.join('/');
		moveDialogShowNewFolder = false;
		moveDialogNewFolderInput = '';
		moveDialogNewFolderError = '';
		moveError = '';
		await loadMoveDialogFolders(moveDialogPath);
	}

	async function moveDialogNavigateToBreadcrumb(path: string) {
		moveDialogPath = path;
		moveDialogShowNewFolder = false;
		moveDialogNewFolderInput = '';
		moveDialogNewFolderError = '';
		moveError = '';
		await loadMoveDialogFolders(moveDialogPath);
	}

	async function moveDialogCreateFolder() {
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) return;
		moveDialogNewFolderError = '';
		try {
			const created = await createFolder(lib.path, moveDialogPath, moveDialogNewFolderInput.trim());
			moveDialogNewFolderInput = '';
			moveDialogShowNewFolder = false;
			folderRefreshToken.update(n => n + 1);
			await loadMoveDialogFolders(moveDialogPath);
			// Auto-navigate into the newly created folder
			await moveDialogNavigateTo(created);
		} catch (err) {
			moveDialogNewFolderError = err instanceof Error ? err.message : m.catalog_failed_to_create_folder();
		}
	}

	async function confirmMoveVolumes() {
		if (isMovingVolumes || selectedCount === 0) return;
		const lib = $settings.libraries.find(l => l.id === $selectedLibraryId);
		if (!lib || !isLocalLibrary(lib)) return;

		isMovingVolumes = true;
		moveError = '';

		try {
			const result = await moveVolumes(lib.path, lib.id, selectedVolumeUuids, moveDialogPath);

			if (result.failed === 0) {
				// Full success: close everything
				showMoveDialog = false;
				selectionMode = false;
				selectedVolumeUuids = new Set();
				folderRefreshToken.update(n => n + 1);
			} else if (result.moved > 0) {
				// Partial failure: keep dialog open, show only failed volumes
				moveError = m.catalog_moved_moved_failed_failed({ moved: result.moved, failed: result.failed, join: result.errors.join('; ') });
				selectedVolumeUuids = new Set(result.failedUuids);
				folderRefreshToken.update(n => n + 1);
			} else {
				// Complete failure
				moveError = m.catalog_failed_to_move_join({ join: result.errors.join('; ') });
			}
		} catch (err) {
			moveError = err instanceof Error ? err.message : m.catalog_move_failed();
		} finally {
			isMovingVolumes = false;
		}
	}

	function handleEditDetails(vol: VolumeMetadata) {
		closeContextMenu();
		detailsVolume = vol;
	}

	function handleDeleteVolume(vol: VolumeMetadata) {
		closeContextMenu();
		deleteConfirmVolume = vol;
	}

	async function confirmDeleteSelected() {
		if (isDeletingSelected || selectedCount === 0) return;
		isDeletingSelected = true;
		try {
			for (const uuid of [...selectedVolumeUuids]) {
				revokeThumbnailUrl(uuid);
				await deleteVolume(uuid);
			}
			deleteSelectedConfirm = false;
			exitSelectionMode();
		} finally {
			isDeletingSelected = false;
		}
	}

	async function confirmDelete() {
		if (!deleteConfirmVolume) return;
		revokeThumbnailUrl(deleteConfirmVolume.volume_uuid);
		await deleteVolume(deleteConfirmVolume.volume_uuid);
		deleteConfirmVolume = null;
	}

	function handleClearTranslations(vol: VolumeMetadata) {
		closeContextMenu();
		clearTranslationsConfirmVolume = vol;
	}

	async function confirmClearTranslations() {
		if (!clearTranslationsConfirmVolume) return;
		await deleteVolumeTranslations(clearTranslationsConfirmVolume.volume_uuid);
		// Also remove from in-memory translation jobs store
		removeJob(clearTranslationsConfirmVolume.volume_uuid);
		clearTranslationsConfirmVolume = null;
	}

	async function handleExportTranslatedCbz(vol: VolumeMetadata) {
		closeContextMenu();
		const filename = `${sanitizePathSegment(vol.title)} [Translated].cbz`;
		let unregisterCancelHandle: (() => void) | null = null;
		// Hoisted out of the try: an abort or a throw anywhere below must still
		// release the service claim, and a handle declared inside the try is not
		// in scope in the finally.
		let bgBridge: typeof import('$lib/translation/background-service-bridge.js') | null = null;
		let serviceClaimed = false;

		try {
			// Dynamic import to avoid loading dialog plugin eagerly
			const { save } = await import('@tauri-apps/plugin-dialog');
			const savePath = await save({
				title: m.catalog_export_translated_cbz(),
				defaultPath: filename,
				filters: [{ name: m.catalog_comic_book_archive(), extensions: ['cbz'] }]
			});
			if (!savePath) return; // user cancelled

			exportingVolume = vol;
			exportProgress = { current: 0, total: 0 };
			exportError = null;
			const controller = new AbortController();
			exportAbortController = controller;
			// Let the notification's uuid-scoped Cancel reach this export.
			unregisterCancelHandle = registerVolumeCancelHandle(vol.volume_uuid, controller);

			// Start Android background service if available
			try {
				bgBridge = await import('$lib/translation/background-service-bridge.js');
				if (bgBridge.isBackgroundServiceAvailable()) {
					serviceClaimed = bgBridge.startBackgroundTranslation(
						vol.title,
						vol.page_count,
						vol.volume_uuid
					);
					if (!serviceClaimed) bgBridge = null;
				} else {
					bgBridge = null;
				}
			} catch { bgBridge = null; }

			const cbzBlob = await exportTranslatedVolume(
				vol,
				{ format: 'jpeg', quality: 0.92, filename },
				(current, total) => {
					exportProgress = { current, total };
					// The uuid matters: keyed by title this matches no claim, and the
					// notification then republishes the primary volume's numbers.
					bgBridge?.updateTranslationProgress(
						vol.title,
						current,
						total,
						'Exporting',
						vol.volume_uuid
					);
				},
				controller.signal
			);

			// Stream the archive to the chosen save path in chunks instead of
			// materializing the whole file in the JS heap (OOM on long volumes).
			const { open } = await import('@tauri-apps/plugin-fs');
			const file = await open(savePath, { write: true, create: true, truncate: true });
			try {
				const reader = cbzBlob.stream().getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					await file.write(value);
				}
			} finally {
				await file.close();
			}

		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				// User cancelled — expected
			} else {
				console.error('Export failed:', err);
				exportError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			// Release only this export's claim, and release it on every path. The
			// no-argument form clears the whole map, which would stop the service
			// and drop the wake lock out from under a volume translation still
			// running; leaving it inside the try meant a cancel or a failure kept
			// the notification and wake lock alive to the 4h failsafe.
			if (serviceClaimed) bgBridge?.stopBackgroundTranslation(vol.volume_uuid);
			unregisterCancelHandle?.();
			exportingVolume = null;
			exportAbortController = null;
			exportProgress = { current: 0, total: 0 };
		}
	}

	/**
	 * Cancellation used to be recognised by comparing the error's message to one
	 * exact string. It happened to work only because the checkpoint writer throws
	 * a DOMException whose message reads 'Translation cancelled' — every other
	 * layer words it differently, and each of those surfaced the user's own
	 * cancel as a red, persistent error toast. The revision path was the worst:
	 * it re-throws the provider's own `Error('Request cancelled')` unchanged, and
	 * a revision spends nearly all its time inside provider calls, so cancelling
	 * one almost always produced "Request cancelled" in red.
	 */
	function wasCancelled(err: unknown): boolean {
		if (err instanceof Error && err.name === 'AbortError') return true;
		return /\bcancell?ed\b/i.test(err instanceof Error ? err.message : '');
	}

	function cancelExport() {
		exportAbortController?.abort();
	}

	function getListProgressPercent(status: string, currentPage: number, totalPages: number, galleryMode?: boolean): number {
		if (galleryMode || status === 'revising') {
			return totalPages > 0 ? Math.min(100, Math.round((currentPage / totalPages) * 100)) : 0;
		}
		const passWeights: Record<string, number> = { translating: 0, reviewing: 50 };
		const base = passWeights[status] ?? 0;
		const pageProgress = totalPages > 0 ? (currentPage / totalPages) * 50 : 0;
		return Math.min(100, Math.round(base + pageProgress));
	}

	// Concurrent translations are supported: each volume gets its own AbortController
	// in the translation service. This guard only prevents duplicate jobs for the
	// same volume — multiple different volumes can translate in parallel.
	async function handleGetFullTranslation(vol: VolumeMetadata) {
		closeContextMenu();

		const existingJob = getJobForVolume($activeTranslationJobs, vol.volume_uuid);
		if (existingJob && isJobActive(vol.volume_uuid)) {
			return;
		}
		// isJobActive only knows about translations. Revise guards against a
		// running translation but not the reverse, so a translation could start
		// on top of a running revision with both writing page records for the
		// same volume.
		if (isRevisionActive(vol.volume_uuid)) {
			return;
		}

		translationNotification = null;

		try {
			const completedJob = await startVolumeTranslation(vol.volume_uuid);
			if (jobWarningText(completedJob)) {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: jobWarningText(completedJob),
					isError: true
				};
			} else {
				const leftover = completedJob.failed_pages?.length ?? 0;
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: leftover > 0
						? m.catalog_translation_complete_leftover_page({ leftover, s: leftover === 1 ? '' : 's' })
						: m.catalog_translation_complete(),
					isError: false
				};
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : m.job_failed_title();
			if (wasCancelled(err)) {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: m.catalog_translation_cancelled(),
					isError: false
				};
			} else {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message,
					isError: true
				};
			}
		}

		// Auto-dismiss success/cancellation notifications after a delay;
		// error notifications persist until the user starts another action
		if (translationNotification && !translationNotification.isError) {
			const dismissDelay = 5000;
			setTimeout(() => {
				translationNotification = null;
			}, dismissDelay);
		}
	}

	async function handleCustomTranslation(vol: VolumeMetadata, options: VolumeTranslationOptions) {
		customTranslationVolume = null;

		const existingJob = getJobForVolume($activeTranslationJobs, vol.volume_uuid);
		if (existingJob && isJobActive(vol.volume_uuid)) {
			return;
		}
		// isJobActive only knows about translations. Revise guards against a
		// running translation but not the reverse, so a translation could start
		// on top of a running revision with both writing page records for the
		// same volume.
		if (isRevisionActive(vol.volume_uuid)) {
			return;
		}

		translationNotification = null;

		try {
			const completedJob = await startVolumeTranslation(vol.volume_uuid, options);
			if (jobWarningText(completedJob)) {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: jobWarningText(completedJob),
					isError: true
				};
			} else {
				const leftover = completedJob.failed_pages?.length ?? 0;
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: leftover > 0
						? m.catalog_translation_complete_leftover_page({ leftover, s: leftover === 1 ? '' : 's' })
						: m.catalog_translation_complete(),
					isError: false
				};
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : m.job_failed_title();
			if (wasCancelled(err)) {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: m.catalog_translation_cancelled(),
					isError: false
				};
			} else {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message,
					isError: true
				};
			}
		}

		if (translationNotification && !translationNotification.isError) {
			const dismissDelay = 5000;
			setTimeout(() => {
				translationNotification = null;
			}, dismissDelay);
		}
	}

	async function handleReviseVolume(vol: VolumeMetadata, instructions: string) {
		reviseVolumeTarget = null;

		const existingJob = getJobForVolume($activeTranslationJobs, vol.volume_uuid);
		// A 'revising' row left behind by a crash or a kill is not a running
		// revision — isRevisionActive is the live signal. Refusing it made the
		// card's own "run Revise Translation to restart" instruction impossible
		// to follow: the user had to press ✕ first, with nothing saying so.
		const abandonedRevision = existingJob?.status === 'revising'
			&& !isRevisionActive(vol.volume_uuid);
		if (
			existingJob
			&& !abandonedRevision
			&& existingJob.status !== 'completed'
			&& existingJob.status !== 'failed'
			&& existingJob.status !== 'cancelled'
		) {
			return;
		}

		translationNotification = null;

		try {
			const completedJob = await reviseVolume(vol.volume_uuid, instructions);
			if (jobWarningText(completedJob)) {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: jobWarningText(completedJob),
					isError: true
				};
			} else {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: m.catalog_revision_complete(),
					isError: false
				};
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : m.reader_revision_failed();
			if (wasCancelled(err)) {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message: m.catalog_revision_cancelled(),
					isError: false
				};
			} else {
				translationNotification = {
					volumeUuid: vol.volume_uuid,
					message,
					isError: true
				};
			}
		}

		if (translationNotification && !translationNotification.isError) {
			const dismissDelay = 5000;
			setTimeout(() => {
				translationNotification = null;
			}, dismissDelay);
		}
	}

	async function handleToggleFavorite(vol: VolumeMetadata) {
		closeContextMenu();
		const favorited = !vol.favorited_at;
		await setVolumeFavorited(vol.volume_uuid, favorited);
		const stamp = favorited ? new Date().toISOString() : undefined;
		volumes = volumes.map((volume) =>
			volume.volume_uuid === vol.volume_uuid ? { ...volume, favorited_at: stamp } : volume
		);
	}

	async function handleMarkAsTranslated(vol: VolumeMetadata) {
		closeContextMenu();
		const now = new Date().toISOString();
		const syntheticJob: VolumeTranslationJob = {
			id: `manual-${vol.volume_uuid}`,
			volume_uuid: vol.volume_uuid,
			status: 'completed',
			current_page: vol.page_count,
			total_pages: vol.page_count,
			total_prompt_tokens: 0,
			total_completion_tokens: 0,
			started_at: now,
			updated_at: now,
			completed_at: now,
			model: 'manual'
		};
		await db.volume_translation_jobs.put(syntheticJob);
		updateJob(syntheticJob);
	}

	async function handleUnmarkAsTranslated(vol: VolumeMetadata) {
		closeContextMenu();
		const job = getJobForVolume($activeTranslationJobs, vol.volume_uuid);
		if (job) {
			await db.volume_translation_jobs.delete(job.id);
			removeJob(vol.volume_uuid);
		}
	}

	// The selected library's last sync failure, if it is a remote library.
	// Drives the "can't reach server" empty state instead of the misleading
	// "no volumes match" (the catalog renders from local cache, so unreachable
	// servers never produce a load error).
	const selectedRemoteSyncFailure = $derived.by(() => {
		const libraryId = $selectedLibraryId;
		if (!libraryId) return null;
		const failure = $remoteSyncFailures.get(libraryId);
		if (!failure) return null;
		const library = $settings.libraries.find((candidate) => candidate.id === libraryId);
		return library && isRemoteServerLibrary(library) ? failure : null;
	});

	// Library scan/sync — scans local libraries or syncs YACReader libraries
	async function handleScanLibrary() {
		const libs = $selectedLibraryId
			? $settings.libraries.filter((l) => l.id === $selectedLibraryId)
			: $settings.libraries;

		if (libs.length === 0) return;

		isScanning = true;
		scanMessage = null;

		let totalImported = 0;
		let totalFailed = 0;

		try {
			for (const lib of libs) {
				try {
					const prefix = libs.length > 1 ? `[${lib.name}] ` : '';
					const result = await catalogController.syncLibrary(
						lib,
						{ subfolder: $currentSubfolder, remoteFolderId: $currentRemoteFolderId },
						(progress) => { scanMessage = `${prefix}${renderUserMessage(progress.message)}`; },
					);
					if (isRemoteServerLibrary(lib)) reportRemoteSyncSuccess(lib.id);
					totalImported += result.newComicCount;
					totalFailed += result.failureCount;
				} catch (err) {
					if (isRemoteServerLibrary(lib)) reportRemoteSyncFailure(lib.id, err);
					const message = err instanceof Error ? err.message : m.catalog_sync_failed();
					console.warn(`[CatalogView] Scan/Sync failed for ${lib.name}:`, message);
					scanMessage = `${lib.name}: ${renderUserMessage(describeErrorForUser(err).message)}`;
					totalFailed++;
				}
			}

			if (totalImported > 0) {
				scanMessage = m.catalog_imported_totalimported_new_volume({ totalImported, s: totalImported !== 1 ? 's' : '' });
			} else {
				scanMessage = m.catalog_library_is_up_to();
			}

			if (totalFailed > 0) {
				scanMessage += ` (${totalFailed} failed)`;
			}

			setTimeout(() => { scanMessage = null; }, 4000);
		} catch (err) {
			scanMessage = m.catalog_scan_failed_error({ error: err instanceof Error ? err.message : 'Unknown error' });
			setTimeout(() => { scanMessage = null; }, 6000);
		} finally {
			isScanning = false;
		}
	}

	// Validate library paths
	$effect(() => {
		const showWarnings = $settings.showLibraryAccessWarnings;
		const localPaths = $settings.libraries.filter(isLocalLibrary).map((library) => library.path);
		const generation = ++libraryValidationGeneration;

		if (!showWarnings || localPaths.length === 0) {
			libraryPathValid = true;
			return;
		}

		void Promise.all(localPaths.map(validateLibraryPath)).then((results) => {
			if (generation === libraryValidationGeneration) {
				libraryPathValid = results.every(Boolean);
			}
		});
	});

</script>

<!-- Sort fields as glyphs: the toolbar has no room for their words, which the
     sort menu spells out instead. -->
{#snippet sortFieldIcon(icon: string)}
	<svg class="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
		{#if icon === 'calendar'}
			<rect x="2.75" y="4.25" width="14.5" height="13" rx="2" />
			<path d="M2.75 8.25h14.5M6.5 2.75v3M13.5 2.75v3" stroke-linecap="round" />
		{:else if icon === 'clock'}
			<circle cx="10" cy="10" r="7.25" />
			<path d="M10 5.75V10l2.75 2" stroke-linecap="round" stroke-linejoin="round" />
		{:else if icon === 'alphabet'}
			<text x="10" y="13.75" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" stroke="none">A-Z</text>
		{:else}
			<text x="10" y="14.75" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor" stroke="none">#</text>
		{/if}
	</svg>
{/snippet}

<div class="flex h-full flex-col" style="{isMobile ? 'padding-top: var(--sat, 0px); padding-left: var(--sal, 0px); padding-right: var(--sar, 0px)' : ''}">
	<!-- Catalog header -->
	{#if selectionMode}
		<!-- ═══ SELECTION MODE toolbar ═══
		     Four equal actions. Cancel and Select All are filled like Move so they
		     read as pressable rather than as inert labels; Delete is red when it
		     can act. The count moved below, where Recently Read normally sits. -->
		<div class="border-b border-surface-800 {isMobile ? 'px-3 py-2' : 'px-6 py-3'}">
			<div class="flex items-center justify-center gap-2">
				<button
					onclick={exitSelectionMode}
					class="flex min-h-11 max-w-[200px] flex-1 basis-0 items-center justify-center rounded-lg bg-surface-700 px-2 text-xs font-medium text-surface-100 transition-colors active:bg-surface-600 hover:bg-surface-600"
					data-selection-cancel
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={selectAllVisible}
					class="flex min-h-11 max-w-[200px] flex-1 basis-0 items-center justify-center rounded-lg bg-surface-700 px-2 text-xs font-medium text-surface-100 transition-colors active:bg-surface-600 hover:bg-surface-600"
					data-selection-select-all
				>
					{m.catalog_select_all()}
				</button>
				<button
					onclick={openMoveDialog}
					disabled={selectedCount === 0}
					class="flex min-h-11 max-w-[200px] flex-1 basis-0 items-center justify-center rounded-lg bg-primary-600 px-2 text-xs font-medium text-white transition-colors active:bg-primary-700 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
					data-selection-move
				>
					{m.catalog_move()}
				</button>
				<button
					onclick={() => { deleteSelectedConfirm = true; }}
					disabled={selectedCount === 0 || !activeLibraryIsLocal}
					title={activeLibraryIsLocal ? m.catalog_delete_selected_volumes() : m.catalog_remote_libraries_cannot_be()}
					class="flex min-h-11 max-w-[200px] flex-1 basis-0 items-center justify-center rounded-lg bg-red-600 px-2 text-xs font-medium text-white transition-colors active:bg-red-700 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
					data-selection-delete
				>
					{m.settings_models_delete()}
				</button>
			</div>
		</div>
	{:else if isMobile}
		<!-- ═══ MOBILE catalog controls ═══ -->
		<div class="border-b border-surface-800 pb-2" style="padding-left: 8px; padding-right: 12px;">
			{#snippet trailingCluster()}
				<!-- The app bar's trailing controls: sort, view, overflow — three
				     equal 44px tonal circles at every library level. Scan/import/
				     folder/select actions live in the overflow at library level and
				     in the root action row at the top level. -->
				<!-- self-center: the root app bar bottom-aligns its title block,
			     but the circles sit vertically centered in the 60px bar in
			     BOTH library views, at the same pixel. -->
			<div class="flex shrink-0 items-center gap-1.5 self-center" data-catalog-toolbar>
					<button
						type="button"
						onclick={openSortMenu}
						class="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-surface-300 transition-colors active:bg-surface-700 active:text-surface-100"
						title={m.catalog_sort_by_title({ field: activeSortField.label() })}
						aria-haspopup="dialog"
						aria-expanded={sortMenuOpen}
						data-catalog-sort
					>
						{@render sortFieldIcon(activeSortField.icon)}
					</button>
					<button
						type="button"
						onclick={cycleViewMode}
						class="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-surface-300 transition-colors active:bg-surface-700 active:text-surface-100"
						title={viewModeTitle($catalogViewMode)}
						aria-label={m.catalog_view_mode_aria({ mode: viewModeTitle($catalogViewMode) })}
						data-catalog-view-cycle
					>
						{#if $catalogViewMode === 'grid-3'}
							<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
								<rect x="1" y="1" width="6" height="6" rx="1" />
								<rect x="9" y="1" width="6" height="6" rx="1" />
								<rect x="1" y="9" width="6" height="6" rx="1" />
								<rect x="9" y="9" width="6" height="6" rx="1" />
							</svg>
						{:else if $catalogViewMode === 'grid-2'}
							<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
								<rect x="1" y="1" width="6.5" height="14" rx="1" />
								<rect x="8.5" y="1" width="6.5" height="14" rx="1" />
							</svg>
						{:else}
							<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
								<rect x="1" y="1.5" width="14" height="2.5" rx="0.75" />
								<rect x="1" y="6.75" width="14" height="2.5" rx="0.75" />
								<rect x="1" y="12" width="14" height="2.5" rx="0.75" />
							</svg>
						{/if}
					</button>
					<button
						type="button"
						onclick={openLibraryMenu}
						class="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-surface-300 transition-colors active:bg-surface-700 active:text-surface-100"
						title={m.catalog_library_options()}
						aria-haspopup="dialog"
						aria-expanded={libraryMenuOpen}
						data-library-overflow
					>
						<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
					</button>
				</div>
			{/snippet}

			{#if $selectedLibraryId || $currentSubfolder !== '' || $currentRemoteFolderId !== null}
				<!-- Mirrors the reader header's geometry tokens, so the back button
				     sits at the exact same place and size in both views. Reader back
				     x = top-inset-x + the pill's 6px inner padding; the container
				     already pads 8px left, hence the −8px in the calc. -->
				<div
					class="flex h-[var(--reader-top-height)] min-w-0 items-center gap-2"
					style="margin-top: var(--reader-top-gap); padding-left: calc(var(--reader-top-inset-x) + 6px - 8px);"
					data-library-context
				>
					<button type="button" class="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full border border-surface-700 text-surface-100 active:bg-surface-800" onclick={navigateUpFolder} aria-label={m.header_back_to_parent_folder()} data-library-back>
						<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
					</button>
					<div class="min-w-0 flex-1">
						{#if mobileCollectionHeading}
							<h2 class="truncate text-base font-semibold leading-tight text-surface-100" title={mobileCollectionHeading} data-library-name data-user-text>{mobileCollectionHeading}</h2>
						{/if}
						<p class="truncate text-[11px] leading-tight text-surface-500" data-library-volume-count>
						{#if activeLibraryIsRemote}
							{remoteInlineSubfolders.length} folder{remoteInlineSubfolders.length !== 1 ? 's' : ''}, {filteredVolumes.length} volume{filteredVolumes.length !== 1 ? 's' : ''}
						{:else}
							{filteredVolumes.length}{hasActiveFilters ? ` of ${volumes.length}` : ''} volume{filteredVolumes.length !== 1 ? 's' : ''}
						{/if}
						</p>
					</div>
					{@render trailingCluster()}
				</div>
			{:else}
				<!-- All-Libraries root: display header + the one action row. -->
				<div
					class="flex min-w-0 items-end justify-between gap-2 pl-1"
					style="margin-top: var(--reader-top-gap); min-height: var(--reader-top-height);"
					data-library-appbar
				>
					<div class="min-w-0">
						<p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary-400">
							{$settings.libraries.length} librar{$settings.libraries.length === 1 ? 'y' : 'ies'}
						</p>
						<h2 class="truncate text-2xl font-bold tracking-tight text-surface-100">{m.reader_info_library()}</h2>
					</div>
					{@render trailingCluster()}
				</div>
				<!-- py-1 gives this row the same 52px outer box as the filter
			     pill track below-library, so the section's bottom edge (the
			     divider) sits at the same pixel in both library views. -->
			<div class="mt-2 grid grid-cols-3 gap-2 py-1" data-library-actions>
					<button
						onclick={handleScanLibrary}
						disabled={isScanning || $settings.libraries.length === 0}
						class="flex h-11 min-w-0 w-full items-center justify-center whitespace-nowrap rounded-full border border-surface-700 px-1 text-[12px] font-medium transition-colors
							{isScanning ? 'cursor-wait text-surface-500' : $settings.libraries.length === 0 ? 'cursor-not-allowed border-surface-800 text-surface-600' : 'text-surface-300 active:bg-surface-800'}"
					>
						{isScanning
							? (scanTargetsIncludeRemote ? m.catalog_syncing() : m.catalog_scanning())
							: (scanTargetsIncludeRemote ? m.catalog_scan_sync() : m.catalog_scan())}
					</button>
					<button
						onclick={() => importDialogOpen.set(true)}
						disabled={!hasLocalLibrary}
						class="flex h-11 min-w-0 w-full items-center justify-center whitespace-nowrap rounded-full bg-primary-600 px-1 text-[12px] font-medium text-white transition-colors active:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{m.catalog_import()}
					</button>
					<button
						onclick={() => { newFolderTargetLibraryId = defaultLocalTargetId(); showNewFolderDialog = true; }}
						disabled={!hasLocalLibrary}
						class="flex h-11 min-w-0 w-full items-center justify-center whitespace-nowrap rounded-full border border-surface-700 px-1 text-[12px] font-medium text-surface-300 transition-colors active:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{m.catalog_folder()}
					</button>
				</div>
			{/if}
			{#if $selectedLibraryId || $currentSubfolder !== '' || $currentRemoteFolderId !== null}
				<!-- Category filter: five equal pills; Translated reveals its
				     sub-segment with live counts. The green pill is a single
				     sliding indicator (slidingSelection), not a per-button bg. -->
				<div class="relative mt-2 grid grid-cols-5 gap-1 rounded-full bg-surface-container-high p-1" role="radiogroup" aria-label={m.catalog_library_filter()} data-library-filters use:slidingSelection>
					{#each CATALOG_FILTERS as filter (filter.id)}
						<button
							type="button"
							role="radio"
							aria-checked={catalogFilter === filter.id}
							class="press-morph relative flex h-11 min-w-0 items-center justify-center whitespace-normal break-words rounded-full px-0.5 text-[11px] font-semibold leading-tight {catalogFilter === filter.id ? 'text-on-accent-strong' : 'text-surface-400 active:bg-surface-800'}"
							onclick={() => { playReaderHaptic('selection'); catalogFilter = filter.id; }}
						>
							{filter.label()}
						</button>
					{/each}
				</div>
				{#if catalogFilter === 'translated'}
					<div class="relative mt-1.5 grid grid-cols-3 gap-1 rounded-full bg-surface-container-high p-1" role="radiogroup" aria-label={m.catalog_translated_filter()} data-translated-subfilter transition:slide={{ duration: motionDuration(160) }} use:slidingSelection>
						{#each [
							{ id: 'all', label: m.catalog_subfilter_all({ n: translatedCounts.all }) },
							{ id: 'translating', label: m.catalog_subfilter_translating({ n: translatedCounts.translating }) },
							{ id: 'done', label: m.catalog_subfilter_done({ n: translatedCounts.done }) }
						] as const as sub (sub.id)}
							<button
								type="button"
								role="radio"
								aria-checked={translatedSubFilter === sub.id}
								class="press-morph relative flex h-11 min-w-0 items-center justify-center whitespace-normal break-words rounded-full px-0.5 text-[11px] font-semibold leading-tight {translatedSubFilter === sub.id ? 'text-on-accent-strong' : 'text-surface-400 active:bg-surface-800'}"
								onclick={() => { playReaderHaptic('selection'); translatedSubFilter = sub.id; }}
							>
								{sub.label}
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	{:else}
		<!-- ═══ DESKTOP catalog header: single row (unchanged) ═══ -->
		<div class="flex items-center justify-between border-b border-surface-800 px-6 py-3">
			<div>
				{#if currentFolderName}
					<p class="text-xs text-primary-400">📁 {currentFolderName}</p>
				{/if}
				{#if $selectedLibraryId}<p class="text-xs text-surface-500">
					{#if activeLibraryIsRemote}
						{remoteInlineSubfolders.length} folder{remoteInlineSubfolders.length !== 1 ? 's' : ''}, {filteredVolumes.length} volume{filteredVolumes.length !== 1 ? 's' : ''}
					{:else}
						{filteredVolumes.length}{hasActiveFilters ? ` of ${volumes.length}` : ''} volume{filteredVolumes.length !== 1 ? 's' : ''}
					{/if}
				</p>{/if}
			</div>

			<div class="flex items-center gap-3">
				<!-- Sort controls -->
				<div class="flex items-center gap-1">
					<select
						bind:value={$catalogSortField}
						class="rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-xs text-surface-300 focus:border-primary-500 focus:outline-none"
					>
						<option value="created_at">{m.catalog_sort_date_added()}</option>
						<option value="name">{m.catalog_sort_name()}</option>
						<option value="last_read_at">{m.catalog_sort_last_read()}</option>
						<option value="page_count">{m.reader_info_pages()}</option>
					</select>
					<button
						onclick={() => catalogSortDirection.update((d) => d === 'asc' ? 'desc' : 'asc')}
						class="rounded-md border border-surface-700 bg-surface-800 p-1 text-surface-400 transition-colors hover:text-surface-200"
						title={m.catalog_toggle_sort_direction({ direction: $catalogSortDirection })}
					>
						{#if $catalogSortDirection === 'asc'}
							<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clip-rule="evenodd" />
							</svg>
						{:else}
							<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clip-rule="evenodd" />
							</svg>
						{/if}
					</button>
				</div>

				<!-- Search toggle -->
				<button
					onclick={toggleSearchBar}
					class="rounded-md border border-surface-700 bg-surface-800 p-1 transition-colors {showSearchBar ? 'text-primary-400' : 'text-surface-400'} hover:text-surface-200"
					title={showSearchBar ? m.catalog_hide_search_bar() : m.catalog_show_search_bar()}
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
					</svg>
				</button>

				<!-- View mode toggle -->
				<div class="flex items-center gap-0.5 rounded-md border border-surface-700 bg-surface-800 p-0.5">
					<button
						onclick={() => catalogViewMode.set('grid-3')}
						class="rounded p-1 transition-colors {$catalogViewMode !== 'list' ? 'bg-surface-700 text-surface-100' : 'text-surface-500 hover:text-surface-300'}"
						title={m.catalog_view_grid()}
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
							<rect x="1" y="1" width="6" height="6" rx="1" />
							<rect x="9" y="1" width="6" height="6" rx="1" />
							<rect x="1" y="9" width="6" height="6" rx="1" />
							<rect x="9" y="9" width="6" height="6" rx="1" />
						</svg>
					</button>
					<button
						onclick={() => catalogViewMode.set('list')}
						class="rounded p-1 transition-colors {$catalogViewMode === 'list' ? 'bg-surface-700 text-surface-100' : 'text-surface-500 hover:text-surface-300'}"
						title={m.catalog_view_list()}
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
							<rect x="1" y="1.5" width="14" height="2.5" rx="0.75" />
							<rect x="1" y="6.75" width="14" height="2.5" rx="0.75" />
							<rect x="1" y="12" width="14" height="2.5" rx="0.75" />
						</svg>
					</button>
				</div>

				<!-- Scan library button -->
				<button
					onclick={handleScanLibrary}
					disabled={isScanning || $settings.libraries.length === 0 || recoveredDownloadsSelected}
					class="rounded-lg border border-surface-700 px-3 py-1.5 text-xs font-medium transition-colors
						{isScanning ? 'cursor-wait text-surface-500' : $settings.libraries.length === 0 || recoveredDownloadsSelected ? 'cursor-not-allowed border-surface-800 text-surface-600' : 'text-surface-300 hover:border-surface-500 hover:text-surface-100'}"
				>
					{isScanning
						? (scanTargetsIncludeRemote ? m.catalog_syncing() : m.catalog_scanning())
						: scanScopeIsFolder
							? (scanTargetsIncludeRemote ? m.catalog_sync_this_folder() : m.catalog_scan_this_folder())
							: (scanTargetsIncludeRemote ? m.catalog_scan_sync() : m.catalog_scan_library())}
				</button>

				<!-- Select + Folder + Import buttons -->
				{#if activeLibraryIsLocal}
					<button
						onclick={() => { selectionMode = true; selectedVolumeUuids = new Set(); }}
						class="rounded-lg border border-surface-700 px-3 py-1.5 text-xs font-medium text-surface-300 transition-colors hover:border-surface-500 hover:text-surface-100"
					>
						{m.catalog_select()}
					</button>
					<button
						onclick={() => showNewFolderDialog = true}
						class="rounded-lg border border-surface-700 px-3 py-1.5 text-xs font-medium text-surface-300 transition-colors hover:border-surface-500 hover:text-surface-100"
					>
						{m.catalog_folder()}
					</button>
					<button
						onclick={() => importDialogOpen.set(true)}
						class="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
					>
						{m.catalog_import()}
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Library scan status (desktop keeps the inline row; mobile gets the
	     toast via the effect in the script — no layout reflow). -->
	{#if !isMobile && scanMessage}
		<div class="border-b border-surface-800 bg-surface-900 px-6 py-1.5">
			<p class="text-xs text-surface-400">{scanMessage}</p>
		</div>
	{/if}

	<!-- Mobile browse-mode status for the currently selected remote folder
	     (YACReader, Komga, or Kavita — the label follows the library type;
	     this banner used to say "YACReader" for all three). -->
	{#if isMobile && remoteFolderSyncState.key === `${$selectedLibraryId}:${$currentRemoteFolderId ?? '1'}` && (remoteFolderSyncState.loading || remoteFolderSyncState.error)}
		{@const selectedRemoteLib = $settings.libraries.find((l) => l.id === $selectedLibraryId)}
		{@const remoteLabel = selectedRemoteLib && isRemoteServerLibrary(selectedRemoteLib) ? REMOTE_SERVER_TYPE_LABELS[selectedRemoteLib.type] : 'remote'}
		<div class="flex items-center justify-between gap-3 border-b border-surface-800 px-4 py-2 {remoteFolderSyncState.error ? 'bg-red-500/10' : 'bg-surface-900'}" aria-live="polite">
			<p class="text-xs {remoteFolderSyncState.error ? 'text-red-400' : 'text-surface-400'}">
				{remoteFolderSyncState.loading ? m.catalog_syncing_this_remotelabel_folder({ remoteLabel }) : renderUserMessage(describeErrorForUser(remoteFolderSyncState.error).message)}
			</p>
			{#if remoteFolderSyncState.error}
				<button
					type="button"
					onclick={retrySelectedRemoteFolder}
					class="shrink-0 rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors active:bg-red-500/20"
				>
					{m.common_retry()}
				</button>
			{/if}
		</div>
	{/if}

	<!-- Invalid library path warning -->
	{#if $settings.showLibraryAccessWarnings && $settings.libraries.length > 0 && !libraryPathValid}
		<div class="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2" role="status" data-testid="library-access-warning">
			<p class="text-xs text-amber-400">
				{m.catalog_one_or_more_library()}
			</p>
			<button
				type="button"
				onclick={dismissLibraryAccessWarning}
				class="shrink-0 rounded p-1 text-sm leading-none text-amber-400 transition-colors hover:bg-amber-500/10 hover:text-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
				aria-label={m.catalog_dismiss_inaccessible_library_warning()}
				title={m.catalog_dismiss_and_don_t()}
				data-testid="dismiss-library-access-warning"
			>✕</button>
		</div>
	{/if}

	<!-- Translation notification -->
	{#if translationNotification}
		<div class="flex items-center justify-between border-b px-4 py-2 {translationNotification.isError ? 'border-red-500/30 bg-red-500/10' : 'border-green-500/30 bg-green-500/10'}">
			<p class="text-xs {translationNotification.isError ? 'text-red-400' : 'text-green-400'}">
				{translationNotification.message}
			</p>
			{#if translationNotification.isError}
				<button
					onclick={() => translationNotification = null}
					class="ml-2 shrink-0 text-xs text-surface-500 hover:text-surface-300"
					title={m.common_dismiss()}
				>✕</button>
			{/if}
		</div>
	{/if}

	<!-- Search bar (visible when toggled on and library is selected) -->
	{#if !isMobile && showSearchBar && $selectedLibraryId}
		<div class="border-b border-surface-800 px-3 py-2">
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
					</svg>
					<input
						type="text"
						placeholder={m.catalog_search_mode_placeholder({ mode: $catalogSearchMode })}
						bind:value={$catalogSearchQuery}
						class="w-full rounded-lg border border-surface-700 bg-surface-800 py-2 pl-9 pr-9 text-sm text-surface-100 placeholder-surface-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
					/>
					{#if $catalogSearchQuery}
						<button
							class="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300"
							onclick={() => catalogSearchQuery.set('')}
							aria-label={m.catalog_clear_search()}
						>
							<svg class="h-4 w-4" viewBox="0 0 12 12" fill="currentColor">
								<path d="M3.05 3.05a.75.75 0 011.06 0L6 4.94l1.89-1.89a.75.75 0 111.06 1.06L7.06 6l1.89 1.89a.75.75 0 11-1.06 1.06L6 7.06 4.11 8.95a.75.75 0 11-1.06-1.06L4.94 6 3.05 4.11a.75.75 0 010-1.06z" />
							</svg>
						</button>
					{/if}
				</div>
				<!-- Search mode toggle -->
				<button
					onclick={() => catalogSearchMode.update((m) => m === 'comics' ? 'folders' : 'comics')}
					class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-surface-700 bg-surface-800 transition-colors hover:border-surface-500 active:bg-surface-700
						{$catalogSearchMode === 'folders' ? 'text-primary-400' : 'text-surface-400'}"
					title={m.catalog_search_mode_switch_title({ mode: $catalogSearchMode })}
				>
					{#if $catalogSearchMode === 'comics'}
						<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
							<path d="M10.75 16.82A7.462 7.462 0 0115 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0018 15.06V3.94a.75.75 0 00-.546-.721A9.006 9.006 0 0015 3a8.963 8.963 0 00-4.25 1.065V16.82zM9.25 4.065A8.963 8.963 0 005 3c-.85 0-1.673.118-2.454.34A.75.75 0 002 4.06v11.12a.75.75 0 00.954.721A7.506 7.506 0 015 15.5c1.579 0 3.042.487 4.25 1.32V4.065z" />
						</svg>
					{:else}
						<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
							<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
						</svg>
					{/if}
				</button>
			</div>
		</div>
	{/if}

	<!-- Recently Read bar (library root only). While selecting, this slot carries
	     the selection count instead, so the toolbar above stays all-actions. -->
	{#if selectionMode}
		<div class="border-b border-surface-800 px-3 py-2 text-center" data-selection-count>
			<span class="text-sm text-surface-300">{selectedCount} selected</span>
		</div>
	{:else if continueReadingForLibrary}
		<ContinueReadingStrip surface="library" volume={continueReadingForLibrary} onopen={openFromHistory} />
	{/if}

	<!-- Volume grid -->
	<div class="relative flex-1 {isMobile ? 'overflow-hidden' : ''}">
	<!-- While a folder's scroll restore is still pending, scroll events are the
	     browser clamping scrollTop against transitional content heights, not the
	     user — recording them would corrupt the anchor the restore is about to
	     apply and shift the virtual window to the wrong rows. -->
	<div class="overflow-y-auto {isMobile ? 'h-full p-3' : 'h-full p-6'}" style={isMobile ? 'padding-bottom: calc(var(--app-bottom-clearance) + 12px);' : ''} bind:this={scrollContainer} onscroll={(event) => { if (restoredKey === prevFolderKey) catalogScrollTop = event.currentTarget.scrollTop; }} data-catalog-scroll>
		{#if catalogLoadError && catalogHasLastGood}
			<div class="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2" role="status">
				<p class="min-w-0 truncate text-xs text-amber-300">{m.catalog_refresh_failed({ message: renderUserMessage(describeErrorForUser(catalogLoadError).message) })}</p>
				<button type="button" class="shrink-0 text-xs font-semibold text-amber-200" onclick={() => catalogController.refresh()}>{m.common_retry()}</button>
			</div>
		{/if}
		{#if catalogColdLoading}
			<div class="flex h-full items-center justify-center text-sm text-surface-400" role="status" aria-busy="true" data-catalog-loading>{m.reader_loading()}</div>
		{:else if catalogPhase === 'error' && !catalogHasLastGood}
			{@const friendlyLoadError = describeErrorForUser(catalogLoadError)}
			<div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
				<p class="text-sm text-red-300">{m.catalog_could_not_load_library({ message: renderUserMessage(friendlyLoadError.message) })}</p>
				{#if friendlyLoadError.detail && friendlyLoadError.detail !== renderUserMessage(friendlyLoadError.message)}
					<p class="allow-select max-w-full break-words text-[10px] text-surface-600">{friendlyLoadError.detail}</p>
				{/if}
				<button type="button" class="rounded-lg border border-surface-600 px-4 py-2 text-sm text-surface-200" onclick={() => catalogController.refresh()}>{m.common_retry()}</button>
			</div>
		{:else if !$selectedLibraryId && visibleCollectionCount > 0}
			<!-- All Libraries panel view -->
			<div class="grid grid-cols-2 gap-3 landscape:grid-cols-4 sm:grid-cols-3 sm:gap-4 md:grid-cols-4">
				{#if hasRecoveredDownloads}
					<button
						class="group flex flex-col items-center overflow-hidden rounded-xl border border-surface-700 bg-surface-800/40 transition-all hover:border-primary-500/50 hover:bg-surface-800/70 active:scale-[0.98]"
						onclick={() => {
							selectedLibraryId.set(RECOVERED_DOWNLOADS_COLLECTION_ID);
							currentSubfolder.set('');
							currentRemoteFolderId.set(null);
						}}
					>
						<!-- Header with the library name on a thin strip along its top -->
						<div class="relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-surface-800/50">
							<svg class="h-12 w-12 text-primary-400 transition-colors group-hover:text-primary-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 8.25h15m-13.5 0 1.1-3.3A1.5 1.5 0 018.52 3.9h6.96a1.5 1.5 0 011.42 1.05l1.1 3.3m-12 0v10.35A1.4 1.4 0 007.4 20h9.2a1.4 1.4 0 001.4-1.4V8.25M9 12h6" />
							</svg>
							<div class="absolute inset-x-0 top-0 bg-surface-950/80 px-1.5 py-1 backdrop-blur-[2px]" data-library-title-strip>
								<p class="truncate text-[11px] font-medium leading-tight text-surface-100 group-hover:text-white">{m.catalog_recovered_downloads()}</p>
							</div>
						</div>
						<div class="w-full px-3 py-2.5 text-left">
							<p class="text-xs text-surface-500">{recoveredDownloadCount} volume{recoveredDownloadCount !== 1 ? 's' : ''}</p>
							<p class="mt-0.5 truncate text-[10px] text-surface-500">{m.catalog_stored_on_this_device()}</p>
						</div>
					</button>
				{/if}
				{#each visibleLibraries as lib (lib.id)}
					{@const libVolCount = collectionCounts[lib.id] ?? 0}
					<button
						class="group flex flex-col items-center overflow-hidden rounded-xl border border-surface-700 bg-surface-800/40 transition-all hover:border-primary-500/50 hover:bg-surface-800/70 active:scale-[0.98]"
						onclick={() => {
							selectedLibraryId.set(lib.id);
							currentSubfolder.set('');
							currentRemoteFolderId.set(null);
						}}
					>
						<!-- Header with the library name on a thin strip along its top -->
						<div class="relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-surface-800/50">
							<svg class="h-12 w-12 text-primary-400 transition-colors group-hover:text-primary-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z" />
							</svg>
							<div class="absolute inset-x-0 top-0 bg-surface-950/80 px-1.5 py-1 backdrop-blur-[2px]" data-library-title-strip>
								<p class="truncate text-[11px] font-medium leading-tight text-surface-100 group-hover:text-white">{lib.name}</p>
							</div>
						</div>
						<div class="w-full px-3 py-2.5 text-left">
							<p class="text-xs text-surface-500">{libVolCount} volume{libVolCount !== 1 ? 's' : ''}</p>
							<p class="mt-0.5 truncate text-[10px] text-surface-500">
								{isLocalLibrary(lib) ? lib.path : isRemoteServerLibrary(lib) ? lib.serverUrl : ''}
							</p>
						</div>
					</button>
				{/each}
			</div>
		{:else if catalogPhase === 'ready' && volumes.length === 0 && visibleLibraries.length === 0}
			<div class="flex h-full flex-col items-center justify-center text-center">
				<p class="mb-2 text-4xl">📖</p>
				<p class="mb-1 text-lg text-surface-300">{m.catalog_no_manga_imported_yet()}</p>
				<p class="mb-4 text-sm text-surface-500">
					{m.catalog_import_a_zip_cbz()}
				</p>
				<button
					onclick={() => importDialogOpen.set(true)}
					class="rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700"
				>
					{m.import_title()}
				</button>
			</div>
		{:else if catalogPhase === 'ready' && filteredVolumes.length === 0 && inlineSubfolders.length === 0 && remoteInlineSubfolders.length === 0 && selectedRemoteSyncFailure}
			{@const friendlySyncError = describeErrorForUser(selectedRemoteSyncFailure.error)}
			<div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
				<p class="mb-1 text-4xl">📡</p>
				<p class="text-sm text-surface-300">{renderUserMessage(friendlySyncError.message)}</p>
				{#if friendlySyncError.detail && friendlySyncError.detail !== renderUserMessage(friendlySyncError.message)}
					<p class="allow-select max-w-full break-words text-[10px] text-surface-600">{friendlySyncError.detail}</p>
				{/if}
				<button
					type="button"
					onclick={handleScanLibrary}
					disabled={isScanning}
					class="mt-2 rounded-lg border border-surface-600 px-4 py-2 text-sm text-surface-200 transition-colors active:bg-surface-700 disabled:opacity-50"
				>{isScanning ? m.catalog_retrying() : m.catalog_retry_sync()}</button>
			</div>
		{:else if catalogPhase === 'ready' && filteredVolumes.length === 0 && inlineSubfolders.length === 0 && remoteInlineSubfolders.length === 0}
			<div class="flex h-full flex-col items-center justify-center px-6 text-center" data-catalog-empty>
				{#if hasNarrowingFilters}
					<p class="mb-1 text-sm text-surface-400">{m.catalog_no_volumes_match_the()}</p>
					<button
						onclick={() => {
							catalogFilter = 'all';
							translatedSubFilter = 'all';
							selectedLibraryId.set(null);
							currentSubfolder.set('');
							catalogSearchQuery.set('');
							activeTagFilters.set([]);
						}}
						class="text-xs text-primary-400 transition-colors hover:text-primary-300"
					>{m.catalog_clear_all_filters()}</button>
				{:else}
					<!-- Nothing is filtered — this library is simply empty. Offer the
					     way forward rather than a Clear-filters button that does
					     nothing the user can perceive. -->
					<p class="mb-2 text-4xl">📖</p>
					<p class="mb-1 text-lg text-surface-300">{m.catalog_this_library_is_empty()}</p>
					<p class="mb-4 text-sm text-surface-500">
						{m.catalog_empty_import_hint({ others: $selectedLibraryId !== null && visibleLibraries.length > 1 ? 'yes' : 'no' })}
					</p>
					<div class="flex flex-wrap items-center justify-center gap-2">
						<button
							onclick={() => importDialogOpen.set(true)}
							data-catalog-empty-import
							class="rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700"
						>{m.import_title()}</button>
						{#if $selectedLibraryId !== null && visibleLibraries.length > 1}
							<button
								onclick={() => { selectedLibraryId.set(null); currentSubfolder.set(''); }}
								data-catalog-empty-all-libraries
								class="rounded-lg border border-surface-600 px-4 py-2.5 text-sm text-surface-200 transition-colors active:bg-surface-700"
							>{m.catalog_all_libraries_button()}</button>
						{/if}
					</div>
				{/if}
			</div>
			{:else if $catalogViewMode === 'list'}
				<!-- List view -->
				<div style="height: {catalogWindow.topSpacer}px" aria-hidden="true"></div>
				<div class="flex flex-col gap-1">
				{#each visibleLocalSubfolders as folder (folder)}
					{@const listLocalCoverUrl = localFolderCoverUrls.get(folder)}
					<div
						use:measureCatalogRow
						class="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors hover:bg-surface-800/60"
						role="button"
						tabindex="0"
						onclick={() => { if (folderLongPress.triggered) return; currentSubfolder.set($currentSubfolder ? $currentSubfolder + '/' + folder : folder); }}
						onkeydown={(e) => {
							if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
							e.preventDefault();
							currentSubfolder.set($currentSubfolder ? $currentSubfolder + '/' + folder : folder);
						}}
						oncontextmenu={activeLibraryIsLocal && !selectionMode ? (e) => openFolderContextMenu(e, folder) : undefined}
						ontouchstart={activeLibraryIsLocal && !selectionMode ? (e) => handleFolderTouchStart(e, folder) : undefined}
						ontouchmove={activeLibraryIsLocal && !selectionMode ? handleFolderTouchMove : undefined}
						ontouchend={activeLibraryIsLocal && !selectionMode ? handleFolderTouchEnd : undefined}
						ontouchcancel={activeLibraryIsLocal && !selectionMode ? handleFolderTouchCancel : undefined}
					>
						{#if listLocalCoverUrl}
							<img src={listLocalCoverUrl} alt="" class="h-8 w-6 shrink-0 rounded object-cover" use:fadeOnDecode />
						{:else}
							<svg class="h-5 w-5 shrink-0 text-primary-400" viewBox="0 0 20 20" fill="currentColor">
								<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
							</svg>
						{/if}
						<p class="min-w-0 flex-1 truncate text-sm font-medium text-surface-200 group-hover:text-surface-100">
							{folder}
						</p>
						{#if activeLibraryIsLocal && !selectionMode}
							<button
								class="flex shrink-0 items-center justify-center rounded-full text-surface-500 transition-opacity {isMobile ? 'min-h-11 min-w-11 opacity-100 active:bg-surface-700 active:text-surface-300' : 'pointer-events-none p-1 opacity-0 hover:bg-surface-700 hover:text-surface-300 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'}"
								onclick={(e) => { e.stopPropagation(); openFolderContextMenuAt(e.clientX, e.clientY, folder); }}
								title={m.help_fig_more_options()}
							>
								<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
									<circle cx="8" cy="3" r="1.5" />
									<circle cx="8" cy="8" r="1.5" />
									<circle cx="8" cy="13" r="1.5" />
								</svg>
							</button>
						{/if}
						<svg class="h-4 w-4 shrink-0 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
						</svg>
					</div>
				{/each}
				{#each visibleRemoteSubfolders as folder (folder.id)}
					{@const listCoverUrl = folderCoverUrls.get(folder.id)}
					<button
						type="button"
						use:measureCatalogRow
						use:observeRemoteCover={{ kind: 'folder', id: folder.id, revision: folderCoverRevision(folder) }}
						data-catalog-item-key={`folder:${folder.id}`}
						class="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors hover:bg-surface-800/60"
						onclick={() => currentRemoteFolderId.set(folder.remoteFolderId)}
					>
						{#if listCoverUrl}
							<img src={listCoverUrl} alt="" class="h-8 w-6 shrink-0 rounded object-cover" data-catalog-thumbnail use:fadeOnDecode />
						{:else}
							<svg class="h-5 w-5 shrink-0 text-primary-400" viewBox="0 0 20 20" fill="currentColor">
								<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
							</svg>
						{/if}
						<p class="min-w-0 flex-1 truncate text-sm font-medium text-surface-200 group-hover:text-surface-100">
							{folder.name}
						</p>
						{#if folder.numChildren > 0}
							<span class="text-xs text-surface-600">{folder.numChildren}</span>
						{/if}
						<svg class="h-4 w-4 shrink-0 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
						</svg>
					</button>
				{/each}
				{#each visibleVolumes as vol (vol.volume_uuid)}
					{@const listJob = getJobForVolume($activeTranslationJobs, vol.volume_uuid)}
					{@const listSelected = selectionMode && selectedVolumeUuids.has(vol.volume_uuid)}
					<div
						use:observeRemoteCover={{ kind: 'volume', id: vol.volume_uuid, revision: volumeCoverRevision(vol) }}
						data-catalog-item-key={`volume:${vol.volume_uuid}`}
						use:measureCatalogRow
						class="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors hover:bg-surface-800/60 {listSelected ? 'bg-primary-600/10' : ''}"
						role="button"
						tabindex="0"
						onclick={() => selectionMode ? toggleVolumeSelection(vol.volume_uuid) : openVolume(vol)}
						onkeydown={(e) => {
							if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
							e.preventDefault();
							selectionMode ? toggleVolumeSelection(vol.volume_uuid) : openVolume(vol);
						}}
						ontouchstart={selectionMode ? undefined : (e) => handleCardTouchStart(e, vol)}
						ontouchmove={selectionMode ? undefined : handleCardTouchMove}
						ontouchend={selectionMode ? undefined : handleCardTouchEnd}
						ontouchcancel={selectionMode ? undefined : handleCardTouchCancel}
					>
						{#if selectionMode}
							<div class="flex h-5 w-5 shrink-0 items-center justify-center rounded {listSelected ? 'bg-primary-500' : 'border border-surface-500'}">
								{#if listSelected}
									<svg class="h-3 w-3 text-white" viewBox="0 0 12 12" fill="currentColor">
										<path d="M10.28 2.28a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-1.06 0l-2.5-2.5a.75.75 0 011.06-1.06L4.5 7.56l4.97-4.97a.75.75 0 011.06-.25z" />
									</svg>
								{/if}
							</div>
						{/if}
						<div class="relative h-[68px] w-[48px] shrink-0 overflow-hidden rounded bg-surface-800" data-catalog-list-thumb>
							{#if thumbnailUrls.get(vol.volume_uuid)}
								<img src={thumbnailUrls.get(vol.volume_uuid)} alt="" class="h-full w-full object-cover" use:fadeOnDecode />
							{/if}
							{#if vol.current_page > 0 && vol.page_count > 0}
								<div class="absolute bottom-0 left-0 h-[3px] bg-primary-500" style="width: {Math.min(100, Math.round(((vol.current_page + 1) / vol.page_count) * 100))}%"></div>
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium text-surface-200 group-hover:text-surface-100">
								{vol.title}
							</p>
							<p class="truncate text-[11px] text-surface-500">
								{vol.current_page > 0 ? m.catalog_page_current_page_of({ current_page: vol.current_page + 1, page_count: vol.page_count }) : `${vol.page_count} pages`}
							</p>
						</div>
						{#if vol.author}
							<span class="hidden shrink-0 text-xs text-surface-400 sm:inline">{vol.author}</span>
						{/if}
						<span class="shrink-0 text-xs text-surface-500">{vol.page_count}p</span>
						{#if listJob && listJob.status !== 'completed' && listJob.status !== 'failed' && listJob.status !== 'cancelled'}
							{#if listJob.paused}
								<span
									class="shrink-0 rounded bg-amber-600/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
									title={renderUserMessage(listJob.activity_message ?? listJob.activity) || m.job_paused_resume_hint()}
								>
									{m.job_badge_paused()}
								</span>
							{:else}
								<span
									class="shrink-0 rounded bg-primary-600/20 px-1.5 py-0.5 text-[10px] font-medium text-primary-400"
									title={renderUserMessage(listJob.activity_message ?? listJob.activity)}
								>
									{Math.round(getListProgressPercent(listJob.status, listJob.current_page, listJob.total_pages, listJob.gallery_mode))}%
								</span>
							{/if}
						{:else if listJob?.status === 'completed'}
							<span class="shrink-0 rounded bg-green-600/20 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
								{m.catalog_filter_translated()}
							</span>
						{:else if listJob?.status === 'failed'}
							<span
								class="shrink-0 rounded bg-red-600/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400"
								title={listJob.error || m.job_failed_title()}
							>
								{m.job_badge_failed()}
							</span>
						{:else if listJob?.status === 'cancelled'}
							<span class="shrink-0 rounded bg-surface-600/20 px-1.5 py-0.5 text-[10px] font-medium text-surface-400">
								{m.job_badge_cancelled()}
							</span>
						{/if}
						{#if !selectionMode}
							<button
								class="flex shrink-0 items-center justify-center rounded-full text-surface-500 transition-opacity {isMobile ? 'min-h-11 min-w-11 opacity-100 active:bg-surface-700 active:text-surface-300' : 'pointer-events-none p-1 opacity-0 hover:bg-surface-700 hover:text-surface-300 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'}"
								onclick={(e) => { e.stopPropagation(); openContextMenu(e, vol); }}
								title={m.help_fig_more_options()}
							>
								<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
									<circle cx="8" cy="3" r="1.5" />
									<circle cx="8" cy="8" r="1.5" />
									<circle cx="8" cy="13" r="1.5" />
								</svg>
							</button>
						{/if}
					</div>
				{/each}
				</div>
				<div style="height: {catalogWindow.bottomSpacer}px" aria-hidden="true"></div>
			{:else}
				<!-- Grid view -->
				<div style="height: {catalogWindow.topSpacer}px" aria-hidden="true"></div>
				<div class="grid gap-2 sm:gap-4 {$catalogViewMode === 'grid-2' ? 'grid-cols-2 landscape:grid-cols-4' : 'grid-cols-3 landscape:grid-cols-5'} sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
				{#each visibleLocalSubfolders as folder (folder)}
					{@const localCoverUrl = localFolderCoverUrls.get(folder)}
					<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
					<div
						use:measureCatalogRow
						class="group relative flex flex-col items-center justify-center rounded-lg border border-surface-800 bg-surface-800/30 transition-all hover:border-primary-500/50 hover:bg-surface-800/60"
						oncontextmenu={activeLibraryIsLocal && !selectionMode ? (e) => openFolderContextMenu(e, folder) : undefined}
						ontouchstart={activeLibraryIsLocal && !selectionMode ? (e) => handleFolderTouchStart(e, folder) : undefined}
						ontouchmove={activeLibraryIsLocal && !selectionMode ? handleFolderTouchMove : undefined}
						ontouchend={activeLibraryIsLocal && !selectionMode ? handleFolderTouchEnd : undefined}
						ontouchcancel={activeLibraryIsLocal && !selectionMode ? handleFolderTouchCancel : undefined}
					>
					<button
							class="flex w-full flex-1 flex-col"
							onclick={() => { if (folderLongPress.triggered) return; currentSubfolder.set($currentSubfolder ? $currentSubfolder + '/' + folder : folder); }}
						>
							<div class="relative aspect-[2/3] w-full flex-none overflow-hidden rounded-[7px] bg-surface-800/40">
								{#if localCoverUrl}
									<img
										src={localCoverUrl}
										alt={folder}
										class="h-full w-full object-cover"
									/>
								{:else}
									<div class="flex h-full w-full flex-col items-center justify-center gap-2">
										<svg class="h-12 w-12 text-primary-400 transition-colors group-hover:text-primary-300" viewBox="0 0 20 20" fill="currentColor">
											<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
										</svg>
									</div>
								{/if}
								<div class="absolute inset-x-0 top-0 bg-surface-950/80 px-1.5 py-1 backdrop-blur-[2px]" data-catalog-title-strip data-user-text>
									<p class="truncate text-[11px] font-medium leading-tight text-surface-100 group-hover:text-white">{folder}</p>
								</div>
							</div>
						</button>
						{#if activeLibraryIsLocal && !selectionMode}
							<button
								class="absolute -bottom-px -right-px flex h-8 w-8 items-center justify-center rounded-br-lg rounded-tl-lg border-l border-t border-surface-600/70 bg-surface-900/85 text-surface-300 backdrop-blur-sm transition-opacity active:bg-surface-700 before:absolute before:-left-3 before:-top-3 before:bottom-0 before:right-0 before:content-[''] {isMobile ? 'opacity-100' : 'pointer-events-none opacity-0 hover:bg-surface-800 hover:text-surface-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'}"
								onclick={(e) => { e.stopPropagation(); openFolderContextMenuAt(e.clientX, e.clientY, folder); }}
								aria-label={m.catalog_more_options_for({ name: folder })}
								title={m.help_fig_more_options()}
							>
								<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
									<circle cx="8" cy="3.25" r="1.25" />
									<circle cx="8" cy="8" r="1.25" />
									<circle cx="8" cy="12.75" r="1.25" />
								</svg>
							</button>
						{/if}
					</div>
				{/each}
				{#each visibleRemoteSubfolders as folder (folder.id)}
					{@const coverUrl = folderCoverUrls.get(folder.id)}
					<button
						use:observeRemoteCover={{ kind: 'folder', id: folder.id, revision: folderCoverRevision(folder) }}
						data-catalog-item-key={`folder:${folder.id}`}
						use:measureCatalogRow
						class="group flex flex-col items-center justify-center overflow-hidden rounded-lg border border-surface-800 bg-surface-800/30 transition-all hover:border-primary-500/50 hover:bg-surface-800/60"
						onclick={() => currentRemoteFolderId.set(folder.remoteFolderId)}
					>
						{#if coverUrl}
							<div class="relative aspect-[2/3] w-full flex-none overflow-hidden bg-surface-800">
								<div class="absolute inset-x-0 top-0 z-10 bg-surface-950/80 px-1.5 py-1 backdrop-blur-[2px]" data-catalog-title-strip data-user-text>
									<p class="truncate text-[11px] font-medium leading-tight text-surface-100 group-hover:text-white">{folder.name}</p>
								</div>
								<img
									src={coverUrl}
									alt={folder.name}
									class="h-full w-full object-cover"
									data-catalog-thumbnail
								/>
							</div>
						{:else}
							<div class="relative aspect-[2/3] w-full flex-none">
								<div class="flex h-full w-full flex-col items-center justify-center gap-2">
									<svg class="h-12 w-12 text-primary-400 transition-colors group-hover:text-primary-300" viewBox="0 0 20 20" fill="currentColor">
										<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
									</svg>
								</div>
								<div class="absolute inset-x-0 top-0 bg-surface-950/80 px-1.5 py-1 backdrop-blur-[2px]" data-catalog-title-strip data-user-text>
									<p class="truncate text-[11px] font-medium leading-tight text-surface-100 group-hover:text-white">{folder.name}</p>
								</div>
							</div>
						{/if}
					</button>
				{/each}
				{#each visibleVolumes as vol (vol.volume_uuid)}
					{@const gridSelected = selectionMode && selectedVolumeUuids.has(vol.volume_uuid)}
					<div
						use:observeRemoteCover={{ kind: 'volume', id: vol.volume_uuid, revision: volumeCoverRevision(vol) }}
						data-catalog-item-key={`volume:${vol.volume_uuid}`}
						use:measureCatalogRow
						class="group relative flex flex-col rounded-lg border transition-all hover:bg-surface-800/60 {gridSelected ? 'border-primary-500 bg-primary-600/10' : 'border-surface-800 bg-surface-800/30 hover:border-primary-500/50'}"
						role="group"
						aria-label={vol.title}
						ontouchstart={selectionMode ? undefined : (e) => handleCardTouchStart(e, vol)}
						ontouchmove={selectionMode ? undefined : handleCardTouchMove}
						ontouchend={selectionMode ? undefined : handleCardTouchEnd}
						ontouchcancel={selectionMode ? undefined : handleCardTouchCancel}
					>
						{#if selectionMode}
							<!-- Selection checkbox overlay (below the title strip) -->
							<div class="absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full {gridSelected ? 'bg-primary-500' : 'border-2 border-surface-400 bg-surface-900/70'}">
								{#if gridSelected}
									<svg class="h-3.5 w-3.5 text-white" viewBox="0 0 12 12" fill="currentColor">
										<path d="M10.28 2.28a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-1.06 0l-2.5-2.5a.75.75 0 011.06-1.06L4.5 7.56l4.97-4.97a.75.75 0 011.06-.25z" />
									</svg>
								{/if}
							</div>
						{/if}
						<!-- Clickable area -->
						<button
							class="flex flex-1 flex-col text-left"
							onclick={() => selectionMode ? toggleVolumeSelection(vol.volume_uuid) : openVolume(vol)}
						>
							<!-- Cover. Both grid modes pin the title to a top strip,
							     mirroring the folder cards, so the bottom-right ⋮ chip and
							     the translation overlay never crowd it; a bottom progress
							     edge appears once reading starts. The cover rounds itself
							     (radius minus the 1px border) because the card no longer
							     clips children — the corner chip must cover the border. -->
							<div class="relative aspect-[2/3] w-full flex-none overflow-hidden rounded-[7px] bg-surface-800">
								{#if thumbnailUrls.get(vol.volume_uuid)}
									<img
										src={thumbnailUrls.get(vol.volume_uuid)}
										alt={vol.title}
										class="h-full w-full object-cover"
										data-catalog-thumbnail
										use:fadeOnDecode
									/>
								{:else}
									<div class="flex h-full animate-pulse items-center justify-center bg-surface-700/50" data-catalog-thumbnail-fallback>
										<div class="h-8 w-8 rounded-full bg-surface-600/50"></div>
									</div>
								{/if}
								<div class="absolute inset-x-0 top-0 bg-surface-950/80 px-1.5 py-1 backdrop-blur-[2px] {selectionMode ? 'pl-9' : ''}" data-catalog-title-strip data-user-text>
									<p class="truncate text-[11px] font-semibold leading-tight text-surface-100">
										{vol.title}
									</p>
									<p class="truncate text-[9px] text-surface-300">
										{vol.page_count}p · {effectiveReadingDirection(vol, $settings).toUpperCase()}{#if vol.author}&nbsp;· {vol.author}{/if}
									</p>
								</div>
								{#if vol.current_page > 0 && vol.page_count > 0}
									<div class="absolute bottom-0 left-0 h-[3px] bg-primary-500" style="width: {Math.min(100, Math.round(((vol.current_page + 1) / vol.page_count) * 100))}%" data-catalog-progress-edge></div>
								{/if}
							</div>
						</button>

						<!-- Three-dot menu button (hidden in selection mode) -->
						{#if !selectionMode}
							<button
								class="absolute -bottom-px -right-px flex h-8 w-8 items-center justify-center rounded-br-lg rounded-tl-lg border-l border-t border-surface-600/70 bg-surface-900/85 text-surface-300 backdrop-blur-sm transition-opacity active:bg-surface-700 before:absolute before:-left-3 before:-top-3 before:bottom-0 before:right-0 before:content-[''] {isMobile ? 'opacity-100' : 'pointer-events-none opacity-0 hover:bg-surface-800 hover:text-surface-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'}"
								onclick={(e) => openContextMenu(e, vol)}
								data-volume-menu-trigger
								aria-label={m.catalog_more_options_for({ name: vol.title })}
								title={m.help_fig_more_options()}
							>
								<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
									<circle cx="8" cy="3.25" r="1.25" />
									<circle cx="8" cy="8" r="1.25" />
									<circle cx="8" cy="12.75" r="1.25" />
								</svg>
							</button>
						{/if}

						<!-- Translation progress overlay (reactive child component).
						     Resume routes through handleGetFullTranslation so the
						     duplicate-job guard and notifications are shared. -->
						<TranslationProgress volumeUuid={vol.volume_uuid} onresume={() => handleGetFullTranslation(vol)} />
					</div>
				{/each}
			</div>
			<div style="height: {catalogWindow.bottomSpacer}px" aria-hidden="true"></div>
		{/if}
	</div>
	{#if isMobile && !selectionMode && showSearchBar}
		<!-- Floating search: tonal 54px button above the dock, never
		     scroll-hidden; opens the full-screen subtree search. -->
		<button
			type="button"
			class="press-morph fixed z-30 flex h-[54px] w-[54px] items-center justify-center rounded-[18px] bg-surface-container-high text-primary-300 shadow-dock active:bg-surface-700"
			style="right: calc(16px + var(--sar, 0px)); bottom: calc(var(--app-bottom-clearance) + 12px);"
			aria-label={m.catalog_search_library()}
			onclick={() => { playReaderHaptic('control'); searchOverlayOpen = true; }}
			data-library-search-fab
		>
			<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
		</button>
	{/if}
	</div>

</div>

{#if searchOverlayOpen}
	<SearchOverlay
		onclose={() => (searchOverlayOpen = false)}
		onopen={(volume) => { searchOverlayOpen = false; void openFromHistory(volume); }}
		onopenfolder={(folder) => {
			searchOverlayOpen = false;
			selectedLibraryId.set(folder.libraryId);
			if (folder.kind === 'local') {
				currentRemoteFolderId.set(null);
				currentSubfolder.set(folder.path);
			} else {
				currentSubfolder.set('');
				currentRemoteFolderId.set(folder.remoteFolderId);
			}
		}}
	/>
{/if}

<!-- Context menu -->
{#if contextMenuVolume && contextMenuPosition}
	<!-- On mobile the sheet dismisses only via Cancel or Android back; the
	     backdrop just blocks interaction. Desktop keeps click-away. -->
	<button
		type="button"
		aria-label={m.catalog_close_volume_menu()}
		class="fixed inset-0 z-40 {isMobile ? 'bg-black/50' : ''}"
		style={isMobile ? '' : 'background: rgba(0,0,0,0.01);'}
		onclick={isMobile ? undefined : closeContextMenu}
		ontouchstart={isMobile ? undefined : closeContextMenu}
		oncontextmenu={(e) => { e.preventDefault(); if (!isMobile) closeContextMenu(); }}
		in:fade={{ duration: motionDuration(100) }} out:fade={{ duration: motionDuration(exitDuration(100)) }}
	></button>
	<div
		bind:this={contextMenuEl}
		class={isMobile
			? 'catalog-menu-mobile fixed left-1/2 top-1/2 z-50 w-[min(20rem,calc(100vw-3rem))] max-h-[calc(100dvh-6rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-surface-700 bg-surface-900 py-1 shadow-2xl'
			: 'fixed z-50 min-w-[270px] overflow-hidden rounded-lg border border-surface-700 bg-surface-900 py-1 shadow-xl'}
		style={isMobile ? '' : `left: ${contextMenuPosition.x}px; top: ${contextMenuPosition.y}px;`}
		in:scale={{ duration: motionDuration(100), start: 0.9 }} out:scale={{ duration: motionDuration(exitDuration(100)), start: 0.9 }}
		role="dialog"
		aria-label={m.catalog_options_for({ name: contextMenuVolume.title })}
		data-volume-menu
	>
		{#if isMobile}
			<p class="truncate border-b border-surface-800 px-4 pb-2.5 pt-3 text-sm font-semibold text-surface-100" data-volume-menu-heading>{contextMenuVolume.title}</p>
			<button
				class="flex w-full min-h-12 items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors active:bg-surface-800"
				onclick={() => { void openInNewTab(contextMenuVolume!); }}
				data-open-in-new-tab
			>
				<span class="text-surface-400">▣</span>
				{m.catalog_open_in_new_tab()}
			</button>
		{/if}
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
			onclick={() => handleToggleFavorite(contextMenuVolume!)}
			data-volume-favorite-toggle
		>
			<span class="{contextMenuVolume.favorited_at ? 'text-amber-300' : 'text-surface-400'}">{contextMenuVolume.favorited_at ? '★' : '☆'}</span>
			{contextMenuVolume.favorited_at ? m.catalog_unfavorite() : m.catalog_favorite()}
		</button>
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
			onclick={() => handleGetFullTranslation(contextMenuVolume!)}
		>
			<span class="text-surface-400">📝</span>
			{m.catalog_get_full_translation()}
		</button>
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
			onclick={() => { const vol = contextMenuVolume; closeContextMenu(); customTranslationVolume = vol; }}
		>
			<span class="text-surface-400">⚙️</span>
			{m.catalog_get_full_translation_custom()}
		</button>
		{#if contextMenuHasTranslations}
			<button
				class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
				onclick={() => { const vol = contextMenuVolume; closeContextMenu(); reviseVolumeTarget = vol; }}
			>
				<span class="text-surface-400">🔄</span>
				{m.catalog_revise_translation()}
			</button>
		{/if}
		{#if getJobForVolume($activeTranslationJobs, contextMenuVolume.volume_uuid)?.status === 'completed'}
			<button
				class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
				onclick={() => handleUnmarkAsTranslated(contextMenuVolume!)}
			>
				<span class="text-surface-400">✖</span>
				{m.catalog_unmark_as_translated()}
			</button>
		{:else}
			<button
				class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
				onclick={() => handleMarkAsTranslated(contextMenuVolume!)}
			>
				<span class="text-surface-400">✓</span>
				{m.catalog_mark_as_translated()}
			</button>
		{/if}
		{#if contextMenuHasTranslations}
			<button
				class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
				onclick={() => handleClearTranslations(contextMenuVolume!)}
			>
				<span class="text-surface-400">🧹</span>
				{m.catalog_clear_translation_data()}
			</button>
		{/if}
		{#if contextMenuHasTranslations}
			<div class="mx-2 border-t border-surface-800"></div>
			<button
				class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
				onclick={() => handleExportTranslatedCbz(contextMenuVolume!)}
			>
				<span class="text-surface-400">📦</span>
				{m.catalog_export_translated_cbz()}
			</button>
		{/if}
		<div class="mx-2 border-t border-surface-800"></div>
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
			onclick={() => handleEditDetails(contextMenuVolume!)}
		>
			<span class="text-surface-400">✏️</span>
			{m.catalog_edit_details()}
		</button>
		<div class="mx-2 border-t border-surface-800"></div>
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-400 transition-colors hover:bg-surface-800"
			onclick={() => handleDeleteVolume(contextMenuVolume!)}
		>
			<span>🗑</span>
			{m.common_delete()}
		</button>
		{#if isMobile}
			<div class="mx-2 border-t border-surface-800"></div>
			<button
				class="flex w-full min-h-12 items-center justify-center px-4 py-2 text-sm font-medium text-surface-300 transition-colors active:bg-surface-800"
				onclick={closeContextMenu}
				data-volume-menu-cancel
			>
				{m.common_cancel()}
			</button>
		{/if}
	</div>
{/if}

<!-- Folder context menu -->
{#if folderContextMenuName && folderContextMenuPosition}
	<button
		type="button"
		aria-label={m.catalog_close_folder_menu()}
		class="fixed inset-0 z-40 {isMobile ? 'bg-black/50' : ''}"
		style={isMobile ? '' : 'background: rgba(0,0,0,0.01);'}
		onclick={isMobile ? undefined : closeFolderContextMenu}
		ontouchstart={isMobile ? undefined : closeFolderContextMenu}
		oncontextmenu={(e) => { e.preventDefault(); if (!isMobile) closeFolderContextMenu(); }}
		in:fade={{ duration: motionDuration(100) }} out:fade={{ duration: motionDuration(exitDuration(100)) }}
	></button>
	<div
		bind:this={folderContextMenuEl}
		class={isMobile
			? 'catalog-menu-mobile fixed left-1/2 top-1/2 z-50 w-[min(20rem,calc(100vw-3rem))] max-h-[calc(100dvh-6rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-surface-700 bg-surface-900 py-1 shadow-2xl'
			: 'fixed z-50 min-w-[200px] overflow-hidden rounded-lg border border-surface-700 bg-surface-900 py-1 shadow-xl'}
		style={isMobile ? '' : `left: ${folderContextMenuPosition.x}px; top: ${folderContextMenuPosition.y}px;`}
		in:scale={{ duration: motionDuration(100), start: 0.9 }} out:scale={{ duration: motionDuration(exitDuration(100)), start: 0.9 }}
		role="dialog"
		aria-label={m.catalog_options_for_folder({ name: folderContextMenuName })}
		data-folder-menu
	>
		{#if isMobile}
			<p class="truncate border-b border-surface-800 px-4 pb-2.5 pt-3 text-sm font-semibold text-surface-100" data-folder-menu-heading>{folderContextMenuName}</p>
		{/if}
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800"
			onclick={() => handleRenameFolder(folderContextMenuName!)}
		>
			<span class="text-surface-400">✏️</span>
			{m.catalog_rename()}
		</button>
		<button
			class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-400 transition-colors hover:bg-surface-800"
			onclick={() => handleDeleteFolder(folderContextMenuName!)}
		>
			<span>🗑</span>
			{m.common_delete()}
		</button>
		{#if isMobile}
			<div class="mx-2 border-t border-surface-800"></div>
			<button
				class="flex w-full min-h-12 items-center justify-center px-4 py-2 text-sm font-medium text-surface-300 transition-colors active:bg-surface-800"
				onclick={closeFolderContextMenu}
				data-folder-menu-cancel
			>
				{m.common_cancel()}
			</button>
		{/if}
	</div>
{/if}

<!-- Sort menu (mobile): the toolbar shows the glyph, this spells the field out -->
{#if sortMenuOpen}
	<button
		type="button"
		aria-label={m.catalog_close_sort_menu()}
		class="fixed inset-0 z-40 bg-black/50"
		onclick={closeSortMenu}
		in:fade={{ duration: motionDuration(100) }} out:fade={{ duration: motionDuration(exitDuration(100)) }}
	></button>
	<div
		class="catalog-menu-mobile fixed left-1/2 top-1/2 z-50 w-[min(20rem,calc(100vw-3rem))] max-h-[calc(100dvh-6rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-surface-700 bg-surface-900 py-1 shadow-2xl"
		in:scale={{ duration: motionDuration(100), start: 0.9 }} out:scale={{ duration: motionDuration(exitDuration(100)), start: 0.9 }}
		role="dialog"
		aria-label={m.catalog_sort_volumes_by()}
		data-catalog-sort-menu
	>
		<p class="border-b border-surface-800 px-4 pb-2.5 pt-3 text-sm font-semibold text-surface-100">{m.catalog_sort_by()}</p>
		{#each SORT_FIELDS as field (field.value)}
			<button
				type="button"
				class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors active:bg-surface-800 {$catalogSortField === field.value ? 'text-primary-300' : 'text-surface-200'}"
				aria-current={$catalogSortField === field.value ? 'true' : undefined}
				onclick={() => { catalogSortField.set(field.value); closeSortMenu(); }}
			>
				<span class="shrink-0 {$catalogSortField === field.value ? 'text-primary-300' : 'text-surface-400'}">{@render sortFieldIcon(field.icon)}</span>
				<span class="min-w-0 flex-1 truncate">{field.label()}</span>
				{#if $catalogSortField === field.value}
					<svg class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
						<path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
					</svg>
				{/if}
			</button>
		{/each}
		<div class="mx-2 border-t border-surface-800"></div>
		<div class="flex gap-1 px-3 py-2" role="group" aria-label={m.catalog_sort_direction()} data-catalog-sort-direction>
			<button
				type="button"
				class="h-11 flex-1 rounded-full text-xs font-medium transition-colors {$catalogSortDirection === 'asc' ? 'bg-primary-600 text-white' : 'bg-surface-container-high text-surface-400 active:bg-surface-700'}"
				aria-pressed={$catalogSortDirection === 'asc'}
				onclick={() => catalogSortDirection.set('asc')}
			>
				{m.catalog_ascending()}
			</button>
			<button
				type="button"
				class="h-11 flex-1 rounded-full text-xs font-medium transition-colors {$catalogSortDirection === 'desc' ? 'bg-primary-600 text-white' : 'bg-surface-container-high text-surface-400 active:bg-surface-700'}"
				aria-pressed={$catalogSortDirection === 'desc'}
				onclick={() => catalogSortDirection.set('desc')}
			>
				{m.catalog_descending()}
			</button>
		</div>
		<div class="mx-2 border-t border-surface-800"></div>
		<button
			class="flex min-h-12 w-full items-center justify-center px-4 text-sm font-medium text-surface-300 transition-colors active:bg-surface-800"
			onclick={closeSortMenu}
			data-catalog-sort-cancel
		>
			{m.common_back()}
		</button>
	</div>
{/if}

<!-- Library overflow menu (mobile app bar ⋮): the actions that used to be
     permanent toolbar rows, scoped to the current level. -->
{#if libraryMenuOpen}
	<button
		type="button"
		aria-label={m.catalog_close_library_options()}
		class="fixed inset-0 z-40 bg-[var(--color-scrim-menu)]"
		onclick={closeLibraryMenu}
		in:fade={{ duration: motionDuration(100) }}
		out:fade={{ duration: motionDuration(exitDuration(100)) }}
	></button>
	<div
		class="catalog-menu-mobile fixed left-1/2 top-1/2 z-50 w-[min(20rem,calc(100vw-3rem))] max-h-[calc(100dvh-6rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-surface-container-high py-1 shadow-2xl"
		in:scale={{ duration: motionDuration(100), start: 0.9 }}
		out:scale={{ duration: motionDuration(exitDuration(100)), start: 0.9 }}
		role="dialog"
		aria-label={m.catalog_library_options()}
		data-library-menu
	>
		<p class="border-b border-surface-800 px-4 pb-2.5 pt-3 text-sm font-semibold text-surface-100">{m.catalog_library_options()}</p>
		{#if $selectedLibraryId || $currentSubfolder !== '' || $currentRemoteFolderId !== null}
			<button
				type="button"
				class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm text-surface-200 transition-colors active:bg-surface-800 disabled:text-surface-500"
				disabled={isScanning || recoveredDownloadsSelected}
				onclick={() => { closeLibraryMenu(); handleScanLibrary(); }}
			>
				<span class="text-surface-400" aria-hidden="true">⟳</span>
				{isScanning
					? (scanTargetsIncludeRemote ? m.catalog_syncing() : m.catalog_scanning())
					: scanScopeIsFolder
						? (scanTargetsIncludeRemote ? m.catalog_sync_folder() : m.catalog_scan_folder())
						: (scanTargetsIncludeRemote ? m.catalog_scan_sync() : m.catalog_scan())}
			</button>
			{#if activeLibraryIsLocal}
				<button
					type="button"
					class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm text-surface-200 transition-colors active:bg-surface-800"
					onclick={() => { closeLibraryMenu(); importDialogOpen.set(true); }}
				>
					<span class="text-surface-400" aria-hidden="true">＋</span>
					{m.catalog_plus_import()}
				</button>
				<button
					type="button"
					class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm text-surface-200 transition-colors active:bg-surface-800"
					onclick={() => { closeLibraryMenu(); showNewFolderDialog = true; }}
				>
					<span class="text-surface-400" aria-hidden="true">🗀</span>
					{m.catalog_plus_folder()}
				</button>
				<button
					type="button"
					class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm text-surface-200 transition-colors active:bg-surface-800"
					onclick={() => { closeLibraryMenu(); selectionMode = true; selectedVolumeUuids = new Set(); }}
					title={m.catalog_select_volumes_to_move()}
				>
					<span class="text-surface-400" aria-hidden="true">✓</span>
					{m.catalog_select_volumes()}
				</button>
			{/if}
		{/if}
		<button
			type="button"
			class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm text-surface-200 transition-colors active:bg-surface-800"
			onclick={() => { closeLibraryMenu(); toggleSearchBar(); }}
		>
			<span class="text-surface-400" aria-hidden="true">🔍</span>
			{showSearchBar ? m.catalog_hide_search_button() : m.catalog_show_search_button()}
		</button>
		<div class="mx-2 border-t border-surface-800"></div>
		<button
			class="flex min-h-12 w-full items-center justify-center px-4 text-sm font-medium text-surface-300 transition-colors active:bg-surface-800"
			onclick={closeLibraryMenu}
			data-library-menu-cancel
		>
			{m.common_cancel()}
		</button>
	</div>
{/if}

<!-- New folder dialog -->
{#if showNewFolderDialog}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) { showNewFolderDialog = false; newFolderInput = ''; newFolderError = ''; } }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h3 class="text-lg font-semibold text-surface-100">{m.catalog_new_folder()}</h3>
			{#if $currentSubfolder}
				<p class="mt-1 text-xs text-surface-500">{m.catalog_inside_folder({ folder: $currentSubfolder })}</p>
			{/if}
			{#if !$selectedLibraryId}
				<!-- Root-level create: pick which local library receives the folder. -->
				<label class="mt-3 flex items-center gap-2 text-xs text-surface-400">
					<span class="shrink-0">{m.catalog_create_in()}</span>
					<select
						bind:value={newFolderTargetLibraryId}
						class="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-800 px-2 py-1.5 text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
						data-new-folder-target
					>
						{#each $settings.libraries.filter(isLocalLibrary) as lib (lib.id)}
							<option value={lib.id}>{lib.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				placeholder={m.catalog_folder_name()}
				bind:value={newFolderInput}
				onkeydown={(e) => { if (e.key === 'Enter' && newFolderInput.trim()) handleCreateFolder(); }}
				autofocus
				class="mt-3 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
			/>
			{#if newFolderError}
				<p class="mt-1 text-xs text-red-400">{newFolderError}</p>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<button
					onclick={() => { showNewFolderDialog = false; newFolderInput = ''; newFolderError = ''; }}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={handleCreateFolder}
					disabled={!newFolderInput.trim()}
					class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{m.catalog_create()}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Rename folder dialog -->
{#if renameFolderTarget}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget && !isRenamingFolder) { renameFolderTarget = null; renameFolderInput = ''; renameFolderError = ''; } }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h3 class="text-lg font-semibold text-surface-100">{m.catalog_rename_folder()}</h3>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				bind:value={renameFolderInput}
				onkeydown={(e) => { if (e.key === 'Enter' && renameFolderInput.trim() && renameFolderInput.trim() !== renameFolderTarget && !isRenamingFolder) confirmRenameFolder(); }}
				autofocus
				disabled={isRenamingFolder}
				class="mt-3 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
			/>
			{#if renameFolderError}
				<p class="mt-1 text-xs text-red-400">{renameFolderError}</p>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<button
					onclick={() => { if (!isRenamingFolder) { renameFolderTarget = null; renameFolderInput = ''; renameFolderError = ''; } }}
					disabled={isRenamingFolder}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={confirmRenameFolder}
					disabled={!renameFolderInput.trim() || renameFolderInput.trim() === renameFolderTarget || isRenamingFolder}
					class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isRenamingFolder ? m.catalog_renaming() : m.catalog_rename()}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete folder confirmation dialog -->
{#if deleteFolderConfirm}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget && !isDeletingFolder) { deleteFolderConfirm = null; deleteFolderError = ''; } }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h3 class="text-lg font-semibold text-surface-100">{m.catalog_delete_folder()}</h3>
			<p class="mt-2 text-sm text-surface-400">
				<RichMessage message={m.catalog_confirm_delete_named({ name: deleteFolderConfirm.name })} emClass="text-surface-200" />
			</p>
			{#if deleteFolderConfirm.volumeCount > 0}
				<p class="mt-2 text-sm text-surface-400">
					<RichMessage message={m.catalog_delete_folder_volumes({ n: deleteFolderConfirm.volumeCount })} emClass="text-red-400" />
				</p>
			{:else}
				<p class="mt-2 text-sm text-surface-500">{m.catalog_this_folder_is_empty()}</p>
			{/if}
			{#if deleteFolderError}
				<p class="mt-2 text-xs text-red-400">{deleteFolderError}</p>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<button
					onclick={() => { if (!isDeletingFolder) { deleteFolderConfirm = null; deleteFolderError = ''; } }}
					disabled={isDeletingFolder}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={confirmDeleteFolder}
					disabled={isDeletingFolder}
					class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-wait disabled:opacity-70"
				>
					{isDeletingFolder ? m.catalog_deleting() : m.settings_models_delete()}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Move volumes dialog (folder picker) -->
{#if showMoveDialog}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget && !isMovingVolumes) { showMoveDialog = false; } }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-2xl {isMobile ? 'mx-3 max-h-[80vh]' : 'max-h-[70vh]'}"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<!-- Header -->
			<div class="border-b border-surface-800 px-5 py-4">
				<h3 class="text-lg font-semibold text-surface-100">{m.catalog_move_n_volumes({ n: selectedCount })}</h3>
				<p class="mt-0.5 text-xs text-surface-500">{m.catalog_select_destination_folder()}</p>
			</div>

			<!-- Breadcrumbs -->
			<div class="flex items-center gap-1 border-b border-surface-800 px-5 py-2 text-xs">
				<button
					onclick={() => moveDialogNavigateToBreadcrumb('')}
					class="shrink-0 text-primary-400 transition-colors hover:text-primary-300 {moveDialogPath === '' ? 'font-semibold text-surface-200' : ''}"
				>
					{m.catalog_root()}
				</button>
				{#each moveDialogBreadcrumbs as crumb}
					<span class="text-surface-600">/</span>
					<button
						onclick={() => moveDialogNavigateToBreadcrumb(crumb.path)}
						class="truncate text-primary-400 transition-colors hover:text-primary-300 {crumb.path === moveDialogPath ? 'font-semibold text-surface-200' : ''}"
					>
						{crumb.name}
					</button>
				{/each}
			</div>

			<!-- Folder list (scrollable) -->
			<div class="flex-1 overflow-y-auto">
				<!-- Up button (when not at root) -->
				{#if moveDialogPath}
					<button
						class="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm text-surface-300 transition-colors hover:bg-surface-800/60"
						onclick={moveDialogNavigateUp}
					>
						<svg class="h-4 w-4 shrink-0 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd" />
						</svg>
						<span class="text-surface-400">..</span>
					</button>
				{/if}

				{#each moveDialogFolders as folder (folder)}
					<button
						class="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm text-surface-200 transition-colors hover:bg-surface-800/60"
						onclick={() => moveDialogNavigateTo(folder)}
					>
						<svg class="h-4 w-4 shrink-0 text-primary-400" viewBox="0 0 20 20" fill="currentColor">
							<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
						</svg>
						<span class="flex-1 truncate">{folder}</span>
						<svg class="h-4 w-4 shrink-0 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
						</svg>
					</button>
				{/each}

				{#if moveDialogFolders.length === 0 && !moveDialogPath}
					<p class="px-5 py-6 text-center text-sm text-surface-500">
						{m.catalog_no_subfolders_use_new()}
					</p>
				{:else if moveDialogFolders.length === 0}
					<p class="px-5 py-6 text-center text-sm text-surface-500">
						{m.catalog_no_subfolders_here()}
					</p>
				{/if}
			</div>

			<!-- New folder inline form (shown on demand) -->
			{#if moveDialogShowNewFolder}
				<div class="border-t border-surface-800 px-5 py-3">
					<div class="flex items-center gap-2">
						<!-- svelte-ignore a11y_autofocus -->
						<input
							type="text"
							placeholder={m.catalog_folder_name()}
							bind:value={moveDialogNewFolderInput}
							onkeydown={(e) => { if (e.key === 'Enter' && moveDialogNewFolderInput.trim()) moveDialogCreateFolder(); }}
							autofocus
							class="flex-1 rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
						/>
						<button
							onclick={moveDialogCreateFolder}
							disabled={!moveDialogNewFolderInput.trim()}
							class="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{m.catalog_create()}
						</button>
					</div>
					{#if moveDialogNewFolderError}
						<p class="mt-1 text-xs text-red-400">{moveDialogNewFolderError}</p>
					{/if}
				</div>
			{/if}

			<!-- Error message -->
			{#if moveError}
				<div class="border-t border-red-500/20 bg-red-500/5 px-5 py-2">
					<p class="text-xs text-red-400">{moveError}</p>
				</div>
			{/if}

			<!-- Footer. The "already here" hint sits on its own line: sharing a row
			     with three buttons wrapped every label ("+ New / Folder", "Move /
			     Here") and collided with them on a phone. Labels never wrap now. -->
			<div class="border-t border-surface-800 px-5 py-3">
				{#if moveDialogPath === $currentSubfolder}
					<p class="mb-2 text-center text-xs text-surface-500">{m.catalog_already_in_this_folder()}</p>
				{/if}
				<div class="flex items-center justify-between gap-2">
					<button
						onclick={() => { moveDialogShowNewFolder = !moveDialogShowNewFolder; moveDialogNewFolderInput = ''; moveDialogNewFolderError = ''; }}
						class="shrink-0 whitespace-nowrap rounded-lg border border-surface-700 px-3 py-2 text-xs font-medium text-surface-300 transition-colors hover:border-surface-500 hover:text-surface-100"
					>
						{moveDialogShowNewFolder ? m.reader_hide() : m.catalog_new_folder_2()}
					</button>
					<div class="flex shrink-0 items-center gap-2">
						<button
							onclick={() => { showMoveDialog = false; }}
							disabled={isMovingVolumes}
							class="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{m.common_cancel()}
						</button>
						<button
							onclick={confirmMoveVolumes}
							disabled={isMovingVolumes || moveDialogPath === $currentSubfolder}
							class="whitespace-nowrap rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isMovingVolumes ? m.catalog_moving() : m.catalog_move_here()}
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}

<!-- Volume details dialog -->
<VolumeDetailsDialog
	volume={detailsVolume}
	thumbnailUrl={detailsVolume ? thumbnailUrls.get(detailsVolume.volume_uuid) : undefined}
	onclose={() => detailsVolume = null}
/>

<!-- Custom translation dialog -->
<CustomTranslationDialog
	volume={customTranslationVolume}
	onclose={() => customTranslationVolume = null}
	onstart={(options) => handleCustomTranslation(customTranslationVolume!, options)}
/>

<!-- Revise volume dialog -->
<ReviseVolumeDialog
	volume={reviseVolumeTarget}
	onclose={() => reviseVolumeTarget = null}
	onsubmit={(instructions) => handleReviseVolume(reviseVolumeTarget!, instructions)}
/>

<!-- Delete confirmation dialog -->
{#if deleteSelectedConfirm}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget && !isDeletingSelected) deleteSelectedConfirm = false; }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
			role="dialog"
			aria-modal="true"
			aria-label={m.catalog_delete_selected_volumes()}
			data-delete-selected-dialog
		>
			<h3 class="text-lg font-semibold text-surface-100">
				{m.catalog_delete_n_volumes_question({ n: selectedCount })}
			</h3>
			<p class="mt-2 text-sm text-surface-400">
				{m.catalog_this_removes_the_archives()}
			</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					onclick={() => { deleteSelectedConfirm = false; }}
					disabled={isDeletingSelected}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={confirmDeleteSelected}
					disabled={isDeletingSelected}
					class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
					data-delete-selected-confirm
				>
					{isDeletingSelected ? m.reader_deleting() : m.catalog_delete_selectedcount({ selectedCount })}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if deleteConfirmVolume}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) deleteConfirmVolume = null; }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h3 class="text-lg font-semibold text-surface-100">{m.catalog_delete_volume()}</h3>
			<p class="mt-2 text-sm text-surface-400">
				<RichMessage message={m.catalog_confirm_delete_volume({ name: deleteConfirmVolume.title })} emClass="text-surface-200" />
			</p>
			<div class="mt-4 flex items-center gap-2">
				{#if thumbnailUrls.get(deleteConfirmVolume.volume_uuid)}
					<img
						src={thumbnailUrls.get(deleteConfirmVolume.volume_uuid)}
						alt=""
						class="h-16 w-12 rounded object-cover"
					/>
				{/if}
				<span class="text-xs text-surface-500">
					{deleteConfirmVolume.page_count} pages
				</span>
			</div>
			<div class="mt-5 flex justify-end gap-2">
				<button
					onclick={() => deleteConfirmVolume = null}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={confirmDelete}
					class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
				>
					{m.settings_models_delete()}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Clear translations confirmation dialog -->
{#if clearTranslationsConfirmVolume}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) clearTranslationsConfirmVolume = null; }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h3 class="text-lg font-semibold text-surface-100">{m.catalog_clear_translation_data()}</h3>
			<p class="mt-2 text-sm text-surface-400">
				<RichMessage message={m.catalog_confirm_clear_translations({ name: clearTranslationsConfirmVolume.title })} emClass="text-surface-200" />
			</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					onclick={() => clearTranslationsConfirmVolume = null}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={confirmClearTranslations}
					class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
				>
					{m.catalog_clear()}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Export progress overlay -->
{#if exportError}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-red-900/60 bg-surface-900 p-6 shadow-2xl"
			role="alertdialog"
			aria-label={m.catalog_export_failed()}
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
			data-export-error
		>
			<h3 class="text-lg font-semibold text-red-300">{m.catalog_export_failed_2()}</h3>
			<p class="mt-2 break-words text-sm text-surface-300 allow-select">{exportError}</p>
			<div class="mt-5 flex justify-end">
				<button
					onclick={() => { exportError = null; }}
					class="min-h-11 rounded-lg bg-surface-700 px-4 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-600 active:bg-surface-600"
					data-export-error-dismiss
				>
					{m.common_dismiss()}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if exportingVolume}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h3 class="text-lg font-semibold text-surface-100">{m.catalog_exporting_translated_cbz()}</h3>
			<p class="mt-2 text-sm text-surface-400">
				{exportingVolume.title}
			</p>
			<div class="mt-4">
				<div class="flex items-center justify-between text-xs text-surface-400">
					<span>{m.catalog_export_page_progress({ current: exportProgress.current, total: exportProgress.total || '…' })}</span>
					<span>{exportProgress.total > 0 ? Math.round((exportProgress.current / exportProgress.total) * 100) : 0}%</span>
				</div>
				<div class="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-800">
					<div
						class="h-full rounded-full bg-teal-500 transition-all duration-200"
						style="width: {exportProgress.total > 0 ? (exportProgress.current / exportProgress.total) * 100 : 0}%"
					></div>
				</div>
			</div>
			<div class="mt-5 flex justify-end">
				<button
					onclick={cancelExport}
					class="rounded-lg bg-surface-700 px-4 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-600"
				>
					{m.common_cancel()}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Mobile action-sheet rows need full touch-target height. */
	.catalog-menu-mobile button {
		min-height: 48px;
	}
</style>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { motionDuration } from '$lib/util/motion.js';
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { settings, isLocalLibrary, isYACReaderLibrary, isKomgaLibrary, isKavitaLibrary, isRemoteServerLibrary } from '$lib/settings/settings.js';
	import {
		catalogSidebarOpen,
		selectedLibraryId,
		currentSubfolder,
		currentRemoteFolderId,
		catalogFlattenActive,
		catalogSearchQuery,
		catalogSearchMode,
		catalogSortField,
		catalogSortDirection,
		folderRefreshToken,
		RECOVERED_DOWNLOADS_COLLECTION_ID,
		isRecoveredDownloadsCollectionId,
	} from '$lib/stores/catalog-state.js';
	import { buildBreadcrumbs, mergeSubfolderSources } from '$lib/library/subfolder-utils.js';
	import { readFilesystemFolders } from '$lib/library/folder-service.js';
	import { isMobile } from '$lib/util/platform.js';
	import { getOrCreateClient } from '$lib/yacreader/yac-client-manager.js';
	import { fetchFolderCover } from '$lib/yacreader/yac-sync-service.js';
	import type { RemoteFolder } from '$lib/types/index.js';
	import { catalogController } from '$lib/controllers/catalog-controller.js';
	import type { LoadablePhase } from '$lib/controllers/loadable-snapshot.js';
	import { UNASSIGNED_LIBRARY_ID } from '$lib/catalog/catalog-repository.js';

	const initialCatalogSnapshot = catalogController.getSnapshot();
	let projectedLocalSubfolders = $state<string[]>(initialCatalogSnapshot.data?.localSubfolders ?? []);
	let remoteFolders = $state<RemoteFolder[]>(initialCatalogSnapshot.data?.remoteFolders ?? []);
	let collectionCounts = $state<Record<string, number>>(initialCatalogSnapshot.data?.collectionCounts ?? {});
	let catalogPhase = $state<LoadablePhase>(initialCatalogSnapshot.phase);
	let loadingRemoteFolders = $state(false);
	let remoteFolderError = $state<string | null>(null);
	let remoteFolderStatusKey = $state<string | null>(null);
	let filesystemFolders = $state<string[]>([]);
	let sidebarScrollContainer: HTMLDivElement | undefined = $state();
	let sidebarDestroyed = false;

	const observedFolderCovers = new Map<Element, string>();
	const visibleFolderCovers = new Set<string>();
	const pendingFolderCovers = new Set<string>();
	const folderCoverRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let folderCoverObserver: IntersectionObserver | null = null;

	function clearFolderCoverRetryTimer(folderId: string) {
		const timer = folderCoverRetryTimers.get(folderId);
		if (timer) clearTimeout(timer);
		folderCoverRetryTimers.delete(folderId);
	}

	function queueSidebarFolderCover(folderId: string) {
		if (!visibleFolderCovers.has(folderId) || pendingFolderCovers.has(folderId)) return;
		const currentFolder = remoteFolders.find((candidate) => candidate.id === folderId);
		const retryAt = Date.parse(currentFolder?.coverRetryAt ?? '');
		if (Number.isFinite(retryAt) && retryAt > Date.now()) {
			clearFolderCoverRetryTimer(folderId);
			const timer = setTimeout(() => {
				folderCoverRetryTimers.delete(folderId);
				queueSidebarFolderCover(folderId);
			}, retryAt - Date.now());
			folderCoverRetryTimers.set(folderId, timer);
			return;
		}

		const lib = selectedLib;
		if (!lib || !isYACReaderLibrary(lib)) return;
		pendingFolderCovers.add(folderId);
		void (async () => {
				if (!visibleFolderCovers.has(folderId) || sidebarDestroyed) return;
				const currentLib = selectedLib;
				const folder = remoteFolders.find((candidate) => candidate.id === folderId);
				if (!currentLib || !isYACReaderLibrary(currentLib) || !folder || folder.librarySettingsId !== currentLib.id) return;
				if (!folder.coverHash && !folder.coverPath) {
					clearFolderCoverRetryTimer(folderId);
					return;
				}
				try {
					const client = getOrCreateClient(currentLib.serverUrl);
					await fetchFolderCover(client, folder);
				} catch (err) {
					console.debug(`[CatalogSidebar] YACReader folder cover hydration failed for ${folderId}:`, err);
				}
			})()
			.finally(() => pendingFolderCovers.delete(folderId));
	}

	function observeSidebarFolderCover(node: HTMLElement, folderId: string) {
		observedFolderCovers.set(node, folderId);
		if (typeof IntersectionObserver === 'undefined') {
			visibleFolderCovers.add(folderId);
			queueMicrotask(() => queueSidebarFolderCover(folderId));
		} else {
			if (!folderCoverObserver) {
				folderCoverObserver = new IntersectionObserver((entries) => {
					for (const entry of entries) {
						const id = observedFolderCovers.get(entry.target);
						if (!id) continue;
						if (entry.isIntersecting) {
							visibleFolderCovers.add(id);
							queueSidebarFolderCover(id);
						} else {
							visibleFolderCovers.delete(id);
							clearFolderCoverRetryTimer(id);
						}
					}
				}, { root: sidebarScrollContainer ?? null, rootMargin: '300px 0px', threshold: 0 });
			}
			folderCoverObserver.observe(node);
		}

		return {
			destroy() {
				folderCoverObserver?.unobserve(node);
				const id = observedFolderCovers.get(node);
				if (id) {
					visibleFolderCovers.delete(id);
					clearFolderCoverRetryTimer(id);
				}
				observedFolderCovers.delete(node);
			}
		};
	}

	$effect(() => {
		remoteFolders.map((folder) => `${folder.id}:${folder.metadataRevision ?? 0}:${folder.coverRetryAt ?? ''}`).join('|');
		for (const folderId of visibleFolderCovers) queueSidebarFolderCover(folderId);
	});

	onMount(() => {
		sidebarDestroyed = false;
		const unsubscribeCatalog = catalogController.subscribe((snapshot) => {
			catalogPhase = snapshot.phase;
			if (snapshot.data) {
				projectedLocalSubfolders = snapshot.data.localSubfolders;
				remoteFolders = snapshot.data.remoteFolders;
				collectionCounts = snapshot.data.collectionCounts;
			}
		});

		return () => {
			sidebarDestroyed = true;
			folderCoverObserver?.disconnect();
			folderCoverObserver = null;
			visibleFolderCovers.clear();
			observedFolderCovers.clear();
			for (const timer of folderCoverRetryTimers.values()) clearTimeout(timer);
			folderCoverRetryTimers.clear();
			unsubscribeCatalog();
		};
	});

	$effect(() => {
		catalogController.setLocation({
			libraryId: $selectedLibraryId,
			subfolder: $currentSubfolder,
			remoteFolderId: $currentRemoteFolderId,
			// Same flatten authority as CatalogView — omitting it here would
			// clobber the flattened location on sidebar remount and blank the
			// filtered view (the shared controller is last-writer-wins).
			flatten: $catalogFlattenActive
		});
	});

	// Determine if selected library is local or remote
	let selectedLib = $derived(
		$selectedLibraryId
			? ($settings.libraries.find((l) => l.id === $selectedLibraryId) ?? null)
			: null
	);
	let isRemoteLibrary = $derived(selectedLib ? isRemoteServerLibrary(selectedLib) : false);

	let visibleLibraries = $derived($settings.libraries);
	let recoveredDownloadCount = $derived(collectionCounts[UNASSIGNED_LIBRARY_ID] ?? 0);
	let hasRecoveredDownloads = $derived(recoveredDownloadCount > 0);
	let recoveredDownloadsSelected = $derived(
		isRecoveredDownloadsCollectionId($selectedLibraryId)
	);

	// Read filesystem folders for local libraries (picks up empty folders created via folder management)
	let sidebarFsFolderVersion = 0;
	$effect(() => {
		const lib = selectedLib;
		const sub = $currentSubfolder;
		const _refresh = $folderRefreshToken; // track refresh token for re-reads
		if (!lib || !isLocalLibrary(lib)) {
			filesystemFolders = [];
			return;
		}
		const dirPath = sub ? lib.path + '/' + sub : lib.path;
		const version = ++sidebarFsFolderVersion;
		readFilesystemFolders(dirPath).then((folders) => {
			if (version === sidebarFsFolderVersion) filesystemFolders = folders;
		});
	});

	// Derive subfolders for local libraries from volume folder_path data + filesystem
	let localSubfolders = $derived.by(() => {
		if (!selectedLib || !isLocalLibrary(selectedLib)) return [];
		let folders = mergeSubfolderSources(projectedLocalSubfolders, filesystemFolders);
		// Filter folders by search query when in folders search mode
		if ($catalogSearchMode === 'folders' && $catalogSearchQuery.trim()) {
			const q = $catalogSearchQuery.toLowerCase();
			folders = folders.filter((f) => f.toLowerCase().includes(q));
		}
		return folders;
	});

	// Derive remote subfolders for YACReader libraries
	let remoteSubfolders = $derived.by(() => {
		if (!$selectedLibraryId || !isRemoteLibrary) return [];
		// Get children of the current remote folder
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
			return dir * a.name.localeCompare(b.name, undefined, { numeric: true });
		});
		// Filter folders by search query when in folders search mode
		if ($catalogSearchMode === 'folders' && $catalogSearchQuery.trim()) {
			const q = $catalogSearchQuery.toLowerCase();
			folders = folders.filter((f) => f.name.toLowerCase().includes(q));
		}
		return folders;
	});

	// Folder assets are loaded only for the current list. YAC/Kavita use
	// authenticated, persisted media; Komga can use its authenticated image URL.
	let folderCoverUrls = $state<Map<string, string>>(new Map());
	$effect(() => {
		const lib = selectedLib;
		const folders = remoteSubfolders;
		const ownedUrls: string[] = [];
		let current = true;
		if (!lib || !isRemoteServerLibrary(lib)) {
			folderCoverUrls = new Map();
			return;
		}
		if (isKomgaLibrary(lib)) {
			folderCoverUrls = new Map(folders.flatMap((folder) => folder.coverHash
				? [[folder.id, `${lib.serverUrl}/api/v1/series/${encodeURIComponent(folder.coverHash)}/thumbnail`] as const]
				: []));
			return;
		}
		folderCoverUrls = new Map();
		void catalogController.loadFolderCoverAssets(folders.map((folder) => folder.id)).then((assets) => {
			if (!current) return;
			const urls = new Map<string, string>();
			for (const folder of folders) {
				const asset = assets.get(folder.id);
				if (!asset) continue;
				const url = URL.createObjectURL(asset.blob);
				ownedUrls.push(url);
				urls.set(folder.id, url);
			}
			if (current) folderCoverUrls = urls;
		});
		return () => {
			current = false;
			for (const url of ownedUrls) URL.revokeObjectURL(url);
		};
	});

	// Build remote breadcrumbs by walking up the parent chain
	let remoteBreadcrumbs = $derived.by(() => {
		if (!$currentRemoteFolderId || !isRemoteLibrary) return [];
		const crumbs: { id: string; name: string }[] = [];
		let currentId: string | null = $currentRemoteFolderId;
		while (currentId) {
			const folder = remoteFolders.find(
				(f) => f.librarySettingsId === $selectedLibraryId && f.remoteFolderId === currentId
			);
			if (folder) {
				crumbs.unshift({ id: folder.remoteFolderId, name: folder.name });
				currentId = folder.parentFolderId;
			} else {
				break;
			}
		}
		return crumbs;
	});

	// Local breadcrumbs
	let localBreadcrumbs = $derived(buildBreadcrumbs($currentSubfolder));

	// Whether to show the folder browser section
	let showFolderBrowser = $derived.by(() => {
		if (!$selectedLibraryId) return false;
		// Always show when in folder search mode (so search results are visible)
		if ($catalogSearchMode === 'folders' && $catalogSearchQuery.trim()) return true;
		if (isRemoteLibrary) {
			return remoteSubfolders.length > 0 || $currentRemoteFolderId !== null;
		}
		return localSubfolders.length > 0 || $currentSubfolder !== '';
	});

	// Selected library name
	let selectedLibName = $derived(
		recoveredDownloadsSelected
			? 'Recovered Downloads'
			: $selectedLibraryId
			? $settings.libraries.find((l) => l.id === $selectedLibraryId)?.name ?? 'Unknown'
			: null
	);

	function selectLibrary(id: string | null) {
		selectedLibraryId.set(id);
		currentSubfolder.set('');
		currentRemoteFolderId.set(null);
	}

	function navigateToLocalFolder(path: string) {
		currentSubfolder.set(path);
	}

	function navigateToRemoteFolder(folderId: string | null) {
		currentRemoteFolderId.set(folderId);
	}

	// The app-scoped catalog controller owns remote-location caching,
	// coalescing, and cancellation across sidebar/view remounts.
	let remoteFetchGeneration = 0;
	let remoteRetryNonce = $state(0);

	/**
	 * A user-pressed Retry must actually refetch. Invalidating the in-memory
	 * marker is not enough — the persisted freshness gate short-circuits the
	 * call underneath it, so this button did nothing whenever the stored stamp
	 * was recent. Mobile's retry already passes `force`; this is the same
	 * contract.
	 */
	let remoteRetryForced = false;
	function retryRemoteFolderFetch() {
		const libId = $selectedLibraryId;
		if (!libId) return;
		catalogController.invalidateRemoteLocation(libId, $currentRemoteFolderId);
		remoteRetryForced = true;
		remoteRetryNonce += 1;
	}

	$effect(() => {
		remoteRetryNonce;
		const folderId = $currentRemoteFolderId;
		const libId = $selectedLibraryId;
		const generation = ++remoteFetchGeneration;
		if (!libId || !isRemoteLibrary) {
			loadingRemoteFolders = false;
			remoteFolderError = null;
			remoteFolderStatusKey = null;
			return;
		}

		const lib = $settings.libraries.find((l) => l.id === libId);
		if (!lib || !isRemoteServerLibrary(lib)) return;
		const remoteFolderId = isYACReaderLibrary(lib) ? (folderId ?? '1') : folderId;
		const cacheKey = `${libId}:${remoteFolderId ?? 'root'}`;
		const isCurrent = () => generation === remoteFetchGeneration && remoteFolderStatusKey === cacheKey;
		remoteFolderStatusKey = cacheKey;
		remoteFolderError = null;
		loadingRemoteFolders = true;
		const forced = remoteRetryForced;
		remoteRetryForced = false;
		catalogController.refreshRemoteLocation(lib, folderId, forced)
			.then(() => {
				if (isCurrent()) loadingRemoteFolders = false;
			})
			.catch((err) => {
				if ((err as Error)?.name === 'AbortError') return;
				console.warn(`[CatalogSidebar] Failed to refresh remote folder ${remoteFolderId ?? 'root'}:`, err);
				if (isCurrent()) {
					loadingRemoteFolders = false;
					remoteFolderError = err instanceof Error ? err.message : m.catalog_unable_to_sync_this();
				}
			});
	});

	function navigateToRoot() {
		if (isRemoteLibrary) {
			currentRemoteFolderId.set(null);
		} else {
			currentSubfolder.set('');
		}
	}

	function navigateUp() {
		if (isRemoteLibrary) {
			// Find current folder's parent
			if ($currentRemoteFolderId) {
				const currentFolder = remoteFolders.find(
					(f) => f.librarySettingsId === $selectedLibraryId && f.remoteFolderId === $currentRemoteFolderId
				);
				currentRemoteFolderId.set(currentFolder?.parentFolderId ?? null);
			}
		} else {
			const parts = $currentSubfolder.replace(/\\/g, '/').split('/');
			parts.pop();
			currentSubfolder.set(parts.join('/'));
		}
	}

</script>

{#if isMobile || $catalogSidebarOpen}
	<aside
		class="flex h-full shrink-0 flex-col {isMobile ? 'w-full' : 'w-60 border-r border-surface-800 bg-surface-900'}"
		transition:slide={{ axis: 'x', duration: motionDuration(200) }}
		aria-busy={catalogPhase === 'loading' || catalogPhase === 'uninitialized'}
	>
		<!-- Search -->
		<div class="border-b border-surface-800 p-3">
			<div class="flex items-center gap-1.5">
				<div class="relative flex-1">
					<svg class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
					</svg>
					<input
						type="text"
						placeholder={m.catalog_search_mode_placeholder({ mode: $catalogSearchMode })}
						bind:value={$catalogSearchQuery}
						class="w-full rounded-lg border border-surface-700 bg-surface-800 py-1.5 pl-8 pr-3 text-xs text-surface-100 placeholder-surface-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
					/>
					{#if $catalogSearchQuery}
						<button
							class="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300"
							onclick={() => catalogSearchQuery.set('')}
							aria-label={m.catalog_clear_search()}
						>
							<svg class="h-3 w-3" viewBox="0 0 12 12" fill="currentColor">
								<path d="M3.05 3.05a.75.75 0 011.06 0L6 4.94l1.89-1.89a.75.75 0 111.06 1.06L7.06 6l1.89 1.89a.75.75 0 11-1.06 1.06L6 7.06 4.11 8.95a.75.75 0 11-1.06-1.06L4.94 6 3.05 4.11a.75.75 0 010-1.06z" />
							</svg>
						</button>
					{/if}
				</div>
				<!-- Search mode toggle -->
				<button
					onclick={() => catalogSearchMode.update((m) => m === 'comics' ? 'folders' : 'comics')}
					class="shrink-0 rounded-lg border border-surface-700 bg-surface-800 px-2 py-1.5 text-[10px] font-medium transition-colors hover:border-surface-500
						{$catalogSearchMode === 'folders' ? 'text-primary-400' : 'text-surface-400'}"
					title={m.catalog_search_mode_switch_title({ mode: $catalogSearchMode })}
				>
					{#if $catalogSearchMode === 'comics'}
						<!-- Book icon for comics mode -->
						<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
							<path d="M10.75 16.82A7.462 7.462 0 0115 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0018 15.06V3.94a.75.75 0 00-.546-.721A9.006 9.006 0 0015 3a8.963 8.963 0 00-4.25 1.065V16.82zM9.25 4.065A8.963 8.963 0 005 3c-.85 0-1.673.118-2.454.34A.75.75 0 002 4.06v11.12a.75.75 0 00.954.721A7.506 7.506 0 015 15.5c1.579 0 3.042.487 4.25 1.32V4.065z" />
						</svg>
					{:else}
						<!-- Folder icon for folders mode -->
						<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
							<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
						</svg>
					{/if}
				</button>
			</div>
		</div>

		<!-- Scrollable content -->
		<div class="flex-1 overflow-y-auto" bind:this={sidebarScrollContainer}>
			<!-- Libraries section -->
			<div class="border-b border-surface-800 p-3">
				<h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-surface-500">{m.libraries_title()}</h3>
				<div class="space-y-0.5">
					<button
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors
							{$selectedLibraryId === null
								? 'bg-primary-600/20 text-primary-300'
								: 'text-surface-300 hover:bg-surface-800 hover:text-surface-100'}"
						onclick={() => selectLibrary(null)}
					>
						<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
							<path d="M10.75 16.82A7.462 7.462 0 0115 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0018 15.06V3.94a.75.75 0 00-.546-.721A9.006 9.006 0 0015 3a8.963 8.963 0 00-4.25 1.065V16.82zM9.25 4.065A8.963 8.963 0 005 3c-.85 0-1.673.118-2.454.34A.75.75 0 002 4.06v11.12a.75.75 0 00.954.721A7.506 7.506 0 015 15.5c1.579 0 3.042.487 4.25 1.32V4.065z" />
						</svg>
						{m.catalog_all_libraries_button()}
					</button>

					{#if hasRecoveredDownloads}
						<button
							class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors
								{recoveredDownloadsSelected
									? 'bg-primary-600/20 text-primary-300'
									: 'text-surface-300 hover:bg-surface-800 hover:text-surface-100'}"
							onclick={() => selectLibrary(RECOVERED_DOWNLOADS_COLLECTION_ID)}
							title={m.catalog_complete_recovered_books_stored()}
						>
							<svg class="h-3.5 w-3.5 shrink-0 text-primary-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 7h12.5m-11 0 .9-2.7a1.25 1.25 0 011.19-.86h5.32a1.25 1.25 0 011.19.86l.9 2.7m-9.5 0v8.4a1.1 1.1 0 001.1 1.1h7.3a1.1 1.1 0 001.1-1.1V7M7.5 10h5" />
							</svg>
							<span class="min-w-0 flex-1 truncate">{m.catalog_recovered_downloads()}</span>
							<span class="shrink-0 text-[10px] text-surface-500">{recoveredDownloadCount}</span>
						</button>
					{/if}

					{#each visibleLibraries as lib (lib.id)}
						<button
							class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors
								{$selectedLibraryId === lib.id
									? 'bg-primary-600/20 text-primary-300'
									: 'text-surface-300 hover:bg-surface-800 hover:text-surface-100'}"
							onclick={() => selectLibrary(lib.id)}
							title={isLocalLibrary(lib) ? lib.path : isRemoteServerLibrary(lib) ? lib.serverUrl : ''}
						>
							{#if isYACReaderLibrary(lib)}
								<svg class="h-3.5 w-3.5 shrink-0 text-primary-400" viewBox="0 0 20 20" fill="currentColor">
									<path fill-rule="evenodd" d="M4.25 2A2.25 2.25 0 002 4.25v2.5A2.25 2.25 0 004.25 9h2.5A2.25 2.25 0 009 6.75v-2.5A2.25 2.25 0 006.75 2h-2.5zm0 9A2.25 2.25 0 002 13.25v2.5A2.25 2.25 0 004.25 18h2.5A2.25 2.25 0 009 15.75v-2.5A2.25 2.25 0 006.75 11h-2.5zm9-9A2.25 2.25 0 0011 4.25v2.5A2.25 2.25 0 0013.25 9h2.5A2.25 2.25 0 0018 6.75v-2.5A2.25 2.25 0 0015.75 2h-2.5zm0 9A2.25 2.25 0 0011 13.25v2.5A2.25 2.25 0 0013.25 18h2.5A2.25 2.25 0 0018 15.75v-2.5A2.25 2.25 0 0015.75 11h-2.5z" clip-rule="evenodd" />
								</svg>
							{:else if isKomgaLibrary(lib)}
								<svg class="h-3.5 w-3.5 shrink-0 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
									<path d="M10.75 16.82A7.462 7.462 0 0115 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0018 15.06v-11a.75.75 0 00-.546-.721A9.006 9.006 0 0015 3a8.999 8.999 0 00-4.25 1.065v12.755zM9.25 4.065A8.999 8.999 0 005 3c-.85 0-1.673.118-2.454.339A.75.75 0 002 4.06v11a.75.75 0 00.954.721A7.506 7.506 0 015 15.5c1.579 0 3.042.487 4.25 1.32V4.065z" />
								</svg>
							{:else if isKavitaLibrary(lib)}
								<svg class="h-3.5 w-3.5 shrink-0 text-teal-400" viewBox="0 0 20 20" fill="currentColor">
									<path d="M10.75 16.82A7.462 7.462 0 0115 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0018 15.06v-11a.75.75 0 00-.546-.721A9.006 9.006 0 0015 3a8.999 8.999 0 00-4.25 1.065v12.755zM9.25 4.065A8.999 8.999 0 005 3c-.85 0-1.673.118-2.454.339A.75.75 0 002 4.06v11a.75.75 0 00.954.721A7.506 7.506 0 015 15.5c1.579 0 3.042.487 4.25 1.32V4.065z" />
								</svg>
							{:else}
								<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
									<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
								</svg>
							{/if}
							<span class="truncate">{lib.name}</span>
						</button>
					{/each}

					{#if visibleLibraries.length === 0 && !hasRecoveredDownloads}
						<p class="px-2 py-1 text-[10px] text-surface-600">
							{m.catalog_no_libraries_configured_add()}
						</p>
					{/if}
				</div>
			</div>

			<!-- Folder browser (dual-mode: local subfolder paths or remote folder IDs) -->
			{#if showFolderBrowser}
				<div class="border-b border-surface-800 p-3">
					<h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-surface-500">{m.catalog_folders()}</h3>

					<!-- Breadcrumbs -->
					<div class="mb-2 flex flex-wrap items-center gap-0.5 text-[10px]">
						<button
							class="text-primary-400 transition-colors hover:text-primary-300"
							onclick={navigateToRoot}
						>
							{selectedLibName}
						</button>
						{#if isRemoteLibrary}
							{#each remoteBreadcrumbs as crumb (crumb.id)}
								<span class="text-surface-600">/</span>
								<button
									class="truncate text-primary-400 transition-colors hover:text-primary-300"
									onclick={() => navigateToRemoteFolder(crumb.id)}
								>
									{crumb.name}
								</button>
							{/each}
						{:else}
							{#each localBreadcrumbs as crumb (crumb.path)}
								<span class="text-surface-600">/</span>
								<button
									class="truncate text-primary-400 transition-colors hover:text-primary-300"
									onclick={() => navigateToLocalFolder(crumb.path)}
								>
									{crumb.name}
								</button>
							{/each}
						{/if}
					</div>

					<!-- Folder list -->
					<div class="space-y-0.5">
						<!-- Up (..) button -->
						{#if isRemoteLibrary ? $currentRemoteFolderId !== null : $currentSubfolder !== ''}
							<button
								class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-200"
								onclick={navigateUp}
							>
								<svg class="h-3 w-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
									<path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd" />
								</svg>
								..
							</button>
						{/if}

						{#if isRemoteLibrary}
							<!-- Remote folders -->
							{#if loadingRemoteFolders}
								<div class="px-2 py-2 text-[10px] text-surface-500" aria-live="polite">{m.catalog_loading_folders()}</div>
							{:else if remoteFolderError}
								<div class="flex items-center justify-between gap-2 rounded-md bg-red-500/10 px-2 py-2" aria-live="polite">
									<span class="min-w-0 text-[10px] text-red-400">{remoteFolderError}</span>
									{#if selectedLib && isYACReaderLibrary(selectedLib)}
										<button
											type="button"
											onclick={retryRemoteFolderFetch}
											class="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-500/20"
										>
											{m.reader_retry()}
										</button>
									{/if}
								</div>
							{/if}
							{#each remoteSubfolders as folder (folder.id)}
								{@const sidebarCoverUrl = folderCoverUrls.get(folder.id)}
								<button
									use:observeSidebarFolderCover={folder.id}
									class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-100"
									onclick={() => navigateToRemoteFolder(folder.remoteFolderId)}
								>
									{#if sidebarCoverUrl}
										<img src={sidebarCoverUrl} alt="" class="h-5 w-4 shrink-0 rounded-sm object-cover" />
									{:else}
										<svg class="h-3 w-3 shrink-0 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
											<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
										</svg>
									{/if}
									<span class="truncate">{folder.name}</span>
									{#if folder.numChildren > 0}
										<span class="ml-auto text-[9px] text-surface-600">{folder.numChildren}</span>
									{/if}
								</button>
							{/each}
						{:else}
							<!-- Local subfolders -->
							{#each localSubfolders as folder (folder)}
								<button
									class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-100"
									onclick={() => navigateToLocalFolder($currentSubfolder ? $currentSubfolder + '/' + folder : folder)}
								>
									<svg class="h-3 w-3 shrink-0 text-surface-500" viewBox="0 0 20 20" fill="currentColor">
										<path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
									</svg>
									<span class="truncate">{folder}</span>
								</button>
							{/each}
						{/if}
					</div>
				</div>
			{/if}

			</div>
	</aside>
{/if}

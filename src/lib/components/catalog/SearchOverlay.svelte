<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * SearchOverlay — the full-screen library search behind the floating
	 * button. Scope is subtree-recursive (the locked decision): inside a
	 * subfolder it searches that subtree, at a library root the whole
	 * library, at the All-Libraries root everything. Results show folder
	 * provenance when a match lives in a subfolder. The input docks at the
	 * bottom, riding --viewport-height so the keyboard never covers it.
	 */
	import { fade } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { fadeOnDecode } from '$lib/util/fade-on-decode.js';
	import { get } from 'svelte/store';
	import {
		catalogRowToVolume,
		remoteSubtreeParentKeys,
		searchCatalogFolders,
		searchCatalogSubtree,
		type CatalogSearchScope,
		type FolderSearchResult
	} from '$lib/catalog/catalog-repository.js';
	import { getThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
	import { catalogController } from '$lib/controllers/catalog-controller.js';
	import { catalogSearchMode, currentRemoteFolderId, currentSubfolder, selectedLibraryId } from '$lib/stores/catalog-state.js';
	import { settings, isRemoteServerLibrary } from '$lib/settings/settings.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import type { CatalogRow, VolumeMetadata } from '$lib/types/index.js';

	interface Props {
		onclose: () => void;
		onopen: (volume: VolumeMetadata) => void;
		onopenfolder: (folder: FolderSearchResult) => void;
	}

	let { onclose, onopen, onopenfolder }: Props = $props();

	const RECENTS_KEY = 'fumeto-recent-searches';
	const MAX_RESULTS = 60;

	let query = $state('');
	let results = $state<CatalogRow[]>([]);
	let folderResults = $state<FolderSearchResult[]>([]);
	let searched = $state(false);
	let thumbUrls = $state<Map<string, string>>(new Map());
	let inputElement = $state<HTMLInputElement | null>(null);
	let recents = $state<string[]>(readRecents());
	let searchGeneration = 0;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	function readRecents(): string[] {
		try {
			const raw = localStorage.getItem(RECENTS_KEY);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
		} catch {
			return [];
		}
	}

	function rememberSearch(term: string): void {
		const trimmed = term.trim();
		if (!trimmed) return;
		recents = [trimmed, ...recents.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase())].slice(0, 8);
		localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
	}

	let scopeLabel = $derived.by(() => {
		const libraryId = $selectedLibraryId;
		if (!libraryId) return m.catalog_all_libraries();
		const library = $settings.libraries.find((entry) => entry.id === libraryId);
		const name = library?.name ?? 'Library';
		if ($currentSubfolder) return `${name} · ${$currentSubfolder.split('/').pop()}`;
		if ($currentRemoteFolderId) return `${name} · this folder`;
		return name;
	});

	async function resolveScope(): Promise<CatalogSearchScope> {
		const libraryId = get(selectedLibraryId);
		if (!libraryId) return { libraryId: null };
		const library = get(settings).libraries.find((entry) => entry.id === libraryId);
		const remoteFolderId = get(currentRemoteFolderId);
		if (library && isRemoteServerLibrary(library) && remoteFolderId) {
			return { libraryId, remoteParentKeys: await remoteSubtreeParentKeys(libraryId, remoteFolderId) };
		}
		return { libraryId, folderPrefix: get(currentSubfolder) };
	}

	async function runSearch(term: string): Promise<void> {
		const generation = ++searchGeneration;
		if (!term.trim()) {
			results = [];
			folderResults = [];
			searched = false;
			return;
		}
		const scope = await resolveScope();
		if (get(catalogSearchMode) === 'folders') {
			const folders = (await searchCatalogFolders(scope, term)).slice(0, MAX_RESULTS);
			if (generation !== searchGeneration) return;
			folderResults = folders;
			results = [];
			searched = true;
			return;
		}
		const rows = (await searchCatalogSubtree(scope, term)).slice(0, MAX_RESULTS);
		if (generation !== searchGeneration) return;
		results = rows;
		folderResults = [];
		searched = true;
		const assets = await catalogController.loadThumbnailAssets(rows.map((row) => row.volume_uuid));
		if (generation !== searchGeneration) return;
		thumbUrls = new Map(rows.flatMap((row) => {
			const asset = assets.get(row.volume_uuid);
			const url = getThumbnailUrl(row.volume_uuid, asset?.blob, asset?.revision);
			return url ? [[row.volume_uuid, url] as const] : [];
		}));
	}

	$effect(() => {
		const term = query;
		void $catalogSearchMode;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => void runSearch(term), 120);
		return () => clearTimeout(debounceTimer);
	});

	$effect(() => {
		inputElement?.focus();
	});

	function openResult(row: CatalogRow): void {
		rememberSearch(query);
		onopen(catalogRowToVolume(row));
	}

	function openFolderResult(folder: FolderSearchResult): void {
		rememberSearch(query);
		onopenfolder(folder);
	}

	function folderProvenance(folder: FolderSearchResult): string {
		const libraryName = $settings.libraries.find((entry) => entry.id === folder.libraryId)?.name ?? '';
		if (folder.kind === 'local') {
			const parent = folder.path.includes('/') ? folder.path.slice(0, folder.path.lastIndexOf('/')) : '';
			if (parent) return parent;
		}
		return $selectedLibraryId ? '' : libraryName;
	}

	function provenance(row: CatalogRow): string {
		if (row.folder_path) return row.folder_path;
		if (!$selectedLibraryId) {
			return $settings.libraries.find((entry) => entry.id === row.library_id)?.name ?? '';
		}
		return '';
	}
</script>

<div
	class="fixed inset-0 z-[70] flex flex-col bg-[var(--color-surface-base)]"
	style="height: var(--viewport-height, 100dvh); padding-top: var(--sat, 0px); padding-left: var(--sal, 0px); padding-right: var(--sar, 0px);"
	role="dialog"
	aria-label={m.catalog_search_library()}
	tabindex="-1"
	data-library-search-overlay
	in:fade={{ duration: motionDuration(140) }}
	out:fade={{ duration: motionDuration(exitDuration(140)) }}
	onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onclose(); } }}
>
	<header class="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
		<div class="min-w-0">
			<p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary-400">{m.catalog_search()}</p>
			<p class="truncate text-sm font-semibold text-surface-100" data-library-search-scope>{scopeLabel}</p>
		</div>
		<button
			type="button"
			class="flex h-11 shrink-0 items-center justify-center rounded-full px-4 text-sm font-medium text-surface-300 transition-colors active:bg-surface-800"
			onclick={onclose}
			data-library-search-cancel
		>
			{m.common_cancel()}
		</button>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
		{#if query.trim() === ''}
			{#if recents.length > 0}
				<p class="px-1 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-surface-500">{m.catalog_recent_searches()}</p>
				<div class="flex flex-wrap gap-1.5" data-library-search-recents>
					{#each recents as recent (recent)}
						<button
							type="button"
							class="h-9 rounded-full bg-surface-container-high px-3.5 text-xs text-surface-200 transition-colors active:bg-surface-700"
							onclick={() => (query = recent)}
						>
							{recent}
						</button>
					{/each}
				</div>
			{:else}
				<p class="px-1 py-6 text-center text-xs text-surface-500">
					{$catalogSearchMode === 'folders' ? m.catalog_search_folder_names_in({ scopeLabel }) : m.catalog_search_titles_and_filenames({ scopeLabel })}
				</p>
			{/if}
		{:else if searched && ($catalogSearchMode === 'folders' ? folderResults.length === 0 : results.length === 0)}
			<div class="px-1 py-6 text-center" data-library-search-empty>
				<p class="select-none text-xl tracking-wide text-surface-500" aria-hidden="true">(・_・?)</p>
				<p class="mt-2 text-xs text-surface-500">{m.catalog_no_matches_for({ query: query.trim() })}</p>
			</div>
		{:else if $catalogSearchMode === 'folders'}
			<div class="space-y-1" data-library-search-results>
				{#each folderResults as folder (folder.kind === 'local' ? `local:${folder.libraryId}:${folder.path}` : `remote:${folder.libraryId}:${folder.remoteFolderId}`)}
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-[var(--radius-card)] p-2 text-left transition-colors active:bg-surface-800"
						onclick={() => openFolderResult(folder)}
						data-folder-result
					>
						<div class="flex h-[56px] w-[40px] shrink-0 items-center justify-center rounded bg-surface-800 text-surface-400">
							<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
						</div>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium text-surface-100">{folder.name}</p>
							<p class="truncate text-[11px] text-surface-500">
								{m.catalog_folder_result()}{#if folderProvenance(folder)}&nbsp;· {folderProvenance(folder)}{/if}
							</p>
						</div>
					</button>
				{/each}
			</div>
		{:else}
			<div class="space-y-1" data-library-search-results>
				{#each results as row (row.volume_uuid)}
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-[var(--radius-card)] p-2 text-left transition-colors active:bg-surface-800"
						onclick={() => openResult(row)}
					>
						<div class="h-[56px] w-[40px] shrink-0 overflow-hidden rounded bg-surface-800">
							{#if thumbUrls.get(row.volume_uuid)}
								<img src={thumbUrls.get(row.volume_uuid)} alt="" class="h-full w-full object-cover" use:fadeOnDecode />
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium text-surface-100">{row.title}</p>
							<p class="truncate text-[11px] text-surface-500">
								{row.page_count}p{#if provenance(row)}&nbsp;· {provenance(row)}{/if}
							</p>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- max(--sab, --kb): the native inset bridge reports the soft keyboard's
	     occlusion as --kb (edge-to-edge Android never resizes the viewport for
	     it), so the mode segment and input ride up above the keyboard. -->
	<div class="shrink-0 border-t border-surface-800 px-4 pt-2.5" style="padding-bottom: calc(max(var(--sab, 0px), var(--kb, 0px)) + 12px);">
		<div class="relative mb-2 grid grid-cols-2 gap-1 rounded-full bg-surface-container-high p-1" role="radiogroup" aria-label={m.catalog_search_mode()} data-library-search-mode use:slidingSelection>
			<button
				type="button"
				role="radio"
				aria-checked={$catalogSearchMode === 'comics'}
				class="press-morph relative h-9 min-w-0 truncate rounded-full text-[11px] font-semibold {$catalogSearchMode === 'comics' ? 'text-on-accent-strong' : 'text-surface-400 active:bg-surface-800'}"
				onclick={() => { playReaderHaptic('selection'); catalogSearchMode.set('comics'); inputElement?.focus(); }}
			>
				{m.catalog_comics()}
			</button>
			<button
				type="button"
				role="radio"
				aria-checked={$catalogSearchMode === 'folders'}
				class="press-morph relative h-9 min-w-0 truncate rounded-full text-[11px] font-semibold {$catalogSearchMode === 'folders' ? 'text-on-accent-strong' : 'text-surface-400 active:bg-surface-800'}"
				onclick={() => { playReaderHaptic('selection'); catalogSearchMode.set('folders'); inputElement?.focus(); }}
			>
				{m.catalog_folders()}
			</button>
		</div>
		<input
			bind:this={inputElement}
			bind:value={query}
			type="search"
			placeholder={m.catalog_search_scope_placeholder({ scope: scopeLabel })}
			aria-label={m.catalog_search_library()}
			autocapitalize="off"
			autocorrect="off"
			class="w-full rounded-full border border-surface-700 bg-surface-container-high px-4 py-3 text-sm text-surface-100 placeholder-surface-500 focus:border-primary-500 focus:outline-none"
			data-library-search-input
		/>
	</div>
</div>

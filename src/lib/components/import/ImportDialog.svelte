<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { fade, scale } from 'svelte/transition';
	import { importDialogOpen, isImporting, importProgressMessage } from '$lib/stores/ui-state.js';
	import { openReader } from '$lib/stores/reader-state.js';
	import { importArchive, importToLibrary } from '$lib/import/import-service.js';
	import { resolveDisplayName } from '$lib/util/file-utils.js';
	import { db } from '$lib/db/index.js';
	import { open } from '@tauri-apps/plugin-dialog';
	import {
		fileSource,
		importSourcesSequentially,
		partitionImportSources,
		pathSource,
		type ImportSource
	} from '$lib/import/import-sources.js';
	import { listenForFileDrops } from '$lib/desktop/file-drop.js';
	import { isMobile, isTauriDesktop } from '$lib/util/platform.js';
	import { settings, isLocalLibrary } from '$lib/settings/settings.js';
	import { recallLocalTarget, rememberLocalTarget, selectedLibraryId } from '$lib/stores/catalog-state.js';
	import { get } from 'svelte/store';

	const supportedExtensions = isMobile
		? ['zip', 'cbz', 'epub', 'pdf']
		: ['zip', 'cbz', 'cbr', 'rar', 'epub', 'pdf'];
	const supportedLabel = isMobile ? '.zip, .cbz, .epub, .pdf' : '.zip, .cbz, .cbr, .rar, .epub, .pdf';

	let dragOver = $state(false);
	let errorMessage = $state('');
	let importResult = $state<{ succeeded: number; failed: { name: string; error: string }[]; deleteFailures?: string[] } | null>(null);

	// Mobile multi-step state
	type MobileStep = 'select' | 'assign' | 'importing' | 'results';
	let mobileStep = $state<MobileStep>('select');
	let selectedPaths = $state<string[]>([]);
	let assignAuthor = $state('');
	let assignSeries = $state('');
	let deleteOriginals = $state(false);
	let existingAuthors = $state<string[]>([]);
	let existingSeriesForAuthor = $state<string[]>([]);

	/**
	 * The import target is an explicit, visible choice: default to the
	 * selected library when it is local, else the remembered last target,
	 * else the first local library (locked decision: only/last-used).
	 */
	let targetLibraryId = $state<string | null>(null);
	let localLibraries = $derived($settings.libraries.filter(isLocalLibrary));
	$effect(() => {
		if (!$importDialogOpen) return;
		if (targetLibraryId && localLibraries.some((lib) => lib.id === targetLibraryId)) return;
		const selected = get(selectedLibraryId);
		if (selected && localLibraries.some((lib) => lib.id === selected)) {
			targetLibraryId = selected;
			return;
		}
		const remembered = recallLocalTarget();
		targetLibraryId = remembered && localLibraries.some((lib) => lib.id === remembered)
			? remembered
			: (localLibraries[0]?.id ?? null);
	});

	function getActiveLocalLibrary() {
		const s = get(settings);
		const lib = s.libraries.find((entry) => entry.id === targetLibraryId);
		if (lib && isLocalLibrary(lib)) return lib;
		return s.libraries.find(isLocalLibrary) ?? null;
	}

	/** Load existing authors from library volumes (from folder_path first segment + author field). */
	async function loadExistingAuthors() {
		const volumes = await db.volumes.toArray();
		const authors = new Set<string>();
		for (const v of volumes) {
			if (v.author) authors.add(v.author);
			// Also extract author from folder_path (set by scanner: "AuthorName/SeriesName")
			if (v.folder_path) {
				const first = v.folder_path.split('/')[0];
				if (first) authors.add(first);
			}
		}
		existingAuthors = [...authors].sort((a, b) => a.localeCompare(b));
	}

	/** Load existing series for a given author (from folder_path second segment). */
	async function loadSeriesForAuthor(author: string) {
		if (!author) { existingSeriesForAuthor = []; return; }
		const volumes = await db.volumes.toArray();
		const series = new Set<string>();
		for (const v of volumes) {
			if (!v.folder_path) continue;
			const parts = v.folder_path.split('/');
			// Match author via folder_path first segment OR the author field
			const matchesAuthor = parts[0] === author || v.author === author;
			if (matchesAuthor && parts.length >= 2) {
				series.add(parts[1]);
			}
		}
		existingSeriesForAuthor = [...series].sort((a, b) => a.localeCompare(b));
	}

	/** Mobile: open file picker and go to assignment step. */
	async function handleMobileOpen() {
		const selected = await open({
			multiple: true,
			filters: [{ name: m.import_filter_manga_archives(), extensions: supportedExtensions }]
		});
		if (!selected) return;

		const paths = Array.isArray(selected) ? selected : [selected];
		if (paths.length === 0) return;

		selectedPaths = paths;
		assignAuthor = '';
		assignSeries = '';
		deleteOriginals = false;
		await loadExistingAuthors();
		mobileStep = 'assign';
	}

	/** Mobile: start the import (copy to library + scan). */
	async function handleMobileImport() {
		const lib = getActiveLocalLibrary();
		if (!lib) {
			errorMessage = m.import_no_local_library();
			return;
		}

		rememberLocalTarget(lib.id);
		mobileStep = 'importing';
		isImporting.set(true);
		errorMessage = '';

		const assignments = selectedPaths.map(() => ({
			author: assignAuthor.trim() || undefined,
			series: assignSeries.trim() || undefined,
		}));

		try {
			const result = await importToLibrary(
				selectedPaths,
				lib.path,
				lib.id,
				assignments,
				deleteOriginals,
				(msg) => importProgressMessage.set(msg),
			);

			// Indexing failures are import failures from the user's perspective: a
			// file that copied but did not index never appears in the library.
			const scanFailures = (result.scan?.failed ?? []).map((f) => ({
				name: resolveDisplayName(f.path),
				error: m.import_indexing_failed({ detail: f.error }),
			}));
			importResult = {
				succeeded: result.succeeded.length - scanFailures.length,
				failed: [
					...result.failed.map(f => ({
						name: resolveDisplayName(f.path),
						error: f.error,
					})),
					...scanFailures,
				],
				deleteFailures: result.deleteFailures,
			};
		} catch (err) {
			importResult = {
				succeeded: 0,
				failed: [{ name: m.common_import(), error: err instanceof Error ? err.message : String(err) }],
			};
		}

		isImporting.set(false);
		importProgressMessage.set('');
		mobileStep = 'results';

		if (importResult.failed.length === 0 && (!importResult.deleteFailures || importResult.deleteFailures.length === 0)) {
			setTimeout(() => {
				importResult = null;
				mobileStep = 'select';
				importDialogOpen.set(false);
			}, 2000);
		}
	}

	/** Open the native file picker dialog and import selected files (desktop). */
	async function handleNativeOpen() {
		const selected = await open({
			multiple: true,
			filters: [{
				name: m.import_filter_manga_archives(),
				extensions: supportedExtensions
			}]
		});

		if (!selected) return; // User cancelled

		const paths = Array.isArray(selected) ? selected : [selected];
		// Paths, not Files: each archive is read only when its turn comes.
		await handleImportSources(paths.map((path) => pathSource(path)));
	}

	/** Handle files from an HTML5 drop (the browser dev server; the app gets paths). */
	function handleDroppedFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		void handleImportSources(Array.from(files, fileSource));
	}

	// The desktop app: Tauri takes OS file drops for itself, so the HTML5 drop
	// handlers below never fire there. Its drag-drop events carry paths.
	$effect(() => {
		if (!$importDialogOpen || !isTauriDesktop()) return;
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void listenForFileDrops({
			onHover: (active) => {
				dragOver = active && !$isImporting;
			},
			onDrop: (paths) => {
				if ($isImporting) return;
				void handleImportSources(paths.map((path) => pathSource(path)));
			}
		})
			.then((stop) => {
				if (disposed) stop();
				else unlisten = stop;
			})
			.catch((err) => console.warn('[import] could not listen for dropped files:', err));
		return () => {
			disposed = true;
			unlisten?.();
			dragOver = false;
		};
	});

	/** Core import logic (desktop flow): validate by name, then import one file at a time. */
	async function handleImportSources(sources: ImportSource[]) {
		if (sources.length === 0) return;

		const existingVolumes = await db.volumes.toArray();
		const {
			accepted: newFiles,
			unsupported: invalidNames,
			duplicates: duplicateNames
		} = partitionImportSources(sources, supportedExtensions, new Set(existingVolumes.map((v) => v.filename)));

		if (newFiles.length === 0 && duplicateNames.length === 0) {
			errorMessage = invalidNames.length > 0
				? m.import_unsupported_types({ names: invalidNames.join(', '), formats: supportedLabel })
				: m.import_no_files();
			return;
		}

		if (newFiles.length === 0) {
			errorMessage = duplicateNames.length === 1
				? m.import_duplicate_one({ name: duplicateNames[0] })
				: m.import_duplicate_all({ n: duplicateNames.length });
			return;
		}

		const warnings: string[] = [];
		if (invalidNames.length > 0) {
			warnings.push(m.import_skipped_unsupported({ names: invalidNames.join(', ') }));
		}
		if (duplicateNames.length > 0) {
			warnings.push(m.import_already_imported({ names: duplicateNames.join(', ') }));
		}

		errorMessage = warnings.join('. ');
		importResult = null;
		isImporting.set(true);

		const totalFiles = newFiles.length;
		const prefixFor = (index: number, name: string) =>
			totalFiles > 1 ? `[${index + 1}/${totalFiles}] ${name}: ` : '';

		const { succeeded, failed } = await importSourcesSequentially(
			newFiles,
			(file, index) => {
				const prefix = prefixFor(index, newFiles[index].name);
				return importArchive(file, (progress) => {
					importProgressMessage.set(`${prefix}${renderUserMessage(progress.message)}`);
				});
			},
			{
				onStart: (index, source) => importProgressMessage.set(`${prefixFor(index, source.name)}${m.import_starting()}`),
				fallbackError: () => m.import_failed()
			}
		);

		isImporting.set(false);
		importProgressMessage.set('');

		if (totalFiles === 1 && succeeded.length === 1) {
			// Single file — auto-open in reader (existing behavior)
			const metadata = await db.volumes.get(succeeded[0]);
			if (metadata) await openReader({ ...metadata, current_page: 0 }, 'catalog');

			importDialogOpen.set(false);
		} else {
			// Multiple files — show results summary
			importResult = { succeeded: succeeded.length, failed };
			if (failed.length === 0) {
				// All succeeded — auto-close after brief delay
				setTimeout(() => {
					importResult = null;
					importDialogOpen.set(false);
				}, 2000);
			}
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		handleDroppedFiles(e.dataTransfer?.files ?? null);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function handleDragLeave() {
		dragOver = false;
	}

	function close() {
		if (!$isImporting) {
			importResult = null;
			errorMessage = '';
			mobileStep = 'select';
			selectedPaths = [];
			importDialogOpen.set(false);
		}
	}
</script>

{#if $importDialogOpen}
	<!-- Backdrop -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) close(); }}
		data-dialog
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		>
			<h2 class="mb-4 text-lg font-semibold text-surface-100">{m.import_title()}</h2>

			{#if isMobile}
				<!-- ============ Mobile multi-step flow ============ -->
				{#if mobileStep === 'importing'}
					<div class="py-8 text-center">
						<div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
						<p class="text-sm text-surface-300">{$importProgressMessage}</p>
					</div>

				{:else if mobileStep === 'results' && importResult}
					<div class="space-y-3 py-4">
						{#if importResult.succeeded > 0}
							<div class="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5">
								<span class="text-lg">✓</span>
								<p class="text-sm text-green-400">
									{m.import_success_count({ n: importResult.succeeded })}
								</p>
							</div>
						{/if}
						{#if importResult.failed.length > 0}
							<div class="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5">
								<p class="mb-2 text-sm text-red-400">
									{importResult.failed.length} import{importResult.failed.length !== 1 ? 's' : ''} failed:
								</p>
								<ul class="space-y-1">
									{#each importResult.failed as f}
										<li class="text-xs text-red-300">
											<span class="font-medium">{f.name}</span>
											<span class="text-red-400/70"> — {f.error}</span>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
						{#if importResult.deleteFailures && importResult.deleteFailures.length > 0}
							<div class="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5">
								<p class="text-xs text-yellow-400">
									{m.import_delete_failures({ n: importResult.deleteFailures.length })}
								</p>
							</div>
						{/if}
					</div>
					<div class="flex justify-end">
						<button onclick={close} class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors active:bg-primary-700">
							{m.common_done()}
						</button>
					</div>

				{:else if mobileStep === 'assign'}
					<!-- Step 2: Author/Series assignment -->
					<div class="space-y-4">
						<label class="flex items-center gap-2 text-xs text-surface-400" data-import-target-row>
							<span class="shrink-0">{m.import_into()}</span>
							<select
								bind:value={targetLibraryId}
								disabled={localLibraries.length <= 1}
								class="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-800 px-2 py-1.5 text-xs text-surface-100 focus:border-primary-500 focus:outline-none disabled:opacity-70"
								data-import-target
							>
								{#each localLibraries as lib (lib.id)}
									<option value={lib.id}>{lib.name}</option>
								{/each}
							</select>
						</label>
						<div class="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
							<p class="mb-1 text-xs font-medium text-surface-400">{selectedPaths.length} file{selectedPaths.length !== 1 ? 's' : ''} selected</p>
							<ul class="max-h-24 space-y-0.5 overflow-y-auto text-xs text-surface-300">
								{#each selectedPaths as p}
									<li class="truncate">{resolveDisplayName(p)}</li>
								{/each}
							</ul>
						</div>

						<div>
							<label for="import-author" class="mb-1 block text-xs font-medium text-surface-400">{m.import_author_label()}</label>
							<input
								id="import-author"
								type="text"
								list="author-suggestions"
								bind:value={assignAuthor}
								oninput={() => loadSeriesForAuthor(assignAuthor)}
								placeholder={m.import_author_placeholder()}
								class="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
							/>
							<datalist id="author-suggestions">
								{#each existingAuthors as a}
									<option value={a}></option>
								{/each}
							</datalist>
						</div>

						{#if assignAuthor.trim()}
							<div>
								<label for="import-series" class="mb-1 block text-xs font-medium text-surface-400">{m.import_series_label()}</label>
								<input
									id="import-series"
									type="text"
									list="series-suggestions"
									bind:value={assignSeries}
									placeholder={m.import_series_placeholder()}
									class="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
								/>
								<datalist id="series-suggestions">
									{#each existingSeriesForAuthor as s}
										<option value={s}></option>
									{/each}
								</datalist>
							</div>
						{/if}

						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="flex items-center gap-2.5">
							<input type="checkbox" bind:checked={deleteOriginals} class="h-4 w-4 rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500" />
							<span class="text-xs text-surface-300">{m.import_delete_originals()}</span>
						</label>
					</div>

					<div class="mt-5 flex justify-end gap-2">
						<button onclick={() => { mobileStep = 'select'; selectedPaths = []; }} class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors active:text-surface-200">
							{m.common_back()}
						</button>
						<button onclick={handleMobileImport} class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors active:bg-primary-700">
							{m.import_submit_count({ n: selectedPaths.length })}
						</button>
					</div>

				{:else}
					<!-- Step 1: File selection -->
					<div
						class="mb-4 flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-surface-600 p-6 transition-colors active:border-primary-400 active:bg-primary-500/10"
						role="button"
						tabindex="0"
						onclick={handleMobileOpen}
						onkeydown={(e) => { if (e.key === 'Enter') handleMobileOpen(); }}
					>
						<p class="mb-2 text-2xl">📚</p>
						<p class="text-sm text-surface-300">{m.import_tap_select()}</p>
						<p class="mt-1 text-xs text-surface-500">{m.import_supports({ formats: supportedLabel })}</p>
					</div>

					{#if errorMessage}
						<div class="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
							{errorMessage}
						</div>
					{/if}

					<div class="flex justify-end">
						<button onclick={close} class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors active:text-surface-200">
							{m.common_cancel()}
						</button>
					</div>
				{/if}

			{:else}
				<!-- ============ Desktop flow (unchanged) ============ -->
				{#if $isImporting}
					<div class="py-8 text-center">
						<div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
						<p class="text-sm text-surface-300">{$importProgressMessage}</p>
					</div>
				{:else if importResult}
					<div class="space-y-3 py-4">
						{#if importResult.succeeded > 0}
							<div class="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5">
								<span class="text-lg">✓</span>
								<p class="text-sm text-green-400">
									{m.import_success_count_desktop({ n: importResult.succeeded })}
								</p>
							</div>
						{/if}
						{#if importResult.failed.length > 0}
							<div class="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5">
								<p class="mb-2 text-sm text-red-400">
									{importResult.succeeded === 0 ? m.import_failed_all() : m.import_failed_count({ n: importResult.failed.length })}
								</p>
								<ul class="space-y-1">
									{#each importResult.failed as f}
										<li class="text-xs text-red-300">
											<span class="font-medium">{f.name}</span>
											<span class="text-red-400/70"> — {f.error}</span>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					</div>
					<div class="flex justify-end">
						<button onclick={close} class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700">
							{m.common_done()}
						</button>
					</div>
				{:else}
					<div
						class="mb-4 flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors {dragOver
							? 'border-primary-400 bg-primary-500/10'
							: 'border-surface-600 hover:border-surface-400'}"
						role="button"
						tabindex="0"
						ondrop={handleDrop}
						ondragover={handleDragOver}
						ondragleave={handleDragLeave}
						onclick={handleNativeOpen}
						onkeydown={(e) => { if (e.key === 'Enter') handleNativeOpen(); }}
					>
						<p class="mb-2 text-2xl">📚</p>
						<p class="text-sm text-surface-300">
							{m.import_drop_hint()}
						</p>
						<p class="mt-1 text-xs text-surface-500">
							{m.import_supports({ formats: supportedLabel })}
						</p>
					</div>

					{#if errorMessage}
						<div class="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
							{errorMessage}
						</div>
					{/if}

					<div class="flex justify-end">
						<button onclick={close} class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200">
							{m.common_cancel()}
						</button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

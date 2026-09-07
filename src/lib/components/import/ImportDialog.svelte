<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { fade, scale } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { importDialogOpen, isImporting, importProgressMessage, settingsDialogOpen } from '$lib/stores/ui-state.js';
	import { appView, openReader } from '$lib/stores/reader-state.js';
	import { importArchive, importToLibrary } from '$lib/import/import-service.js';
	import { resolveDisplayName } from '$lib/util/file-utils.js';
	import { db } from '$lib/db/index.js';
	import { open } from '@tauri-apps/plugin-dialog';
	import { readDir, stat } from '@tauri-apps/plugin-fs';
	import { appDataDir, join } from '@tauri-apps/api/path';
	import { filePathToFile } from '$lib/import/tauri-file-bridge.js';
	import { isDesktopTauri, isMobile } from '$lib/util/platform.js';
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

		if (isDesktopTauri) {
			await importPathsIntoLocalLibrary(paths);
			return;
		}

		// Convert native paths to File objects
		const files: File[] = [];
		for (const path of paths) {
			try {
				const file = await filePathToFile(path);
				files.push(file);
			} catch (err) {
				console.error(`Failed to read file: ${path}`, err);
			}
		}

		if (files.length > 0) {
			await handleFilesArray(files);
		}
	}

	/**
	 * The library a desktop import copies into: the app's own "Local Comics"
	 * library (created at launch under the app data directory), or the local
	 * library the dialog was opened for. A folder the user already owns is
	 * never the target — that is what Settings → Libraries is for.
	 */
	async function resolveDesktopImportLibrary() {
		const s = get(settings);
		try {
			const comicsPath = await join(await appDataDir(), 'Comics');
			const own = s.libraries.filter(isLocalLibrary).find((entry) => entry.path === comicsPath);
			if (own) return own;
		} catch {
			// Fall through to the dialog's own target.
		}
		return getActiveLocalLibrary();
	}

	/**
	 * Desktop: files chosen in the dialog or dropped on the window are copied
	 * into the local library and picked up by its scan, exactly as a phone's
	 * import does. An archive kept only inside the browser database would
	 * belong to no library and never appear in the catalog.
	 */
	async function importPathsIntoLocalLibrary(paths: string[]): Promise<void> {
		const lib = await resolveDesktopImportLibrary();
		if (!lib) {
			errorMessage = m.import_no_local_library();
			return;
		}
		rememberLocalTarget(lib.id);
		isImporting.set(true);
		errorMessage = '';
		try {
			const result = await importToLibrary(
				paths,
				lib.path,
				lib.id,
				paths.map(() => ({})),
				false,
				(message) => importProgressMessage.set(message)
			);
			const failed = result.failed.map((entry) => ({
				name: entry.path.split(/[\\/]/).pop() ?? entry.path,
				error: entry.error
			}));
			if (paths.length === 1 && result.succeeded.length === 1) {
				// Single file — open it, as the browser flow does.
				const filename = result.succeeded[0].split(/[\\/]/).pop() ?? '';
				const metadata = (await db.volumes.where('library_id').equals(lib.id).toArray())
					.find((volume) => volume.filename === filename);
				if (metadata) await openReader({ ...metadata, current_page: 0 }, 'catalog');
				importDialogOpen.set(false);
				return;
			}
			importResult = { succeeded: result.succeeded.length, failed };
			if (failed.length === 0) {
				setTimeout(() => {
					importResult = null;
					importDialogOpen.set(false);
				}, 2000);
			}
		} finally {
			isImporting.set(false);
			importProgressMessage.set('');
		}
	}

	/** Handle files from drag/drop (provides File objects directly). */
	function handleDroppedFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		handleFilesArray(Array.from(files));
	}

	/** Core import logic — accepts an array of File objects (desktop flow). */
	async function handleFilesArray(files: File[]) {
		if (files.length === 0) return;

		// Validate all files up front
		const validFiles: File[] = [];
		const invalidNames: string[] = [];
		for (const file of files) {
			const ext = file.name.split('.').pop()?.toLowerCase() || '';
			if (supportedExtensions.includes(ext)) {
				validFiles.push(file);
			} else {
				invalidNames.push(file.name);
			}
		}

		if (validFiles.length === 0) {
			errorMessage = invalidNames.length > 0
				? m.import_unsupported_types({ names: invalidNames.join(', '), formats: supportedLabel })
				: m.import_no_files();
			return;
		}

		// Check for duplicates against existing library
		const existingVolumes = await db.volumes.toArray();
		const existingFilenames = new Set(existingVolumes.map((v) => v.filename));
		const duplicateNames: string[] = [];
		const newFiles: File[] = [];

		for (const file of validFiles) {
			if (existingFilenames.has(file.name)) {
				duplicateNames.push(file.name);
			} else {
				newFiles.push(file);
			}
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
		const succeeded: string[] = [];
		const failed: { name: string; error: string }[] = [];

		for (let i = 0; i < newFiles.length; i++) {
			const file = newFiles[i];
			const prefix = totalFiles > 1 ? `[${i + 1}/${totalFiles}] ${file.name}: ` : '';
			importProgressMessage.set(`${prefix}${m.import_starting()}`);

			try {
				const volumeUuid = await importArchive(file, (progress) => {
					importProgressMessage.set(`${prefix}${renderUserMessage(progress.message)}`);
				});
				succeeded.push(volumeUuid);
			} catch (err) {
				failed.push({
					name: file.name,
					error: err instanceof Error ? err.message : m.import_failed()
				});
			}
		}

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

	function extensionOf(name: string): string {
		return name.split('.').pop()?.toLowerCase() || '';
	}

	/**
	 * Files dropped from the desktop arrive as paths. A dropped folder
	 * contributes its supported files one level deep — a whole library tree
	 * belongs in Settings → Libraries, not in a single import — while a
	 * dropped file is passed through as-is so an unsupported one is named in
	 * the same message the file dialog would produce.
	 */
	async function expandDroppedPaths(paths: string[]): Promise<string[]> {
		const files: string[] = [];
		for (const path of paths) {
			try {
				const info = await stat(path);
				if (!info.isDirectory) {
					files.push(path);
					continue;
				}
				for (const entry of await readDir(path)) {
					if (!entry.isFile || !supportedExtensions.includes(extensionOf(entry.name))) continue;
					files.push(await join(path, entry.name));
				}
			} catch (err) {
				console.error('Dropped item could not be read:', err);
			}
		}
		return files;
	}

	/** Desktop shell: paths from the window's native drop go through the file-dialog pipeline. */
	async function handleDroppedPaths(paths: string[]): Promise<void> {
		const filePaths = await expandDroppedPaths(paths);
		if (filePaths.length === 0) {
			errorMessage = m.import_no_files();
			return;
		}
		if (isDesktopTauri) {
			await importPathsIntoLocalLibrary(filePaths);
			return;
		}
		const files: File[] = [];
		for (const path of filePaths) {
			try {
				files.push(await filePathToFile(path));
			} catch (err) {
				console.error(`Failed to read file: ${path}`, err);
			}
		}
		if (files.length === 0) {
			errorMessage = m.import_no_files();
			return;
		}
		await handleFilesArray(files);
	}

	// The desktop shell delivers OS drag-and-drop through its own event stream
	// (HTML5 drop events carry no files there); the handlers above stay for a
	// plain browser. One listener for the app's lifetime: a drop on the
	// library opens this dialog with the files, a drop while it is open feeds
	// the drop zone. Android never registers it.
	onMount(() => {
		if (!isDesktopTauri) return;
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void import('@tauri-apps/api/webview')
			.then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
				const payload = event.payload;
				if (payload.type === 'leave') {
					dragOver = false;
					return;
				}
				const acceptsDrop = !get(isImporting) && importResult === null && !get(settingsDialogOpen)
					&& (get(importDialogOpen) || get(appView) === 'catalog');
				if (!acceptsDrop) return;
				if (payload.type !== 'drop') {
					if (get(importDialogOpen)) dragOver = true;
					return;
				}
				dragOver = false;
				if (payload.paths.length === 0) return;
				importDialogOpen.set(true);
				void handleDroppedPaths(payload.paths);
			}))
			.then((stop) => {
				if (disposed) stop();
				else unlisten = stop;
			})
			.catch((err) => {
				console.warn('Drag-and-drop events are unavailable:', err);
			});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

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

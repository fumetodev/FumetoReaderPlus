<script lang="ts">
	/**
	 * Adds a comic opened from another app (`opened-file.ts`) to a local library, from the reader's ⋮ menu. Filed the
	 * way Import files a pick: a library, then an optional author folder and, under it, a series folder, with the
	 * names the library already has as suggestions. The comic keeps its translations and its place.
	 */
	import * as m from '$lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { portal } from '$lib/utils/portal.js';
	import { settings, isLocalLibrary } from '$lib/settings/settings.js';
	import { recallLocalTarget, selectedLibraryId } from '$lib/stores/catalog-state.js';
	import { pushToast } from '$lib/stores/toasts.js';
	import { readerTransientCloseHandler } from '$lib/stores/ui-state.js';
	import { addOpenedFileToLibrary } from '$lib/import/opened-file.js';
	import { libraryAuthors, librarySeriesFor } from '$lib/import/library-folders.js';

	interface Props {
		/** The comic's name, for the messages. */
		name: string;
		onclose: () => void;
	}

	let { name, onclose }: Props = $props();

	const localLibraries = $derived($settings.libraries.filter(isLocalLibrary));
	// The same default as Import: the library on screen when it is local, else the one used last, else the first.
	let libraryId = $state(defaultLibrary());
	let author = $state('');
	let series = $state('');
	let authors = $state<string[]>([]);
	let seriesNames = $state<string[]>([]);
	let adding = $state(false);

	function defaultLibrary(): string {
		const libraries = get(settings).libraries.filter(isLocalLibrary);
		const preferred = [get(selectedLibraryId), recallLocalTarget()];
		return preferred.find((id) => id && libraries.some((lib) => lib.id === id)) ?? libraries[0]?.id ?? '';
	}

	onMount(() => {
		void libraryAuthors().then((list) => (authors = list));
		// Android Back closes this before it reaches the reader (handleReaderBack asks this port first).
		const close = () => onclose();
		readerTransientCloseHandler.set(close);
		return () => {
			if (get(readerTransientCloseHandler) === close) readerTransientCloseHandler.set(null);
		};
	});

	$effect(() => {
		const current = author.trim();
		void librarySeriesFor(current).then((list) => {
			if (author.trim() === current) seriesNames = list;
		});
	});

	async function add(): Promise<void> {
		if (adding || !libraryId) return;
		adding = true;
		try {
			const outcome = await addOpenedFileToLibrary({ libraryId, author, series });
			if (outcome === 'already-in-library') {
				pushToast({ message: m.import_duplicate_one({ name }), tone: 'error' });
			} else {
				const library = localLibraries.find((lib) => lib.id === libraryId);
				pushToast({ message: m.reader_added_to_library({ library: library?.name ?? '' }) });
			}
			onclose();
		} catch (error) {
			console.warn('[opened-file] Could not add the file to a library:', error);
			pushToast({ message: m.reader_add_to_library_failed({ name }), tone: 'error' });
		} finally {
			adding = false;
		}
	}
</script>

<!-- Above the soft keyboard: edge-to-edge Android never resizes the viewport for it, and the native inset bridge
     reports it as --kb. Without this the fields being typed into sat under the keyboard.
     Portalled: the reader's header, which hosts the menu that opens this, is transformed, and a fixed element inside
     a transformed one is placed relative to it, not to the screen. -->
<div use:portal class="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 p-4" role="presentation" onclick={() => { if (!adding) onclose(); }}>
	<div
		class="w-full max-w-md rounded-3xl bg-surface-container-high p-5 shadow-dock"
		style="margin-bottom: max(var(--sab, 0px), var(--kb, 0px)); max-height: calc(var(--viewport-height, 100dvh) - max(var(--sab, 0px), var(--kb, 0px)) - var(--sat, 0px) - 2rem); overflow-y: auto;"
		role="dialog"
		aria-modal="true"
		aria-labelledby="add-to-library-title"
		tabindex="-1"
		onclick={(event) => event.stopPropagation()}
		onkeydown={(event) => { if (event.key === 'Escape' && !adding) onclose(); }}
		data-add-to-library-dialog
	>
		<h2 id="add-to-library-title" class="text-base font-semibold text-surface-100">{m.reader_add_to_library()}</h2>
		<p class="mt-1 break-words text-xs text-surface-400">{m.reader_add_to_library_body({ name })}</p>
		{#if localLibraries.length === 0}
			<p class="mt-3 text-xs text-amber-400/90">{m.import_no_local_library()}</p>
		{:else}
			<label class="mt-3 flex items-center gap-2 text-xs text-surface-300">
				<span class="shrink-0">{m.import_into()}</span>
				<select
					bind:value={libraryId}
					disabled={localLibraries.length <= 1 || adding}
					class="h-11 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-800 px-2 text-sm text-surface-100 focus:border-primary-500 focus:outline-none disabled:opacity-70"
					data-add-to-library-target
				>
					{#each localLibraries as lib (lib.id)}
						<option value={lib.id}>{lib.name}</option>
					{/each}
				</select>
			</label>
			<label class="mt-3 block text-xs text-surface-300" for="add-to-library-author">{m.import_author_label()}</label>
			<input
				id="add-to-library-author"
				type="text"
				list="add-to-library-authors"
				bind:value={author}
				disabled={adding}
				placeholder={m.import_author_placeholder()}
				class="mt-1 h-11 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
				data-add-to-library-author
			/>
			<datalist id="add-to-library-authors">
				{#each authors as option (option)}
					<option value={option}></option>
				{/each}
			</datalist>
			{#if author.trim()}
				<label class="mt-3 block text-xs text-surface-300" for="add-to-library-series">{m.import_series_label()}</label>
				<input
					id="add-to-library-series"
					type="text"
					list="add-to-library-series-names"
					bind:value={series}
					disabled={adding}
					placeholder={m.import_series_placeholder()}
					class="mt-1 h-11 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
					data-add-to-library-series
				/>
				<datalist id="add-to-library-series-names">
					{#each seriesNames as option (option)}
						<option value={option}></option>
					{/each}
				</datalist>
			{/if}
		{/if}
		<div class="mt-4 flex justify-end gap-2">
			<button type="button" class="h-11 rounded-full px-4 text-sm font-semibold text-surface-300 active:bg-surface-700 disabled:opacity-50" disabled={adding} onclick={onclose}>{m.common_cancel()}</button>
			<button
				type="button"
				class="h-11 rounded-full bg-primary-600 px-4 text-sm font-semibold text-white active:bg-primary-700 disabled:opacity-60"
				disabled={adding || !libraryId}
				onclick={() => void add()}
				data-add-to-library-confirm
			>{adding ? m.reader_adding_to_library() : m.reader_add_to_library_confirm()}</button>
		</div>
	</div>
</div>

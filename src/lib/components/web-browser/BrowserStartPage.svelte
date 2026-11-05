<script lang="ts">
	/**
	 * A tab's start page: the pages the person bookmarked and the chapters they saved, by series, each chapter opened
	 * again with its translations (`reopenSavedChapter`). No page image is shown or kept — a chapter is a placeholder with
	 * its site's icon. A long press edits a chapter: its title, the series it is filed under, or deleting it with its
	 * translations.
	 */
	import * as m from '$lib/paraglide/messages.js';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { onDestroy, onMount } from 'svelte';
	import { appView } from '$lib/stores/reader-state.js';
	import { bookmarks, browserNav, browserPageWaiting, browserTransientClose, closeStartPage, hasPage, navigate, removeBookmark, reopenSavedChapter } from '$lib/web-browser/browser-controller.js';
	import {
		deleteSavedChapter,
		editSavedChapter,
		listSavedChapters,
		type SavedChapterView,
		type SavedSeriesView
	} from '$lib/web-browser/web-chapter-store.js';

	let groups = $state<SavedSeriesView[]>([]);
	let loadedOnce = $state(false);
	let editing = $state<{ view: SavedChapterView; series: string; chapter: string } | null>(null);
	let deleteArmed = $state(false);
	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressed = false;

	async function refresh(): Promise<void> {
		groups = await listSavedChapters();
		loadedOnce = true;
	}

	onMount(() => {
		void refresh();
	});

	// This page stays mounted while the reader is open (the browser's screen is kept alive), so a chapter saved there,
	// or how far it was read, must be picked up on the way back. A bookmark made on another tab shows up the same way.
	let wasShown = false;
	$effect(() => {
		void $bookmarks;
		const shown = $appView === 'browser';
		if (shown && (!wasShown || loadedOnce)) void refresh();
		wasShown = shown;
	});

	// Back closes the dialog first, before anything behind it.
	const closeEditor = () => {
		editing = null;
	};
	$effect(() => {
		if (!editing) return;
		browserTransientClose.set(closeEditor);
		return () => browserTransientClose.set(null);
	});
	onDestroy(() => {
		if (editing) browserTransientClose.set(null);
	});

	function progress(view: SavedChapterView): string | null {
		const total = view.volume?.page_count ?? 0;
		if (!total) return null;
		return m.browser_saved_progress({ page: Math.min(total, (view.volume?.current_page ?? 0) + 1), total });
	}

	function pressStart(view: SavedChapterView, seriesTitle: string): void {
		longPressed = false;
		pressTimer = setTimeout(() => {
			longPressed = true;
			deleteArmed = false;
			editing = { view, series: seriesTitle, chapter: view.chapter.title };
		}, 500);
	}

	function pressEnd(): void {
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = null;
	}

	function open(view: SavedChapterView): void {
		if (longPressed) return;
		reopenSavedChapter(view);
	}

	async function saveEdit(): Promise<void> {
		if (!editing) return;
		await editSavedChapter(editing.view.chapter.volume_uuid, editing.chapter, editing.series);
		editing = null;
		await refresh();
	}

	async function remove(): Promise<void> {
		if (!editing) return;
		if (!deleteArmed) {
			deleteArmed = true;
			return;
		}
		await deleteSavedChapter(editing.view.chapter.volume_uuid);
		editing = null;
		await refresh();
	}
</script>

<div class="h-full overflow-y-auto px-4 pb-6 pt-4" data-browser-start>
	{#if hasPage($browserNav) || $browserPageWaiting}
		<button type="button" class="mb-3 flex h-10 items-center gap-1 rounded-full px-2 text-sm text-primary-300 active:bg-surface-800" onclick={closeStartPage}>
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
			{m.browser_back_to_page()}
		</button>
	{/if}

	{#if groups.length > 0}
		<h2 class="mb-3 text-lg font-semibold text-surface-100">{m.browser_menu_home()}</h2>
		<div class="space-y-5">
			{#each groups as group (group.series.id)}
				<section>
					<div class="mb-1.5 flex items-center gap-1">
						<button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left active:bg-surface-800" aria-label={m.browser_open_page({ title: group.series.title })} onclick={() => navigate(group.series.seriesUrl)} data-browser-series>
							{#if group.series.icon}
								<img src={`data:image/png;base64,${group.series.icon}`} alt="" class="h-4 w-4 rounded-sm" />
							{:else}
								<span class="text-surface-500" aria-hidden="true"><Icon name="globe" size={16} /></span>
							{/if}
							<h3 class="min-w-0 truncate text-sm font-semibold text-surface-200">{group.series.title}</h3>
							<span class="shrink-0 text-[11px] text-surface-500">{group.series.siteHost}</span>
						</button>
						{#if group.series.bookmarked}
							<button type="button" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-primary-300 active:bg-surface-800" aria-label={m.browser_menu_remove_bookmark()} onclick={() => void removeBookmark(group.series.seriesUrl)} data-browser-remove-bookmark>
								<Icon name="star" size={18} />
							</button>
						{/if}
					</div>
					<ul class="space-y-1">
						{#each group.chapters as view (view.chapter.volume_uuid)}
							<li>
								<button
									type="button"
									class="flex min-h-12 w-full items-center gap-3 rounded-xl bg-surface-container-high px-3 py-2 text-left active:bg-surface-700"
									aria-label={m.browser_chapter_options({ title: view.chapter.title })}
									onpointerdown={() => pressStart(view, group.series.title)}
									onpointerup={pressEnd}
									onpointerleave={pressEnd}
									onpointercancel={pressEnd}
									oncontextmenu={(event) => event.preventDefault()}
									onclick={() => open(view)}
									data-saved-chapter
								>
									<span class="flex h-10 w-8 shrink-0 items-center justify-center rounded-md bg-surface-800 text-surface-500" aria-hidden="true">
										<Icon name="library" size={16} />
									</span>
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm text-surface-100">{view.chapter.title}</span>
										{#if progress(view)}
											<span class="block text-[11px] text-surface-500">{progress(view)}</span>
										{/if}
									</span>
								</button>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	{:else if loadedOnce}
		<div class="flex h-full flex-col justify-center gap-3 px-4 text-center">
			<span class="mx-auto text-primary-300" aria-hidden="true"><Icon name="globe" size={40} strokeWidth={1.5} /></span>
			<h2 class="text-lg font-semibold text-surface-100">{m.browser_start_title()}</h2>
			<p class="text-sm text-surface-300">{m.browser_start_body()}</p>
			<p class="text-xs text-surface-500">{m.browser_start_note()}</p>
			<p class="text-xs text-surface-500">{m.browser_saved_empty()}</p>
		</div>
	{/if}
</div>

{#if editing}
	<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4" role="presentation" onclick={() => (editing = null)}>
		<div
			class="w-full max-w-md rounded-3xl bg-surface-container-high p-5 shadow-dock"
			style="margin-bottom: var(--sab, 0px);"
			role="dialog"
			aria-modal="true"
			aria-labelledby="web-chapter-edit-title"
			tabindex="-1"
			onclick={(event) => event.stopPropagation()}
			onkeydown={(event) => { if (event.key === 'Escape') editing = null; }}
		>
			<h2 id="web-chapter-edit-title" class="text-base font-semibold text-surface-100">{m.browser_edit_chapter()}</h2>
			<label class="mt-3 block text-xs text-surface-300" for="web-chapter-title">{m.browser_edit_chapter_label()}</label>
			<input id="web-chapter-title" class="mt-1 h-11 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-100 focus:border-primary-500 focus:outline-none" bind:value={editing.chapter} />
			<label class="mt-3 block text-xs text-surface-300" for="web-chapter-series">{m.browser_edit_series_label()}</label>
			<input id="web-chapter-series" class="mt-1 h-11 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-100 focus:border-primary-500 focus:outline-none" bind:value={editing.series} />
			<div class="mt-4 flex items-center justify-between gap-2">
				<button
					type="button"
					class="h-11 rounded-full px-3 text-sm font-semibold {deleteArmed ? 'bg-red-600 text-white' : 'text-red-400 active:bg-surface-700'}"
					onclick={() => void remove()}
					data-delete-saved-chapter
				>{deleteArmed ? m.browser_delete_chapter_again() : m.browser_delete_chapter()}</button>
				<div class="flex gap-2">
					<button type="button" class="h-11 rounded-full px-4 text-sm font-semibold text-surface-300 active:bg-surface-700" onclick={() => (editing = null)}>{m.common_cancel()}</button>
					<button type="button" class="h-11 rounded-full bg-primary-600 px-4 text-sm font-semibold text-white active:bg-primary-700" onclick={() => void saveEdit()}>{m.browser_edit_save()}</button>
				</div>
			</div>
		</div>
	</div>
{/if}

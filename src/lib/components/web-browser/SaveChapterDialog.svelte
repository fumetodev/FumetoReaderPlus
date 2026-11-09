<script lang="ts">
	/**
	 * Saving the web chapter open in the reader: its title and the series it is filed under, both editable. The
	 * series is named after the page the chapter was reached from when the browser saw its title.
	 */
	import * as m from '$lib/paraglide/messages.js';
	import { portal } from '$lib/utils/portal.js';

	interface Props {
		chapterTitle: string;
		seriesTitle: string;
		onsave: (chapterTitle: string, seriesTitle: string) => void;
		onclose: () => void;
	}

	let { chapterTitle, seriesTitle, onsave, onclose }: Props = $props();
	// svelte-ignore state_referenced_locally
	let chapter = $state(chapterTitle);
	// svelte-ignore state_referenced_locally
	let series = $state(seriesTitle);
</script>

<!-- Above the soft keyboard: edge-to-edge Android never resizes the viewport for it, and the native inset bridge
     reports it as --kb. Without this the fields being typed into sat under the keyboard.
     Portalled: the reader's header, which hosts the menu that opens this, is transformed, and a fixed element inside
     a transformed one is placed relative to it, not to the screen. -->
<div use:portal class="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 p-4" role="presentation" onclick={onclose}>
	<div
		class="w-full max-w-md rounded-3xl bg-surface-container-high p-5 shadow-dock"
		style="margin-bottom: max(var(--sab, 0px), var(--kb, 0px)); max-height: calc(var(--viewport-height, 100dvh) - max(var(--sab, 0px), var(--kb, 0px)) - var(--sat, 0px) - 2rem); overflow-y: auto;"
		role="dialog"
		aria-modal="true"
		aria-labelledby="save-chapter-title"
		tabindex="-1"
		onclick={(event) => event.stopPropagation()}
		onkeydown={(event) => { if (event.key === 'Escape') onclose(); }}
		data-save-chapter-dialog
	>
		<h2 id="save-chapter-title" class="text-base font-semibold text-surface-100">{m.reader_save_dialog_title()}</h2>
		<p class="mt-1 text-xs text-surface-400">{m.reader_save_chapter_hint()}</p>
		<label class="mt-3 block text-xs text-surface-300" for="save-chapter-name">{m.browser_edit_chapter_label()}</label>
		<input id="save-chapter-name" class="mt-1 h-11 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-100 focus:border-primary-500 focus:outline-none" bind:value={chapter} />
		<label class="mt-3 block text-xs text-surface-300" for="save-chapter-series">{m.browser_edit_series_label()}</label>
		<input id="save-chapter-series" class="mt-1 h-11 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-100 focus:border-primary-500 focus:outline-none" bind:value={series} />
		<div class="mt-4 flex justify-end gap-2">
			<button type="button" class="h-11 rounded-full px-4 text-sm font-semibold text-surface-300 active:bg-surface-700" onclick={onclose}>{m.common_cancel()}</button>
			<button type="button" class="h-11 rounded-full bg-primary-600 px-4 text-sm font-semibold text-white active:bg-primary-700" onclick={() => onsave(chapter, series)} data-save-chapter-confirm>{m.browser_edit_save()}</button>
		</div>
	</div>
</div>

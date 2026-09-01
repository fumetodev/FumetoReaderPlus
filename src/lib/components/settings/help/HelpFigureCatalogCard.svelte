<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/** Interactive Help replica of a library comic card. */
	import HelpInteractiveFigure, { type HelpFigurePart } from './HelpInteractiveFigure.svelte';

	const parts: HelpFigurePart[] = [
		{
			id: 'title-strip',
			label: m.help_fig_title_strip(),
			description: m.help_fig_the_comic_title_rides()
		},
		{
			id: 'cover',
			label: m.help_fig_cover(),
			description: m.help_fig_tap_to_start_reading()
		},
		{
			id: 'chip',
			label: '3-dot menu',
			description: m.help_fig_per_comic_actions_open()
		},
		{
			id: 'meta',
			label: m.help_fig_progress_line(),
			description: m.help_fig_shows_page_count_and()
		}
	];
</script>

<HelpInteractiveFigure id="library-comic-card" title={m.help_fig_library_comic_card()} {parts}>
	{#snippet figure({ selected, select })}
		<div class="mx-auto w-[132px] overflow-hidden rounded-xl border border-surface-700 bg-surface-900">
			<div class="relative aspect-[2/3] w-full bg-surface-800">
				<button
					type="button"
					class="absolute inset-0 flex items-center justify-center text-3xl text-surface-600 transition-shadow {selected === 'cover' ? 'ring-2 ring-inset ring-teal-400' : ''}"
					aria-pressed={selected === 'cover'}
					aria-label={m.help_fig_cover()}
					onclick={() => select('cover')}
				>▤</button>
				<button
					type="button"
					class="absolute inset-x-0 top-0 bg-surface-950/80 px-1.5 py-1 text-left backdrop-blur-[2px] transition-shadow {selected === 'title-strip' ? 'ring-2 ring-inset ring-teal-400' : ''}"
					aria-pressed={selected === 'title-strip'}
					onclick={() => select('title-strip')}
				>
					<span class="block truncate text-[10px] font-medium leading-tight text-surface-100">{m.help_fig_my_manga_vol_1()}</span>
				</button>
				<button
					type="button"
					class="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-tl-lg border-l border-t border-surface-600/70 bg-surface-900/85 text-surface-300 transition-shadow {selected === 'chip' ? 'ring-2 ring-teal-400 text-white' : ''}"
					aria-pressed={selected === 'chip'}
					aria-label={m.help_fig_more_options()}
					onclick={() => select('chip')}
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3.25" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="8" cy="12.75" r="1.25"/></svg>
				</button>
			</div>
			<button
				type="button"
				class="block w-full px-2 py-1.5 text-left transition-shadow {selected === 'meta' ? 'ring-2 ring-inset ring-teal-400' : ''}"
				aria-pressed={selected === 'meta'}
				onclick={() => select('meta')}
			>
				<span class="block text-[9px] text-surface-500">{m.help_fig_24_pages_page_3()}</span>
			</button>
		</div>
	{/snippet}
</HelpInteractiveFigure>

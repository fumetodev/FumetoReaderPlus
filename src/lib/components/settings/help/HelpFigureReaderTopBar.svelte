<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/** Interactive Help replica of the reader's top bar. */
	import HelpInteractiveFigure, { type HelpFigurePart } from './HelpInteractiveFigure.svelte';
	import { isMobile } from '$lib/util/platform.js';

	const parts: HelpFigurePart[] = [
		{
			id: 'back',
			label: m.common_back(),
			// The same control; only the hardware that also triggers it differs.
			description: isMobile ? m.help_fig_returns_to_wherever_you() : m.help_fig_returns_desktop()
		},
		{
			id: 'title',
			label: m.help_fig_comic_title(),
			description: m.help_fig_shows_the_current_volume()
		},
		{
			id: 'eye',
			label: m.help_fig_overlay_visibility_eye(),
			description: m.help_fig_shows_or_hides_the()
		},
		{
			id: 'globe',
			label: m.help_fig_translate_options_globe(),
			description: m.help_fig_opens_the_translation_menu()
		},
		{
			id: 'more',
			label: m.help_fig_more_options_2(),
			description: m.help_fig_opens_the_reader_menu()
		}
	];

	const buttonClass = (active: boolean) =>
		`flex h-10 w-10 items-center justify-center rounded-lg transition-shadow ${active ? 'ring-2 ring-teal-400 bg-surface-700 text-white' : 'text-surface-200'}`;
</script>

<HelpInteractiveFigure id="reader-top-bar" title={m.help_fig_reader_top_bar()} {parts}>
	{#snippet figure({ selected, select })}
		<div class="grid h-12 w-full min-w-0 grid-cols-[40px_minmax(0,1fr)_40px_40px_40px] items-center gap-1.5 rounded-lg bg-surface-900 px-1.5">
			<button type="button" aria-label={m.common_back()} class="{buttonClass(selected === 'back')} border border-surface-700" aria-pressed={selected === 'back'} onclick={() => select('back')}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
			</button>
			<button data-user-text
				type="button"
				class="h-10 min-w-0 truncate rounded-lg px-1 text-left text-xs font-semibold {selected === 'title' ? 'ring-2 ring-teal-400 bg-surface-700 text-white' : 'text-surface-100'}"
				aria-pressed={selected === 'title'}
				onclick={() => select('title')}
			>
				{m.help_fig_my_manga_vol_1()}
			</button>
			<button type="button" aria-label={m.help_fig_overlay_visibility()} class="{buttonClass(selected === 'eye')} {selected === 'eye' ? '' : 'bg-teal-500/15 text-teal-300'}" aria-pressed={selected === 'eye'} onclick={() => select('eye')}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
			</button>
			<button type="button" aria-label={m.reader_translate_options()} class={buttonClass(selected === 'globe')} aria-pressed={selected === 'globe'} onclick={() => select('globe')}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15.3 15.3 0 0 1 0 18M12 3a15.3 15.3 0 0 0 0 18"/></svg>
			</button>
			<button type="button" aria-label={m.help_fig_more_options()} class={buttonClass(selected === 'more')} aria-pressed={selected === 'more'} onclick={() => select('more')}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
			</button>
		</div>
	{/snippet}
</HelpInteractiveFigure>

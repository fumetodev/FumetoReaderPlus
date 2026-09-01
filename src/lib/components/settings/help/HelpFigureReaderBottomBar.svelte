<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/** Interactive Help replica of the reader's bottom action bar. */
	import HelpInteractiveFigure, { type HelpFigurePart } from './HelpInteractiveFigure.svelte';

	const parts: HelpFigurePart[] = [
		{
			id: 'tabs',
			label: m.shell_nav_tabs(),
			description: m.help_fig_leaves_the_reader_and()
		},
		{
			id: 'pages',
			label: m.help_fig_page_counter(),
			description: m.help_fig_shows_your_position_tap()
		},
		{
			id: 'translate',
			label: m.help_fig_translate_label(),
			description: m.help_fig_translates_the_current_page()
		}
	];

	const itemClass = (active: boolean) =>
		`flex h-12 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-semibold transition-shadow ${active ? 'ring-2 ring-teal-400 bg-surface-700 text-white' : 'text-surface-100'}`;
</script>

<HelpInteractiveFigure id="reader-bottom-bar" title={m.help_fig_reader_bottom_bar()} {parts}>
	{#snippet figure({ selected, select })}
		<div class="grid h-14 grid-cols-3 items-center gap-1 rounded-lg border-t border-surface-800 bg-surface-950 px-1.5">
			<button type="button" class={itemClass(selected === 'tabs')} aria-pressed={selected === 'tabs'} onclick={() => select('tabs')}>
				<span class="text-sm leading-none" aria-hidden="true">▣</span>
				<span>{m.shell_nav_tabs()}</span>
			</button>
			<button type="button" class={itemClass(selected === 'pages')} aria-pressed={selected === 'pages'} onclick={() => select('pages')}>
				<span class="leading-none">3 / 24</span>
				<span class="text-[8px] font-medium leading-none text-surface-400">{m.reader_info_pages()}</span>
			</button>
			<button type="button" class={itemClass(selected === 'translate')} aria-pressed={selected === 'translate'} onclick={() => select('translate')}>
				<svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
					<text x="0.5" y="11" font-size="10.5" font-weight="600" fill="currentColor">あ</text>
					<text x="14.5" y="22.5" font-size="11" font-weight="700" fill="currentColor">A</text>
					<path d="M14 5h6m0 0-2.2-2.2M20 5l-2.2 2.2M10 19H4m0 0 2.2-2.2M4 19l2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
				<span>{m.reader_translate()}</span>
			</button>
		</div>
	{/snippet}
</HelpInteractiveFigure>

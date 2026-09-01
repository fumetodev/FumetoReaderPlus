<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/** Interactive Help replica of the globe (translate options) menu. */
	import HelpInteractiveFigure, { type HelpFigurePart } from './HelpInteractiveFigure.svelte';

	const parts: HelpFigurePart[] = [
		{
			id: 'auto-translate',
			label: m.reader_auto_translate_pages(),
			description: m.help_fig_when_on_any_page()
		},
		{
			id: 'vertical-text',
			label: m.settings_search_vertical_text_label(),
			description: m.help_fig_keeps_overlays_vertical_where()
		},
		{
			id: 'sfx-overlays',
			label: m.reader_sound_effect_overlays(),
			description: m.help_fig_shows_or_hides_overlay()
		},
		{
			id: 'retranslate',
			label: m.reader_re_translate_page(),
			description: m.help_fig_discards_the_current_page()
		},
		{
			id: 'revise',
			label: m.reader_revise_page(),
			description: m.help_fig_asks_the_model_to()
		},
		{
			id: 'regions',
			label: m.reader_select_regions(),
			description: m.help_fig_lets_you_draw_boxes()
		},
		{
			id: 'help',
			label: m.reader_translation_help(),
			description: m.help_fig_opens_this_help_section()
		}
	];

	const rowClass = (active: boolean) =>
		`flex h-9 w-full min-w-0 items-center justify-between rounded-md bg-surface-800 px-2.5 text-xs transition-shadow ${active ? 'ring-2 ring-teal-400 text-white' : 'text-surface-100'}`;
	const actionClass = (active: boolean) =>
		`flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-xs transition-shadow ${active ? 'ring-2 ring-teal-400 bg-surface-700 text-white' : 'text-surface-100'}`;
</script>

<HelpInteractiveFigure id="translate-menu" title={m.help_fig_globe_menu_translate_options()} {parts}>
	{#snippet figure({ selected, select })}
		<div class="w-full max-w-[240px] space-y-1.5 rounded-lg border border-surface-700 bg-surface-900 p-2">
			<button type="button" class={rowClass(selected === 'auto-translate')} aria-pressed={selected === 'auto-translate'} onclick={() => select('auto-translate')}>
				<span class="truncate">{m.reader_auto_translate_pages()}</span><span class="shrink-0 text-teal-300">{m.settings_server_off()}</span>
			</button>
			<button type="button" class={rowClass(selected === 'vertical-text')} aria-pressed={selected === 'vertical-text'} onclick={() => select('vertical-text')}>
				<span class="truncate">{m.settings_search_vertical_text_label()}</span><span class="shrink-0 text-teal-300">{m.settings_server_on()}</span>
			</button>
			<button type="button" class={rowClass(selected === 'sfx-overlays')} aria-pressed={selected === 'sfx-overlays'} onclick={() => select('sfx-overlays')}>
				<span class="truncate">{m.reader_sound_effect_overlays()}</span><span class="shrink-0 text-teal-300">{m.settings_server_off()}</span>
			</button>
			<div class="border-t border-surface-700 pt-1.5">
				<button type="button" class={actionClass(selected === 'retranslate')} aria-pressed={selected === 'retranslate'} onclick={() => select('retranslate')}>
					<svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
					{m.reader_re_translate_page()}
				</button>
				<button type="button" class="mt-1 {actionClass(selected === 'revise')}" aria-pressed={selected === 'revise'} onclick={() => select('revise')}>
					<svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
					{m.reader_revise_page()}
				</button>
				<button type="button" class="mt-1 {actionClass(selected === 'regions')}" aria-pressed={selected === 'regions'} onclick={() => select('regions')}>
					<svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><rect x="8" y="9" width="8" height="6" rx="1"/></svg>
					{m.reader_select_regions()}
				</button>
			</div>
			<button type="button" class="{actionClass(selected === 'help')} border-t border-surface-800 text-surface-400" aria-pressed={selected === 'help'} onclick={() => select('help')}>
				<span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-surface-700 text-xs font-semibold">?</span>
				{m.reader_translation_help()}
			</button>
		</div>
	{/snippet}
</HelpInteractiveFigure>

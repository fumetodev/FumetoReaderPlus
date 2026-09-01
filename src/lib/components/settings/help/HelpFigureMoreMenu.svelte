<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/** Interactive Help replica of the ⋮ (more reader options) menu. */
	import HelpInteractiveFigure, { type HelpFigurePart } from './HelpInteractiveFigure.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	const parts: HelpFigurePart[] = [
		{
			id: 'zoom',
			label: m.help_fig_zoom_presets(),
			description: m.help_fig_auto_fits_the_whole()
		},
		{
			id: 'direction',
			label: m.reader_reading_direction(),
			description: m.help_fig_right_to_left_manga()
		},
		{
			id: 'reader-mode',
			label: m.header_reader_mode(),
			description: m.help_fig_switches_between_paged_one()
		},
		{
			id: 'page-turn',
			label: m.header_page_turn(),
			description: m.help_fig_how_pages_turn_in()
		},
		{
			id: 'settings',
			label: m.shell_nav_settings(),
			description: m.help_fig_jumps_to_the_full()
		}
	];

	const zoomTile = (active: boolean) =>
		`flex h-10 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md bg-surface-800 text-surface-100 transition-shadow ${active ? 'ring-2 ring-teal-400 text-white' : ''}`;
	const rowClass = (active: boolean) =>
		`flex h-9 w-full min-w-0 items-center justify-between rounded-md bg-surface-800 px-2.5 text-xs transition-shadow ${active ? 'ring-2 ring-teal-400 text-white' : 'text-surface-100'}`;
</script>

<HelpInteractiveFigure id="more-menu" title={m.help_fig_menu_reader_options()} {parts}>
	{#snippet figure({ selected, select })}
		<div class="w-full max-w-[240px] space-y-1.5 rounded-lg border border-surface-700 bg-surface-900 p-2">
			<button type="button" class="grid w-full grid-cols-4 gap-1.5 rounded-md p-0.5 transition-shadow {selected === 'zoom' ? 'ring-2 ring-teal-400' : ''}" aria-pressed={selected === 'zoom'} aria-label={m.help_fig_zoom_presets()} onclick={() => select('zoom')}>
				<span class={zoomTile(false)}>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6" rx=".75"/></svg>
					<span class="text-[8px] leading-none text-surface-300">{m.reader_auto_2()}</span>
				</span>
				<span class={zoomTile(false)}>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5v14M21 5v14M7 12h10M7 12l3-3M7 12l3 3M17 12l-3-3M17 12l-3 3"/></svg>
					<span class="text-[8px] leading-none text-surface-300">{m.header_width()}</span>
				</span>
				<span class={zoomTile(false)}>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="rotate(90 12 12)"><path d="M3 5v14M21 5v14M7 12h10M7 12l3-3M7 12l3 3M17 12l-3-3M17 12l-3 3"/></g></svg>
					<span class="text-[8px] leading-none text-surface-300">{m.header_height()}</span>
				</span>
				<span class={zoomTile(false)}>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><text x="12" y="15.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor" stroke-width="0">1:1</text></svg>
					<span class="text-[8px] leading-none text-surface-300">{m.header_actual()}</span>
				</span>
			</button>
			<button type="button" class={rowClass(selected === 'direction')} aria-pressed={selected === 'direction'} onclick={() => select('direction')}>
				<span class="truncate">{m.reader_reading_direction()}</span><span class="shrink-0">{m.reader_direction_rtl()}</span>
			</button>
			<button type="button" class={rowClass(selected === 'reader-mode')} aria-pressed={selected === 'reader-mode'} onclick={() => select('reader-mode')}>
				<span class="truncate">{m.header_reader_mode()}</span><span class="shrink-0">{m.settings_display_paged()}</span>
			</button>
			<button type="button" class="w-full rounded-md p-0.5 transition-shadow {selected === 'page-turn' ? 'ring-2 ring-teal-400' : ''}" aria-pressed={selected === 'page-turn'} aria-label={m.header_page_turn()} onclick={() => select('page-turn')}>
				<span class="block px-1 text-left text-[9px] text-surface-400">{m.header_page_turn()}</span>
				<span class="mt-0.5 grid grid-cols-3 gap-1.5">
					<span class="flex h-8 items-center justify-center rounded-md bg-primary-600 text-[10px] font-semibold text-white">{m.settings_display_swipe()}</span>
					<span class="flex h-8 items-center justify-center rounded-md bg-surface-800 text-[10px] font-semibold text-surface-300">{m.settings_display_tap()}</span>
					<span class="flex h-8 items-center justify-center rounded-md bg-surface-800 text-[10px] font-semibold text-surface-300">{m.settings_display_both()}</span>
				</span>
			</button>
			<button type="button" class="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-xs transition-shadow {selected === 'settings' ? 'ring-2 ring-teal-400 bg-surface-700 text-white' : 'text-surface-100'}" aria-pressed={selected === 'settings'} onclick={() => select('settings')}>
				<Icon name="settings" size={16} strokeWidth={2} class="shrink-0" />
				{m.shell_nav_settings()}
			</button>
		</div>
	{/snippet}
</HelpInteractiveFigure>

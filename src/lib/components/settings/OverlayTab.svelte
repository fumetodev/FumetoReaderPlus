<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { formatPercent } from '$lib/i18n/format.js';
	import { settingsDraft as draft } from './settings-state.svelte.js';
	import { overlayFontScale } from '$lib/stores/reader-state.js';
	import Switch from '$lib/components/ui/Switch.svelte';
</script>

<div class="space-y-5">
	<!-- Enable -->
	<div data-settings-anchor="overlay-enabled">
		<Switch bind:checked={draft.overlayEnabled} dataTestid="enable-text-overlays" label={m.settings_search_overlay_enabled_label()} />
		<p class="text-[11px] text-surface-500">
			{m.settings_overlay_when_enabled_translated_text()}
		</p>
	</div>

	{#if draft.overlayEnabled}
		<!-- SFX rendering (policy-21) -->
		<div class="border-t border-surface-700 pt-4" data-settings-anchor="sfx-overlays">
			<Switch bind:checked={draft.overlaySfx} label={m.settings_search_sfx_overlays_label()} />
			<p class="mt-1 text-[11px] text-surface-500">
				{m.settings_overlay_off_default_drawn_sound()}
			</p>
		</div>

		<!-- Overlay text size (persisted twin of the reader's live slider) -->
		<div class="border-t border-surface-700 pt-4" data-settings-anchor="overlay-text-size">
			<label for="overlay-font-scale-default" class="mb-1.5 block text-sm font-medium text-surface-300">
				{m.settings_overlay_text_size_label({ percent: formatPercent(draft.overlayFontScaleDefault) })}
			</label>
			<input
				id="overlay-font-scale-default"
				type="range"
				min="0.5"
				max="3"
				step="0.05"
				bind:value={draft.overlayFontScaleDefault}
				oninput={() => overlayFontScale.set(draft.overlayFontScaleDefault)}
				class="w-full accent-primary-500"
			/>
			<p class="mt-1 text-[11px] text-surface-500">
				{m.settings_overlay_scales_all_overlay_text()}
			</p>
		</div>

		<div class="border-t border-surface-700 pt-4" data-settings-anchor="auto-generate">
			<Switch bind:checked={draft.overlayAutoGenerate} label={m.settings_search_auto_generate_label()} />
			<p class="mt-1 text-[11px] text-surface-500">
				{m.settings_overlay_when_enabled_get_full()}
			</p>
		</div>
		<div class="border-t border-surface-700 pt-4" data-settings-anchor="vertical-text">
			<Switch bind:checked={draft.overlayVerticalText} label={m.settings_search_vertical_text_label()} />
			<p class="mt-1 text-[11px] text-surface-500">
				{m.settings_overlay_when_enabled_vertical_source()}
			</p>
		</div>
	{/if}
</div>

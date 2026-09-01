<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';
	import { settingsDraft as draft } from './settings-state.svelte.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { COLOR_SCHEMES, applyColorScheme, normalizeSchemeId } from '$lib/settings/color-schemes.js';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { SUPPORTED_UI_LOCALES } from '$lib/i18n/locales.js';
	import { setUiLocale } from '$lib/i18n/locale.js';
</script>

<div class="space-y-5">
	<!-- ═══ User Interface ═══ -->
	<div class="space-y-4">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_display_user_interface()}</h3>
		<!-- Color Scheme -->
		<fieldset data-settings-anchor="color-scheme">
			<legend class="mb-2 block text-sm text-surface-200">{m.settings_display_color_scheme()}</legend>
			<!-- One seed-derived tonal set; light schemes retired until a real light pass. -->
			<div class="grid grid-cols-4 gap-2 sm:grid-cols-6" role="radiogroup" aria-label={m.settings_display_color_schemes()}>
				{#each COLOR_SCHEMES as scheme (scheme.id)}
					{@const selected = normalizeSchemeId(draft.colorScheme) === scheme.id}
					<button
						type="button"
						role="radio"
						aria-checked={selected}
						onclick={() => { draft.colorScheme = scheme.id; applyColorScheme(scheme.id); }}
						class="flex flex-col items-center gap-1 rounded-lg p-1.5 transition-all {selected ? 'ring-2 ring-primary-500 ring-offset-1 ring-offset-surface-900' : 'hover:bg-surface-800'}"
						title={scheme.name}
					>
						<div
							class="flex h-9 w-full items-end justify-start overflow-hidden rounded"
							style="background-color: {scheme.preview.bg};"
						>
							<div
								class="h-3 w-3 rounded-tr"
								style="background-color: {scheme.preview.accent};"
							></div>
						</div>
						<span class="text-[11px] leading-tight" style="color: {scheme.preview.text};">{scheme.name}</span>
					</button>
				{/each}
			</div>
		</fieldset>

		<!-- App language: the UI axis only; the translation target lives under Translation. -->
		<div data-settings-anchor="ui-language">
			<label class="mb-1.5 block text-sm text-surface-200" for="ui-language">{m.settings_display_ui_language()}</label>
			<select
				id="ui-language"
				value={draft.uiLocale}
				onchange={(event) => { const value = (event.target as HTMLSelectElement).value; draft.uiLocale = value; setUiLocale(value); }}
				class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
				data-ui-language
			>
				<option value="system">{m.settings_display_ui_language_system()}</option>
				{#each SUPPORTED_UI_LOCALES as locale (locale.tag)}
					<option value={locale.tag} lang={locale.tag}>{locale.endonym}</option>
				{/each}
			</select>
			<p class="mt-1 text-[11px] text-surface-500">{m.settings_display_ui_language_hint()}</p>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- ═══ Library View ═══ -->
	<div class="space-y-4">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_display_library_view()}</h3>
		<div data-settings-anchor="switch-new-tabs">
			<Switch
				bind:checked={draft.switchToNewTabsImmediately}
				dataTestid="switch-to-new-tabs-immediately"
				label={m.settings_display_switch_to_new_tabs()}
				sublabel={m.settings_display_open_the_reader_after()}
			/>
		</div>

		<div data-settings-anchor="library-warnings">
			<Switch
				bind:checked={draft.showLibraryAccessWarnings}
				dataTestid="show-library-access-warnings"
				label={m.settings_search_library_warnings_label()}
				sublabel={m.settings_display_show_a_catalog_notice()}
			/>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- ═══ Reading Defaults ═══ -->
	<div class="space-y-4">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_display_reading_defaults()}</h3>

		<!-- Default reading direction -->
		<div data-settings-anchor="reading-direction">
			<p class="mb-1.5 block text-sm text-surface-200" id="reading-direction-label">{m.settings_display_reading_direction()}</p>
			<div class="relative flex gap-1 rounded-full bg-surface-container-high p-1" role="radiogroup" aria-labelledby="reading-direction-label" use:slidingSelection>
				<button
					type="button"
					role="radio"
					aria-checked={draft.defaultReadingDirection === 'rtl'}
					onclick={() => (draft.defaultReadingDirection = 'rtl')}
					class="relative flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors {draft.defaultReadingDirection === 'rtl' ? 'text-white' : 'text-surface-400 hover:text-surface-200'}"
				>
					{m.settings_display_right_to_left()}
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={draft.defaultReadingDirection === 'ltr'}
					onclick={() => (draft.defaultReadingDirection = 'ltr')}
					class="relative flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors {draft.defaultReadingDirection === 'ltr' ? 'text-white' : 'text-surface-400 hover:text-surface-200'}"
				>
					{m.settings_display_left_to_right()}
				</button>
			</div>
			<p class="mt-1 text-[11px] text-surface-500">
				{m.settings_display_used_for_volumes_without()}
			</p>
		</div>

		<!-- Reader mode -->
		<div data-settings-anchor="reader-mode">
			<p class="mb-1.5 block text-sm text-surface-200" id="reader-mode-label">{m.settings_display_reader_mode()}</p>
			<div class="relative flex gap-1 rounded-full bg-surface-container-high p-1" role="radiogroup" aria-labelledby="reader-mode-label" use:slidingSelection>
				{#each [
					{ value: 'paged', label: () => m.settings_display_paged() },
					{ value: 'long-strip', label: () => m.settings_display_long_strip() }
				] as option (option.value)}
					<button
						type="button"
						role="radio"
						aria-checked={draft.readerMode === option.value}
						onclick={() => (draft.readerMode = option.value as 'paged' | 'long-strip')}
						class="relative flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors {draft.readerMode === option.value ? 'text-white' : 'text-surface-400 hover:text-surface-200'}"
					>
						{option.label()}
					</button>
				{/each}
			</div>
			<p class="mt-1 text-[11px] text-surface-500">
				{draft.readerMode === 'paged'
					? m.settings_display_one_page_at_a()
					: m.settings_display_all_pages_in_one()}
			</p>
		</div>

		<!-- Page turn mode -->
		<div data-settings-anchor="page-turning">
			<p class="mb-1.5 block text-sm {draft.readerMode === 'long-strip' ? 'text-surface-500' : 'text-surface-200'}" id="page-turn-label">{m.settings_display_page_turning()}</p>
			<div class="relative flex gap-1 rounded-full bg-surface-container-high p-1 {draft.readerMode === 'long-strip' ? 'opacity-50' : ''}" role="radiogroup" aria-labelledby="page-turn-label" use:slidingSelection>
				{#each [
					{ value: 'swipe', label: () => m.settings_display_swipe() },
					{ value: 'tap', label: () => m.settings_display_tap() },
					{ value: 'both', label: () => m.settings_display_both() }
				] as option (option.value)}
					<button
						type="button"
						role="radio"
						aria-checked={draft.pageTurnMode === option.value}
						disabled={draft.readerMode === 'long-strip'}
						onclick={() => (draft.pageTurnMode = option.value as 'swipe' | 'tap' | 'both')}
						class="relative flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed {draft.pageTurnMode === option.value ? 'text-white' : 'text-surface-400 hover:text-surface-200'}"
					>
						{option.label()}
					</button>
				{/each}
			</div>
			<p class="mt-1 text-[11px] text-surface-500">
				{draft.readerMode === 'long-strip'
					? m.settings_display_not_used_in_long()
					: draft.pageTurnMode === 'swipe'
						? m.settings_display_swipe_horizontally_to_change()
						: draft.pageTurnMode === 'tap'
							? m.settings_display_tap_the_left_or()
							: m.settings_display_both_swiping_and_edge()}
			</p>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- ═══ Comic View ═══ -->
	<div class="space-y-4">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_display_comic_view()}</h3>
		<!-- Resume Last Page -->
		<div data-settings-anchor="resume-last-page">
			<Switch bind:checked={draft.resumeLastPage} label={m.settings_search_resume_last_page_label()} />
			<p class="text-[11px] text-surface-500">
				{draft.resumeLastPage
					? m.settings_display_volumes_will_open_to()
					: m.settings_display_volumes_will_always_open()}
			</p>
		</div>

		<!-- Restart finished volumes (only meaningful while resuming) -->
		<div data-settings-anchor="restart-finished-volumes">
			<Switch
				bind:checked={draft.restartFinishedVolumes}
				disabled={!draft.resumeLastPage}
				label={m.settings_search_restart_finished_volumes_label()}
			/>
			<p class="text-[11px] text-surface-500">
				{!draft.resumeLastPage
					? m.settings_display_needs_resume_from_last()
					: draft.restartFinishedVolumes
						? m.settings_display_once_a_volume_is()
						: m.settings_display_a_volume_left_on()}
			</p>
		</div>
		<!-- Continue into the next comic in the same folder -->
		<div data-settings-anchor="continue-to-next-volume">
			<Switch bind:checked={draft.continueToNextVolume} label={m.settings_display_continue_to_the_next()} />
			<p class="text-[11px] text-surface-500">
				{draft.continueToNextVolume
					? m.settings_display_turning_past_the_last()
					: m.settings_display_turning_past_the_last_2()}
			</p>
		</div>
		<p class="text-[11px] text-surface-500">
			<RichMessage message={m.settings_display_overlay_moved({ tab: m.settings_tab_overlay() })} emClass="font-medium text-surface-400" />
		</p>
	</div>
</div>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { formatPercent } from '$lib/i18n/format.js';
	import { settingsDraft as draft } from './settings-state.svelte.js';
	import { overlayFontScale } from '$lib/stores/reader-state.js';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { untrack } from 'svelte';
	import {
		SFX_MODEL,
		cancelSfxModelDownload,
		deleteSfxModel,
		downloadSfxModel,
		isSfxModelReady,
		sfxModelDownloadState,
		sfxModelIsManagedHere
	} from '$lib/detection/sfx-model-manager.js';

	// Every app build downloads the sound-effect model on demand; a plain
	// browser reads a developer's local copy, and there is nothing to show.
	const sfxModelManaged = sfxModelIsManagedHere();
	const sfxModelMB = Math.round(SFX_MODEL.sizeBytes / 1024 / 1024);
	let sfxModelReady = $state(false);

	async function refreshSfxModel(): Promise<void> {
		sfxModelReady = await isSfxModelReady().catch(() => false);
	}

	$effect(() => {
		// Re-probe whenever a transfer settles, so Ready/Download flips in place.
		const status = $sfxModelDownloadState.status;
		if (sfxModelManaged && (status === 'idle' || status === 'completed')) untrack(() => { void refreshSfxModel(); });
	});

	function sfxFilterLevel(strength: number): string {
		if (strength <= 0) return m.settings_overlay_sfx_filter_off();
		if (strength < 0.375) return m.settings_overlay_sfx_filter_gentle();
		if (strength < 0.625) return m.settings_overlay_sfx_filter_balanced();
		if (strength < 0.875) return m.settings_overlay_sfx_filter_strong();
		return m.settings_overlay_sfx_filter_maximum();
	}
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

		{#if !draft.overlaySfx}
			<!-- Learned sound-effect filter strength (0 = rules only) -->
			<div class="border-t border-surface-700 pt-4" data-settings-anchor="sfx-filter-strength">
				<label for="sfx-filter-strength" class="mb-1.5 block text-sm font-medium text-surface-300">
					{m.settings_overlay_sfx_filter_label({ level: sfxFilterLevel(draft.sfxFilterStrength) })}
				</label>
				<input
					id="sfx-filter-strength"
					type="range"
					min="0"
					max="1"
					step="0.05"
					bind:value={draft.sfxFilterStrength}
					class="w-full accent-primary-500"
				/>
				<p class="mt-1 text-[11px] text-surface-500">
					{m.settings_overlay_sfx_filter_help()}
				</p>

				<!-- Shown while the filter is on, and while a downloaded model can still be removed. -->
				{#if sfxModelManaged && (draft.sfxFilterStrength > 0 || sfxModelReady)}
					<div class="mt-3 rounded-lg border border-surface-700 bg-surface-800/50 px-3 py-2.5" data-sfx-model-card>
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0">
								<p class="text-xs font-semibold text-surface-100">{m.settings_overlay_sfx_model()}</p>
								<p class="mt-0.5 text-[11px] text-surface-400">{m.settings_overlay_sfx_model_desc({ size: sfxModelMB })}</p>
							</div>
							<div class="flex shrink-0 flex-col items-stretch justify-center gap-2">
								{#if $sfxModelDownloadState.status === 'downloading'}
									<button
										type="button"
										onclick={() => cancelSfxModelDownload()}
										class="rounded-full bg-surface-700 px-3 py-1.5 text-[11px] font-medium text-surface-300 transition-colors hover:bg-surface-600"
									>
										{m.common_cancel()}
									</button>
								{:else if sfxModelReady}
									<span class="rounded-full bg-green-600/20 px-3 py-1 text-center text-[11px] font-medium text-green-400">{m.settings_models_ready()}</span>
									<button
										type="button"
										onclick={async () => { await deleteSfxModel().catch(() => undefined); await refreshSfxModel(); }}
										class="rounded-full bg-red-600/20 px-3 py-1.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/30"
										data-testid="sfx-model-delete"
									>
										{m.settings_models_delete()}
									</button>
								{:else}
									<button
										type="button"
										onclick={async () => { await downloadSfxModel().catch(() => undefined); await refreshSfxModel(); }}
										class="rounded-full bg-primary-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
										data-testid="sfx-model-download"
									>
										{m.settings_models_download()}
									</button>
								{/if}
							</div>
						</div>
						{#if $sfxModelDownloadState.status === 'downloading' && $sfxModelDownloadState.progress}
							{@const pct = $sfxModelDownloadState.progress.totalBytes > 0
								? Math.round(($sfxModelDownloadState.progress.downloadedBytes / $sfxModelDownloadState.progress.totalBytes) * 100)
								: 0}
							<div class="mt-2 h-1.5 w-full rounded-full bg-surface-700">
								<div class="h-1.5 rounded-full bg-primary-500 transition-all" style="width: {pct}%"></div>
							</div>
							<p class="mt-1 text-[11px] text-surface-500">
								{m.settings_translation_download_progress({ done: Math.round($sfxModelDownloadState.progress.downloadedBytes / 1024 / 1024), total: Math.round($sfxModelDownloadState.progress.totalBytes / 1024 / 1024), pct })}
							</p>
						{/if}
						{#if $sfxModelDownloadState.status === 'error'}
							<p class="mt-1.5 text-[11px] text-red-400">{$sfxModelDownloadState.error}</p>
						{/if}
						{#if !sfxModelReady && draft.sfxFilterStrength > 0 && $sfxModelDownloadState.status !== 'downloading'}
							<p class="mt-1 text-[11px] text-amber-400/90">{m.settings_overlay_sfx_model_needed()}</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

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

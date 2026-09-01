<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { getLanguageDisplayName } from '$lib/i18n/language-names.js';
	import { motionDuration } from '$lib/util/motion.js';
	import { fade, scale } from 'svelte/transition';
	import { get } from 'svelte/store';
	import { settings, SUPPORTED_LANGUAGES } from '$lib/settings/settings.js';
	import type { VolumeMetadata, VolumeTranslationOptions } from '$lib/types/index.js';

	interface Props {
		volume: VolumeMetadata | null;
		onclose: () => void;
		onstart: (options: VolumeTranslationOptions) => void;
	}

	let { volume, onclose, onstart }: Props = $props();

	// Check if on-device pipeline is active (some features don't apply)
	const isOnDevice = $derived(get(settings).translationPipeline === 'on-device');

	// Form state
	let comicType = $state<'story' | 'gallery'>('story');
	let initialSummary = $state('');
	let usePageRange = $state(false);
	let startPage = $state(1);
	let endPage = $state(1);
	let useLanguageOverride = $state(false);
	let sourceLanguage = $state('ja');
	let targetLanguage = $state('en');
	let generateOverlays = $state(false);
	let skipReview = $state(false);

	// Reset form when dialog opens
	$effect(() => {
		if (volume) {
			comicType = 'story';
			initialSummary = '';
			usePageRange = false;
			startPage = 1;
			endPage = volume.page_count;
			useLanguageOverride = false;
			const s = get(settings);
			sourceLanguage = s.sourceLanguage;
			targetLanguage = s.targetLanguage;
			generateOverlays = s.overlayAutoGenerate ?? false;
			skipReview = s.skipReviewPass ?? false;
		}
	});

	// Validation
	let pageRangeValid = $derived(
		!usePageRange || (startPage >= 1 && endPage >= startPage && endPage <= (volume?.page_count ?? 1))
	);

	function handleStart() {
		if (!volume || !pageRangeValid) return;

		const options: VolumeTranslationOptions = {
			mode: comicType,
			// Preserve explicit unchecked choices instead of silently falling back
			// to the global settings in the translation service.
			generateOverlays,
			skipReview
		};

		if (comicType === 'story' && initialSummary.trim()) {
			options.initialSummary = initialSummary.trim();
		}

		if (usePageRange) {
			options.startPage = startPage - 1; // Convert to 0-indexed
			options.endPage = endPage; // endPage is exclusive in 0-indexed terms
		}

		if (useLanguageOverride) {
			options.sourceLanguage = sourceLanguage;
			options.targetLanguage = targetLanguage;
		}

		onstart(options);
	}
</script>

{#if volume}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}
		transition:fade={{ duration: motionDuration(150) }}
	>
		<div
			class="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			transition:scale={{ duration: motionDuration(150), start: 0.95 }}
		>
			<h2 class="mb-1 text-lg font-semibold text-surface-100">{m.catalog_custom_translation()}</h2>
			<p class="mb-5 truncate text-xs text-surface-500" title={volume.title}>
				{volume.title} · {volume.page_count} pages
			</p>

			<!-- Comic Type -->
			<fieldset class="mb-4">
				<legend class="mb-1.5 block text-sm font-medium text-surface-300">{m.catalog_comic_type()}</legend>
				<div class="flex gap-2">
					<button
						class="flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors {comicType === 'story'
							? 'border-primary-500 bg-primary-600/20 text-primary-400'
							: 'border-surface-700 bg-surface-800 text-surface-400 hover:text-surface-200'}"
						onclick={() => comicType = 'story'}
					>
						{m.catalog_story()}
					</button>
					<button
						class="flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors {comicType === 'gallery'
							? 'border-primary-500 bg-primary-600/20 text-primary-400'
							: 'border-surface-700 bg-surface-800 text-surface-400 hover:text-surface-200'}"
						onclick={() => comicType = 'gallery'}
					>
						{m.catalog_gallery()}
					</button>
				</div>
				<p class="mt-1 text-[10px] text-surface-500">
					{#if comicType === 'story'}
						{m.catalog_translates_with_rolling_story()}
					{:else}
						{m.catalog_each_page_translated_independently()}
					{/if}
				</p>
			</fieldset>

			<!-- Initial Summary (story mode + off-device only) -->
			{#if comicType === 'story' && !isOnDevice}
				<div class="mb-4">
					<label for="initial-summary" class="mb-1.5 block text-sm font-medium text-surface-300">
						{m.catalog_initial_story_summary()} <span class="text-surface-500">{m.catalog_optional()}</span>
					</label>
					<textarea
						id="initial-summary"
						bind:value={initialSummary}
						placeholder={m.catalog_provide_an_official_story()}
						rows="3"
						class="w-full resize-y rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
					></textarea>
				</div>
			{/if}

			<!-- Page Range -->
			<div class="mb-4">
				<label class="flex items-center gap-2 text-sm font-medium text-surface-300">
					<input
						type="checkbox"
						bind:checked={usePageRange}
						class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
					/>
					{m.catalog_translate_specific_page_range()}
				</label>
				{#if usePageRange}
					<div class="mt-2 flex items-center gap-2">
						<div class="flex-1">
							<label for="start-page" class="mb-1 block text-xs text-surface-400">{m.catalog_start_page()}</label>
							<input
								id="start-page"
								type="number"
								bind:value={startPage}
								min="1"
								max={volume.page_count}
								class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
							/>
						</div>
						<span class="mt-5 text-surface-500">–</span>
						<div class="flex-1">
							<label for="end-page" class="mb-1 block text-xs text-surface-400">{m.catalog_end_page()}</label>
							<input
								id="end-page"
								type="number"
								bind:value={endPage}
								min="1"
								max={volume.page_count}
								class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
							/>
						</div>
					</div>
					{#if !pageRangeValid}
						<p class="mt-1 text-[10px] text-red-400">
							{m.catalog_invalid_page_range({ max: volume.page_count })}
						</p>
					{/if}
				{/if}
			</div>

			<!-- Language Override -->
			<div class="mb-5">
				<label class="flex items-center gap-2 text-sm font-medium text-surface-300">
					<input
						type="checkbox"
						bind:checked={useLanguageOverride}
						class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
					/>
					{m.catalog_override_language_settings()}
				</label>
				{#if useLanguageOverride}
					<div class="mt-2 flex items-center gap-2">
						<div class="flex-1">
							<label for="source-lang" class="mb-1 block text-xs text-surface-400">{m.catalog_from()}</label>
							<select
								id="source-lang"
								bind:value={sourceLanguage}
								class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
							>
								{#each SUPPORTED_LANGUAGES as lang}
									<option value={lang.code}>{getLanguageDisplayName(lang.code)}</option>
								{/each}
							</select>
						</div>
						<span class="mt-5 text-surface-500">→</span>
						<div class="flex-1">
							<label for="target-lang" class="mb-1 block text-xs text-surface-400">{m.catalog_to()}</label>
							<select
								id="target-lang"
								bind:value={targetLanguage}
								class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
							>
								{#each SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto') as lang}
									<option value={lang.code}>{getLanguageDisplayName(lang.code)}</option>
								{/each}
							</select>
						</div>
					</div>
				{/if}
			</div>

			<!-- Generate Overlays -->
			<div class="mb-5">
				<label class="flex items-center gap-2 text-sm font-medium text-surface-300">
					<input
						type="checkbox"
						bind:checked={generateOverlays}
						class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
					/>
					{m.catalog_generate_text_overlays()}
				</label>
				<p class="mt-1 pl-5 text-[10px] text-surface-500">
					{m.catalog_run_pp_ocr_text()}
				</p>
			</div>

			<!-- Skip Review (story mode + off-device only — on-device already skips review) -->
			{#if comicType === 'story' && !isOnDevice}
				<div class="mb-5">
					<label class="flex items-center gap-2 text-sm font-medium text-surface-300">
						<input
							type="checkbox"
							bind:checked={skipReview}
							class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
						/>
						{m.catalog_skip_review_step()}
					</label>
					<p class="mt-1 pl-5 text-[10px] text-surface-500">
						{m.catalog_skip_the_quality_review()}
					</p>
				</div>
			{/if}

			<!-- Actions -->
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={handleStart}
					disabled={!pageRangeValid}
					class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{m.catalog_start_translation()}
				</button>
			</div>
		</div>
	</div>
{/if}

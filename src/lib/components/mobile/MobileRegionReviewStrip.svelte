<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fly } from 'svelte/transition';
	import { motionDuration } from '$lib/util/motion.js';
	import { get } from 'svelte/store';
	import { currentPageRegions, regionTranslationMap } from '$lib/stores/translation-state.js';
	import { highlightedDrawRegionIds } from '$lib/regions/region-draw-session.js';
	import {
		clearDrawnRegionsOnCurrentPage,
		convertTranslatedRegionsToOverlay,
		translateGuidedRegions
	} from '$lib/regions/guided-region-actions.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';

	let busy = $state<'translate' | 'convert' | 'clear' | null>(null);
	let stripError = $state<string | null>(null);

	let highlighted = $derived([...$highlightedDrawRegionIds]);
	let untranslatedCount = $derived(
		$currentPageRegions.filter((region) => $highlightedDrawRegionIds.has(region.id) && !$regionTranslationMap.get(region.id)).length
	);
	let translatedCount = $derived(
		$currentPageRegions.filter((region) => $regionTranslationMap.get(region.id)).length
	);

	// Regions can disappear underneath the review (deleted, converted, page
	// change) — prune the highlight set so the strip reflects reality and
	// dismisses itself once nothing is left to review.
	$effect(() => {
		const onPage = new Set($currentPageRegions.map((region) => region.id));
		const current = $highlightedDrawRegionIds;
		const pruned = [...current].filter((id) => onPage.has(id));
		if (pruned.length !== current.size) {
			highlightedDrawRegionIds.set(new Set(pruned));
		}
	});

	function exitReview(): void {
		playReaderHaptic('control');
		highlightedDrawRegionIds.set(new Set());
	}

	async function runTranslate(): Promise<void> {
		if (busy) return;
		playReaderHaptic('control');
		busy = 'translate';
		stripError = null;
		try {
			const result = await translateGuidedRegions(get(highlightedDrawRegionIds));
			if (!result.ok) stripError = result.error ?? m.reader_region_translation_failed();
		} finally {
			busy = null;
		}
	}

	async function runConvert(): Promise<void> {
		if (busy) return;
		playReaderHaptic('control');
		busy = 'convert';
		stripError = null;
		try {
			const result = await convertTranslatedRegionsToOverlay();
			if (!result.ok) stripError = result.error ?? m.reader_adding_to_overlay_failed();
			else exitReview();
		} finally {
			busy = null;
		}
	}

	async function runClear(): Promise<void> {
		if (busy) return;
		playReaderHaptic('control');
		busy = 'clear';
		stripError = null;
		try {
			const result = await clearDrawnRegionsOnCurrentPage();
			if (!result.ok) stripError = result.error ?? m.reader_clearing_regions_failed();
		} finally {
			busy = null;
		}
	}
</script>

<!-- Pill-styled stand-in for the reader bottom bar (same dock tokens); the
     error line renders inside the pill above the action row. -->
<nav class="pointer-events-auto rounded-[var(--dock-radius)] bg-surface-container-high p-[6px] shadow-dock" transition:fly={{ y: 8, duration: motionDuration(120) }} aria-label={m.reader_region_review()} data-reader-region-review>
	{#if stripError}
		<p class="mb-1 truncate rounded-full bg-red-950/60 px-3 py-1 text-[11px] text-red-300" role="alert">{stripError}</p>
	{/if}
	<div class="grid h-[calc(var(--dock-height)-12px)] grid-cols-4">
		<button
			type="button"
			class="min-w-0 truncate rounded-[26px] px-1 text-[11px] font-semibold text-teal-300 active:bg-surface-800 disabled:text-surface-500"
			disabled={busy !== null || untranslatedCount === 0}
			onclick={() => void runTranslate()}
			data-region-review-action="translate"
		>{busy === 'translate' ? m.reader_translating() : m.reader_translate_highlighted({ highlighted: untranslatedCount || highlighted.length })}</button>
		<button
			type="button"
			class="min-w-0 truncate rounded-[26px] px-1 text-[11px] font-semibold text-surface-100 active:bg-surface-800 disabled:text-surface-500"
			disabled={busy !== null || translatedCount === 0}
			onclick={() => void runConvert()}
			data-region-review-action="add-overlay"
		>{busy === 'convert' ? m.reader_adding() : m.reader_add_to_overlay_translatedcount({ translatedCount })}</button>
		<button
			type="button"
			class="min-w-0 truncate rounded-[26px] px-1 text-[11px] font-semibold text-surface-300 active:bg-surface-800 disabled:text-surface-500"
			disabled={busy !== null}
			onclick={() => void runClear()}
			data-region-review-action="clear"
		>{busy === 'clear' ? m.reader_clearing() : m.reader_clear_drawn()}</button>
		<button
			type="button"
			class="min-w-0 truncate rounded-[26px] px-1 text-[11px] font-semibold text-surface-300 active:bg-surface-800"
			onclick={exitReview}
			data-region-review-action="exit"
		>{m.common_done()}</button>
	</div>
</nav>

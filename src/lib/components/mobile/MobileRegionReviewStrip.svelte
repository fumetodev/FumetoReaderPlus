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
	import Icon, { type IconName } from '$lib/components/ui/Icon.svelte';

	interface StripAction {
		id: 'translate' | 'add-overlay' | 'clear' | 'exit';
		icon: IconName;
		/** The one short word under the icon. */
		label: string;
		/** What the button does, in full: its accessible name. */
		name: string;
		tone: string;
		disabled?: boolean;
		working?: boolean;
		/** How many regions the action would act on; drawn as a badge when positive. */
		count?: number;
		run: () => void;
	}

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

<!-- One segment of the strip: an icon over a single word. -->
{#snippet segment(action: StripAction)}
	<button
		type="button"
		class="relative flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-[26px] text-[10px] font-semibold active:bg-surface-800 disabled:text-surface-500 {action.tone}"
		disabled={action.disabled}
		aria-label={action.name}
		aria-busy={action.working || undefined}
		onclick={action.run}
		data-region-review-action={action.id}
		data-region-review-count={action.count}
	>
		<!-- A fixed 22px box whatever is in it, so the label never moves when
		     the icon gives way to the progress ring. -->
		<span class="relative grid h-[22px] w-[22px] place-items-center" aria-hidden="true">
			{#if action.working}
				<span class="block h-[20px] w-[20px] animate-spin rounded-full border-2 border-purple-400 border-t-transparent motion-reduce:animate-none"></span>
			{:else}
				<Icon name={action.icon} size={22} />
				{#if action.count}
					<!-- Hung off the corner rather than over it: the translate
					     glyph has an arrow in that corner. The button's own colour
					     is the fill, so a disabled segment's badge dims with it. -->
					<span class="absolute -right-[15px] -top-[6px] grid h-[15px] min-w-[15px] place-items-center rounded-full bg-current px-[3px] ring-2 ring-surface-container-high">
						<span class="text-[10px] font-bold leading-none text-surface-container-high">{action.count}</span>
					</span>
				{/if}
			{/if}
		</span>
		<span class="max-w-full truncate">{action.label}</span>
	</button>
{/snippet}

<!-- Pill-styled stand-in for the reader bottom bar (same dock tokens); the
     error line renders inside the pill above the action row. -->
<nav class="pointer-events-auto rounded-[var(--dock-radius)] bg-surface-container-high p-[6px] shadow-dock" transition:fly={{ y: 8, duration: motionDuration(120) }} aria-label={m.reader_region_review()} data-reader-region-review>
	{#if stripError}
		<p class="mb-1 truncate rounded-full bg-red-950/60 px-3 py-1 text-[11px] text-red-300" role="alert">{stripError}</p>
	{/if}
	<!-- grid-cols-4 is what holds the four segments to one width, as
	     grid-cols-3 does for the dock. A quarter of a 360dp screen is 79px, a
	     pixel short of the longest label at the dock's 11px, hence 10px. -->
	<div class="grid h-[calc(var(--dock-height)-12px)] grid-cols-4">
		{@render segment({
			id: 'translate',
			icon: 'translate',
			label: m.reader_translate(),
			name: busy === 'translate' ? m.reader_translating() : m.reader_translate_highlighted({ highlighted: untranslatedCount || highlighted.length }),
			tone: 'text-teal-300',
			disabled: busy !== null || untranslatedCount === 0,
			working: busy === 'translate',
			count: untranslatedCount,
			run: () => void runTranslate()
		})}
		{@render segment({
			id: 'add-overlay',
			icon: 'layers-plus',
			label: m.settings_tab_overlay(),
			name: busy === 'convert' ? m.reader_adding() : m.reader_add_to_overlay_translatedcount({ translatedCount }),
			tone: 'text-surface-100',
			disabled: busy !== null || translatedCount === 0,
			working: busy === 'convert',
			count: translatedCount,
			run: () => void runConvert()
		})}
		{@render segment({
			id: 'clear',
			icon: 'trash',
			label: m.catalog_clear(),
			name: busy === 'clear' ? m.reader_clearing() : m.reader_clear_drawn(),
			tone: 'text-surface-300',
			disabled: busy !== null,
			working: busy === 'clear',
			run: () => void runClear()
		})}
		{@render segment({
			id: 'exit',
			icon: 'check',
			label: m.common_done(),
			name: m.common_done(),
			tone: 'text-surface-300',
			run: exitReview
		})}
	</div>
</nav>

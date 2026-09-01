<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * Read-only translation overlay for one page of the long-strip reader.
	 *
	 * Renders the same planned boxes as TranslationOverlay (same plan
	 * controller, same settings, same SVG text runs) without the editing
	 * machinery (selection, move/resize, direct editing) — those remain
	 * paged-mode features. The current page mirrors the live page-scoped stores
	 * so progressive translation updates paint as they land; every other page
	 * reads its persisted record.
	 *
	 * Reveal placements ARE tappable here. A reveal is a whitewashed balloon
	 * whose translation could not be typeset at any size, so without somewhere
	 * to read it the strip erased the original and offered nothing in return.
	 */
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { isOverlayMode, overlayFontScale } from '$lib/stores/reader-state.js';
	import { currentPageOverlay, currentPageTranslation } from '$lib/stores/translation-state.js';
	import { settings } from '$lib/settings/settings.js';
	import type { OverlayRenderPlanV2, PageOverlayDataV2, PageTranslationEntry, PlannedOverlayItemV2, Point, Rect } from '$lib/types/index.js';
	import {
		fontFamilyForKey,
		overlayBackgroundShapes,
		overlayLayoutSettingsFromApp,
		pageOverlayRepository
	} from '$lib/overlay-layout/index.js';

	interface Props {
		volumeUuid: string;
		pageIndex: number;
		isCurrent: boolean;
		/**
		 * Source-image pixels → screen pixels for this page. The overlay lives in
		 * source space and is scaled as a whole, so chrome that should stay a
		 * constant size on screen (the reveal popover) divides by this.
		 */
		scale?: number;
	}

	let { volumeUuid, pageIndex, isCurrent, scale = 1 }: Props = $props();
	const chrome = $derived(scale > 0 ? 1 / scale : 1);

	// One controller for all strip pages so plans cache per scope across
	// scroll-in/scroll-out cycles.
	const controller = stripPlanController();
	let persistedDocument = $state.raw<PageOverlayDataV2 | null>(null);
	let persistedEntries = $state.raw<PageTranslationEntry[]>([]);
	let plan = $state.raw<OverlayRenderPlanV2 | null>(null);
	let planEntries = $state.raw<PageTranslationEntry[]>([]);
	let fetchGeneration = 0;
	let planningGeneration = 0;

	let visible = $derived($settings.overlayEnabled && $isOverlayMode);

	// Persisted record for non-current pages; refetched when the page loses
	// current status (a just-committed translation is persisted by then).
	$effect(() => {
		const uuid = volumeUuid;
		const index = pageIndex;
		const current = isCurrent;
		if (!visible) return;
		const generation = ++fetchGeneration;
		if (current) return; // live stores drive the current page
		void pageOverlayRepository.load(uuid, index).then((read) => {
			if (generation !== fetchGeneration) return;
			if (read.status === 'ready') {
				persistedDocument = read.overlay as PageOverlayDataV2;
				persistedEntries = read.pageTranslation?.entries ?? [];
			} else {
				persistedDocument = null;
				persistedEntries = [];
			}
		}).catch(() => {
			if (generation === fetchGeneration) {
				persistedDocument = null;
				persistedEntries = [];
			}
		});
	});

	// Plan whichever document is authoritative for this page right now.
	$effect(() => {
		const current = isCurrent;
		const document = current ? ($currentPageOverlay as PageOverlayDataV2 | null) : persistedDocument;
		const entries = current ? ($currentPageTranslation?.entries ?? null) : persistedEntries;
		const enabled = visible;
		const settingsSnapshot = overlayLayoutSettingsFromApp($settings, $overlayFontScale);
		const uuid = volumeUuid;
		const index = pageIndex;
		const generation = ++planningGeneration;
		if (!enabled || !document || !entries) {
			plan = null;
			planEntries = [];
			return;
		}
		// Track every planning input before the async boundary.
		JSON.stringify([document, entries, settingsSnapshot, uuid, index]);
		const abort = new AbortController();
		void controller.request({
			scopeId: `strip:${uuid}:${index}`,
			document: structuredClone(document),
			translations: entries,
			settings: settingsSnapshot
		}, {
			volumeUuid: uuid,
			pageIndex: index,
			persist: false,
			signal: abort.signal
		}).then((next) => {
			if (generation === planningGeneration) {
				plan = next;
				planEntries = entries;
			}
		}).catch(() => {
			if (generation === planningGeneration) {
				plan = null;
				planEntries = [];
			}
		});
		return () => abort.abort();
	});

	// A page leaving current status refetches its (now committed) record.
	let wasCurrent = false;
	$effect(() => {
		const current = isCurrent;
		if (untrack(() => wasCurrent) && !current) {
			persistedDocument = null;
			persistedEntries = [];
			fetchGeneration += 1;
			const generation = fetchGeneration;
			void pageOverlayRepository.load(volumeUuid, pageIndex).then((read) => {
				if (generation !== fetchGeneration) return;
				if (read.status === 'ready') {
					persistedDocument = read.overlay as PageOverlayDataV2;
					persistedEntries = read.pageTranslation?.entries ?? [];
				}
			}).catch(() => undefined);
		}
		wasCurrent = current;
	});

	function textFor(item: PlannedOverlayItemV2): string {
		const document = isCurrent ? ($currentPageOverlay as PageOverlayDataV2 | null) : persistedDocument;
		const overlayItem = document?.items.find((candidate) => candidate.id === item.itemId);
		return overlayItem?.manual.textOverride
			?? planEntries.find((entry) => entry.id === overlayItem?.translationEntryId)?.translated_text
			?? '';
	}

	function polygonClip(item: PlannedOverlayItemV2): string {
		if (!item.rect || !item.clipPolygon?.length) return '';
		const points = item.clipPolygon.map((point) => {
			const x = (point.x - item.rect!.x) / item.rect!.width * 100;
			const y = (point.y - item.rect!.y) / item.rect!.height * 100;
			return `${x}% ${y}%`;
		});
		return `polygon(${points.join(',')})`;
	}

	function polygonPoints(polygon: Point[]): string {
		return polygon.map((point) => `${point.x},${point.y}`).join(' ');
	}

	function rotationTransform(rect: Rect, degrees: number): string | undefined {
		if (!degrees) return undefined;
		return `rotate(${degrees} ${rect.x + rect.width / 2} ${rect.y + rect.height / 2})`;
	}

	let revealOpenItemId = $state<string | null>(null);

	/**
	 * Close the popover when this page scrolls out of the render window or the
	 * overlay is switched off, so it cannot outlive the page it belongs to.
	 */
	$effect(() => {
		if (!visible && revealOpenItemId !== null) revealOpenItemId = null;
	});

	function toggleReveal(itemId: string): void {
		revealOpenItemId = revealOpenItemId === itemId ? null : itemId;
	}

	/**
	 * The strip's own tap handler toggles the reader chrome, and the scroller
	 * owns vertical movement. A tap that opens or closes a reveal must not also
	 * toggle chrome, so it is stopped here; scrolling is untouched because the
	 * box never captures touchmove.
	 */
	function handleRevealTap(event: MouseEvent, itemId: string): void {
		event.stopPropagation();
		toggleReveal(itemId);
	}
</script>

<script lang="ts" module>
	import { PageOverlayPlanController as StripPlanControllerClass } from '$lib/overlay-layout/index.js';

	let sharedStripController: InstanceType<typeof StripPlanControllerClass> | null = null;
	function stripPlanController() {
		sharedStripController ??= new StripPlanControllerClass();
		return sharedStripController;
	}
</script>

{#if visible && plan}
	<div
		data-long-strip-overlay={pageIndex}
		data-render-plan-id={plan.planId}
		class="absolute inset-0"
		style="z-index: 5; pointer-events: none;"
	>
		<!--
			The page's whitewash pass, shared with the paged reader and the
			exporter. Painting each background on its own box left the gaps
			between stacked bands unpainted, showing strips of the original
			between the translated lines.
		-->
		<svg
			data-overlay-background-layer
			aria-hidden="true"
			class="absolute left-0 top-0"
			width={plan.sourceImage.width}
			height={plan.sourceImage.height}
			viewBox={`0 0 ${plan.sourceImage.width} ${plan.sourceImage.height}`}
			style="z-index:0; pointer-events:none;"
		>
			{#each overlayBackgroundShapes(plan) as shape (shape.itemId)}
				<g transform={rotationTransform(shape.rect, shape.rotationDegrees)}>
					{#if shape.layers?.length}
						<!-- Soft-edged unbounded whitewash: concentric fills with explicit
						     alphas. `fill-opacity` composites source-over exactly as the
						     Canvas exporter's globalAlpha does, which a blur filter would
						     not — all three surfaces paint the same plan. -->
						{#each shape.layers as layer, layerIndex (layerIndex)}
							{#if layer.rect.width > 0 && layer.rect.height > 0}
								<rect
									x={layer.rect.x}
									y={layer.rect.y}
									width={layer.rect.width}
									height={layer.rect.height}
									rx={layer.radius || undefined}
									fill={shape.fill}
									fill-opacity={layer.alpha}
								/>
							{/if}
						{/each}
					{:else if shape.polygon?.length}
						<polygon points={polygonPoints(shape.polygon)} fill={shape.fill} />
					{:else}
						<rect x={shape.rect.x} y={shape.rect.y} width={shape.rect.width} height={shape.rect.height} fill={shape.fill} />
					{/if}
				</g>
			{/each}
		</svg>
		{#each plan.items.filter((item) => item.status === 'placed' && item.rect && (item.fitMode === 'reveal' || (item.font && item.lines))) as item (item.itemId)}
			{@const rect = item.rect!}
			{@const clip = polygonClip(item)}
			{@const reveal = item.fitMode === 'reveal'}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				data-overlay-box={item.itemId}
				data-overlay-fit-mode={item.fitMode ?? 'standard'}
				role="img"
				aria-label={textFor(item)}
				class="absolute"
				style="left:{rect.x}px; top:{rect.y}px; width:{rect.width}px; height:{rect.height}px; background:transparent; clip-path:{clip || 'none'}; transform:{item.rotationDegrees ? `rotate(${item.rotationDegrees}deg)` : 'none'}; transform-origin:center; z-index:{reveal ? 1 : 2}; pointer-events:{reveal ? 'auto' : 'none'}; overflow:hidden;"
				onclick={reveal ? (event) => handleRevealTap(event, item.itemId) : undefined}
			>
				{#if reveal}
					<!-- Same accent tint the paged reader uses to say "tap me". -->
					<div
						data-overlay-reveal-highlight={item.itemId}
						class="absolute inset-0"
						style="background:rgba(45, 212, 191, 0.28); pointer-events:none;"
					></div>
				{/if}
				{#if item.fitMode !== 'reveal'}
					<svg aria-hidden="true" width={rect.width} height={rect.height} viewBox={`0 0 ${rect.width} ${rect.height}`} style="position:absolute;inset:0;overflow:visible;white-space:pre;word-break:normal;overflow-wrap:normal;">
						{#each item.lines ?? [] as line, lineIndex (`${line.sourceRange.startUtf16}:${lineIndex}`)}
							{#each line.runs as run, runIndex (`${run.sourceRange.startUtf16}:${runIndex}`)}
								<text
									x={run.origin.x - item.rect!.x}
									y={run.origin.y - item.rect!.y}
									text-anchor="start"
									direction={run.direction}
									unicode-bidi="plaintext"
									font-family={fontFamilyForKey(run.fontKey)}
									font-weight={item.font!.weight}
									font-size={item.font!.size}
									fill="#111"
									transform={run.rotationDegrees ? `rotate(${run.rotationDegrees} ${run.origin.x - item.rect!.x} ${run.origin.y - item.rect!.y})` : undefined}
								>{run.text}</text>
							{/each}
						{/each}
					</svg>
				{/if}
			</div>
		{/each}
		{#if revealOpenItemId}
			{@const revealItem = plan.items.find((planned) => planned.itemId === revealOpenItemId)}
			{#if revealItem?.rect}
				<!-- Tap-away backdrop, then the translation, above every box. -->
				<button
					type="button"
					aria-label={m.reader_dismiss_translation_popover()}
					data-overlay-reveal-backdrop
					class="absolute inset-0"
					style="z-index:28; pointer-events:auto; background:transparent; border:none;"
					onclick={(event) => { event.stopPropagation(); revealOpenItemId = null; }}
				></button>
				{@const width = Math.min(plan.sourceImage.width * 0.8, 340 * chrome)}
				{@const left = Math.max(4, Math.min(revealItem.rect.x, plan.sourceImage.width - width - 4))}
				<!--
					Anchored above the balloon when it sits low on the page. Pages are
					stacked edge to edge, so a popover that runs past this page's
					bottom is drawn over — and its taps swallowed by — the next page,
					which is a sibling later in the DOM.
				-->
				{@const placeAbove = revealItem.rect.y + revealItem.rect.height > plan.sourceImage.height * 0.6}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					role="dialog"
					aria-label={m.reader_translated_text()}
					tabindex="-1"
					data-overlay-reveal-popover={revealOpenItemId}
					data-overlay-reveal-placement={placeAbove ? 'above' : 'below'}
					onclick={(event) => { event.stopPropagation(); revealOpenItemId = null; }}
					class="absolute rounded-lg bg-surface-900/95 text-surface-100 shadow-xl"
					style="z-index:30; pointer-events:auto; left:{left}px; {placeAbove
						? `bottom:${Math.max(4, plan.sourceImage.height - revealItem.rect.y + 8 * chrome)}px;`
						: `top:${revealItem.rect.y + revealItem.rect.height + 8 * chrome}px;`} max-width:{width}px; max-height:{plan.sourceImage.height * 0.5}px; overflow:auto; padding:{12 * chrome}px; font-size:{15 * chrome}px; line-height:1.35;"
				>
					{textFor(revealItem)}
				</div>
			{/if}
		{/if}
	</div>
{/if}

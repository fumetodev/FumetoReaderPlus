<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * RegionOverlay — Canvas overlay for drawing and displaying translation regions.
	 *
	 * Positioned absolutely over the manga page image, INSIDE the panzoom container.
	 * Since panzoom applies CSS transforms to the container, the canvas naturally
	 * moves and scales with the image. All coordinates are in image space — no
	 * panzoom transform math needed for drawing or hit-testing.
	 *
	 * Handles:
	 * - Drawing new rectangles (click-drag in draw mode)
	 * - Rendering saved regions with visual states
	 * - Hover detection for region highlight
	 */

	import { get } from 'svelte/store';
	import { onDestroy } from 'svelte';
	import { isDrawingMode, currentVolume, currentPageIndex } from '$lib/stores/reader-state.js';
	import { currentPageRegions, regionTranslationMap, translatingRegionIds } from '$lib/stores/translation-state.js';
	import { hoveredRegionId, isOverlayEditMode } from '$lib/stores/ui-state.js';
	import { highlightedDrawRegionIds, persistDrawSessionRegion } from '$lib/regions/region-draw-session.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { deleteGuidedRegion, translateGuidedRegion } from '$lib/regions/guided-region-actions.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { createRegion } from '$lib/regions/region-manager.js';
	import { isMobile } from '$lib/util/platform.js';
	import { RegionDrawGestureArbiter, type ScreenRectangle } from '$lib/reader/region-draw-gesture.js';
	import { claimReaderTapGesture } from '$lib/reader/reader-gesture-claim.js';
	import { getTransform, setTransformExplicit } from '$lib/panzoom/index.js';
	import type { TranslationRegion, DrawingRegion, RegionVisualState } from '$lib/types/index.js';

	interface Props {
		/** Width of the image in pixels */
		imageWidth: number;
		/** Height of the image in pixels */
		imageHeight: number;
	}

	let { imageWidth, imageHeight }: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let drawing: DrawingRegion | null = $state(null);
	const drawGesture = new RegionDrawGestureArbiter(12);

	// ── Guided post-draw review: tap a region for Translate/Delete (mobile) ──
	let reviewPopoverRegionId = $state<string | null>(null);
	let reviewPopoverScale = $state(1);
	let regionActionBusy = $state<'translate' | 'delete' | null>(null);
	let reviewTapStart: { x: number; y: number; pointerId: number } | null = null;

	let reviewActive = $derived(isMobile && $highlightedDrawRegionIds.size > 0 && !$isDrawingMode);
	let reviewPopoverRegion = $derived($currentPageRegions.find((region) => region.id === reviewPopoverRegionId) ?? null);

	function setReviewPopover(regionId: string | null): void {
		reviewPopoverRegionId = regionId;
		if (regionId != null) {
			reviewPopoverScale = Math.max(0.05, getTransform().scale || 1);
			mobileReaderUi.openDisclosure('overlay-reveal');
		} else if (mobileReaderUi.inspect().disclosure === 'overlay-reveal') {
			mobileReaderUi.closeDisclosure();
		}
	}

	$effect(() => {
		if (!isMobile) return;
		if ($mobileReaderUi.disclosure !== 'overlay-reveal' && reviewPopoverRegionId !== null) {
			reviewPopoverRegionId = null;
		}
	});

	$effect(() => {
		// The popover only renders while its region still exists on the current
		// page. When the region vanishes under it (page turn clearing the
		// page-scoped store, "Clear drawn"/"Add to overlay" deleting it), close
		// the popover so the disclosure slot is not left claimed by an
		// invisible surface — a lingering 'overlay-reveal' silently absorbs
		// the next reader tap.
		if (reviewPopoverRegionId !== null && reviewPopoverRegion === null) {
			setReviewPopover(null);
		}
	});

	function regionAtImagePoint(x: number, y: number): TranslationRegion | null {
		for (const region of get(currentPageRegions)) {
			if (x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height) {
				return region;
			}
		}
		return null;
	}

	async function translatePopoverRegion(): Promise<void> {
		const region = reviewPopoverRegion;
		if (!region || regionActionBusy) return;
		playReaderHaptic('control');
		regionActionBusy = 'translate';
		try {
			await translateGuidedRegion(region);
			redraw();
		} finally {
			regionActionBusy = null;
			setReviewPopover(null);
		}
	}

	async function deletePopoverRegion(): Promise<void> {
		const region = reviewPopoverRegion;
		if (!region || regionActionBusy) return;
		playReaderHaptic('control');
		regionActionBusy = 'delete';
		try {
			await deleteGuidedRegion(region.id);
			redraw();
		} finally {
			regionActionBusy = null;
			setReviewPopover(null);
		}
	}

	onDestroy(() => {
		if (isMobile && reviewPopoverRegionId !== null && mobileReaderUi.inspect().disclosure === 'overlay-reveal') {
			mobileReaderUi.closeDisclosure();
		}
	});

	// Scale factor for line widths so they're visible at image resolution
	function lineScale(): number {
		return Math.max(1, imageWidth / 800);
	}

	// Get the visual state of a region
	function getRegionState(region: TranslationRegion): RegionVisualState {
		if (get(translatingRegionIds).has(region.id)) return 'translating';
		if (get(hoveredRegionId) === region.id) return 'hovered';
		if (get(regionTranslationMap).has(region.id)) return 'translated';
		return 'untranslated';
	}

	// Style constants per visual state (lineWidth will be scaled by lineScale())
	const REGION_STYLES: Record<RegionVisualState, { fill: string; stroke: string; lineWidth: number; dash: number[] }> = {
		untranslated: { fill: 'rgba(148, 163, 184, 0.12)', stroke: 'rgba(148, 163, 184, 0.5)', lineWidth: 1.5, dash: [4, 4] },
		translated: { fill: 'rgba(59, 130, 246, 0.15)', stroke: 'rgba(59, 130, 246, 0.7)', lineWidth: 1.5, dash: [] },
		hovered: { fill: 'rgba(59, 130, 246, 0.25)', stroke: 'rgba(59, 130, 246, 1)', lineWidth: 2, dash: [] },
		translating: { fill: 'rgba(168, 85, 247, 0.2)', stroke: 'rgba(168, 85, 247, 0.8)', lineWidth: 2, dash: [6, 3] }
	};

	// Drawing region style
	const DRAWING_STYLE = { fill: 'rgba(59, 130, 246, 0.2)', stroke: 'rgba(59, 130, 246, 0.9)', lineWidth: 2 };

	function redraw() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		// Set canvas resolution to match image dimensions.
		// The CSS sizes the canvas to 100% of the parent (which is image-sized).
		// Panzoom scales this via CSS transform, so we draw at native image resolution.
		if (canvas.width !== imageWidth || canvas.height !== imageHeight) {
			canvas.width = imageWidth;
			canvas.height = imageHeight;
		}

		ctx.clearRect(0, 0, imageWidth, imageHeight);

		const scale = lineScale();
		const regions = get(currentPageRegions);

		// Draw saved regions (all coordinates are already in image space)
		for (const region of regions) {
			const style = REGION_STYLES[getRegionState(region)];

			ctx.fillStyle = style.fill;
			ctx.fillRect(region.x, region.y, region.width, region.height);

			ctx.strokeStyle = style.stroke;
			ctx.lineWidth = style.lineWidth * scale;
			ctx.setLineDash(style.dash.map((d) => d * scale));
			ctx.strokeRect(region.x, region.y, region.width, region.height);
		}

		// Draw in-progress rectangle
		if (drawing) {
			const x = drawing.startX;
			const y = drawing.startY;
			const w = drawing.currentX - drawing.startX;
			const h = drawing.currentY - drawing.startY;

			ctx.fillStyle = DRAWING_STYLE.fill;
			ctx.fillRect(x, y, w, h);

			ctx.strokeStyle = DRAWING_STYLE.stroke;
			ctx.lineWidth = DRAWING_STYLE.lineWidth * scale;
			ctx.setLineDash([]);
			ctx.strokeRect(x, y, w, h);
		}

		ctx.setLineDash([]);
	}

	/**
	 * Convert mouse event to image-space coordinates.
	 *
	 * Since the canvas is inside the panzoom container, offsetX/Y gives us
	 * coordinates relative to the canvas element's CSS box. We map from the
	 * CSS display size to the canvas's internal resolution (image dimensions).
	 */
	function eventToImageCoords(e: MouseEvent): { x: number; y: number } {
		if (!canvas) return { x: 0, y: 0 };
		return {
			x: (e.offsetX / canvas.clientWidth) * imageWidth,
			y: (e.offsetY / canvas.clientHeight) * imageHeight
		};
	}

	/** Convert touch event to image-space coordinates. */
	function touchToImageCoords(touch: Touch): { x: number; y: number } {
		if (!canvas) return { x: 0, y: 0 };
		const rect = canvas.getBoundingClientRect();
		return {
			x: ((touch.clientX - rect.left) / rect.width) * imageWidth,
			y: ((touch.clientY - rect.top) / rect.height) * imageHeight
		};
	}

	function handleMouseDown(e: MouseEvent) {
		if (!get(isDrawingMode) || e.button !== 0) return;

		const coords = eventToImageCoords(e);
		drawing = {
			startX: coords.x,
			startY: coords.y,
			currentX: coords.x,
			currentY: coords.y
		};

		e.preventDefault();
		e.stopPropagation();
	}

	function handleMouseMove(e: MouseEvent) {
		if (drawing) {
			// Update drawing rectangle
			const coords = eventToImageCoords(e);
			drawing = { ...drawing, currentX: coords.x, currentY: coords.y };
			redraw();
			return;
		}

		// Hover detection (when not drawing)
		if (!get(isDrawingMode)) {
			const coords = eventToImageCoords(e);
			const regions = get(currentPageRegions);

			let found: string | null = null;
			for (const region of regions) {
				if (
					coords.x >= region.x &&
					coords.x <= region.x + region.width &&
					coords.y >= region.y &&
					coords.y <= region.y + region.height
				) {
					found = region.id;
					break;
				}
			}

			const current = get(hoveredRegionId);
			if (found !== current) {
				hoveredRegionId.set(found);
				redraw();
			}
		}
	}

	async function handleMouseUp(e: MouseEvent) {
		if (!drawing) return;

		const coords = eventToImageCoords(e);
		drawing = { ...drawing, currentX: coords.x, currentY: coords.y };

		// Normalize rectangle (ensure positive width/height)
		const x = Math.min(drawing.startX, drawing.currentX);
		const y = Math.min(drawing.startY, drawing.currentY);
		const width = Math.abs(drawing.currentX - drawing.startX);
		const height = Math.abs(drawing.currentY - drawing.startY);

		// Minimum size threshold (10px in image space)
		if (width > 10 && height > 10) {
			const vol = get(currentVolume);
			const pageIdx = get(currentPageIndex);

			if (vol) {
				await createRegion(vol.volume_uuid, pageIdx, { x, y, width, height });
			}
		}

		drawing = null;
		redraw();
	}

	function handleMouseLeave() {
		if (drawing) {
			drawing = null;
			redraw();
		}
		hoveredRegionId.set(null);
	}

	// Right-click to delete region
	function handleContextMenu(e: MouseEvent) {
		const coords = eventToImageCoords(e);
		const regions = get(currentPageRegions);

		for (const region of regions) {
			if (
				coords.x >= region.x &&
				coords.x <= region.x + region.width &&
				coords.y >= region.y &&
				coords.y <= region.y + region.height
			) {
				e.preventDefault();
				// Import dynamically to avoid circular dependency
				import('$lib/regions/region-manager.js').then(({ deleteRegion }) => {
					deleteRegion(region.id);
					redraw();
				});
				return;
			}
		}
	}

	function screenRectToDrawing(rectangle: ScreenRectangle): DrawingRegion | null {
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		const left = Math.max(rect.left, Math.min(rect.right, rectangle.x));
		const top = Math.max(rect.top, Math.min(rect.bottom, rectangle.y));
		const right = Math.max(rect.left, Math.min(rect.right, rectangle.x + rectangle.width));
		const bottom = Math.max(rect.top, Math.min(rect.bottom, rectangle.y + rectangle.height));
		return {
			startX: ((left - rect.left) / rect.width) * imageWidth,
			startY: ((top - rect.top) / rect.height) * imageHeight,
			currentX: ((right - rect.left) / rect.width) * imageWidth,
			currentY: ((bottom - rect.top) / rect.height) * imageHeight
		};
	}

	function applyGestureUpdate(update: ReturnType<RegionDrawGestureArbiter['inspect']>): void {
		if (update.transform) setTransformExplicit(update.transform);
		drawing = update.tentative ? screenRectToDrawing(update.tentative) : null;
		redraw();
		if (update.commit) void persistScreenRectangle(update.commit);
	}

	async function persistScreenRectangle(rectangle: ScreenRectangle): Promise<void> {
		const normalized = screenRectToDrawing(rectangle);
		const vol = get(currentVolume);
		if (!normalized || !vol || !get(isDrawingMode)) return;
		const x = Math.min(normalized.startX, normalized.currentX);
		const y = Math.min(normalized.startY, normalized.currentY);
		const width = Math.min(imageWidth - x, Math.abs(normalized.currentX - normalized.startX));
		const height = Math.min(imageHeight - y, Math.abs(normalized.currentY - normalized.startY));
		if (width <= 0 || height <= 0) return;
		try {
			await persistDrawSessionRegion({ x, y, width, height });
		} catch (error) {
			console.error('Failed to persist drawn region', error);
		}
	}

	function handlePointerDown(event: PointerEvent): void {
		if (isMobile && reviewActive && !get(isDrawingMode)) {
			reviewTapStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
			return;
		}
		if (!isMobile || !get(isDrawingMode) || !canvas) return;
		event.preventDefault();
		canvas.setPointerCapture(event.pointerId);
		drawGesture.setTransform(getTransform());
		const rect = canvas.getBoundingClientRect();
		applyGestureUpdate(drawGesture.pointerDown(event.pointerId, {
			x: event.clientX,
			y: event.clientY
		}, event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
	}

	function handlePointerMove(event: PointerEvent): void {
		if (!isMobile || !get(isDrawingMode)) return;
		event.preventDefault();
		applyGestureUpdate(drawGesture.pointerMove(event.pointerId, { x: event.clientX, y: event.clientY }));
	}

	function handlePointerUp(event: PointerEvent): void {
		if (isMobile && reviewActive && !get(isDrawingMode)) {
			const start = reviewTapStart;
			reviewTapStart = null;
			if (!start || start.pointerId !== event.pointerId || !canvas) return;
			if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
			const rect = canvas.getBoundingClientRect();
			const region = regionAtImagePoint(
				((event.clientX - rect.left) / rect.width) * imageWidth,
				((event.clientY - rect.top) / rect.height) * imageHeight
			);
			if (region) playReaderHaptic('selection');
			// This pointerup runs BEFORE the same contact's touchend reaches the
			// page-gesture machinery. Claim the tap whenever it acted on the
			// review popover (opened one, or dismissed the open one) so the
			// machinery does not also close the just-opened disclosure or toggle
			// chrome under a dismissal. A miss with no popover open stays
			// unclaimed — that tap still toggles chrome normally.
			if (region || reviewPopoverRegionId !== null) claimReaderTapGesture();
			setReviewPopover(region && region.id !== reviewPopoverRegionId ? region.id : null);
			return;
		}
		if (!isMobile || !get(isDrawingMode)) return;
		event.preventDefault();
		applyGestureUpdate(drawGesture.pointerUp(event.pointerId));
		if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	}

	function handlePointerCancel(event: PointerEvent): void {
		reviewTapStart = null;
		if (!isMobile) return;
		applyGestureUpdate(drawGesture.pointerCancel(event.pointerId));
		if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	}

	function discardTentativeDraw(): void {
		if (!isMobile || !get(isDrawingMode)) return;
		applyGestureUpdate(drawGesture.cancel());
	}

	// Redraw on reactive state changes
	$effect(() => {
		// Track all state that should trigger a redraw
		$currentPageRegions;
		$hoveredRegionId;
		$translatingRegionIds;
		$regionTranslationMap;
		imageWidth;
		imageHeight;
		redraw();
	});
</script>

<svelte:window onorientationchange={discardTentativeDraw} />

<canvas
	bind:this={canvas}
	data-region-overlay
	class="absolute inset-0 h-full w-full"
	style="z-index: 10; cursor: {$isDrawingMode ? 'crosshair' : 'default'}; pointer-events: {$isOverlayEditMode ? 'none' : (isMobile ? ($isDrawingMode || reviewActive ? 'auto' : 'none') : ($isDrawingMode || $currentPageRegions.length > 0 ? 'auto' : 'none'))}; {$isDrawingMode ? 'touch-action: none;' : ''}"
	onmousedown={handleMouseDown}
	onmousemove={handleMouseMove}
	onmouseup={handleMouseUp}
	onmouseleave={handleMouseLeave}
	oncontextmenu={handleContextMenu}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerCancel}
	onlostpointercapture={handlePointerCancel}
></canvas>

{#if reviewPopoverRegion}
	{@const popoverWidth = Math.min(imageWidth * 0.8, 260 / reviewPopoverScale)}
	<!-- Tap-away backdrop, then the per-region actions above the canvas. -->
	<button
		type="button"
		aria-label={m.reader_dismiss_region_actions()}
		data-region-review-backdrop
		class="absolute inset-0"
		style="z-index:28; pointer-events:auto; background:transparent; border:none;"
		onclick={() => setReviewPopover(null)}
	></button>
	<div
		role="dialog"
		aria-label={m.reader_region_actions()}
		data-region-review-popover={reviewPopoverRegion.id}
		class="absolute flex overflow-hidden rounded-lg bg-surface-900/95 text-surface-100 shadow-xl"
		style="z-index:30; pointer-events:auto; left:{Math.max(4, Math.min(reviewPopoverRegion.x, imageWidth - popoverWidth - 4))}px; top:{Math.min(reviewPopoverRegion.y + reviewPopoverRegion.height + 8 / reviewPopoverScale, imageHeight - 56 / reviewPopoverScale)}px; font-size:{14 / reviewPopoverScale}px;"
	>
		<button
			type="button"
			class="whitespace-nowrap font-semibold text-teal-300 active:bg-surface-800 disabled:text-surface-500"
			style="padding:{10 / reviewPopoverScale}px {14 / reviewPopoverScale}px;"
			disabled={regionActionBusy !== null}
			onclick={() => void translatePopoverRegion()}
			data-region-popover-action="translate"
		>{regionActionBusy === 'translate' ? m.reader_translating() : $regionTranslationMap.has(reviewPopoverRegion.id) ? m.reader_re_translate() : m.reader_translate()}</button>
		<button
			type="button"
			class="whitespace-nowrap font-semibold text-red-300 active:bg-surface-800 disabled:text-surface-500"
			style="padding:{10 / reviewPopoverScale}px {14 / reviewPopoverScale}px; border-left:{1 / reviewPopoverScale}px solid rgb(63 63 70);"
			disabled={regionActionBusy !== null}
			onclick={() => void deletePopoverRegion()}
			data-region-popover-action="delete"
		>{regionActionBusy === 'delete' ? m.reader_deleting() : m.settings_models_delete()}</button>
	</div>
{/if}

/**
 * Panzoom utility for Fumeto.
 *
 * Adapted from mokuro-reader's panzoom/util.ts.
 * Key changes:
 * - beforeMouseDown checks for "draw region" mode instead of text boxes
 * - Simplified settings integration
 * - Added getTransform() export for coordinate mapping in region selection
 */

import type { PanZoom } from 'panzoom';
import panzoom from 'panzoom';
import { writable, get } from 'svelte/store';
import { isDrawingMode, readingDirection } from '$lib/stores/reader-state.js';
import { isOverlayEditMode } from '$lib/stores/ui-state.js';
import { isDesktopTauri, isMobile } from '$lib/util/platform.js';

let pz: PanZoom | undefined;
let container: HTMLElement | undefined;
let viewportElement: HTMLElement | undefined;

/** Known content dimensions — set by PageViewer, avoids reading from DOM. */
let _contentWidth = 0;
let _contentHeight = 0;

/** Set the known content dimensions (called by PageViewer on page change). */
export function setContentDimensions(w: number, h: number) {
	_contentWidth = w;
	_contentHeight = h;
}

/** Get content width (explicit value preferred, DOM fallback). */
function getContentWidth(): number {
	return _contentWidth || container?.offsetWidth || 0;
}

/** Get content height (explicit value preferred, DOM fallback). */
function getContentHeight(): number {
	return _contentHeight || container?.offsetHeight || 0;
}

export const panzoomStore = writable<PanZoom | undefined>(undefined);

/** Set the viewport element used for size calculations (the reader area excluding header/sidebar). */
export function setViewport(el: HTMLElement) {
	viewportElement = el;
}

/** Get the actual viewport dimensions (reader area, not the full window). */
function getViewportRect(): { width: number; height: number } {
	if (viewportElement) {
		return { width: viewportElement.clientWidth, height: viewportElement.clientHeight };
	}
	return { width: window.innerWidth, height: window.innerHeight };
}

/** Notification for zoom level changes (for UI display) */
export const zoomNotification = writable<{ percent: number; timestamp: number } | null>(null);

/**
 * Initialize panzoom on a DOM node.
 * Returns a Svelte action cleanup object.
 */
export function initPanzoom(node: HTMLElement) {
	container = node;
	pauseHolds = 0;

	pz = panzoom(node, {
		bounds: false,
		maxZoom: 10,
		minZoom: 0.01,
		zoomDoubleClickSpeed: 1,
		enableTextSelection: false,
		onDoubleClick: () => false,
		beforeMouseDown: () => {
			// When in drawing mode or overlay edit mode, prevent panzoom from consuming
			// mouse events so the canvas overlay or overlay boxes can handle clicks
			return get(isDrawingMode) || get(isOverlayEditMode);
		},
		// Disable library's wheel zoom — we handle it ourselves
		beforeWheel: () => true,
		onTouch: (e) => {
			// On mobile: allow single-finger pan when not drawing/editing, block when drawing
			// When overlay edit mode is active, don't consume events so box taps work
			// On desktop: only allow multi-finger touch (pinch zoom)
			if (isMobile) {
				if (get(isDrawingMode)) return false;
				if (get(isOverlayEditMode)) return false;
				// Panzoom consuming a touch preventDefaults it, which stops the
				// browser from synthesizing a click — real-finger taps on
				// interactive overlay children (selection handles/actions,
				// reveal balloons and popovers, region-review popovers) would
				// silently do nothing. These elements are small and only exist
				// in specific states, so exempting them barely affects panning.
				const target = e.target as HTMLElement | null;
				if (target?.closest?.(
					'[data-overlay-manipulation], [data-overlay-fit-mode="reveal"], '
						+ '[data-overlay-reveal-backdrop], [data-overlay-reveal-popover], '
						+ '[data-overlay-review-badge], [data-floating-box-editor], '
						+ '[data-region-review-popover], [data-region-review-backdrop]'
				)) {
					return false;
				}
				return true;
			}
			return e.touches.length > 1;
		},
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-expect-error filterKey typing is wrong in panzoom
		filterKey: (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;

			// Always filter the reader's own navigation keys: left/right arrows
			// turn pages, and Space/PageUp/PageDown/Home/End are the desktop
			// paging keys (PageViewer owns them; panzoom must not pan on them).
			if (
				e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' '
				|| e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End'
			) {
				return true;
			}

			// Filter all keys when in inputs or settings
			if (
				target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable ||
				target.closest('[data-settings]') ||
				target.closest('[data-dialog]')
			) {
				return true;
			}

			// Filter nav keys with modifiers
			const isNavKey = ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key);
			if (isNavKey && (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)) {
				return true;
			}

			return false;
		}
	});

	panzoomStore.set(pz);

	pz.on('pan', () => keepInBounds());
	pz.on('zoom', () => keepInBounds());

	return {
		destroy() {
			pz?.dispose();
			pz = undefined;
			container = undefined;
			pauseHolds = 0;
			panzoomStore.set(undefined);
		}
	};
}

// ============================================================
// Transform accessors (for coordinate mapping in region system)
// ============================================================

/**
 * Pause ownership. The library's pause() is a single boolean, so any blind
 * pause()/resume() pair silently cancels a hold someone else still depends
 * on — the box editor holds a pause for its whole lifetime, and the zoom
 * helpers used to blind-resume around a single transform, stealing that hold
 * whenever a viewport resize re-fit fired mid-edit (which then let panzoom
 * preventDefault every editor touch: dead ✕, dead sliders, dead textarea).
 * Holds are counted here; the library only resumes when none remain.
 */
let pauseHolds = 0;

/** Pause panzoom — removes all event listeners, fully locking pan/zoom. Counted; pair with resumePanzoom. */
export function pausePanzoom(): void {
	pauseHolds++;
	pz?.pause();
}

/** Release one pause hold — re-attaches event listeners only when no holds remain */
export function resumePanzoom(): void {
	if (pauseHolds > 0) pauseHolds--;
	if (pauseHolds === 0) pz?.resume();
}

/** Run a transform with gesture listeners detached, without disturbing outstanding holds. */
function withPausedTransform(fn: () => void): void {
	if (!pz) return;
	pausePanzoom();
	try {
		fn();
	} finally {
		resumePanzoom();
	}
}

/** Get current panzoom transform (for coordinate mapping) */
export function getTransform(): { x: number; y: number; scale: number } {
	if (!pz) return { x: 0, y: 0, scale: 1 };
	return pz.getTransform();
}

/** Apply draw-mode pan/pinch math while panzoom's own gesture listeners are paused. */
export function setTransformExplicit(transform: { x: number; y: number; scale: number }): void {
	if (!pz) return;
	pz.pause();
	pz.zoomAbs(0, 0, Math.max(0.01, Math.min(10, transform.scale)));
	pz.moveTo(transform.x, transform.y);
}

/** Subscribe to transform changes (for canvas redraws) */
export function onTransformChange(callback: () => void): () => void {
	if (!pz) return () => {};

	const panHandler = () => callback();
	const zoomHandler = () => callback();

	pz.on('pan', panHandler);
	pz.on('zoom', zoomHandler);

	return () => {
		pz?.off('pan', panHandler);
		pz?.off('zoom', zoomHandler);
	};
}

// ============================================================
// Pan alignment
// ============================================================

type PanX = 'left' | 'center' | 'right';
type PanY = 'top' | 'center' | 'bottom';

export function panAlign(alignX: PanX, alignY: PanY) {
	if (!pz || !container) return;

	const { scale } = pz.getTransform();
	const { width: innerWidth, height: innerHeight } = getViewportRect();
	const cw = getContentWidth();
	const ch = getContentHeight();

	let x = 0;
	let y = 0;

	switch (alignX) {
		case 'left':
			x = 0;
			break;
		case 'center':
			x = (innerWidth - cw * scale) / 2;
			break;
		case 'right':
			x = innerWidth - cw * scale;
			break;
	}

	switch (alignY) {
		case 'top':
			y = 0;
			break;
		case 'center':
			y = (innerHeight - ch * scale) / 2;
			break;
		case 'bottom':
			y = innerHeight - ch * scale;
			break;
	}

	withPausedTransform(() => pz!.moveTo(x, y));
}

/**
 * Pan to reading start position based on reading direction.
 * RTL manga: top-right. LTR: top-left.
 */
export function panToPageStart() {
	const isRtl = get(readingDirection) === 'rtl';
	panAlign(isRtl ? 'right' : 'left', 'top');
}

// ============================================================
// Zoom controls
// ============================================================

export function zoomOriginal() {
	if (!pz || !container) return;
	withPausedTransform(() => {
		pz!.zoomAbs(0, 0, 1);
		pz!.moveTo(0, 0);
	});
	panToPageStart();
}

export function zoomFitToWidth() {
	if (!pz || !container) return;
	const { width: vw } = getViewportRect();
	const targetScale = vw / getContentWidth();
	withPausedTransform(() => {
		pz!.zoomAbs(0, 0, targetScale);
		pz!.moveTo(0, 0);
	});
	panAlign('center', 'top');
}

export function zoomFitToHeight() {
	if (!pz || !container) return;
	const { height: vh } = getViewportRect();
	const targetScale = vh / getContentHeight();
	withPausedTransform(() => {
		pz!.zoomAbs(0, 0, targetScale);
		pz!.moveTo(0, 0);
	});
	panAlign('center', 'top');
}

export function zoomFitToScreen() {
	if (!pz || !container) return;
	const { width: vw, height: vh } = getViewportRect();
	const scaleX = vw / getContentWidth();
	const scaleY = vh / getContentHeight();
	const targetScale = Math.min(scaleX, scaleY);
	withPausedTransform(() => {
		pz!.zoomAbs(0, 0, targetScale);
		pz!.moveTo(0, 0);
	});
	panAlign('center', 'center');
}

/**
 * Whether the current zoom already matches fit-to-screen. Center taps only
 * need the double-tap disambiguation delay while zoomed in/out — at fit
 * scale, double-tap-to-fit is a no-op, so taps can apply immediately.
 */
export function isAtFitScreenScale(tolerance = 0.02): boolean {
	if (!pz || !container) return true;
	const { width: vw, height: vh } = getViewportRect();
	const contentWidth = getContentWidth();
	const contentHeight = getContentHeight();
	if (contentWidth <= 0 || contentHeight <= 0) return true;
	const fitScale = Math.min(vw / contentWidth, vh / contentHeight);
	const { scale } = pz.getTransform();
	return Math.abs(scale - fitScale) <= fitScale * tolerance;
}

/** Apply the default zoom after page change. Uses double-RAF for layout stability. */
export function zoomDefaultWithLayoutWait() {
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			zoomFitToScreen();
		});
	});
}

// ============================================================
// Bounds enforcement
// ============================================================

export function keepInBounds() {
	if (!pz || !container) return;

	const { x, y, scale } = pz.getTransform();
	const { width: innerWidth, height: innerHeight } = getViewportRect();

	const width = getContentWidth() * scale;
	const height = getContentHeight() * scale;

	let newX = x;
	let newY = y;

	// Center if content fits, otherwise constrain to edges
	if (width <= innerWidth) {
		newX = (innerWidth - width) / 2;
	} else {
		newX = Math.min(0, Math.max(innerWidth - width, x));
	}

	if (height <= innerHeight) {
		newY = (innerHeight - height) / 2;
	} else {
		newY = Math.min(0, Math.max(innerHeight - height, y));
	}

	if (newX !== x || newY !== y) {
		pz.moveTo(newX, newY);
	}
}

// ============================================================
// Wheel handler
// ============================================================

/**
 * Handle wheel events for panning (default) and zooming (Ctrl+wheel).
 * Adapted from mokuro-reader's handleWheel.
 */
export function handleWheel(e: WheelEvent): void {
	if (!pz || !container) return;

	// Don't intercept wheel events outside the panzoom viewport (e.g. sidebar)
	if (!container.contains(e.target as Node)) return;

	const shouldZoom = e.ctrlKey || e.metaKey;

	e.preventDefault();

	if (shouldZoom) {
		// Normalize wheel delta to ~15% zoom per tick
		const baseMultiplier = e.deltaMode === 1 ? 0.15 : e.deltaMode ? 1 : 0.01;
		const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
		const platformMultiplier = isMac ? 1 : 0.5;
		const normalizedDelta = -e.deltaY * baseMultiplier * platformMultiplier;

		let scaleMultiplier = 1 + normalizedDelta;

		const currentScale = pz.getTransform().scale;
		const newScale = Math.max(0.1, Math.min(10, currentScale * scaleMultiplier));
		scaleMultiplier = newScale / currentScale;

		pz.zoomTo(e.clientX, e.clientY, scaleMultiplier);
		zoomNotification.set({ percent: Math.round(newScale * 100), timestamp: Date.now() });
	} else {
		// Pan vertically
		const { x, y } = pz.getTransform();
		pz.moveTo(x, y - e.deltaY);
	}

	keepInBounds();
}

export function scrollImage(direction: 'up' | 'down') {
	if (!pz) return;
	const { x, y } = pz.getTransform();
	const scrollAmount = getViewportRect().height * 0.75;
	if (direction === 'up') {
		pz.smoothMoveTo(x, y + scrollAmount);
	} else {
		pz.smoothMoveTo(x, y - scrollAmount);
	}
	keepInBounds();
}

/**
 * Pan the view so that a box (in image-space pixels) has its bottom edge
 * positioned at a given fraction of the viewport height from the top.
 * Used on mobile to position a tapped overlay box above the translation sheet.
 *
 * @param box  Image-space bounding box { x, y, width, height }
 * @param targetFraction  Where the bottom of the box should appear (0 = top, 1 = bottom)
 */
export function panToShowBox(box: { x: number; y: number; width: number; height: number }, targetFraction: number = 0.5) {
	if (!pz || !container) return;

	const { scale } = pz.getTransform();
	const { width: vw, height: vh } = getViewportRect();

	// Box bottom in screen-space, relative to the container origin
	const boxBottomInImage = box.y + box.height;
	const boxCenterXInImage = box.x + box.width / 2;

	// Target: boxBottom * scale + newY = vh * targetFraction
	const targetY = vh * targetFraction - boxBottomInImage * scale;

	// Center horizontally on the box
	const targetX = vw / 2 - boxCenterXInImage * scale;

	withPausedTransform(() => pz!.moveTo(targetX, targetY));
}

/**
 * Toggle fullscreen. The desktop shell owns its window, so it is asked
 * directly — the document API only fullscreens the page inside a window that
 * keeps its own frame there. Everywhere else (Android, a plain browser) the
 * document API is the whole story. Async so a caller can await the switch.
 */
export async function toggleFullScreen(): Promise<void> {
	if (isDesktopTauri) {
		try {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			const currentWindow = getCurrentWindow();
			await currentWindow.setFullscreen(!(await currentWindow.isFullscreen()));
			return;
		} catch (error) {
			console.warn('Window fullscreen failed, falling back to the document API:', error);
		}
	}
	if (!document.fullscreenElement) {
		await document.documentElement.requestFullscreen?.();
	} else if (document.exitFullscreen) {
		await document.exitFullscreen();
	}
}

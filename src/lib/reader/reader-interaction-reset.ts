import { get } from 'svelte/store';
import { isDrawingMode, pageRotation } from '$lib/stores/reader-state.js';
import {
	editOverlayBoxId,
	hoveredRegionId,
	isOverlayEditMode,
	movingBoxId,
	overlayCancelHandler,
	overlayConfirmHandler,
	pageThumbnailScrubberOpen,
	readerBarsVisible,
	resizeScaleFont,
	resizingBoxId,
	selectedOverlayBoxId,
} from '$lib/stores/ui-state.js';

/**
 * Clear transient reader interaction state when a reader session ends or starts.
 *
 * Overlay visibility itself is intentionally retained. Only editing, drawing,
 * modal controls, and in-progress move/resize interactions are reset.
 */
export function resetReaderInteractionState(): void {
	const cancelActiveOverlayInteraction = get(overlayCancelHandler);
	try {
		cancelActiveOverlayInteraction?.();
	} catch {
		// Session cleanup must still complete if a stale component callback throws.
	} finally {
		isDrawingMode.set(false);
		isOverlayEditMode.set(false);
		editOverlayBoxId.set(null);
		hoveredRegionId.set(null);
		movingBoxId.set(null);
		resizingBoxId.set(null);
		pageRotation.set(0);
		selectedOverlayBoxId.set(null);
		resizeScaleFont.set(false);
		overlayConfirmHandler.set(null);
		overlayCancelHandler.set(null);
		pageThumbnailScrubberOpen.set(false);
		readerBarsVisible.set(false);
	}
}

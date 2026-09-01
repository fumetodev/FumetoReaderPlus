/**
 * Book tap zones: thirds of the content width. Edge zones map to SCREEN-side
 * navigation (goLeft/goRight) — foliate translates screen side to prev/next
 * by the book's page-progression direction, so RTL mirroring is correct by
 * construction and never re-derived here.
 */

export type BookTapZone = 'left' | 'toggle-chrome' | 'right';

/** Boundary semantics: [0, 1/3) left · [1/3, 2/3] center · (2/3, 1] right. */
export function bookTapZone(xFraction: number): BookTapZone {
	if (!Number.isFinite(xFraction)) return 'toggle-chrome';
	if (xFraction < 1 / 3) return 'left';
	if (xFraction > 2 / 3) return 'right';
	return 'toggle-chrome';
}

/**
 * True when a tap target sits inside an anchor (or a control) — in-content
 * links must navigate instead of turning pages or toggling chrome.
 */
export function isBookInteractiveTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		Boolean(target.closest('a, button, input, select, textarea, audio, video, [role="button"]'))
	);
}

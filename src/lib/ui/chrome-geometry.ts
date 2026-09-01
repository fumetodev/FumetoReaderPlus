/**
 * JS access to the chrome-geometry CSS variables (app.css :root). Surfaces
 * that must reason about the reader bars in pixel math (e.g. the overlay
 * action-stack placement) read these instead of hard-coding bar heights, so
 * the floating-chrome token flips move every consumer in lockstep.
 */

function readPxVar(name: string, fallback: number): number {
	if (typeof document === 'undefined') return fallback;
	const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Vertical pixels the reader's bottom chrome occupies above the viewport's
 * bottom edge, excluding the safe-area inset (callers that need it add
 * --sab themselves; the historical call sites reserved bar height only).
 */
export function readerBottomReservePx(): number {
	return readPxVar('--reader-bottom-height', 56) + readPxVar('--reader-bottom-inset', 0);
}

/** The device's bottom safe-area inset (--sab), 0 where none is seeded. */
export function safeAreaBottomPx(): number {
	return readPxVar('--sab', 0);
}

/** Page-turn modes supported by the reader's touch surface. */
export type ReaderPageTurnMode = 'swipe' | 'tap' | 'both';

/** The semantic result of one completed, single-contact touch gesture. */
export type ReaderTouchDecision =
	| 'none'
	| 'toggle-controls'
	| 'previous-page'
	| 'next-page';

export interface ReaderTouchDecisionInput {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	durationMs: number;
	viewportLeft: number;
	viewportWidth: number;
	pageTurnMode?: ReaderPageTurnMode;
	readingDirection: 'ltr' | 'rtl';
}

/** A tap may drift by this many pixels on either axis. */
export const READER_TAP_MAX_AXIS_DELTA_PX = 15;

/**
 * A longer contact is not treated as a tap. 300 ms matches the long-strip
 * recognizer and accommodates real thumb contacts; recognition durations are
 * measured from event timeStamps (input time), so main-thread jank between
 * touchstart and touchend delivery no longer inflates them past this bound.
 */
export const READER_TAP_MAX_DURATION_MS = 300;

/** Minimum horizontal travel for a page-turn swipe. */
export const READER_SWIPE_MIN_HORIZONTAL_DELTA_PX = 80;

/** A slower gesture remains a pan rather than a page-turn swipe. */
export const READER_SWIPE_MAX_DURATION_MS = 300;

/**
 * Decide the reader action for one completed touch gesture.
 *
 * This function is deliberately stateless. PageViewer must arbitrate a possible
 * double-tap before applying a single-tap decision returned here.
 */
export function decideReaderTouch(input: ReaderTouchDecisionInput): ReaderTouchDecision {
	const {
		startX,
		startY,
		endX,
		endY,
		durationMs,
		viewportLeft,
		viewportWidth,
		pageTurnMode = 'swipe',
		readingDirection,
	} = input;

	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 'none';

	const dx = endX - startX;
	const dy = endY - startY;
	const elapsed = Math.max(0, durationMs);
	const swipeEnabled = pageTurnMode === 'swipe' || pageTurnMode === 'both';
	const tapEnabled = pageTurnMode === 'tap' || pageTurnMode === 'both';

	const isHorizontalSwipe = swipeEnabled
		&& Math.abs(dx) > READER_SWIPE_MIN_HORIZONTAL_DELTA_PX
		&& Math.abs(dx) > Math.abs(dy) * 2
		&& elapsed < READER_SWIPE_MAX_DURATION_MS;
	if (isHorizontalSwipe) {
		if (dx > 0) return readingDirection === 'rtl' ? 'next-page' : 'previous-page';
		return readingDirection === 'rtl' ? 'previous-page' : 'next-page';
	}

	const isTap = Math.abs(dx) < READER_TAP_MAX_AXIS_DELTA_PX
		&& Math.abs(dy) < READER_TAP_MAX_AXIS_DELTA_PX
		&& elapsed < READER_TAP_MAX_DURATION_MS;
	if (!isTap) return 'none';

	const relativeX = (endX - viewportLeft) / viewportWidth;
	if (relativeX >= 1 / 3 && relativeX <= 2 / 3) return 'toggle-controls';
	if (!tapEnabled) return 'none';

	if (relativeX < 1 / 3) {
		return readingDirection === 'rtl' ? 'next-page' : 'previous-page';
	}
	return readingDirection === 'rtl' ? 'previous-page' : 'next-page';
}

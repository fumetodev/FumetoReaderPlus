import { currentWindowInsets } from '$lib/insets/window-insets.js';

/**
 * Press-and-hold arming for catalog cards and folders.
 *
 * A bare `setTimeout` armed on `touchstart` and disarmed on move/end is wrong on
 * Android for two separate reasons, and the reported bug — the Back swipe
 * opening a volume's context menu — needs both fixed:
 *
 * 1. **The system takes the gesture away without a `touchend`.** Once SystemUI
 *    commits to an edge swipe it stops delivering the stream to the app and
 *    sends `ACTION_CANCEL`, which reaches the WebView as `touchcancel` and as
 *    nothing else — no trailing `touchmove`, no `touchend`. A timer that only
 *    ever hears about move and end therefore survives the hand-off and fires
 *    into a screen the user is already swiping off. `touchcancel` is the signal
 *    that says "this gesture is no longer yours"; ignoring it is the defect.
 * 2. **The edge belongs to the system before the finger has moved at all.**
 *    `touchcancel` arrives only once the system has decided, which for a slow
 *    or short swipe can be after 500 ms — or never, if the swipe is abandoned.
 *    A press that begins inside the reserved strip had no business opening a
 *    menu either way, so it is refused up front.
 *
 * The strip's width is whatever Android reports through
 * `WindowInsetsCompat.Type.systemGestures()`, not a guess: it is zero under
 * three-button navigation and varies with the user's Back-sensitivity setting.
 * Declining to arm there costs nothing a tap cannot still do, and the app never
 * calls `setSystemGestureExclusionRects` — Back must keep working over the grid,
 * which is the whole point.
 */

/** Matches the delay the catalog has always used; also Android's own default. */
export const LONG_PRESS_DELAY_MS = 500;

export interface LongPressEnvironment {
	/** CSS-px the system reserves along each vertical edge for its own gestures. */
	gestureEdges: () => { left: number; right: number };
	/** Viewport width in CSS px, for resolving the right-hand edge. */
	viewportWidth: () => number;
}

const defaultEnvironment: LongPressEnvironment = {
	gestureEdges: () => {
		const insets = currentWindowInsets();
		return { left: insets.gestureLeft, right: insets.gestureRight };
	},
	viewportWidth: () => (typeof window === 'undefined' ? 0 : window.innerWidth)
};

/**
 * True when `clientX` lands in a strip the system has claimed. Both edges are
 * checked against a positive width so a device reporting zero — three-button
 * navigation, API < 29, a desktop browser — gets no dead zone at all rather
 * than a one-pixel one.
 */
export function isInSystemGestureEdge(
	clientX: number,
	environment: LongPressEnvironment = defaultEnvironment
): boolean {
	const { left, right } = environment.gestureEdges();
	if (left > 0 && clientX <= left) return true;
	const width = environment.viewportWidth();
	return right > 0 && width > 0 && clientX >= width - right;
}

export interface LongPressController<TContext> {
	/** `touchstart`: arm, unless this press cannot legitimately become a hold. */
	start(event: TouchEvent, context: TContext): void;
	/** `touchmove`: any travel at all abandons the hold. */
	move(): void;
	/** `touchcancel`: the system (or anything else) took the gesture. */
	cancel(): void;
	/** `touchend`: disarm, and swallow the trailing tap if the hold fired. */
	end(event: TouchEvent): void;
	/** Test/debug view of whether a timer is currently pending. */
	readonly armed: boolean;
	/**
	 * True between the hold firing and the trailing tap being dealt with.
	 * `end` already calls `preventDefault`, which suppresses the synthetic
	 * click; click handlers that also guard on this are belt-and-braces for the
	 * case where something upstream makes that listener passive.
	 */
	readonly triggered: boolean;
}

export function createLongPressController<TContext>(
	trigger: (x: number, y: number, context: TContext) => void,
	environment: LongPressEnvironment = defaultEnvironment,
	delayMs: number = LONG_PRESS_DELAY_MS
): LongPressController<TContext> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let triggered = false;

	function disarm(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	return {
		start(event: TouchEvent, context: TContext): void {
			// Disarm before the arity check, not after: a second finger landing
			// on an already-armed press used to leave the timer running, so a
			// two-finger gesture that never moved still opened a menu.
			disarm();
			triggered = false;
			if (event.touches.length !== 1) return;
			const touch = event.touches[0];
			if (isInSystemGestureEdge(touch.clientX, environment)) return;
			const x = touch.clientX;
			const y = touch.clientY;
			timer = setTimeout(() => {
				timer = null;
				triggered = true;
				trigger(x, y, context);
			}, delayMs);
		},
		move: disarm,
		cancel(): void {
			disarm();
			// A cancelled gesture produces no click, so nothing is left to
			// swallow — and leaving the flag set would eat the user's next tap.
			triggered = false;
		},
		end(event: TouchEvent): void {
			disarm();
			if (triggered) {
				event.preventDefault();
				triggered = false;
			}
		},
		get armed(): boolean {
			return timer !== null;
		},
		get triggered(): boolean {
			return triggered;
		}
	};
}

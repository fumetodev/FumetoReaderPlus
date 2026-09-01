/**
 * slidingSelection — Svelte action for pill segmented radiogroups: injects a
 * single indicator pill (.segment-indicator) behind the buttons and slides it
 * to whichever child radio carries aria-checked="true", M3E-style, instead of
 * teleporting a background class from button to button. Buttons stay
 * transparent (they keep press-morph for the label dip and the press state
 * layer); the pill itself never changes shape, only position — which is what
 * kills the squared-corner flash on selection change.
 *
 * Requirements at the call site: the container is positioned (`relative`),
 * borderless (offset* math assumes border-box == padding-box origin), and the
 * radios are positioned (`relative`) so DOM order paints them above the
 * first-child indicator without any z-index.
 *
 * Selection changes are observed via aria state mutations, so programmatic
 * resets ("Clear all filters") slide exactly like taps. Three semantics are
 * supported: radiogroup (radio + aria-checked), tablist (tab + aria-selected)
 * and navigation (aria-current="page", the bottom dock). Container resizes
 * reposition instantly with no animation. Reduced motion collapses the slide
 * through motionDuration() — WAAPI ignores the CSS escape hatch.
 *
 * Surfaces whose pill is not fully round (the dock's 26px squircle) override
 * the indicator radius via the --segment-radius custom property.
 */
import { MOTION, motionDuration } from './motion.js';

const SELECTED_SEGMENT =
	'[role="radio"][aria-checked="true"], [role="tab"][aria-selected="true"], [aria-current="page"]';

let cachedEasing: string | null = null;

/** The pre-sampled fast-spatial spring from app.css; WAAPI cannot resolve
 * var() in `easing`, so read it once off :root. */
function spatialEasing(): string {
	if (cachedEasing === null) {
		const raw = getComputedStyle(document.documentElement)
			.getPropertyValue('--ease-spring-spatial')
			.trim();
		cachedEasing = raw.startsWith('linear(') ? raw : 'cubic-bezier(0.2, 0, 0, 1)';
	}
	return cachedEasing;
}

interface SegmentRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Layout-space geometry (offset*, not gBCR) so a mid-press scale on the
 * target button cannot skew the measurement. */
function measure(radio: HTMLElement): SegmentRect {
	return {
		x: radio.offsetLeft,
		y: radio.offsetTop,
		width: radio.offsetWidth,
		height: radio.offsetHeight
	};
}

export function slidingSelection(container: HTMLElement): { destroy(): void } {
	if (getComputedStyle(container).position === 'static') {
		container.style.position = 'relative';
	}

	const indicator = document.createElement('div');
	indicator.className = 'segment-indicator';
	indicator.setAttribute('data-segment-indicator', '');
	indicator.setAttribute('aria-hidden', 'true');
	indicator.style.opacity = '0';
	container.prepend(indicator);

	let selected: HTMLElement | null = null;
	let slide: Animation | null = null;

	const place = (to: SegmentRect) => {
		indicator.style.width = `${to.width}px`;
		indicator.style.height = `${to.height}px`;
		indicator.style.transform = `translate(${to.x}px, ${to.y}px)`;
		indicator.style.opacity = '1';
	};

	const snapTo = (radio: HTMLElement) => {
		slide?.cancel();
		slide = null;
		place(measure(radio));
	};

	const slideTo = (radio: HTMLElement) => {
		const to = measure(radio);
		const duration = motionDuration(MOTION.spatial);
		if (duration === 0 || indicator.style.opacity === '0') {
			snapTo(radio);
			return;
		}

		// Start from the current *visual* position — mid-flight interruptions
		// retarget from wherever the pill actually is, not its last rest stop.
		const computed = getComputedStyle(indicator);
		const matrix = new DOMMatrixReadOnly(
			computed.transform === 'none' ? undefined : computed.transform
		);
		const from = {
			x: matrix.m41,
			y: matrix.m42,
			width: indicator.getBoundingClientRect().width
		};
		slide?.cancel();

		place(to);
		const widthChanges = Math.abs(from.width - to.width) > 0.5;
		const keyframes: Keyframe[] = [
			{
				transform: `translate(${from.x}px, ${from.y}px)`,
				...(widthChanges ? { width: `${from.width}px` } : {})
			},
			{
				transform: `translate(${to.x}px, ${to.y}px)`,
				...(widthChanges ? { width: `${to.width}px` } : {})
			}
		];
		slide = indicator.animate(keyframes, { duration, easing: spatialEasing() });
		slide.onfinish = () => (slide = null);
	};

	const sync = (animated: boolean) => {
		const radio = container.querySelector<HTMLElement>(SELECTED_SEGMENT);
		if (!radio) {
			selected = null;
			slide?.cancel();
			slide = null;
			indicator.style.opacity = '0';
			return;
		}
		if (radio === selected && animated) return;
		selected = radio;
		if (animated) slideTo(radio);
		else snapTo(radio);
	};

	// Selection moves animate; segments appearing or disappearing do not —
	// there is no travel to show when the geometry itself was replaced, and
	// animating from a stale position would read as a glitch.
	const observer = new MutationObserver((records) => {
		const structural = records.some((record) => record.type === 'childList');
		sync(!structural);
	});
	observer.observe(container, {
		subtree: true,
		attributes: true,
		attributeFilter: ['aria-checked', 'aria-selected', 'aria-current'],
		childList: true
	});

	const resizer = new ResizeObserver(() => sync(false));
	resizer.observe(container);

	sync(false);

	return {
		destroy() {
			observer.disconnect();
			resizer.disconnect();
			slide?.cancel();
			indicator.remove();
		}
	};
}

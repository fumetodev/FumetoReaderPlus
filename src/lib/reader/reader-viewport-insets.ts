/**
 * Shared keyboard/safe-area plumbing for bottom-anchored reader surfaces.
 * Combines the CSS inset variables set by installWindowInsetAdapter with the
 * native Android bridge (authoritative when present), and watches every
 * signal that can move the visual viewport (IME, rotation, inset changes).
 */

export function readWindowInset(name: '--sat' | '--sab'): number {
	if (typeof document === 'undefined') return 0;
	const cssValue = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
	const bridge = (window as unknown as { __fumeto_android?: { getWindowInsets?: () => string } }).__fumeto_android;
	try {
		const native = JSON.parse(bridge?.getWindowInsets?.() ?? '{}') as { top?: unknown; bottom?: unknown };
		const nativeValue = name === '--sat' ? native.top : native.bottom;
		return typeof nativeValue === 'number' && Number.isFinite(nativeValue) ? Math.max(0, nativeValue) : cssValue;
	} catch {
		return cssValue;
	}
}

export function readVisualViewportHeight(fallback = 800): number {
	if (typeof window === 'undefined') return fallback;
	return window.visualViewport?.height ?? window.innerHeight;
}

/** Fires immediately, then on every viewport/inset change. Returns cleanup. */
export function observeViewportInsets(callback: () => void): () => void {
	callback();
	window.visualViewport?.addEventListener('resize', callback);
	window.addEventListener('resize', callback);
	window.addEventListener('fumeto:window-insets', callback);
	return () => {
		window.visualViewport?.removeEventListener('resize', callback);
		window.removeEventListener('resize', callback);
		window.removeEventListener('fumeto:window-insets', callback);
	};
}

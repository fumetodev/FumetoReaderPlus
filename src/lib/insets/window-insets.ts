export interface WindowInsetSnapshot {
	top: number;
	right: number;
	bottom: number;
	left: number;
	/**
	 * IME (soft keyboard) occlusion from the bottom edge, 0 when hidden. The
	 * app is edge-to-edge, so Android's adjustResize is a no-op — the window
	 * never resizes for the keyboard and neither viewport unit moves. Native
	 * reports it here instead; bottom-docked inputs offset by
	 * max(var(--sab), var(--kb)).
	 */
	ime: number;
	/**
	 * Width of the strip along each vertical edge that the system reserves for
	 * its own navigation gestures — the Back swipe under gesture navigation.
	 * Zero on three-button navigation, below API 29, and off Android.
	 *
	 * Not a safe area: content is meant to be drawn here. It is a *touch*
	 * exclusion, and only for gestures that hold — the system claims an edge
	 * swipe part-way through and tells the WebView by cancelling the touch,
	 * which is far too late for anything already armed on a timer.
	 */
	gestureLeft: number;
	gestureRight: number;
}

export const ZERO_WINDOW_INSETS: WindowInsetSnapshot = Object.freeze({
	top: 0, right: 0, bottom: 0, left: 0, ime: 0, gestureLeft: 0, gestureRight: 0
});

/**
 * The last snapshot native reported. Read by touch handlers that must decide
 * something per-event, where a `getComputedStyle` round-trip would be both
 * slower and unable to see the gesture edges (they intentionally have no CSS
 * variable — nothing about layout should shift for them).
 */
let latestWindowInsets: WindowInsetSnapshot = { ...ZERO_WINDOW_INSETS };

export function currentWindowInsets(): WindowInsetSnapshot {
	return latestWindowInsets;
}

export function sanitizeWindowInsets(value: unknown): WindowInsetSnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...ZERO_WINDOW_INSETS };
	const record = value as Record<string, unknown>;
	const edge = (key: keyof WindowInsetSnapshot) => {
		const candidate = record[key];
		return typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, candidate) : 0;
	};
	return {
		top: edge('top'), right: edge('right'), bottom: edge('bottom'), left: edge('left'), ime: edge('ime'),
		gestureLeft: edge('gestureLeft'), gestureRight: edge('gestureRight')
	};
}

export function parseWindowInsets(value: unknown): WindowInsetSnapshot {
	if (typeof value === 'string') {
		try { return sanitizeWindowInsets(JSON.parse(value)); } catch { return { ...ZERO_WINDOW_INSETS }; }
	}
	return sanitizeWindowInsets(value);
}

export function applyWindowInsets(snapshot: WindowInsetSnapshot, root: HTMLElement = document.documentElement): void {
	// Every snapshot — bootstrap pull and later push alike — funnels through
	// here, so this is the one place the cache can be kept honest.
	latestWindowInsets = snapshot;
	root.style.setProperty('--sat', `${snapshot.top}px`);
	root.style.setProperty('--sar', `${snapshot.right}px`);
	root.style.setProperty('--sab', `${snapshot.bottom}px`);
	root.style.setProperty('--sal', `${snapshot.left}px`);
	root.style.setProperty('--kb', `${snapshot.ime}px`);
}

export function installWindowInsetAdapter(target: Window = window): () => void {
	const bridge = (target as unknown as { __fumeto_android?: { getWindowInsets?: () => string } }).__fumeto_android;
	const pull = () => {
		const raw = bridge?.getWindowInsets?.();
		if (raw !== undefined) applyWindowInsets(parseWindowInsets(raw));
	};
	const onInsets = (event: Event) => applyWindowInsets(parseWindowInsets((event as CustomEvent).detail));
	target.addEventListener('fumeto:window-insets', onInsets);
	pull();
	return () => target.removeEventListener('fumeto:window-insets', onInsets);
}

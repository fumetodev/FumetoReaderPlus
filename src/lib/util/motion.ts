/**
 * Reduced-motion-aware duration for Svelte JS-driven transitions, which do
 * not respect the CSS `prefers-reduced-motion` escape hatch in app.css.
 * Tracks the media query live so an OS-level change applies without reload.
 */
const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
	? window.matchMedia('(prefers-reduced-motion: reduce)')
	: null;

let reduced = query?.matches ?? false;
query?.addEventListener?.('change', (event) => { reduced = event.matches; });

/**
 * The app's duration scale. Use these with motionDuration() in Svelte
 * transitions; the matching CSS custom properties (--motion-press/fast/base
 * in app.css) serve inline styles and stylesheets. Press stays at 100ms —
 * it is a pinned test contract on the reader bottom-bar slots.
 */
export const MOTION = {
	/** Touch feedback: pressed scale/background. */
	press: 100,
	/** Fades, image reveals, menu/dialog exits. */
	fast: 120,
	/** Menus, dialogs, chrome slides, reflows. */
	base: 200,
	/** Positional slides on the fast-spatial spring (--ease-spring-spatial). */
	spatial: 300
} as const;

export function motionDuration(ms: number): number {
	return reduced ? 0 : ms;
}

/** Exit choreography: dismissals run at 2/3 of their entry duration. */
export function exitDuration(entryMs: number): number {
	return reduced ? 0 : Math.round((entryMs * 2) / 3);
}

/** Test seam: force the reduced-motion state (undefined restores tracking). */
export function overrideReducedMotionForTests(value: boolean | undefined): void {
	reduced = value ?? (query?.matches ?? false);
}

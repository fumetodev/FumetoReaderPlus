/**
 * Device-orientation policy for the reader.
 *
 * The Android Activity is portrait-locked in the manifest (`userPortrait`):
 * the catalog, tabs and settings are portrait layouts. The reader is not — a
 * page fits whichever way the screen is turned, and a wide spread reads
 * better in landscape — so while the reader is on screen the lock lifts to
 * `fullUser`, which hands the decision to the device's own auto-rotate
 * setting: rotation locked stays put, rotation on follows the sensor.
 *
 * Nothing on the web side changes for the turn itself. The Activity declares
 * `configChanges` for orientation, so the WebView is resized rather than
 * recreated; MainActivity re-applies the window insets (`--sal`/`--sar` pick
 * up the landscape cutout and navigation bar), the page viewport's
 * ResizeObserver re-fits the page, the long strip re-anchors on the tracked
 * page, and foliate relays the book out.
 */

import { appView } from '$lib/stores/reader-state.js';
import type { AppView } from '$lib/types/index.js';

export type OrientationPolicy = 'portrait' | 'user';

/** The reader may rotate; every other view keeps the manifest's portrait lock. */
export function orientationPolicyForView(view: AppView): OrientationPolicy {
	return view === 'reader' ? 'user' : 'portrait';
}

type OrientationBridge = { setOrientationPolicy?: (policy: OrientationPolicy) => void };

/**
 * Follows `appView` and restates the policy to native on every change. The
 * cleanup restores portrait, so a torn-down frontend never leaves the
 * Activity free-rotating. A no-op wherever the bridge is absent (a browser,
 * the desktop build, an older native shell).
 */
export function installReaderOrientationPolicy(target: Window = window): () => void {
	const bridge = (target as unknown as { __fumeto_android?: OrientationBridge }).__fumeto_android;
	const setOrientationPolicy = bridge?.setOrientationPolicy;
	if (typeof setOrientationPolicy !== 'function') return () => {};

	let applied: OrientationPolicy | null = null;
	const apply = (policy: OrientationPolicy) => {
		if (policy === applied) return;
		applied = policy;
		try {
			setOrientationPolicy.call(bridge, policy);
		} catch {
			// The bridge is a JS interface into Kotlin; a throw must not take the UI down.
		}
	};

	const unsubscribe = appView.subscribe((view) => apply(orientationPolicyForView(view)));
	return () => {
		unsubscribe();
		apply('portrait');
	};
}

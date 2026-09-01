import { writable } from 'svelte/store';

/**
 * First-run intro tour state.
 *
 * The tour auto-shows once per install, and only inside the real app (Tauri):
 * headless browser tests and plain-browser dev sessions boot dozens of fresh
 * profiles, and every one of them greeting the suite with a five-page overlay
 * is exactly the kind of breakage the sample seeder already dodges. Tests and
 * dev preview opt in with the `fumeto-onboarding-preview` localStorage flag;
 * Settings → Help can re-open it any time via `onboardingTourOpen`.
 */

/** Versioned like the sample-seed marker, so a future revamp can re-show. */
export const ONBOARDING_MARKER = 'fumeto-onboarding-v1';
export const ONBOARDING_PREVIEW_FLAG = 'fumeto-onboarding-preview';

/** Runtime visibility of the tour overlay (auto-show and Help replay). */
export const onboardingTourOpen = writable<boolean>(false);

export function hasSeenOnboarding(): boolean {
	try {
		return localStorage.getItem(ONBOARDING_MARKER) === '1';
	} catch {
		return false;
	}
}

export function markOnboardingSeen(): void {
	try {
		localStorage.setItem(ONBOARDING_MARKER, '1');
	} catch {
		// Storage failure must never break dismissal; worst case is a repeat tour.
	}
}

export function shouldAutoShowOnboarding(): boolean {
	if (hasSeenOnboarding()) return false;
	try {
		if (localStorage.getItem(ONBOARDING_PREVIEW_FLAG) === '1') return true;
	} catch {
		// fall through to the Tauri check
	}
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

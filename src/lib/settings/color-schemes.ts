/**
 * Color schemes: seed-derived tonal palettes applied as CSS custom properties.
 *
 * Scheme DATA lives in color-schemes.generated.ts, produced by
 * `npm run schemes:generate` from one seed color per scheme through Material's
 * tonal pipeline — every scheme shares identical structure and contrast
 * relationships; only hue/chroma differ. This module owns the runtime API:
 * legacy-id normalization, lookup, and application. applyColorScheme()
 * overrides the custom properties on :root, which Tailwind utilities reference
 * via var(), so every component updates instantly with zero component edits.
 *
 * The pre-tonal scheme ids (dark-grey, dark-green, light-*, …) normalize to
 * their nearest tonal successor; the same table is inlined in app.html's
 * pre-paint script. Light schemes are retired until a deliberate light pass —
 * their users land on Synthesis rather than a broken theme.
 */

import { GENERATED_SCHEMES, type GeneratedScheme } from './color-schemes.generated.js';

export type ColorScheme = GeneratedScheme;

export const COLOR_SCHEMES: ColorScheme[] = GENERATED_SCHEMES;

export const DEFAULT_SCHEME_ID = 'synthesis';

/** Pre-tonal ids → tonal successors. Keep in sync with app.html's LEGACY table. */
const LEGACY_SCHEME_IDS: Record<string, string> = {
	'dark-grey': 'graphite',
	'dark-green': 'synthesis',
	'dark-blue': 'blue',
	'dark-red': 'red',
	'dark-purple': 'purple',
	'light-grey': 'synthesis',
	white: 'synthesis',
	'light-blue': 'synthesis',
	'light-red': 'synthesis',
	'light-green': 'synthesis',
	'light-pink': 'synthesis'
};

export function normalizeSchemeId(id: string | undefined | null): string {
	if (!id) return DEFAULT_SCHEME_ID;
	return LEGACY_SCHEME_IDS[id] ?? id;
}

export function getColorScheme(id: string): ColorScheme {
	const normalized = normalizeSchemeId(id);
	return COLOR_SCHEMES.find((s) => s.id === normalized) ?? COLOR_SCHEMES[0];
}

/**
 * Apply a color scheme by overriding CSS custom properties on :root.
 * Sets the legacy primary/surface ramps AND the semantic tonal tokens
 * (--color-surface-container-*, --color-accent, …) the synthesis UI uses.
 */
export function applyColorScheme(schemeId: string): void {
	const scheme = getColorScheme(schemeId);
	const root = document.documentElement;
	for (const [stop, value] of Object.entries(scheme.colors.primary)) {
		root.style.setProperty(`--color-primary-${stop}`, value);
	}
	for (const [stop, value] of Object.entries(scheme.colors.surface)) {
		root.style.setProperty(`--color-surface-${stop}`, value);
	}
	for (const [name, value] of Object.entries(scheme.colors.tokens)) {
		root.style.setProperty(`--color-${name}`, value);
	}
}

/**
 * The UI locales this build can show, and how a device language maps onto one.
 *
 * This is the UI-language axis. It is NOT `settings.targetLanguage` (what the
 * manga is translated into) and NOT `readingDirection` (which way pages turn):
 * a German reader translating into English with right-to-left pages is the
 * ordinary case, and the three never derive from each other after first run.
 *
 * Endonyms are hand-listed rather than looked up through `Intl.DisplayNames`
 * because a language picker shows each language in its own name whatever the
 * current locale is.
 */
import { INCLUDES_PSEUDOLOCALE } from '$lib/build-info.js';
import { locales as compiledLocales } from '$lib/paraglide/runtime.js';

export interface UiLocaleInfo {
	tag: string;
	endonym: string;
}

/** Locales with a shipped catalogue (messages/<tag>.json), in picker order. The gate keeps src/app.html's pre-paint list equal to this. */
const SHIPPED_UI_LOCALES = [
	{ tag: 'en', endonym: 'English' },
	{ tag: 'de', endonym: 'Deutsch' },
	{ tag: 'es', endonym: 'Español' },
	{ tag: 'fr', endonym: 'Français' },
	{ tag: 'id', endonym: 'Bahasa Indonesia' },
	{ tag: 'it', endonym: 'Italiano' },
	{ tag: 'pt-BR', endonym: 'Português (Brasil)' },
	{ tag: 'ru', endonym: 'Русский' }
] as const satisfies readonly UiLocaleInfo[];

/**
 * The layout gate's locale: English, lengthened and accented. Its tag is
 * deliberately NOT spelled anywhere in app source — it is whatever the
 * compiled catalogue lists beyond the shipped locales, which only the
 * pseudolocale inlang project does. That is what lets the release audit
 * reject the tag's bytes: a normal build cannot contain them.
 */
export const PSEUDOLOCALE_TAG: string | null = INCLUDES_PSEUDOLOCALE
	? ((compiledLocales as readonly string[]).find((tag) => !SHIPPED_UI_LOCALES.some((locale) => locale.tag === tag)) ?? null)
	: null;

export const SUPPORTED_UI_LOCALES: readonly UiLocaleInfo[] = PSEUDOLOCALE_TAG
	? [...SHIPPED_UI_LOCALES, { tag: PSEUDOLOCALE_TAG, endonym: '[Pšéúdó-łóçãłé]' }]
	: SHIPPED_UI_LOCALES;

export type UiLocale = (typeof SHIPPED_UI_LOCALES)[number]['tag'] | (string & {});
/** `'system'` follows the device; the door for Android's per-app language later. */
export type UiLocaleSetting = 'system' | UiLocale;

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

export function isUiLocale(value: unknown): value is UiLocale {
	return typeof value === 'string' && SUPPORTED_UI_LOCALES.some((locale) => locale.tag === value);
}

export function isUiLocaleSetting(value: unknown): value is UiLocaleSetting {
	return value === 'system' || isUiLocale(value);
}

/** Legacy or alternative language subtags a device may report. */
const LANGUAGE_SUBTAG_ALIASES: Record<string, string> = {
	in: 'id', // Java-era Indonesian
	iw: 'he',
	ji: 'yi',
	tl: 'fil'
};

/** Region-specific tags the device may report that map onto a shipped regional tag. */
const REGION_ALIASES: Record<string, string> = {
	'es-419': 'es'
};

function languageOf(tag: string): string {
	const language = tag.toLowerCase().split('-')[0];
	return LANGUAGE_SUBTAG_ALIASES[language] ?? language;
}

/**
 * Resolve the locale to show. An explicit setting wins; `'system'` (or an
 * unknown value) walks the device's ranked languages: exact tag, then a
 * regional alias, then any shipped locale of the same language — the one
 * without a region first, so `pt-PT` still lands on `pt-BR` when that is the
 * only Portuguese we ship. The pseudolocale is never picked from the device.
 */
export function resolveUiLocale(
	setting: UiLocaleSetting | string | undefined,
	languages: readonly string[]
): UiLocale {
	if (setting !== undefined && setting !== 'system' && isUiLocale(setting)) return setting;
	// Device matching considers shipped locales only — never the pseudolocale.
	const candidates: readonly UiLocaleInfo[] = SHIPPED_UI_LOCALES;
	for (const reported of languages) {
		if (typeof reported !== 'string' || reported.length === 0) continue;
		const lower = reported.toLowerCase();
		const exact = candidates.find((locale) => locale.tag.toLowerCase() === lower);
		if (exact) return exact.tag as UiLocale;
		const aliased = REGION_ALIASES[lower];
		if (aliased && candidates.some((locale) => locale.tag === aliased)) return aliased as UiLocale;
		const language = languageOf(reported);
		const sameLanguage = candidates.filter((locale) => languageOf(locale.tag) === language);
		if (sameLanguage.length > 0) {
			const bare = sameLanguage.find((locale) => !locale.tag.includes('-'));
			return (bare ?? sameLanguage[0]).tag as UiLocale;
		}
	}
	return DEFAULT_UI_LOCALE;
}

/**
 * The manga translation target a fresh install starts with for a UI locale.
 * Used once, on first run; changing the UI language later never touches the
 * target again. `null` keeps the built-in default (English).
 */
export function defaultTargetForUiLocale(locale: UiLocale | string): string | null {
	const map: Record<string, string> = {
		es: 'es',
		'pt-BR': 'pt',
		fr: 'fr',
		de: 'de',
		id: 'id',
		ru: 'ru',
		it: 'it'
	};
	return map[locale] ?? null;
}

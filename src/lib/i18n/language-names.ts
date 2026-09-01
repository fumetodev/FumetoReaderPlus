/**
 * The UI half of the language-name split.
 *
 * `getLanguagePromptName` (settings.ts) is what the LLM prompts say —
 * "Translate the Japanese text to German" — and it stays English forever: a
 * localized label there moves the on-device model off the distribution it
 * was tuned on. Pickers and labels use this function instead, which asks
 * `Intl.DisplayNames` for the name in the UI locale and falls back to the
 * English table when the WebView cannot answer.
 */
import * as m from '$lib/paraglide/messages.js';
import { getLanguagePromptName } from '$lib/settings/settings.js';
import { getUiLocale } from './locale.js';

const cache = new Map<string, Intl.DisplayNames | null>();

function displayNames(locale: string): Intl.DisplayNames | null {
	let instance = cache.get(locale);
	if (instance === undefined) {
		try {
			instance = new Intl.DisplayNames([locale], { type: 'language' });
		} catch {
			instance = null;
		}
		cache.set(locale, instance);
	}
	return instance;
}

/** The name of a translation source/target language as the UI should show it. */
export function getLanguageDisplayName(code: string, locale: string = getUiLocale()): string {
	if (code === 'auto') return m.lang_auto_detect({}, { locale: locale as never });
	const fallback = getLanguagePromptName(code);
	try {
		const name = displayNames(locale)?.of(code);
		if (name && name !== code) return name;
	} catch {
		// An unknown or malformed code: the English table decides.
	}
	return fallback;
}

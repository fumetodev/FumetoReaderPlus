/**
 * The language tables and the ENGLISH names the LLM prompts use. This is a
 * prompt module, not UI: the i18n gate skips it on purpose, and nothing a
 * person reads may come from here — pickers use getLanguageDisplayName().
 */
/** Supported source/target languages for translation */
export const SUPPORTED_LANGUAGES = [
	{ code: 'auto', label: 'Auto-detect' },
	{ code: 'en', label: 'English' },
	{ code: 'ja', label: 'Japanese' },
	{ code: 'zh-Hans', label: 'Chinese (Simplified)' },
	{ code: 'zh-Hant', label: 'Chinese (Traditional)' },
	{ code: 'ko', label: 'Korean' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'fr', label: 'French' },
	{ code: 'de', label: 'German' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'it', label: 'Italian' },
	{ code: 'sv', label: 'Swedish' },
	{ code: 'fi', label: 'Finnish' },
	{ code: 'pl', label: 'Polish' },
	{ code: 'uk', label: 'Ukrainian' },
	{ code: 'ru', label: 'Russian' },
	{ code: 'vi', label: 'Vietnamese' },
	{ code: 'th', label: 'Thai' },
	{ code: 'id', label: 'Indonesian' },
	{ code: 'tl', label: 'Tagalog' },
	{ code: 'hi', label: 'Hindi' },
	{ code: 'fa', label: 'Persian' },
	{ code: 'tr', label: 'Turkish' },
	{ code: 'ar', label: 'Arabic' }
] as const;

/**
 * The ENGLISH name of a language, for LLM prompts — "Translate the Japanese
 * text to German". Frozen on purpose: the on-device Hy-MT2 fine-tune saw these
 * exact names, and a localized name here would move every prompt off that
 * distribution. UI pickers show `getLanguageDisplayName()` from `$lib/i18n`
 * instead; never call this for something a person reads.
 */
export function getLanguagePromptName(code: string): string {
	return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ??
		ON_DEVICE_SOURCE_LANGUAGES.find((l) => l.code === code)?.label ??
		ON_DEVICE_TARGET_LANGUAGES.find((l) => l.code === code)?.label ??
		code;
}

/**
 * On-device source languages (PP-OCRv6 recognition + Hy-MT2 translation).
 * Auto-Detect defaults to Japanese internally.
 */
export const ON_DEVICE_SOURCE_LANGUAGES = [
	{ code: 'auto', label: 'Auto-Detect' },
	{ code: 'ja', label: 'Japanese' },
	{ code: 'en', label: 'English' },
	{ code: 'zh-Hans', label: 'Chinese (Simplified)' },
	{ code: 'zh-Hant', label: 'Chinese (Traditional)' },
	{ code: 'ko', label: 'Korean' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'fr', label: 'French' },
	{ code: 'de', label: 'German' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'it', label: 'Italian' },
	{ code: 'sv', label: 'Swedish' },
	{ code: 'fi', label: 'Finnish' },
	{ code: 'pl', label: 'Polish' },
	{ code: 'uk', label: 'Ukrainian' },
	{ code: 'ru', label: 'Russian' },
	{ code: 'vi', label: 'Vietnamese' },
	{ code: 'th', label: 'Thai' },
	{ code: 'id', label: 'Indonesian' },
	{ code: 'hi', label: 'Hindi' },
	{ code: 'tr', label: 'Turkish' },
	{ code: 'ar', label: 'Arabic' }
] as const;

/**
 * On-device target languages (Hy-MT2 translation output).
 */
export const ON_DEVICE_TARGET_LANGUAGES = [
	{ code: 'en', label: 'English' },
	{ code: 'ja', label: 'Japanese' },
	{ code: 'ko', label: 'Korean' },
	{ code: 'zh-Hans', label: 'Chinese (Simplified)' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'fr', label: 'French' },
	{ code: 'de', label: 'German' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'it', label: 'Italian' },
	{ code: 'sv', label: 'Swedish' },
	{ code: 'fi', label: 'Finnish' },
	{ code: 'pl', label: 'Polish' },
	{ code: 'uk', label: 'Ukrainian' },
	{ code: 'ru', label: 'Russian' },
	{ code: 'vi', label: 'Vietnamese' },
	{ code: 'th', label: 'Thai' },
	{ code: 'id', label: 'Indonesian' },
	{ code: 'hi', label: 'Hindi' },
	// Persian was in both native language tables and in the v3 training set
	// from the start, but never in this picker, so it could not be chosen.
	{ code: 'fa', label: 'Persian' },
	{ code: 'tr', label: 'Turkish' },
	{ code: 'ar', label: 'Arabic' }
] as const;

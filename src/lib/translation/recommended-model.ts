/**
 * Which on-device model to recommend. Import-free on purpose: settings.ts seeds a fresh install's choice from it at
 * startup, and pulling the model managers in there would put the settings store inside their import cycle.
 */

export type RecommendedVariant = 'fumetotranslate' | 'manga-v5' | 'manga-v3';

/** Whether this build can run the encoder-decoder translator (Android, where its native bridge is injected). */
export function encdecBridgePresent(): boolean {
	return typeof window !== 'undefined' && !!(window as { __fumeto_encdec_native?: unknown }).__fumeto_encdec_native;
}

/**
 * The model to recommend for an on-device language pair: FumetoTranslate for Japanese to English
 * wherever it can run, the v5 fine-tune for that pair elsewhere, and the multilingual v3 for every other pair. Drives
 * the Recommended badge and a fresh install's choice; it never overrides a choice the user has made.
 */
export function recommendedHyMT2Variant(sourceLang: string, targetLang: string, encdecRuns = encdecBridgePresent()): RecommendedVariant {
	const source = sourceLang === 'auto' ? 'ja' : sourceLang;
	if (source === 'ja' && targetLang === 'en') return encdecRuns ? 'fumetotranslate' : 'manga-v5';
	return 'manga-v3';
}

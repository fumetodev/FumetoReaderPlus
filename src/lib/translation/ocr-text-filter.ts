/**
 * Keep compact manga text (including a single kana/kanji/letter/digit) while
 * dropping OCR boxes that contain only punctuation, whitespace, or symbols.
 * Unicode letter/number properties cover every supported source script while
 * excluding punctuation, symbols, emoji, and combining marks by category.
 * The explicit fallback keeps the module parseable on a stale Android WebView.
 */
const MEANINGFUL_OCR_CHARACTER = (() => {
	try {
		return new RegExp('[\\p{L}\\p{N}]', 'u');
	} catch {
		return /[0-9A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02af\u0370-\u052f\u3005\u3006\u303b\u3041-\u30fa\u30fc-\u30ff\u31f0-\u31ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9d]/;
	}
})();

export function isMeaningfulOcrText(text: string): boolean {
	return MEANINGFUL_OCR_CHARACTER.test(text.trim());
}

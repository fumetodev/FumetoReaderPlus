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

const LATIN_LETTER = (() => {
	try {
		return new RegExp('\\p{Script=Latin}', 'u');
	} catch {
		return /[A-Za-zÀ-ɏＡ-Ｚａ-ｚ]/;
	}
})();
const CJK_OR_HANGUL = (() => {
	try {
		return new RegExp('[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]', 'u');
	} catch {
		return /[ぁ-ヿㇰ-ㇿ㐀-鿿가-힯豈-﫿ｦ-ﾝ]/;
	}
})();

/**
 * Lettering already written in the language the page is translated into: an
 * English label on a drawn notebook, a sign, an "OK!". It is readable as it is,
 * and an overlay would only paint a plate over the original with the same word
 * (measured: a handwritten "NOTEBOOK" came back as "Notebook" under a white
 * plate). Only English targets, whose script is the one such lettering uses:
 * for any other target the English is still worth translating.
 */
export function isAlreadyInTargetLanguage(text: string, targetLanguage: string): boolean {
	if (targetLanguage.trim().toLowerCase().split(/[-_]/u)[0] !== 'en') return false;
	const trimmed = text.trim();
	return LATIN_LETTER.test(trimmed) && !CJK_OR_HANGUL.test(trimmed);
}

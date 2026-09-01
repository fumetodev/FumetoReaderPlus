import type { CatalogProvider } from '$lib/types/index.js';

/**
 * Whether a stored `reading_direction` was a real choice or an import stamp.
 *
 * Until v18 every sync path pinned a direction onto every volume, which left
 * no volume able to follow the global Display setting:
 *
 * - local import  — hardcoded `'rtl'` for every file.
 * - kavita        — hardcoded `'rtl'`, commented "Default manga direction".
 * - komga         — `book.seriesTitle ? 'rtl' : 'ltr'`, a heuristic that tagged
 *                   essentially everything RTL. Both of its outputs are guesses.
 * - yacreader     — `comic.manga`, a real per-comic flag from the server.
 *
 * So: yacreader values survive. Komga values are always discarded. For local
 * and kavita only `'rtl'` is ambiguous — the stamp could never produce `'ltr'`,
 * so an `'ltr'` there can only have come from a user editing Volume Details,
 * and is preserved.
 *
 * Clearing is deliberately conservative in the one direction that matters: a
 * wrongly-kept override is invisible until the user toggles, whereas a wrongly
 * cleared one silently discards a choice they made by hand.
 */
export function shouldClearStampedReadingDirection(
	provider: CatalogProvider,
	storedDirection: 'rtl' | 'ltr' | undefined
): boolean {
	if (storedDirection === undefined) return false;
	if (provider === 'yacreader') return false;
	if (provider === 'komga') return true;
	return storedDirection === 'rtl';
}

/**
 * Character-level text similarity for OCR comparison (model-candidate eval).
 * Whitespace-insensitive: OCR line joins and the vision model's readings
 * differ in spacing without differing in content.
 */

export function normalizeForComparison(text: string): string {
	return text.replace(/\s+/gu, '');
}

/** Plain Levenshtein distance over code points. */
export function editDistance(a: string, b: string): number {
	const s = [...a];
	const t = [...b];
	if (s.length === 0) return t.length;
	if (t.length === 0) return s.length;
	let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
	let current = new Array<number>(t.length + 1);
	for (let i = 1; i <= s.length; i++) {
		current[0] = i;
		for (let j = 1; j <= t.length; j++) {
			const substitution = previous[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1);
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
		}
		[previous, current] = [current, previous];
	}
	return previous[t.length];
}

/**
 * Normalized similarity in [0,1]: 1 = identical (after whitespace removal),
 * 0 = nothing in common. Two empty strings are identical.
 */
export function textSimilarity(a: string, b: string): number {
	const na = normalizeForComparison(a);
	const nb = normalizeForComparison(b);
	const longest = Math.max([...na].length, [...nb].length);
	if (longest === 0) return 1;
	return 1 - editDistance(na, nb) / longest;
}

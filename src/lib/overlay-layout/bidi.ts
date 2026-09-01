import type { OverlayDirection } from '$lib/types/index.js';

type BidiType = 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'NSM' | 'ES' | 'ET' | 'CS' | 'WS' | 'ON';

export interface ResolvedBidiRun {
	startUtf16: number;
	endUtf16: number;
	level: number;
	direction: OverlayDirection;
}

const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;
const DECIMAL = /\p{Nd}/u;

function isRtlLetter(codePoint: number): boolean {
	return (codePoint >= 0x0590 && codePoint <= 0x08ff)
		|| (codePoint >= 0xfb1d && codePoint <= 0xfdff)
		|| (codePoint >= 0xfe70 && codePoint <= 0xfefc)
		|| (codePoint >= 0x10800 && codePoint <= 0x10fff)
		|| (codePoint >= 0x1e800 && codePoint <= 0x1edff)
		|| (codePoint >= 0x1e900 && codePoint <= 0x1e95f);
}

function isArabicLetter(codePoint: number): boolean {
	return (codePoint >= 0x0600 && codePoint <= 0x08ff)
		|| (codePoint >= 0xfb50 && codePoint <= 0xfdff)
		|| (codePoint >= 0xfe70 && codePoint <= 0xfefc)
		|| (codePoint >= 0x1ee00 && codePoint <= 0x1eeff);
}

function classify(grapheme: string): BidiType {
	const first = [...grapheme][0] ?? '';
	const codePoint = first.codePointAt(0) ?? 0;
	if (MARK.test(first)) return 'NSM';
	if ((codePoint >= 0x0660 && codePoint <= 0x0669) || (codePoint >= 0x06f0 && codePoint <= 0x06f9)) return 'AN';
	if (DECIMAL.test(first)) return 'EN';
	if (LETTER.test(first)) {
		if (isArabicLetter(codePoint)) return 'AL';
		return isRtlLetter(codePoint) ? 'R' : 'L';
	}
	if (first === '+' || first === '-' || first === '\u2212') return 'ES';
	if (first === ',' || first === '.' || first === ':' || first === '\u060c' || first === '\u066b' || first === '\u066c') return 'CS';
	if (/[$%\u00a2-\u00a5\u0609\u060a\u066a\u20a0-\u20cf]/u.test(first)) return 'ET';
	if (/\s/u.test(first)) return 'WS';
	return 'ON';
}

/** Unicode's paragraph rule: ignore neutrals and digits, then use the first strong character. */
export function paragraphDirection(
	text: string,
	configured: 'ltr' | 'rtl' | 'auto'
): OverlayDirection {
	if (configured !== 'auto') return configured;
	for (const grapheme of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
		const type = classify(grapheme.segment);
		if (type === 'R' || type === 'AL') return 'rtl';
		if (type === 'L') return 'ltr';
	}
	return 'ltr';
}

/**
 * Cheap admission check for the explicit bidi resolver. A line whose strong
 * characters and numbers all follow the paragraph direction can use Pretext's
 * already-shaped width as one canonical run. Mixed-direction lines still go
 * through the full grapheme-level resolver.
 */
export function requiresExplicitBidiRuns(text: string, baseDirection: OverlayDirection): boolean {
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069)) return true;
		const type = classify(character);
		if (baseDirection === 'ltr') {
			if (type === 'R' || type === 'AL' || type === 'AN') return true;
		} else if (type === 'L' || type === 'EN' || type === 'AN') return true;
	}
	return false;
}

const OPEN_TO_CLOSE = new Map([
	['(', ')'], ['[', ']'], ['{', '}'], ['\u0f3a', '\u0f3b'], ['\u0f3c', '\u0f3d'],
	['\u169b', '\u169c'], ['\u2045', '\u2046'], ['\u207d', '\u207e'], ['\u208d', '\u208e'],
	['\u2308', '\u2309'], ['\u230a', '\u230b'], ['\u2329', '\u232a'], ['\u2768', '\u2769'],
	['\u276a', '\u276b'], ['\u276c', '\u276d'], ['\u276e', '\u276f'], ['\u2770', '\u2771'],
	['\u2772', '\u2773'], ['\u2774', '\u2775'], ['\u27c5', '\u27c6'], ['\u27e6', '\u27e7'],
	['\u27e8', '\u27e9'], ['\u27ea', '\u27eb'], ['\u27ec', '\u27ed'], ['\u27ee', '\u27ef'],
	['\u2983', '\u2984'], ['\u2985', '\u2986'], ['\u2987', '\u2988'], ['\u2989', '\u298a'],
	['\u298b', '\u298c'], ['\u298d', '\u2990'], ['\u298f', '\u298e'], ['\u2991', '\u2992'],
	['\u2993', '\u2994'], ['\u2995', '\u2996'], ['\u2997', '\u2998'], ['\u29d8', '\u29d9'],
	['\u29da', '\u29db'], ['\u29fc', '\u29fd'], ['\u2e22', '\u2e23'], ['\u2e24', '\u2e25'],
	['\u2e26', '\u2e27'], ['\u2e28', '\u2e29'], ['\u3008', '\u3009'], ['\u300a', '\u300b'],
	['\u300c', '\u300d'], ['\u300e', '\u300f'], ['\u3010', '\u3011'], ['\u3014', '\u3015'],
	['\u3016', '\u3017'], ['\u3018', '\u3019'], ['\u301a', '\u301b'], ['\uff08', '\uff09'],
	['\uff3b', '\uff3d'], ['\uff5b', '\uff5d'], ['\uff5f', '\uff60'], ['\uff62', '\uff63']
]);

function resolveBracketPairs(graphemes: string[], types: BidiType[]): void {
	const stack: Array<{ index: number; close: string }> = [];
	for (let index = 0; index < graphemes.length; index += 1) {
		const text = graphemes[index];
		const close = OPEN_TO_CLOSE.get(text);
		if (close) {
			stack.push({ index, close });
			continue;
		}
		for (let open = stack.length - 1; open >= 0; open -= 1) {
			if (stack[open].close !== text) continue;
			const pair = stack[open];
			stack.splice(open);
			let strong: 'L' | 'R' | null = null;
			for (let inner = pair.index + 1; inner < index; inner += 1) {
				const candidate = types[inner] === 'L' ? 'L' : types[inner] === 'R' || types[inner] === 'AN' || types[inner] === 'EN' ? 'R' : null;
				if (!candidate) continue;
				if (strong && strong !== candidate) {
					strong = null;
					break;
				}
				strong = candidate;
			}
			if (strong) types[pair.index] = types[index] = strong;
			break;
		}
	}
}

/**
 * Resolves deterministic directional runs for explicit SVG/Canvas positioning.
 * This implements the UAX #9 weak/neutral/implicit rules needed by overlay text,
 * including paired brackets, while leaving glyph shaping to the named browser font.
 */
export function resolveBidiRuns(
	text: string,
	baseDirection: OverlayDirection,
	locale?: string
): ResolvedBidiRun[] {
	if (!text) return [];
	const segmented = [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(text)];
	const graphemes = segmented.map((entry) => entry.segment);
	const types = graphemes.map(classify);
	const startLevel = baseDirection === 'rtl' ? 1 : 0;
	const sor: BidiType = startLevel === 1 ? 'R' : 'L';

	let previous: BidiType = sor;
	for (let index = 0; index < types.length; index += 1) {
		if (types[index] === 'NSM') types[index] = previous;
		else previous = types[index];
	}
	previous = sor;
	for (let index = 0; index < types.length; index += 1) {
		const type = types[index];
		if (type === 'EN' && previous === 'AL') types[index] = 'AN';
		else if (type === 'R' || type === 'L' || type === 'AL') previous = type;
	}
	for (let index = 0; index < types.length; index += 1) if (types[index] === 'AL') types[index] = 'R';
	for (let index = 1; index < types.length - 1; index += 1) {
		if (types[index] === 'ES' && types[index - 1] === 'EN' && types[index + 1] === 'EN') types[index] = 'EN';
		if (types[index] === 'CS' && (types[index - 1] === 'EN' || types[index - 1] === 'AN') && types[index + 1] === types[index - 1]) types[index] = types[index - 1];
	}
	for (let index = 0; index < types.length; index += 1) {
		if (types[index] !== 'ET') continue;
		const previousType = types[index - 1];
		const nextType = types[index + 1];
		if (previousType === 'EN' || nextType === 'EN') types[index] = 'EN';
	}
	for (let index = 0; index < types.length; index += 1) if (types[index] === 'ES' || types[index] === 'ET' || types[index] === 'CS') types[index] = 'ON';
	previous = sor;
	for (let index = 0; index < types.length; index += 1) {
		if (types[index] === 'EN' && previous === 'L') types[index] = 'L';
		else if (types[index] === 'R' || types[index] === 'L') previous = types[index];
	}

	resolveBracketPairs(graphemes, types);
	for (let index = 0; index < types.length;) {
		if (types[index] !== 'ON' && types[index] !== 'WS') {
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < types.length && (types[end] === 'ON' || types[end] === 'WS')) end += 1;
		const before = index > 0 ? types[index - 1] : sor;
		const after = end < types.length ? types[end] : sor;
		const beforeDirection = before === 'L' ? 'L' : 'R';
		const afterDirection = after === 'L' ? 'L' : 'R';
		const resolved: BidiType = beforeDirection === afterDirection ? beforeDirection : sor;
		for (let neutral = index; neutral < end; neutral += 1) types[neutral] = resolved;
		index = end;
	}

	const levels = types.map((type) => {
		let level = startLevel;
		if (startLevel % 2 === 0) {
			if (type === 'R') level += 1;
			else if (type === 'AN' || type === 'EN') level += 2;
		} else if (type === 'L' || type === 'AN' || type === 'EN') level += 1;
		return level;
	});
	const result: ResolvedBidiRun[] = [];
	for (let index = 0; index < segmented.length; index += 1) {
		const start = segmented[index].index;
		const end = start + segmented[index].segment.length;
		const level = levels[index];
		const previousRun = result[result.length - 1];
		if (previousRun?.level === level && previousRun.endUtf16 === start) previousRun.endUtf16 = end;
		else result.push({ startUtf16: start, endUtf16: end, level, direction: level % 2 === 1 ? 'rtl' : 'ltr' });
	}
	return result;
}

/** Returns logical-run indexes in their left-to-right visual order (UAX #9 L2). */
export function bidiVisualOrder(runs: ResolvedBidiRun[]): number[] {
	const order = runs.map((_, index) => index);
	const maximum = Math.max(0, ...runs.map((run) => run.level));
	const oddLevels = runs.map((run) => run.level).filter((level) => level % 2 === 1);
	if (oddLevels.length === 0) return order;
	const minimumOdd = Math.min(...oddLevels);
	for (let level = maximum; level >= minimumOdd; level -= 1) {
		for (let start = 0; start < order.length;) {
			while (start < order.length && runs[order[start]].level < level) start += 1;
			let end = start;
			while (end < order.length && runs[order[end]].level >= level) end += 1;
			if (end > start) order.splice(start, end - start, ...order.slice(start, end).reverse());
			start = end;
		}
	}
	return order;
}

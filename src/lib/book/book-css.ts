/**
 * Content CSS for book documents — the theme bridge between the app's design
 * tokens and foliate's content iframes. Pure string builder (node-testable);
 * BookReader injects the output via renderer.setStyles and re-injects on
 * settings changes (foliate preserves the reading position across style
 * re-injection).
 */

export interface BookCssOptions {
	theme: 'app-dark' | 'light';
	/** 100 = publisher size; clamped to a sane range. */
	fontScalePercent: number;
	lineHeight: number;
}

export const BOOK_FONT_SCALE_MIN = 70;
export const BOOK_FONT_SCALE_MAX = 200;
export const BOOK_FONT_SCALE_STEP = 10;

const THEMES = {
	'app-dark': {
		// Mirrors the app's dark surface palette (surface-950 backdrop is the
		// host's; content stays transparent so the reader surface shows).
		color: '#e2e2e2',
		background: 'transparent',
		link: '#7dd3a8'
	},
	light: {
		// The "paper" page: content brings its own background.
		color: '#1d1d1f',
		background: '#f5f1e8',
		link: '#1a7f4e'
	}
} as const;

export function clampBookFontScale(percent: number): number {
	if (!Number.isFinite(percent)) return 100;
	return Math.min(BOOK_FONT_SCALE_MAX, Math.max(BOOK_FONT_SCALE_MIN, Math.round(percent)));
}

export function getBookCss(options: BookCssOptions): string {
	const theme = THEMES[options.theme] ?? THEMES['app-dark'];
	const scale = clampBookFontScale(options.fontScalePercent);
	const lineHeight = Number.isFinite(options.lineHeight)
		? Math.min(2.4, Math.max(1.1, options.lineHeight))
		: 1.5;
	return [
		`html { color: ${theme.color} !important; background: ${theme.background} !important;`,
		` font-size: ${scale}% !important; line-height: ${lineHeight} !important; }`,
		` body { color: inherit !important; background: transparent !important; }`,
		` a, a * { color: ${theme.link} !important; }`,
		` img, svg { max-width: 100% !important; }`
	].join('');
}

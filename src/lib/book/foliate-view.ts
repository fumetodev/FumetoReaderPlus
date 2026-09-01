/**
 * Typed access to the <foliate-view> custom element (vendored view.js).
 * The element registers itself on module import; the guard makes repeat
 * imports (HMR, multiple mounts) safe.
 */

import type { FoliateBook, FoliateResolvedTarget } from './foliate-loader.js';

/**
 * view.js relocate detail = SectionProgress.getProgress() spread + extras
 * (verified: view.js #onRelocate + progress.js:75): whole-book `fraction`,
 * `section.current/total`, `cfi`, tocItem/pageItem/range.
 */
export interface FoliateRelocateDetail {
	/** 0..1 progress through the WHOLE book. */
	fraction?: number;
	section?: { current: number; total: number };
	/**
	 * Whole-book page counter. SectionProgress divides total content size by
	 * `sizePerLoc` (1500 chars, view.js:243), so these are stable page units
	 * that do NOT change with font size or window width — which is what makes
	 * them safe to seek by and to print as "page X of Y".
	 */
	location?: { current: number; next: number; total: number };
	/** Durable position locator (EPUB CFI). */
	cfi?: string;
	tocItem?: { label?: string; href?: string } | null;
	[key: string]: unknown;
}

export interface FoliateRenderer extends HTMLElement {
	/** Inject content CSS (theme/typography); upstream reader.js:120 usage. */
	setStyles?: (css: string) => void;
	prev?: () => Promise<void>;
	next?: () => Promise<void>;
}

export interface FoliateView extends HTMLElement {
	open(book: FoliateBook): Promise<void>;
	close?: () => void;
	goTo(target: number | string | FoliateResolvedTarget): Promise<unknown>;
	/** Seek by whole-book fraction — the inverse of relocate's `fraction`. */
	goToFraction(fraction: number): Promise<void>;
	/** Cumulative start fraction of each spine section; view.js:491. */
	getSectionFractions?: () => number[];
	/** Direction-aware page turns (rtl-mirrored); view.js:519/:522. */
	goLeft(): Promise<unknown>;
	goRight(): Promise<unknown>;
	prev(): Promise<unknown>;
	next(): Promise<unknown>;
	renderer: FoliateRenderer;
	book?: FoliateBook;
}

/** Import the element definition (once) and create an instance. */
export async function createFoliateView(): Promise<FoliateView> {
	if (!customElements.get('foliate-view')) {
		await import('$lib/vendor/foliate-js/view.js');
	}
	return document.createElement('foliate-view') as FoliateView;
}

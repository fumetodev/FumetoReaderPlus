/**
 * Page mode detection for single/dual page layouts.
 *
 * Adapted from mokuro-reader's page-mode-detection.ts.
 * Determines whether to show one or two pages based on page aspect ratios
 * and screen orientation.
 */

import type { PageInfo, PageViewMode } from '$lib/types/index.js';

/** A page with an aspect ratio > 1.2 is a landscape/wide spread */
export function isWideSpread(page: PageInfo): boolean {
	if (page.width === 0 || page.height === 0) return false;
	return page.width / page.height > 1.2;
}

/** Check if two pages have similar widths (within 20%) */
export function haveSimilarWidths(
	page1: PageInfo | undefined,
	page2: PageInfo | undefined
): boolean {
	if (!page1 || !page2 || page1.width === 0 || page2.width === 0) return true;

	const ratio = page1.width / page2.width;
	return ratio >= 0.8 && ratio <= 1.2;
}

/** Check if the screen is in portrait orientation */
export function isPortraitOrientation(): boolean {
	return window.innerHeight > window.innerWidth;
}

/**
 * Determine whether to show a single page or dual pages.
 *
 * @param mode - User's selected page view mode
 * @param currentPage - Current page info
 * @param nextPage - Next page info (for dual page layout)
 * @param previousPage - Previous page info
 * @param isFirstPage - Whether this is the first page (cover)
 * @returns true if single page should be shown
 */
export function shouldShowSinglePage(
	mode: PageViewMode,
	currentPage: PageInfo | undefined,
	nextPage: PageInfo | undefined,
	previousPage: PageInfo | undefined,
	isFirstPage: boolean = false
): boolean {
	// Explicit modes override auto detection
	if (mode === 'single') return true;
	if (mode === 'dual') return false;

	// Auto mode logic:

	// First page (cover) is always single
	if (isFirstPage) return true;

	// Portrait orientation always uses single page
	if (isPortraitOrientation()) return true;

	// No current page data
	if (!currentPage) return true;

	// Wide spreads are always single (they span two pages already)
	if (isWideSpread(currentPage)) return true;

	// If the next page is a wide spread, show current as single
	if (nextPage && isWideSpread(nextPage)) return true;

	// If pages have dissimilar widths, show single to avoid misaligned pairs
	if (nextPage && !haveSimilarWidths(currentPage, nextPage)) return true;

	// Default: show dual in landscape
	return false;
}

/**
 * Live handle to the currently-open foliate book, published by BookReader for
 * the book chrome surfaces (TOC panel jumps via view.goTo; the display menu
 * flips renderer attributes/styles). Null whenever no book is mounted.
 */

import { get, writable } from 'svelte/store';
import type { FoliateView } from './foliate-view.js';
import type { FoliateBook } from './foliate-loader.js';

export interface BookHandle {
	view: FoliateView;
	book: FoliateBook;
}

export const currentBookHandle = writable<BookHandle | null>(null);

/**
 * Live 0..1 whole-book progress for the chrome (bottom-bar indicator) —
 * updated on every relocate, ahead of the debounced persisted value.
 */
export const currentBookFraction = writable(0);

/**
 * Whole-book page counter (0-based `current`), straight from foliate's
 * SectionProgress. Pages are content-size units — total chars / 1500 — so they
 * stay put when the font size or window changes, unlike laid-out screens. This
 * is what the chrome counts in and what the scrubber and jump dialog seek by;
 * spine sections remain the persistence unit (currentPageIndex) because that is
 * what resume and the catalog already store.
 */
export const currentBookPages = writable<{ current: number; total: number }>({ current: 0, total: 0 });

/**
 * Seek to a whole-book page.
 *
 * Books navigate through the foliate view, NOT by writing currentPageIndex:
 * that store is an output of foliate's `relocate` event, so setting it would
 * only desync the indicator until the next real move. Returns false when no
 * book is mounted, which is how comic surfaces fall through to their own paths.
 */
export function goToBookPage(page: number): boolean {
	const handle = get(currentBookHandle);
	const { total } = get(currentBookPages);
	if (!handle || !Number.isFinite(page) || total <= 0) return false;
	const clamped = Math.min(Math.max(0, Math.trunc(page)), total - 1);
	// Aim at the middle of the page's slice: its leading edge can round back
	// into the previous page once foliate maps the fraction to a section anchor.
	void handle.view.goToFraction((clamped + 0.5) / total);
	return true;
}

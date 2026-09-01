/**
 * Horizontal virtual window for the floating page filmstrip. Cards are
 * absolutely positioned inside a relative rail of `totalWidth`, so no spacer
 * elements are needed: `offsetFor(index)` is the card's physical left edge.
 * Callers pass a non-negative scroll offset (normalize RTL scrollLeft with
 * Math.abs) — index math is direction-agnostic.
 */

export interface FilmstripWindow {
	firstIndex: number;
	lastIndexExclusive: number;
	indexes: number[];
	totalWidth: number;
	pitch: number;
}

export interface FilmstripWindowInput {
	totalPages: number;
	scrollLeft: number;
	viewportWidth: number;
	itemWidth: number;
	gap?: number;
	overscanItems?: number;
	maxCards?: number;
}

export function getFilmstripWindow(input: FilmstripWindowInput): FilmstripWindow {
	const totalPages = Math.max(0, Math.trunc(input.totalPages));
	const itemWidth = Math.max(1, input.itemWidth);
	const gap = Math.max(0, input.gap ?? 8);
	const overscanItems = Math.max(0, Math.trunc(input.overscanItems ?? 4));
	const maxCards = Math.max(1, Math.trunc(input.maxCards ?? 40));
	const pitch = itemWidth + gap;
	const totalWidth = totalPages === 0 ? 0 : totalPages * pitch - gap;
	if (totalPages === 0) {
		return { firstIndex: 0, lastIndexExclusive: 0, indexes: [], totalWidth: 0, pitch };
	}

	// Clamp to the last page so overshooting scroll offsets (momentum, rail
	// resize) can never produce an inverted window.
	const visibleFirst = Math.min(totalPages - 1, Math.max(0, Math.floor(Math.max(0, input.scrollLeft) / pitch)));
	const visibleCount = Math.max(1, Math.ceil(Math.max(0, input.viewportWidth) / pitch) + 1);
	let firstIndex = Math.max(0, visibleFirst - overscanItems);
	let lastIndexExclusive = Math.min(totalPages, visibleFirst + visibleCount + overscanItems);
	if (lastIndexExclusive - firstIndex > maxCards) lastIndexExclusive = firstIndex + maxCards;
	if (lastIndexExclusive > totalPages) {
		lastIndexExclusive = totalPages;
		firstIndex = Math.max(0, lastIndexExclusive - maxCards);
	}
	return {
		firstIndex,
		lastIndexExclusive,
		indexes: Array.from({ length: lastIndexExclusive - firstIndex }, (_, offset) => firstIndex + offset),
		totalWidth,
		pitch
	};
}

/** Physical left edge of a card inside the rail. */
export function filmstripOffsetForIndex(index: number, itemWidth: number, gap = 8): number {
	return Math.max(0, Math.trunc(index)) * (Math.max(1, itemWidth) + Math.max(0, gap));
}

/** Scroll offset that centers `index` in the viewport, clamped to the rail. */
export function filmstripScrollLeftForIndex(
	index: number,
	totalPages: number,
	viewportWidth: number,
	itemWidth: number,
	gap = 8
): number {
	const total = Math.max(0, Math.trunc(totalPages));
	if (total === 0) return 0;
	const safeIndex = Math.max(0, Math.min(total - 1, Math.trunc(index)));
	const pitch = Math.max(1, itemWidth) + Math.max(0, gap);
	const totalWidth = total * pitch - Math.max(0, gap);
	return Math.max(0, Math.min(
		safeIndex * pitch - (viewportWidth - itemWidth) / 2,
		Math.max(0, totalWidth - viewportWidth)
	));
}

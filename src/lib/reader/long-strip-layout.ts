/**
 * Pure geometry for the long-strip (webtoon) reader mode.
 *
 * Every page is normalized to the strip width (fit-width, "100% zoom"), and
 * pages stack top-down with no gaps. All values are CSS pixels.
 */

export interface StripPageDimension {
	width: number;
	height: number;
}

export interface StripPageMetric {
	index: number;
	/** Top offset of the page inside the strip. */
	top: number;
	/** Rendered height at strip width. */
	height: number;
	/** Scale from source-image pixels to strip pixels (stripWidth / imageWidth). */
	scale: number;
}

export interface StripLayout {
	pages: StripPageMetric[];
	totalHeight: number;
}

/** Aspect ratio used for pages whose dimensions are not yet known. */
const FALLBACK_ASPECT = 3 / 2; // height / width — typical 2:3 manga page

/**
 * Stack pages at the given strip width. Pages with unknown dimensions
 * (width/height <= 0) use the median aspect ratio of the known pages, or a
 * 2:3 fallback when nothing is known yet, so the strip stays scrollable while
 * dimensions backfill.
 */
export function buildStripLayout(
	dimensions: readonly StripPageDimension[],
	stripWidth: number
): StripLayout {
	const knownAspects = dimensions
		.filter((dim) => dim.width > 0 && dim.height > 0)
		.map((dim) => dim.height / dim.width)
		.sort((a, b) => a - b);
	const fallbackAspect = knownAspects.length > 0
		? knownAspects[Math.floor(knownAspects.length / 2)]
		: FALLBACK_ASPECT;

	const pages: StripPageMetric[] = [];
	let top = 0;
	for (let index = 0; index < dimensions.length; index += 1) {
		const dim = dimensions[index];
		const known = dim.width > 0 && dim.height > 0;
		const aspect = known ? dim.height / dim.width : fallbackAspect;
		const height = Math.max(1, Math.round(stripWidth * aspect));
		pages.push({
			index,
			top,
			height,
			scale: known ? stripWidth / dim.width : 1
		});
		top += height;
	}
	return { pages, totalHeight: top };
}

/**
 * The page occupying the most of the viewport [scrollTop, scrollTop + viewportHeight).
 * Ties resolve to the earlier page. Scroll positions outside the strip clamp
 * to the first/last page. Returns 0 for an empty strip.
 */
export function dominantPageIndex(
	layout: StripLayout,
	scrollTop: number,
	viewportHeight: number
): number {
	const pages = layout.pages;
	if (pages.length === 0) return 0;
	const viewTop = scrollTop;
	const viewBottom = scrollTop + Math.max(0, viewportHeight);
	let best = 0;
	let bestVisible = -1;
	for (const page of pages) {
		const pageBottom = page.top + page.height;
		if (pageBottom <= viewTop) continue;
		if (page.top >= viewBottom) break;
		const visible = Math.min(pageBottom, viewBottom) - Math.max(page.top, viewTop);
		if (visible > bestVisible) {
			bestVisible = visible;
			best = page.index;
		}
	}
	if (bestVisible < 0) {
		return viewTop <= 0 ? 0 : pages.length - 1;
	}
	return best;
}

/**
 * Pages intersecting [scrollTop - overscanPx, scrollTop + viewportHeight + overscanPx],
 * as an inclusive index range. Returns { start: 0, end: -1 } for an empty strip.
 */
export function stripPageWindow(
	layout: StripLayout,
	scrollTop: number,
	viewportHeight: number,
	overscanPx: number
): { start: number; end: number } {
	const pages = layout.pages;
	if (pages.length === 0) return { start: 0, end: -1 };
	const windowTop = scrollTop - overscanPx;
	const windowBottom = scrollTop + Math.max(0, viewportHeight) + overscanPx;
	let start = pages.length - 1;
	let end = 0;
	for (const page of pages) {
		const pageBottom = page.top + page.height;
		if (pageBottom <= windowTop) continue;
		if (page.top >= windowBottom) break;
		start = Math.min(start, page.index);
		end = Math.max(end, page.index);
	}
	if (end < start) {
		// The window lies entirely outside the strip: clamp to the nearest edge.
		const index = windowTop <= 0 ? 0 : pages.length - 1;
		return { start: index, end: index };
	}
	return { start, end };
}

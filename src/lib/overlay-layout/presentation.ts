import type {
	OverlayItemV2,
	OverlayRenderPlanV2,
	PageOverlayDataV2,
	PlannedOverlayItemV2,
	Point,
	Rect
} from '$lib/types/index.js';
import { polygonBounds } from './geometry.js';

/** One fill in a whitewash, painted source-over in list order. */
export interface OverlayBackgroundLayer {
	rect: Rect;
	/** Corner radius in page pixels; 0 for a square corner. */
	radius: number;
	/** 0..1, composited over whatever is already there. */
	alpha: number;
}

/** One whitewash to paint, in page-image pixel space. */
export interface OverlayBackgroundShape {
	itemId: string;
	fill: string;
	/** Container contour when the item is contour-bound; absent for manual/free items. */
	polygon?: Point[];
	/** Fallback geometry when there is no polygon, and the rotation centre for both. */
	rect: Rect;
	rotationDegrees: number;
	/**
	 * Soft-edged fills for an unbounded item, outermost first. When present a
	 * renderer paints THESE instead of `rect` — the erasure over the region the
	 * item replaces, then a plate under each line of text.
	 *
	 * Expressed as concentric fills with explicit alphas rather than a blur,
	 * because SVG `fill-opacity` and canvas `globalAlpha` composite source-over
	 * with identical arithmetic and a Gaussian blur does not. Three surfaces
	 * paint these plans and they have to agree.
	 */
	layers?: OverlayBackgroundLayer[];
}

/**
 * Steps in a feathered edge.
 *
 * Per-step alphas are derived from the CUMULATIVE coverage targets below, so
 * the ramp reads as a ramp — a plain per-step alpha would put most of the
 * transition in the first band.
 */
const FEATHER_STEPS = 6;

/**
 * Cumulative source-over coverage of the whitewash at `rect`'s own boundary
 * and everywhere inside it. Deliberately below 1: an unbounded item sits on
 * artwork rather than in a balloon's white space, and a fully opaque slab
 * reads as a sticker pasted over the page. At 0.8 the art (and the erased
 * source) ghost through at 20%, which keeps the panel's texture while the
 * translation stays comfortably legible over it.
 */
const FEATHER_CORE_COVERAGE = 0.8;

/**
 * Cumulative coverage of the outermost band, at `rect + softEdgePx`. Near-zero
 * so the fringe dissolves into the paper instead of announcing where the
 * whitewash ends.
 */
const FEATHER_EDGE_COVERAGE = 0.05;

/**
 * `rect` grown by `softEdgePx`, with the growth spent on the ramp.
 *
 * The ramp goes OUTWARD, and that is the whole point. Feathering inward looked
 * right on an empty page and was wrong on a real one: the translucent bands
 * fall over the source lettering they are meant to erase, and fragments of the
 * original show back through around the edge of the block. Grown outward, peak
 * coverage is reached exactly at `rect`'s own boundary and the ramp lands on
 * the paper beyond it.
 *
 * Cumulative coverage climbs linearly from `FEATHER_EDGE_COVERAGE` at the
 * outermost band to `FEATHER_CORE_COVERAGE` at `rect`; each band's own alpha
 * is whatever tops the stack up to its target under source-over compositing,
 * so all three painting surfaces agree by arithmetic rather than by tuning.
 */
function feather(rect: Rect, softEdgePx: number, radius: number): OverlayBackgroundLayer[] {
	if (!(softEdgePx > 0)) return [{ rect, radius, alpha: FEATHER_CORE_COVERAGE }];
	const layers: OverlayBackgroundLayer[] = [];
	let coverage = 0;
	for (let index = 0; index < FEATHER_STEPS; index += 1) {
		// index 0 is the outermost band, at +softEdgePx; the last is inset to
		// exactly `rect`, where cumulative coverage reaches the core value.
		const grow = softEdgePx * (1 - index / (FEATHER_STEPS - 1));
		const target = FEATHER_EDGE_COVERAGE
			+ ((FEATHER_CORE_COVERAGE - FEATHER_EDGE_COVERAGE) * index) / (FEATHER_STEPS - 1);
		const alpha = (target - coverage) / (1 - coverage);
		coverage = target;
		layers.push({
			rect: {
				x: rect.x - grow,
				y: rect.y - grow,
				width: rect.width + grow * 2,
				height: rect.height + grow * 2
			},
			radius: radius > 0 ? radius + grow : 0,
			alpha
		});
	}
	return layers;
}

/** Line boxes grown into plates, so text on artwork stays legible. */
function platesFor(item: PlannedOverlayItemV2): Rect[] {
	const padding = item.background?.platePadding ?? 0;
	return (item.lines ?? [])
		.filter((line) => line.bounds.width > 0 && line.bounds.height > 0)
		.map((line) => ({
			x: line.bounds.x - padding,
			y: line.bounds.y - padding,
			width: line.bounds.width + padding * 2,
			height: line.bounds.height + padding * 2
		}));
}

/**
 * The page's whitewash pass, in paint order.
 *
 * Every surface that renders a plan paints these first and all of them, before
 * any glyph. Two items can share one container contour — policy-24 stacked
 * column bands, a two-lobe bubble, near-duplicate contours — and each then
 * carries the identical full-contour polygon, so a renderer that interleaves
 * background and text per item lets one sibling's whitewash erase the other's
 * text. Order within the list does not matter (whitewashes are opaque and
 * mutually compatible); what matters is that none of them is painted late.
 *
 * `includeReveal` is false for surfaces that cannot offer the translation a
 * reveal placement stands for. Erasing the source there would leave the reader
 * with neither the original nor a way to reach the translation.
 */
export function overlayBackgroundShapes(
	plan: OverlayRenderPlanV2,
	options: { includeReveal?: boolean } = {}
): OverlayBackgroundShape[] {
	const includeReveal = options.includeReveal ?? true;
	const shapes: OverlayBackgroundShape[] = [];
	for (const item of plan.items) {
		if (!isBackgroundPaintable(item, includeReveal)) continue;
		const background = item.background!;
		const erasures = background.erasureRects ?? [];
		shapes.push({
			itemId: item.itemId,
			fill: background.fill,
			polygon: background.polygon,
			rect: item.rect!,
			rotationDegrees: item.rotationDegrees ?? 0,
			// A reveal placement has no text, so it has no plates and its erasure
			// would hide the source with nothing put in its place; it keeps the
			// plain card it has always painted.
			layers: erasures.length > 0 && item.fitMode !== 'reveal'
				? [
					// Erasures are square: each stands for a column of source
					// lettering, and rounding one would leave the original showing
					// at its corners.
					...erasures.flatMap((rect) => feather(rect, background.softEdgePx ?? 0, 0)),
					...platesFor(item).flatMap((plate) =>
						feather(plate, background.softEdgePx ?? 0, background.plateRadius ?? 0))
				]
				: undefined
		});
	}
	return shapes;
}

/** Whether this item contributes a whitewash at all. */
export function isBackgroundPaintable(item: PlannedOverlayItemV2, includeReveal = true): boolean {
	if (item.status !== 'placed' || !item.rect || !item.background) return false;
	if (item.fitMode === 'reveal') return includeReveal;
	// A non-reveal item without typography was never placed as text and must not
	// whitewash anything.
	return Boolean(item.font && item.lines);
}

export function overlayItemBaseRect(document: PageOverlayDataV2, item: OverlayItemV2): Rect | null {
	if (item.manual.rect) return item.manual.rect;
	const container = document.containers.find((candidate) => candidate.id === item.containerId);
	if (container) return polygonBounds(container.polygon);
	const sources = item.sourceIds.map((id) => document.sources.find((source) => source.id === id)).filter(Boolean);
	if (sources.length === 0) return null;
	const x = Math.min(...sources.map((source) => source!.bounds.x));
	const y = Math.min(...sources.map((source) => source!.bounds.y));
	const right = Math.max(...sources.map((source) => source!.bounds.x + source!.bounds.width));
	const bottom = Math.max(...sources.map((source) => source!.bounds.y + source!.bounds.height));
	return { x, y, width: right - x, height: bottom - y };
}

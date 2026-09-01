import type { OverlayRenderPlanV2, PlannedOverlayItemV2 } from '$lib/types/index.js';
import { fontFamilyForKey } from '$lib/overlay-layout/font-registry.js';
import { overlayBackgroundShapes } from '$lib/overlay-layout/presentation.js';

export interface CanonicalCanvasRenderOptions {
	drawBackground?: boolean;
	textColor?: string | ((item: PlannedOverlayItemV2) => string);
}

function polygonPath(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	polygon: NonNullable<PlannedOverlayItemV2['clipPolygon']>
): void {
	ctx.beginPath();
	ctx.moveTo(polygon[0].x, polygon[0].y);
	for (const point of polygon.slice(1)) ctx.lineTo(point.x, point.y);
	ctx.closePath();
}

/**
 * An item this renderer paints. A `reveal` placement is deliberately excluded:
 * it is a whitewash with no typesettable text, and a CBZ cannot offer the
 * tap-to-read popover the reader does, so painting it would erase the source
 * with nothing put in its place. (It also has no `font`, which used to skip it
 * by accident; the contract is stated here instead.)
 */
function isPaintable(item: PlannedOverlayItemV2): boolean {
	return (
		item.status === 'placed' &&
		item.fitMode !== 'reveal' &&
		Boolean(item.rect) &&
		Boolean(item.font) &&
		Boolean(item.lines)
	);
}

/** Runs `draw` under the item's own rotation and clip, then restores the context. */
function withItemTransform(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	item: PlannedOverlayItemV2,
	draw: () => void
): void {
	ctx.save();
	if (item.rotationDegrees) {
		const centerX = item.rect!.x + item.rect!.width / 2;
		const centerY = item.rect!.y + item.rect!.height / 2;
		ctx.translate(centerX, centerY);
		ctx.rotate(item.rotationDegrees * Math.PI / 180);
		ctx.translate(-centerX, -centerY);
	}
	if (item.clipPolygon?.length) {
		polygonPath(ctx, item.clipPolygon);
		ctx.clip();
	}
	draw();
	ctx.restore();
}

/** Draws a canonical plan verbatim. It never measures, wraps, sizes, or places text. */
export function renderOverlayPlanToCanvas(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	plan: OverlayRenderPlanV2,
	options: CanonicalCanvasRenderOptions = {}
): void {
	// Backgrounds are a PAGE-level pass, not a per-item one. Two items can share
	// one container contour — policy-24 stacked column bands, a two-lobe bubble,
	// near-duplicate contours — and then carry the identical full-contour
	// polygon. `plan.items` is ordered by `itemId`, which is durable content
	// identity and says nothing about reading order, so interleaving fills and
	// text let whichever sibling happens to sort last paint its whitewash over
	// the other's already-drawn glyphs. Separating the passes makes the output
	// independent of that order. The shape list is shared with the DOM
	// renderers so all three surfaces whitewash the same thing.
	const itemsById = new Map(plan.items.map((item) => [item.itemId, item]));
	if (options.drawBackground !== false) {
		// Reveal placements are excluded: a CBZ cannot offer the tap-to-read
		// popover the reader does, so whitewashing there would erase the source
		// with nothing put in its place.
		for (const shape of overlayBackgroundShapes(plan, { includeReveal: false })) {
			const item = itemsById.get(shape.itemId);
			if (!item) continue;
			withItemTransform(ctx, item, () => {
				ctx.fillStyle = shape.fill;
				if (shape.layers?.length) {
					// Soft-edged unbounded whitewash: concentric fills with explicit
					// alphas, composited source-over exactly as the SVG renderers
					// composite nested `fill-opacity`. Never a blur — the two would
					// not match, and all three surfaces paint the same plan.
					for (const layer of shape.layers) {
						if (!(layer.rect.width > 0 && layer.rect.height > 0)) continue;
						ctx.save();
						ctx.globalAlpha = layer.alpha;
						ctx.beginPath();
						if (layer.radius > 0 && typeof ctx.roundRect === 'function') {
							ctx.roundRect(layer.rect.x, layer.rect.y, layer.rect.width, layer.rect.height, layer.radius);
						} else {
							ctx.rect(layer.rect.x, layer.rect.y, layer.rect.width, layer.rect.height);
						}
						ctx.fill();
						ctx.restore();
					}
				} else if (shape.polygon?.length) {
					polygonPath(ctx, shape.polygon);
					ctx.fill();
				} else {
					ctx.fillRect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height);
				}
			});
		}
	}

	ctx.textBaseline = 'alphabetic';
	for (const item of plan.items) {
		if (!isPaintable(item)) continue;
		withItemTransform(ctx, item, () => {
			ctx.fillStyle = typeof options.textColor === 'function'
				? options.textColor(item)
				: options.textColor ?? '#111111';
			for (const line of item.lines!) {
				for (const run of line.runs) {
					ctx.save();
					ctx.font = `${item.font!.weight} ${item.font!.size}px "${fontFamilyForKey(run.fontKey)}"`;
					ctx.direction = run.direction;
					// Canonical origins are logical starts: physical left for LTR and
					// physical right for RTL. This is the same contract as SVG `start`.
					ctx.textAlign = 'start';
					if (run.rotationDegrees) {
						ctx.translate(run.origin.x, run.origin.y);
						ctx.rotate(run.rotationDegrees * Math.PI / 180);
						ctx.fillText(run.text, 0, 0);
					} else {
						ctx.fillText(run.text, run.origin.x, run.origin.y);
					}
					ctx.restore();
				}
			}
		});
	}
}

/** Retained as a no-op compatibility hook for callers that owned old DOM probes. */
export function cleanupMeasureSpan(): void {}

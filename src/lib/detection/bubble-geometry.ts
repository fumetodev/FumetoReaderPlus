/**
 * Bubble region geometry — shared contour tracing and IoU helpers.
 *
 * Formerly `bubble-segmenter.ts`, which also owned a bundled YOLO11n-seg ONNX
 * model. That model was removed on 2026-07-24: production layout detection is
 * the bespoke Apache-2.0 rtmdet-manga model (see `layout-detector.ts`), and the
 * legacy artifact was an unused Ultralytics/AGPL-3.0 file that only created a
 * redistribution problem. What remains here is the `BubbleRegion` shape every
 * detection backend returns, plus the mask→polygon and IoU utilities the RTMDet
 * and candidate segmenters share.
 */

// Douglas-Peucker simplification: epsilon as fraction of bounding box diagonal
const SIMPLIFY_EPSILON_RATIO = 0.02;
const MAX_CONTOUR_POINTS = 30;
// Instance masks come from a coarse prototype grid, so tracing or simplifying
// millions of projected source-image pixels cannot add useful geometry, but it
// can turn an unusual mask into an unbounded CPU/memory path.
const MAX_RAW_CONTOUR_POINTS = 65_536;
const MAX_SIMPLIFICATION_INPUT_POINTS = 2_048;
const SIMPLIFICATION_SEARCH_STEPS = 16;

/** A detected speech bubble with bounding box and contour polygon. */
export interface BubbleRegion {
	bubbleId: number;
	x: number;
	y: number;
	width: number;
	height: number;
	confidence: number;
	/** Simplified polygon contour in image-space coordinates ([x, y] pairs). */
	contour: [number, number][];
}

/**
 * Extract a simplified polygon contour from a binary mask region.
 * Uses Moore-Neighbor boundary tracing + Douglas-Peucker simplification.
 */
function extractContour(
	mask: Uint8Array,
	bx: number,
	by: number,
	bw: number,
	bh: number,
	imgW: number,
	_imgH: number
): [number, number][] {
	// Trace boundary within the bounding box region
	const points: [number, number][] = [];

	// Moore-Neighbor direction offsets (8-connected, clockwise starting from right)
	const dx = [1, 1, 0, -1, -1, -1, 0, 1];
	const dy = [0, 1, 1, 1, 0, -1, -1, -1];

	// Find start pixel (first foreground pixel scanning left-to-right, top-to-bottom)
	let startX = -1,
		startY = -1;
	for (let y = by; y < by + bh && startX < 0; y++) {
		for (let x = bx; x < bx + bw; x++) {
			if (mask[y * imgW + x] === 1) {
				startX = x;
				startY = y;
				break;
			}
		}
	}

	if (startX < 0) return [];

	// Moore-Neighbor tracing
	let cx = startX,
		cy = startY;
	let dir = 7; // start searching from top-right
	const maxSteps = Math.min(bw * bh * 2, MAX_RAW_CONTOUR_POINTS);
	let steps = 0;
	const visitedStates = new Set<string>();

	do {
		const state = `${cx - bx}:${cy - by}:${dir}`;
		if (visitedStates.has(state)) break;
		visitedStates.add(state);
		points.push([cx, cy]);
		// Search for next boundary pixel
		let found = false;
		const startDir = (dir + 5) % 8; // backtrack direction + 1

		for (let i = 0; i < 8; i++) {
			const d = (startDir + i) % 8;
			const nx = cx + dx[d];
			const ny = cy + dy[d];

			if (nx >= bx && nx < bx + bw && ny >= by && ny < by + bh && mask[ny * imgW + nx] === 1) {
				dir = d;
				cx = nx;
				cy = ny;
				found = true;
				break;
			}
		}

		if (!found) break;
		steps++;
	} while ((cx !== startX || cy !== startY) && steps < maxSteps);

	if (points.length < 3) return points;

	// Douglas-Peucker simplification. Uniform pre-decimation retains far more
	// detail than the final 30-point contract can expose while bounding the
	// work for high-resolution, high-frequency masks.
	const simplificationInput = evenlySamplePoints(points, MAX_SIMPLIFICATION_INPUT_POINTS);
	const diagonal = Math.sqrt(bw * bw + bh * bh);
	const epsilon = diagonal * SIMPLIFY_EPSILON_RATIO;
	return simplifyContourToLimit(simplificationInput, epsilon, diagonal, MAX_CONTOUR_POINTS);
}

function evenlySamplePoints(points: [number, number][], limit: number): [number, number][] {
	if (points.length <= limit) return points;
	if (limit <= 1) return [points[0]];
	const sampled: [number, number][] = [];
	for (let index = 0; index < limit; index += 1) {
		sampled.push(points[Math.round(index * (points.length - 1) / (limit - 1))]);
	}
	return sampled;
}

function simplifyContourToLimit(
	points: [number, number][],
	baseEpsilon: number,
	maximumEpsilon: number,
	limit: number
): [number, number][] {
	if (points.length <= limit) return points;
	const initial = douglasPeucker(points, baseEpsilon);
	if (initial.length <= limit) return initial;

	let low = Math.max(0, baseEpsilon);
	let high = Math.max(low, maximumEpsilon);
	let best = douglasPeucker(points, high);
	for (let iteration = 0; iteration < SIMPLIFICATION_SEARCH_STEPS; iteration += 1) {
		const middle = (low + high) / 2;
		const candidate = douglasPeucker(points, middle);
		if (candidate.length > limit) low = middle;
		else {
			best = candidate;
			high = middle;
		}
	}
	// A degenerate open-line result is not a polygon. Evenly sampling the traced
	// boundary is a deterministic conservative fallback and is still bounded.
	return best.length >= 3 ? best : evenlySamplePoints(points, limit);
}

/**
 * Douglas-Peucker polyline simplification.
 */
function douglasPeucker(points: [number, number][], epsilon: number): [number, number][] {
	if (points.length <= 2) return points;
	const retained = new Uint8Array(points.length);
	retained[0] = 1;
	retained[points.length - 1] = 1;
	const ranges: Array<[number, number]> = [[0, points.length - 1]];
	while (ranges.length > 0) {
		const [start, end] = ranges.pop()!;
		const [sx, sy] = points[start];
		const [ex, ey] = points[end];
		const lineLength = Math.hypot(ex - sx, ey - sy);
		let maximumDistance = 0;
		let maximumIndex = -1;
		for (let index = start + 1; index < end; index += 1) {
			const [px, py] = points[index];
			const distance = lineLength < 1e-6
				? Math.hypot(px - sx, py - sy)
				: Math.abs((ey - sy) * px - (ex - sx) * py + ex * sy - ey * sx) / lineLength;
			if (distance > maximumDistance) {
				maximumDistance = distance;
				maximumIndex = index;
			}
		}
		if (maximumIndex < 0 || maximumDistance <= epsilon) continue;
		retained[maximumIndex] = 1;
		// Push right first so the traversal order remains equivalent to the
		// former recursive left-then-right implementation.
		ranges.push([maximumIndex, end], [start, maximumIndex]);
	}
	return points.filter((_, index) => retained[index] === 1);
}

/** Compute IoU between two center-format detections. */
function computeIoU(
	a: { cx: number; cy: number; w: number; h: number },
	b: { cx: number; cy: number; w: number; h: number }
): number {
	const ax1 = a.cx - a.w / 2,
		ay1 = a.cy - a.h / 2;
	const ax2 = a.cx + a.w / 2,
		ay2 = a.cy + a.h / 2;
	const bx1 = b.cx - b.w / 2,
		by1 = b.cy - b.h / 2;
	const bx2 = b.cx + b.w / 2,
		by2 = b.cy + b.h / 2;

	const ix1 = Math.max(ax1, bx1),
		iy1 = Math.max(ay1, by1);
	const ix2 = Math.min(ax2, bx2),
		iy2 = Math.min(ay2, by2);
	const iw = Math.max(0, ix2 - ix1),
		ih = Math.max(0, iy2 - iy1);
	const inter = iw * ih;

	const aArea = a.w * a.h;
	const bArea = b.w * b.h;
	const union = aArea + bArea - inter;

	return union > 0 ? inter / union : 0;
}

/** @internal Exported for testing */
export {
	computeIoU as _computeIoU,
	douglasPeucker as _douglasPeucker,
	extractContour as _extractContour,
	simplifyContourToLimit as _simplifyContourToLimit
};

/**
 * Shared with the RTMDet segmenters and the model-candidate eval suite: trace a
 * simplified polygon from any binary original-resolution mask, and the
 * center-format detection IoU used for NMS/agreement metrics.
 */
export { extractContour as traceMaskContour, computeIoU as detectionIoU };

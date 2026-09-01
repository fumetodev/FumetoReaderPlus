import type { Point, Rect } from '$lib/types/index.js';
import { recordGate, recordGateResult } from './gate-telemetry.js';
import { quantize } from './canonical.js';

export interface Interval {
	start: number;
	end: number;
}

export const rectRight = (rect: Rect): number => rect.x + rect.width;
export const rectBottom = (rect: Rect): number => rect.y + rect.height;

export function isFiniteRect(rect: Rect): boolean {
	return Number.isFinite(rect.x)
		&& Number.isFinite(rect.y)
		&& Number.isFinite(rect.width)
		&& Number.isFinite(rect.height)
		&& rect.width > 0
		&& rect.height > 0;
}

export function rectInside(rect: Rect, width: number, height: number): boolean {
	return isFiniteRect(rect)
		&& rect.x >= 0
		&& rect.y >= 0
		&& rectRight(rect) <= width
		&& rectBottom(rect) <= height;
}

export function polygonBounds(points: Point[]): Rect | null {
	if (points.length < 3 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	const width = Math.max(...xs) - x;
	const height = Math.max(...ys) - y;
	return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function polygonArea(points: Point[]): number {
	let area = 0;
	for (let index = 0; index < points.length; index += 1) {
		const next = (index + 1) % points.length;
		area += points[index].x * points[next].y - points[next].x * points[index].y;
	}
	return Math.abs(area) / 2;
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const first = orientation(a, b, c);
	const second = orientation(a, b, d);
	const third = orientation(c, d, a);
	const fourth = orientation(c, d, b);
	return first * second < 0 && third * fourth < 0;
}

export function isSimplePolygon(points: Point[]): boolean {
	if (points.length < 3 || polygonArea(points) <= 0) return false;
	for (let left = 0; left < points.length; left += 1) {
		const leftNext = (left + 1) % points.length;
		for (let right = left + 1; right < points.length; right += 1) {
			const rightNext = (right + 1) % points.length;
			if (left === right || leftNext === right || rightNext === left) continue;
			if (segmentsIntersect(points[left], points[leftNext], points[right], points[rightNext])) return false;
		}
	}
	return true;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
	let inside = false;
	for (let left = 0, right = polygon.length - 1; left < polygon.length; right = left++) {
		const a = polygon[left];
		const b = polygon[right];
		if (((a.y > point.y) !== (b.y > point.y))
			&& point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || Number.EPSILON) + a.x) inside = !inside;
	}
	return inside;
}

export function scanlineIntervals(polygon: Point[], y: number): Interval[] {
	const intersections: number[] = [];
	for (let index = 0; index < polygon.length; index += 1) {
		const a = polygon[index];
		const b = polygon[(index + 1) % polygon.length];
		if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
			intersections.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
		}
	}
	intersections.sort((left, right) => left - right);
	const result: Interval[] = [];
	for (let index = 0; index + 1 < intersections.length; index += 2) {
		if (intersections[index + 1] > intersections[index]) {
			result.push({ start: intersections[index], end: intersections[index + 1] });
		}
	}
	return result;
}

export function intersectIntervals(left: Interval[], right: Interval[]): Interval[] {
	const result: Interval[] = [];
	for (const a of left) {
		for (const b of right) {
			const start = Math.max(a.start, b.start);
			const end = Math.min(a.end, b.end);
			if (end > start) result.push({ start, end });
		}
	}
	return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function subtractIntervals(source: Interval[], removed: Interval[]): Interval[] {
	let result = [...source];
	for (const cut of removed) {
		const next: Interval[] = [];
		for (const interval of result) {
			if (cut.end <= interval.start || cut.start >= interval.end) next.push(interval);
			else {
				if (cut.start > interval.start) next.push({ start: interval.start, end: cut.start });
				if (cut.end < interval.end) next.push({ start: cut.end, end: interval.end });
			}
		}
		result = next;
	}
	return result;
}

/**
 * Fraction of the smaller polygon's area covered by the pair's intersection.
 * Scanline-band integration with events at every vertex y of either polygon;
 * exact for vertex-aligned spans, midpoint-sampled within spans. Deterministic.
 */
export function polygonPairOverlapRatio(left: Point[], right: Point[]): number {
	const leftBounds = polygonBounds(left);
	const rightBounds = polygonBounds(right);
	if (!leftBounds || !rightBounds) return 0;
	const top = Math.max(leftBounds.y, rightBounds.y);
	const bottom = Math.min(rectBottom(leftBounds), rectBottom(rightBounds));
	if (!(bottom > top)) return 0;
	if (Math.min(rectRight(leftBounds), rectRight(rightBounds)) <= Math.max(leftBounds.x, rightBounds.x)) {
		return 0;
	}
	const events = [top, bottom, ...left.map((point) => point.y), ...right.map((point) => point.y)]
		.filter((value) => Number.isFinite(value) && value >= top && value <= bottom)
		.sort((a, b) => a - b)
		.filter((value, index, values) => index === 0 || value !== values[index - 1]);
	let area = 0;
	for (let index = 0; index + 1 < events.length; index += 1) {
		const spanTop = events[index];
		const spanBottom = events[index + 1];
		if (!(spanBottom > spanTop)) continue;
		const mid = (spanTop + spanBottom) / 2;
		const overlap = intersectIntervals(scanlineIntervals(left, mid), scanlineIntervals(right, mid));
		const width = overlap.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
		area += width * (spanBottom - spanTop);
	}
	if (!(area > 0)) return 0;
	const minArea = Math.min(polygonArea(left), polygonArea(right));
	return minArea > 0 ? Math.min(1, area / minArea) : 0;
}

export function safeBandIntervals(
	polygon: Point[],
	top: number,
	bottom: number,
	padding: number,
	tailPolygon?: Point[],
	exclusionPolygons?: Point[][]
): Interval[] {
	if (!(bottom > top)) return [];
	// Between consecutive polygon-vertex y values every scanline boundary is
	// linear, so its extrema occur at an event boundary. Sample each event and
	// both sides of every event span. The old top/middle/bottom sampling missed
	// narrow concavities whose vertex fell elsewhere inside a glyph band.
	const events = [top, bottom, ...polygon.map((point) => point.y), ...(tailPolygon?.map((point) => point.y) ?? [])]
		.filter((value) => Number.isFinite(value) && value >= top && value <= bottom)
		.sort((left, right) => left - right)
		.filter((value, index, values) => index === 0 || value !== values[index - 1]);
	const samples: number[] = [];
	const addSample = (value: number): void => {
		if (value > top && value < bottom && !samples.includes(value)) samples.push(value);
	};
	for (let index = 0; index + 1 < events.length; index += 1) {
		const start = events[index];
		const end = events[index + 1];
		const epsilon = Math.min(1 / 64, (end - start) / 4);
		addSample(start + epsilon);
		addSample((start + end) / 2);
		addSample(end - epsilon);
	}
	for (const event of events.slice(1, -1)) addSample(event);
	samples.sort((left, right) => left - right);
	if (samples.length === 0) addSample((top + bottom) / 2);
	let intervals = scanlineIntervals(polygon, samples[0]);
	for (const y of samples.slice(1)) intervals = intersectIntervals(intervals, scanlineIntervals(polygon, y));
	if (tailPolygon && isSimplePolygon(tailPolygon)) {
		let tail = scanlineIntervals(tailPolygon, samples[0]);
		for (const y of samples.slice(1)) tail = tail.concat(scanlineIntervals(tailPolygon, y));
		intervals = subtractIntervals(intervals, tail);
	}
	if (exclusionPolygons) {
		// Neighbor-contour erosion: like the tail, each exclusion's union of
		// scanlines across the band is subtracted so ink provably stays out of
		// the shared region with an adjacent balloon.
		for (const exclusion of exclusionPolygons) {
			if (!isSimplePolygon(exclusion)) continue;
			let cut = scanlineIntervals(exclusion, samples[0]);
			for (const y of samples.slice(1)) cut = cut.concat(scanlineIntervals(exclusion, y));
			intervals = subtractIntervals(intervals, cut);
		}
	}
	return intervals
		.map((interval) => ({ start: quantize(interval.start + padding), end: quantize(interval.end - padding) }))
		.filter((interval) => interval.end > interval.start);
}

/** Dynamic programming keeps successive lines in one coherent contour lobe. */
export function coherentIntervalStack(rows: Interval[][]): Interval[] | null {
	if (rows.length === 0 || rows.some((row) => row.length === 0)) return null;
	let states = rows[0].map((interval, index) => ({ interval, index, score: interval.end - interval.start, path: [interval] }));
	for (const row of rows.slice(1)) {
		const next: typeof states = [];
		for (let index = 0; index < row.length; index += 1) {
			const interval = row[index];
			let best: (typeof states)[number] | null = null;
			for (const state of states) {
				const overlap = Math.max(0, Math.min(interval.end, state.interval.end) - Math.max(interval.start, state.interval.start));
				if (overlap <= 0) continue;
				const centerShift = Math.abs((interval.start + interval.end - state.interval.start - state.interval.end) / 2);
				const score = state.score + (interval.end - interval.start) + overlap - centerShift * 0.25;
				if (!best || score > best.score || (score === best.score && state.index < best.index)) {
					best = { interval, index, score, path: [...state.path, interval] };
				}
			}
			if (best) next.push(best);
		}
		if (next.length === 0) return null;
		states = next;
	}
	return states.sort((left, right) => right.score - left.score || left.index - right.index)[0].path;
}

/**
 * Contiguous sub-window escape from the full-height requirement above. A
 * two-lobe ("peanut") contour has no single coherent stack spanning every
 * band — or only a neck-height one — so the caller can search every
 * contiguous run of bands for the best coherent stack instead: the
 * horizontal mirror of the column sub-window search in vertical.ts. Scored
 * by covered width, then path length, then earliest start — all tie-breaks
 * explicit because plans must stay byte-stable.
 */
export function coherentSubWindowStack(
	rows: Interval[][],
	options?: { exactLength?: number }
): { start: number; path: Interval[] } | null {
	let best: { start: number; path: Interval[]; area: number } | null = null;
	for (let start = 0; start < rows.length; start += 1) {
		for (let end = start + 1; end <= rows.length; end += 1) {
			if (rows[end - 1].length === 0) break;
			if (options?.exactLength !== undefined && end - start !== options.exactLength) {
				if (end - start > options.exactLength) break;
				continue;
			}
			const path = coherentIntervalStack(rows.slice(start, end));
			if (!path) break;
			const area = path.reduce((sum, interval) => sum + interval.end - interval.start, 0);
			if (
				!best
				|| area > best.area
				|| (area === best.area && (path.length > best.path.length
					|| (path.length === best.path.length && start < best.start)))
			) {
				best = { start, path, area };
			}
		}
	}
	return best ? { start: best.start, path: best.path } : null;
}

/**
 * Two lobes, or null. A thin wrapper over `polygonLobeSplit` so that "this
 * shape is two bubbles drawn conjoined" has exactly one definition.
 *
 * It used to be a second implementation with its own sampling rate (48
 * sections) and its own neck threshold (0.34), and both were too strict to see
 * a real join: a balloon pair 1300px tall can be pinched over 40px, so at 48
 * sections the sampled minimum landed well above the true one. Measured on
 * drawn ellipse pairs, the same neck reads 0.41 at 48 sections and 0.31 at 128
 * — either side of the old threshold. Per-lobe candidate geometry therefore
 * almost never appeared for a real conjoined bubble, and a single utterance in
 * one had to span the merged shape at whatever font the neck allowed.
 */
export function polygonWaistSplit(
	polygon: Point[],
	options?: { samples?: number; maxNeckRatio?: number; minLobeRatio?: number }
): { axis: 'x' | 'y'; lobes: [Rect, Rect] } | null {
	const split = polygonLobeSplit(polygon, { ...options, maxLobes: 2 });
	if (!split || split.lobes.length !== 2) return null;
	return { axis: split.axis, lobes: [split.lobes[0], split.lobes[1]] };
}

/**
 * Usable ink width at each of `slices` equal-height bands of `rect`.
 *
 * This is the measurement that band stacking was missing. Splitting a shared
 * region between two utterances used to divide its HEIGHT by text share, which
 * is only correct if the region is a rectangle. Inside a balloon it is not: a
 * band across the waist of a conjoined bubble, or across the top of an ellipse,
 * holds a fraction of the ink a mid-body band of the same height does. Equal
 * character counts therefore bought wildly unequal amounts of usable space, and
 * the short-changed member either shrank to fit or fell out to tap-to-reveal.
 *
 * Width is sampled at the band's midline rather than intersected across it, so
 * the profile describes the shape rather than the worst case within each slice;
 * `safeBandIntervals` still enforces the worst case when the text is actually
 * laid out.
 */
export function usableWidthProfile(
	polygon: Point[] | undefined,
	rect: Rect,
	slices: number,
	padding = 0
): number[] {
	const count = Math.max(1, Math.floor(slices));
	const sliceHeight = rect.height / count;
	if (!polygon || polygon.length < 3) {
		return Array.from({ length: count }, () => Math.max(0, rect.width - padding * 2));
	}
	const left = rect.x + padding;
	const right = rectRight(rect) - padding;
	return Array.from({ length: count }, (_, index) => {
		const y = rect.y + (index + 0.5) * sliceHeight;
		let width = 0;
		for (const interval of scanlineIntervals(polygon, y)) {
			const start = Math.max(interval.start + padding, left);
			const end = Math.min(interval.end - padding, right);
			if (end > start) width += end - start;
		}
		return width;
	});
}

export interface DemandBand {
	top: number;
	height: number;
}

/**
 * Indices of `profile` that are necks: narrow enough, relative to the widest
 * part on each side, to be a join between two bodies rather than a taper.
 *
 * Shared by lobe detection and band partitioning so "where does this shape
 * pinch" has exactly one answer. Ordered by depth, deepest first, then by
 * index — callers take the first N and re-sort positionally.
 */
/**
 * How narrow a section has to be, against the wider body on each side, to count
 * as a join between two drawn bubbles.
 *
 * One number for both callers, because both are asking the same question. It
 * was 0.42 for `polygonLobeSplit` and 0.34 for band snapping, and real drawn
 * joins measure 0.499-0.547 — so both sat below every join a letterer draws and
 * neither ever fired on a real balloon. Measured effect on band snapping: for
 * three utterances in a two-lobe bubble, where per-lobe assignment declines and
 * bands are the fallback, the boundary landed 138px from the join at 0.34 and
 * 3px from it at 0.65.
 *
 * Ordinary single-body balloons produce NO neck at any of 0.34, 0.50, 0.65 or
 * 0.80 — checked over four drawn shapes and every non-splitting contour in the
 * corpus — so this is a gate on what can be considered, not the guard against
 * considering it. `minLobeRatio` and the two-sided test are the guard, and they
 * are measured at 0.454-0.484 on real lobes against 0.22.
 */
export const CONJOINED_NECK_RATIO = 0.65;

export function profileNecks(
	profile: readonly number[],
	options?: { maxNeckRatio?: number; marginRatio?: number }
): number[] {
	const maxNeckRatio = options?.maxNeckRatio ?? CONJOINED_NECK_RATIO;
	const margin = Math.floor(profile.length * (options?.marginRatio ?? 0.15));
	const found: Array<{ index: number; depth: number }> = [];
	for (let index = margin; index < profile.length - margin; index += 1) {
		const leftPeak = Math.max(...profile.slice(0, index));
		const rightPeak = Math.max(...profile.slice(index + 1));
		const smallerPeak = Math.min(leftPeak, rightPeak);
		if (!(smallerPeak > 0)) continue;
		const depth = profile[index] / smallerPeak;
		// Recorded per candidate slice, not per call: the plateau audit needs the
		// distribution of depths a real page offers, which is the population this
		// threshold was set without.
		if (!recordGateResult('neck-depth', depth <= maxNeckRatio, depth)) continue;
		found.push({ index, depth });
	}
	// A neck is usually several slices wide. Keep one representative per run —
	// its middle — so "two necks" means two joins, not one join sampled twice.
	// Liveness: this is the comparison every conjoined-shape decision starts
	// from, and at its old value it never once fired on a real balloon.
	recordGate('neck-profile', found.length > 0 ? 'fired' : 'declined');
	found.sort((left, right) => left.index - right.index);
	const runs: number[] = [];
	for (let cursor = 0; cursor < found.length;) {
		let end = cursor;
		while (end + 1 < found.length && found[end + 1].index === found[end].index + 1) end += 1;
		runs.push(Math.round((found[cursor].index + found[end].index) / 2));
		cursor = end + 1;
	}
	return runs.sort((left, right) => profile[left] - profile[right] || left - right);
}

/**
 * Split `rect` into one band per demand, proportional to usable AREA.
 *
 * Two properties fall out of measuring area instead of height, and both are the
 * point of the exercise:
 *
 * - Inside a shape, a member gets the height it needs to hold its share of the
 *   ink, so a band across a narrow part of the balloon is automatically taller.
 * - Where the shape has a waist — two bubbles drawn conjoined — the cumulative
 *   area barely moves across the neck, so a boundary placed by area inversion
 *   lands *in* the neck. Snapping finishes the job: the split ends up exactly
 *   at the join, one utterance per lobe, which is what a letterer would do.
 *
 * Returns null when the region cannot hold the bands at all; the caller then
 * simply does not offer a stack, exactly as before.
 */
export function partitionByDemand(
	rect: Rect,
	profile: readonly number[],
	demands: readonly number[],
	options: { gap: number; minBand: number; snapToNecks?: boolean }
): DemandBand[] | null {
	const members = demands.length;
	if (members < 2 || profile.length === 0) return null;
	const gap = Math.max(0, options.gap);
	const minBand = Math.max(1, options.minBand);
	// One `gap` of slack beyond the obvious `members * minBand`. The boundary
	// clamp below reserves `minBand + gap` per band from both ends, so a region
	// sized to the obvious bound leaves the last band at `minBand - gap / 2` —
	// under the minimum this function promises. Refusing marginally sooner is
	// the honest way to keep the promise.
	const usableHeight = rect.height - gap * (members - 1);
	// A shared region too small to give every member a readable band. Counted
	// because "bands are never offered" and "bands are always refused" look the
	// same from outside and mean very different things.
	if (recordGateResult('band-min-height', usableHeight < members * minBand + gap)) return null;

	const sliceHeight = rect.height / profile.length;
	// Cumulative usable area at every slice boundary; cumulative[i] is the area
	// above slice i. Monotone non-decreasing, so it inverts by scanning.
	const cumulative: number[] = [0];
	for (const width of profile) cumulative.push(cumulative[cumulative.length - 1] + Math.max(0, width) * sliceHeight);
	const totalArea = cumulative[cumulative.length - 1];
	// A region with no usable width anywhere cannot be partitioned by area.
	// Fall back to plain height proportioning rather than dividing by zero.
	const byArea = totalArea > 0;

	const demandTotal = demands.reduce((sum, value) => sum + Math.max(0, value), 0);
	if (!(demandTotal > 0)) return null;

	/** y where the cumulative area first reaches `target`, linearly within a slice. */
	const yAtArea = (target: number): number => {
		for (let index = 0; index < profile.length; index += 1) {
			const from = cumulative[index];
			const to = cumulative[index + 1];
			if (to < target || to === from) continue;
			return rect.y + (index + (target - from) / (to - from)) * sliceHeight;
		}
		return rectBottom(rect);
	};

	let running = 0;
	const boundaries: number[] = [];
	for (let index = 0; index < members - 1; index += 1) {
		running += Math.max(0, demands[index]);
		const fraction = running / demandTotal;
		boundaries.push(byArea ? yAtArea(totalArea * fraction) : rect.y + rect.height * fraction);
	}

	// Where the shape pinches, structure beats proportion.
	//
	// A boundary placed purely by area lands wherever the cumulative integral
	// says, which inside a conjoined bubble routinely cuts a lobe in half and
	// leaves the neighbouring member's band spanning the neck — the exact shape
	// whose text is then capped at neck width. A neck is not a hint to nudge
	// towards; it is where a letterer would put the break. So each boundary
	// takes the nearest unclaimed neck outright, and area proportioning is what
	// decides the boundaries no neck accounts for.
	//
	// The neck test is what keeps this safe: an ellipse, a rectangle and a
	// single notch have none, so their boundaries stay exactly where area put
	// them.
	//
	// More necks than boundaries: take the deepest ones (profileNecks orders by
	// depth) and use them in position order, so three members in a four-lobe
	// shape break at the two most pronounced joins. Fewer necks than
	// boundaries: every neck is used and the remaining boundaries stay where
	// area put them. Assignment walks both lists forward, so the result is
	// always ordered.
	const deepest = options.snapToNecks === false
		? []
		: profileNecks(profile)
			.slice(0, members - 1)
			.sort((left, right) => left - right)
			.map((index) => rect.y + (index + 0.5) * sliceHeight);
	const snapped = [...boundaries];
	// Whether structure actually beat proportion here. At the old 0.34 this
	// fired on shapes that had no join and placed the boundary 138px from the
	// one real join it was shown, so both halves of the count matter.
	recordGate('band-neck-snap', deepest.length > 0 ? 'fired' : 'declined');
	let neckCursor = 0;
	for (let index = 0; index < snapped.length && neckCursor < deepest.length; index += 1) {
		const remainingBoundaries = snapped.length - index;
		const remainingNecks = deepest.length - neckCursor;
		// Once every remaining boundary is needed for a remaining neck, stop
		// choosing and just consume them in order.
		const neck = deepest[neckCursor];
		const nextGap = index + 1 < snapped.length ? Math.abs(snapped[index + 1] - neck) : Number.POSITIVE_INFINITY;
		if (remainingNecks >= remainingBoundaries || Math.abs(snapped[index] - neck) <= nextGap) {
			snapped[index] = neck;
			neckCursor += 1;
		}
	}

	// Boundaries must stay ordered and leave room for a minimum band each.
	const ordered: number[] = [];
	for (let index = 0; index < snapped.length; index += 1) {
		const floor = (ordered[index - 1] ?? rect.y) + minBand + gap;
		const ceiling = rectBottom(rect) - (members - 1 - index) * (minBand + gap);
		ordered.push(Math.min(Math.max(snapped[index], floor), Math.max(floor, ceiling)));
	}

	// A neck belongs to neither utterance.
	//
	// Splitting AT the pinch is only half the job: with a plain 4px gap the band
	// below a neck still starts inside it, and since a line stack is centred in
	// its band a short first line ends up floating in the constriction — one word
	// alone in the join between two balloons, which is not where a letterer would
	// ever put it. Widening the gap to cover the constricted run gives the neck
	// to nobody, and both utterances sit in the bodies they belong to.
	//
	// Only as far as the bands can afford: the minimum this function promises
	// wins over the cosmetic improvement, so a region that cannot spare the
	// height falls back to the nominal gap rather than to no stack at all.
	const constrictionCeiling = Math.max(...profile) * 0.6;
	const halfGaps = ordered.map((boundary) => {
		const centre = Math.min(profile.length - 1, Math.max(0, Math.round((boundary - rect.y) / sliceHeight - 0.5)));
		if (!(profile[centre] <= constrictionCeiling)) return gap / 2;
		let from = centre;
		let to = centre;
		while (from > 0 && profile[from - 1] <= constrictionCeiling) from -= 1;
		while (to + 1 < profile.length && profile[to + 1] <= constrictionCeiling) to += 1;
		const runTop = rect.y + from * sliceHeight;
		const runBottom = rect.y + (to + 1) * sliceHeight;
		return Math.max(gap / 2, Math.min(boundary - runTop, runBottom - boundary));
	});

	const build = (gaps: number[]): DemandBand[] | null => {
		const bands: DemandBand[] = [];
		for (let index = 0; index < members; index += 1) {
			const top = index === 0 ? rect.y : ordered[index - 1] + gaps[index - 1];
			const bottom = index === members - 1 ? rectBottom(rect) : ordered[index] - gaps[index];
			if (!(bottom - top >= minBand)) return null;
			bands.push({ top: quantize(top), height: quantize(bottom) - quantize(top) });
		}
		return bands.every((band) => band.height > 0) ? bands : null;
	};

	return build(halfGaps) ?? build(ordered.map(() => gap / 2));
}

/**
 * Split a contour into its lobes — two conjoined bubbles, or three, or four.
 *
 * `polygonWaistSplit` finds the single deepest waist and returns exactly two
 * rects, which is right for a peanut and wrong for anything more joined than
 * that: three bubbles drawn touching produced either two lobes with a whole
 * bubble absorbed into one of them, or no split at all, and the text then had
 * to span the full merged shape at whatever font the narrowest neck allowed.
 *
 * Waists are accepted deepest-first and only while every resulting segment
 * still holds a real share of the area, so an ellipse, a rectangle, a single
 * notch, and a tail junction all keep returning null.
 */
export function polygonLobeSplit(
	polygon: Point[],
	options?: { samples?: number; maxNeckRatio?: number; minLobeRatio?: number; maxLobes?: number }
): { axis: 'x' | 'y'; lobes: Rect[] } | null {
	const bounds = polygonBounds(polygon);
	if (!bounds || !isSimplePolygon(polygon)) return null;
	// 48 sections was too coarse to see a real join. A balloon pair 1300px tall
	// can be pinched over 40px — one and a half sections — so the sampled minimum
	// landed well above the true one and the neck test failed on shapes a reader
	// sees as unmistakably two bubbles. Measured on drawn ellipse pairs: 0.41 at
	// 48 sections against 0.31 at 128, either side of the threshold. Sections are
	// a scanline each, so this costs microseconds.
	const samples = Math.max(16, Math.floor(options?.samples ?? 128));
	// A join, not a pinch — and drawn joins are far shallower than hand-written
	// test polygons suggest. Measured on five conjoined balloons from real pages:
	// 0.499, 0.500, 0.502, 0.547, 0.547. Ordinary single-body balloons on the
	// same pages measure 0.983 to 1.002, so the two populations are separated by
	// a gulf and CONJOINED_NECK_RATIO sits in the middle of it. The old 0.42 was
	// below EVERY real join, which is why per-lobe assignment had never fired on
	// a real balloon.
	//
	// This is a gate, not the guard. `minLobeRatio` and `twoSided` are what
	// reject a single body: probed to 0.80, an ellipse, a circle, a tall oval, a
	// balloon with a tail spliced into its outline, a teardrop and a corpus-style
	// dent all still return null. Real lobes hold 0.454-0.484 of the area against
	// the 0.22 this demands, so the guard has margin on both sides.
	const maxNeckRatio = options?.maxNeckRatio ?? CONJOINED_NECK_RATIO;
	const minLobeRatio = options?.minLobeRatio ?? 0.22;
	const maxLobes = Math.max(2, Math.floor(options?.maxLobes ?? 4));

	const axisProfile = (axis: 'x' | 'y'): {
		profile: number[]; starts: number[]; ends: number[]; lo: number; step: number;
	} => {
		const sectioned = axis === 'y' ? polygon : polygon.map((point) => ({ x: point.y, y: point.x }));
		const lo = axis === 'y' ? bounds.y : bounds.x;
		const extent = axis === 'y' ? bounds.height : bounds.width;
		const step = extent / samples;
		const profile: number[] = [];
		const starts: number[] = [];
		const ends: number[] = [];
		for (let index = 0; index < samples; index += 1) {
			const at = lo + (index + 0.5) * step;
			const intervals = scanlineIntervals(sectioned, at);
			profile.push(intervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0));
			starts.push(intervals.length > 0 ? intervals[0].start : Number.NaN);
			ends.push(intervals.length > 0 ? intervals[intervals.length - 1].end : Number.NaN);
		}
		return { profile, starts, ends, lo, step };
	};

	/**
	 * A waist is narrow from BOTH sides; a notch is narrow from one.
	 *
	 * Section width alone cannot tell them apart, and once the neck threshold
	 * was loosened enough to see a smoothly drawn join it started reading a
	 * corpus-style concave dent as two bodies. The dent's narrow sections stay
	 * flush with one edge of the shape while the other edge cuts in; a real join
	 * pulls in from both. Comparing against the WIDEST section on each side —
	 * the bodies themselves — also handles a staggered peanut, where each edge
	 * is flush with one neighbour but interior to the pair.
	 */
	const twoSided = (
		index: number,
		profile: number[],
		starts: number[],
		ends: number[],
		tolerance: number
	): boolean => {
		let leftBody = -1;
		let rightBody = -1;
		for (let scan = 0; scan < index; scan += 1) {
			if (leftBody < 0 || profile[scan] > profile[leftBody]) leftBody = scan;
		}
		for (let scan = index + 1; scan < profile.length; scan += 1) {
			if (rightBody < 0 || profile[scan] > profile[rightBody]) rightBody = scan;
		}
		if (leftBody < 0 || rightBody < 0) return false;
		if (!Number.isFinite(starts[index]) || !Number.isFinite(ends[index])) return true;
		const outerStart = Math.min(starts[leftBody], starts[rightBody]);
		const outerEnd = Math.max(ends[leftBody], ends[rightBody]);
		return starts[index] - outerStart > tolerance && outerEnd - ends[index] > tolerance;
	};

	/**
	 * Waists that survive the lobe-share test: every body the cuts create must
	 * still hold a real fraction of the area, which is what keeps an ellipse, a
	 * rectangle, a single notch and a tail junction returning null.
	 */
	const waistsFor = (profile: number[], starts: number[], ends: number[]): number[] => {
		const total = profile.reduce((sum, value) => sum + value, 0);
		if (!(total > 0)) return [];
		const tolerance = Math.max(...profile) * 0.05;
		const share = (from: number, to: number) =>
			profile.slice(from, to).reduce((sum, value) => sum + value, 0) / total;
		const accepted: number[] = [];
		// profileNecks orders by depth, so the most pronounced joins are taken
		// first and a shallower one is only added if it still leaves real bodies.
		for (const index of profileNecks(profile, { maxNeckRatio })) {
			if (accepted.length + 1 >= maxLobes) break;
			// The two-sided test and the lobe-share bound are the actual guard
			// against reading one balloon as two; the neck ratio only decides what
			// reaches them. Both are counted so a guard that has stopped rejecting
			// anything is as visible as one that has stopped admitting anything.
			if (!recordGateResult('lobe-two-sided', twoSided(index, profile, starts, ends, tolerance))) continue;
			const cuts = [...accepted, index].sort((left, right) => left - right);
			const edges = [0, ...cuts.map((cut) => cut + 1), samples];
			const viable = Array.from({ length: edges.length - 1 }, (_, segment) => segment)
				.every((segment) => edges[segment + 1] - edges[segment] >= 2
					&& share(edges[segment], edges[segment + 1]) >= minLobeRatio);
			if (recordGateResult('lobe-min-share', viable)) accepted.push(index);
		}
		return accepted.sort((left, right) => left - right);
	};

	const candidates = (['x', 'y'] as const)
		.map((axis) => {
			const { profile, starts, ends, lo, step } = axisProfile(axis);
			const waists = waistsFor(profile, starts, ends);
			if (waists.length === 0) return null;
			// Prefer the axis with more lobes, then the deeper primary waist.
			// Ratio, never the absolute section width: an x-axis profile measures
			// vertical extents and a y-axis profile horizontal ones, so comparing
			// them directly let a shallow pinch on the narrow axis outrank a real
			// waist on the other — which is how a teardrop with a 0.26 neck came
			// back with no lobes at all.
			const peak = Math.max(...profile);
			const primaryDepth = peak > 0 ? Math.min(...waists.map((index) => profile[index])) / peak : 1;
			return { axis, profile, lo, step, waists, primaryDepth };
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		.sort((left, right) => right.waists.length - left.waists.length
			|| left.primaryDepth - right.primaryDepth
			|| (left.axis === 'x' ? -1 : 1));
	if (!recordGateResult('lobe-split', candidates.length > 0)) return null;
	const { axis, lo, step, waists } = candidates[0];

	const sectioned = axis === 'y' ? polygon : polygon.map((point) => ({ x: point.y, y: point.x }));
	const extent = axis === 'y' ? bounds.height : bounds.width;
	const lobeBounds = (from: number, to: number): Rect | null => {
		let axisMin = Number.POSITIVE_INFINITY;
		let axisMax = Number.NEGATIVE_INFINITY;
		let crossMin = Number.POSITIVE_INFINITY;
		let crossMax = Number.NEGATIVE_INFINITY;
		for (let at = from + step / 2; at < to; at += step) {
			const intervals = scanlineIntervals(sectioned, at);
			if (intervals.length === 0) continue;
			axisMin = Math.min(axisMin, at - step / 2);
			axisMax = Math.max(axisMax, at + step / 2);
			crossMin = Math.min(crossMin, intervals[0].start);
			crossMax = Math.max(crossMax, intervals[intervals.length - 1].end);
		}
		if (!(axisMax > axisMin) || !(crossMax > crossMin)) return null;
		const rect = axis === 'y'
			? { x: crossMin, y: axisMin, width: crossMax - crossMin, height: axisMax - axisMin }
			: { x: axisMin, y: crossMin, width: axisMax - axisMin, height: crossMax - crossMin };
		return {
			x: quantize(rect.x),
			y: quantize(rect.y),
			width: quantize(rect.width),
			height: quantize(rect.height)
		};
	};

	const splitPoints = waists.map((index) => lo + (index + 0.5) * step);
	const edges = [lo, ...splitPoints, lo + extent];
	const lobes: Rect[] = [];
	for (let index = 0; index + 1 < edges.length; index += 1) {
		const lobe = lobeBounds(edges[index], edges[index + 1]);
		if (!lobe) return null;
		lobes.push(lobe);
	}
	return lobes.length >= 2 ? { axis, lobes } : null;
}

export function rectIntersectionArea(left: Rect, right: Rect): number {
	const width = Math.max(0, Math.min(rectRight(left), rectRight(right)) - Math.max(left.x, right.x));
	const height = Math.max(0, Math.min(rectBottom(left), rectBottom(right)) - Math.max(left.y, right.y));
	return width * height;
}

/** Exact polygon/axis-aligned-rectangle intersection area for diagnostic and hard-mask checks. */
export function polygonRectIntersectionArea(polygon: Point[], rect: Rect): number {
	if (!isFiniteRect(rect) || polygon.length < 3) return 0;
	type Edge = 'left' | 'right' | 'top' | 'bottom';
	const inside = (point: Point, edge: Edge): boolean => {
		if (edge === 'left') return point.x >= rect.x;
		if (edge === 'right') return point.x <= rectRight(rect);
		if (edge === 'top') return point.y >= rect.y;
		return point.y <= rectBottom(rect);
	};
	const intersect = (from: Point, to: Point, edge: Edge): Point => {
		if (edge === 'left' || edge === 'right') {
			const x = edge === 'left' ? rect.x : rectRight(rect);
			const ratio = (x - from.x) / (to.x - from.x || Number.EPSILON);
			return { x, y: from.y + (to.y - from.y) * ratio };
		}
		const y = edge === 'top' ? rect.y : rectBottom(rect);
		const ratio = (y - from.y) / (to.y - from.y || Number.EPSILON);
		return { x: from.x + (to.x - from.x) * ratio, y };
	};
	let output = polygon.map((point) => ({ ...point }));
	for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
		const input = output;
		output = [];
		for (let index = 0; index < input.length; index += 1) {
			const current = input[index];
			const previous = input[(index + input.length - 1) % input.length];
			const currentInside = inside(current, edge);
			const previousInside = inside(previous, edge);
			if (currentInside) {
				if (!previousInside) output.push(intersect(previous, current, edge));
				output.push(current);
			} else if (previousInside) output.push(intersect(previous, current, edge));
		}
		if (output.length === 0) return 0;
	}
	return polygonArea(output);
}

export function rectGap(left: Rect, right: Rect): number {
	const dx = Math.max(left.x - rectRight(right), right.x - rectRight(left), 0);
	const dy = Math.max(left.y - rectBottom(right), right.y - rectBottom(left), 0);
	return Math.hypot(dx, dy);
}

export function clampRect(rect: Rect, width: number, height: number): Rect {
	const w = Math.min(width, Math.max(1, rect.width));
	const h = Math.min(height, Math.max(1, rect.height));
	return {
		x: quantize(Math.min(width - w, Math.max(0, rect.x))),
		y: quantize(Math.min(height - h, Math.max(0, rect.y))),
		width: quantize(w),
		height: quantize(h)
	};
}

export function expandRect(rect: Rect, scaleX: number, scaleY: number, dx = 0, dy = 0): Rect {
	const width = rect.width * scaleX;
	const height = rect.height * scaleY;
	return {
		x: rect.x + (rect.width - width) / 2 + dx,
		y: rect.y + (rect.height - height) / 2 + dy,
		width,
		height
	};
}

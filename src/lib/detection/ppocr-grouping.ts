import type {
	DetectedTextComponent,
	DetectedTextGroupKind,
	DetectedTextRegion
} from '$lib/types/index.js';
import type { BubbleRegion } from './bubble-geometry.js';

export type PPOcrGroupDirection = 'horizontal' | 'vertical' | 'rotated' | 'ambiguous';

export interface PPOcrPanelRegion {
	panelId: string;
	polygon: [number, number][];
	confidence?: number;
}

export interface PPOcrComponentAssignment {
	componentId: number;
	/** Stable logical group produced for this component. */
	groupId?: string;
	bubbleId?: number;
	panelId: string;
	overlapRatio: number;
	secondBestOverlapRatio: number;
	ambiguous: boolean;
	candidateBubbleIds: number[];
}

export interface PPOcrRejectedComponent {
	componentId: number;
	reason: 'non-finite' | 'degenerate' | 'out-of-page' | 'invalid-polygon' | 'duplicate-id';
}

export interface PPOcrSeparationReason {
	componentIds: [number, number];
	reason:
		| 'bubble-owner'
		| 'ambiguous-bubble'
		| 'balloon-rim'
		| 'panel'
		| 'direction'
		| 'orientation'
		| 'glyph-scale'
		| 'free-satellite-span'
		| 'span-cap'
		| 'geometry';
}

export interface PPOcrGroupTrace {
	componentCount: number;
	glyphScale: number;
	glyphScaleRatio: number;
	orientationSpread: number;
	fillRatio: number;
	edgeDistanceRatio: number;
	nearestGroupDistanceInGlyphs: number;
	inferredPanel: boolean;
	bubbleOverlap: number;
	reasons: string[];
}

export interface PPOcrTextGroup extends DetectedTextRegion {
	id: string;
	inBubble: boolean;
	componentIds: number[];
	components: DetectedTextComponent[];
	direction: PPOcrGroupDirection;
	trace: PPOcrGroupTrace;
}

export interface PPOcrGroupingDiagnostics {
	inputRegions: number;
	acceptedComponents: number;
	invalidComponents: number;
	groups: number;
	assignedToBubbles: number;
	freeComponents: number;
	ambiguousBubbleAssignments: number;
	duplicateComponentIds: number[];
	missingComponentIds: number[];
	inferredVerticalCuts: number[];
	inferredHorizontalCuts: number[];
	classificationCounts: Record<DetectedTextGroupKind, number>;
	evaluatedPairs: number;
	candidateEdges: number;
	acceptedEdges: number;
	/** Always zero in the pure result; callers measure wall time outside it. */
	processingMs: number;
	rejectedComponents: PPOcrRejectedComponent[];
	separationReasons: PPOcrSeparationReason[];
	separationReasonsTruncated: boolean;
	/**
	 * Raw-region `boxId`s whose detector-owned shared recognition crop was NOT
	 * honoured because its source components resolved to different bubbles or
	 * panels (or an ambiguous bubble). The must-link is dropped and the sources
	 * group independently.
	 *
	 * Callers that recognize text per raw region MUST split these regions into
	 * their source components before recognition — otherwise both groups look up
	 * the same union crop and receive the same string. `extractTextWithPPOCR`
	 * does exactly that.
	 */
	sharedCropOwnershipSplits: number[];
}

export interface PPOcrGroupingResult {
	groups: PPOcrTextGroup[];
	assignments: PPOcrComponentAssignment[];
	diagnostics: PPOcrGroupingDiagnostics;
}

export interface PPOcrGroupingOptions {
	panels?: PPOcrPanelRegion[];
	/** Locale controls script-sensitive vertical/satellite policy. */
	locale?: string;
	/** Minimum fraction of a component polygon that must overlap a bubble. */
	minimumBubbleOverlap?: number;
	/** Similar competing bubble overlaps are left explicitly ambiguous. */
	ambiguityRatio?: number;
	/**
	 * Page reading direction, which orders the assigned box IDs within a reading
	 * band. Box IDs are what the translation prompts address and what the reader
	 * sidebar lists, so this is the page's direction — not the direction of the
	 * script inside a group, which stays a typography property (see
	 * `componentReadingOrder`).
	 *
	 * Defaults to 'rtl': the manga order every corpus, gate and benchmark in this
	 * repo was captured under. Production callers resolve the real direction with
	 * `effectiveReadingDirection()` and pass it explicitly.
	 */
	readingDirection?: 'rtl' | 'ltr';
	/** Page/session cancellation propagated by translation producers. */
	signal?: AbortSignal;
}

export class PPOcrGroupingInputLimitError extends RangeError {
	readonly code = 'PPOCR_GROUPING_INPUT_LIMIT';

	constructor(readonly input: 'components' | 'bubbles' | 'panels', readonly count: number, readonly limit: number) {
		super(`PP-OCR grouping ${input} count ${count} exceeds limit ${limit}`);
		this.name = 'PPOcrGroupingInputLimitError';
	}
}

export class PPOcrGroupingIdentityError extends TypeError {
	readonly code = 'PPOCR_GROUPING_DUPLICATE_IDENTITY';

	constructor(readonly input: 'bubbles' | 'panels', readonly duplicateId: string) {
		super(`PP-OCR grouping ${input} contain duplicate ID ${duplicateId}`);
		this.name = 'PPOcrGroupingIdentityError';
	}
}

export interface PPOcrTextClassification {
	kind: DetectedTextGroupKind;
	confidence: number;
	reasons: string[];
	/**
	 * Structured, text-free evidence for lab traces. This is intentionally
	 * diagnostic: weak narration/name/profile cues never promote a class by
	 * themselves.
	 */
	diagnostics?: PPOcrTextClassificationDiagnostics;
}

export type PPOcrTextClassificationTransition =
	`${DetectedTextGroupKind}->${DetectedTextGroupKind}`;

export interface PPOcrTextClassificationDiagnostics {
	priorKind: DetectedTextGroupKind;
	finalKind: DetectedTextGroupKind;
	transition: PPOcrTextClassificationTransition;
	framedCaption: boolean;
	unframedExposition: boolean;
	dateLabelLike: boolean;
	characterNameLike: boolean;
	profileBlockLike: boolean;
	frameEvidence: 'present' | 'absent' | 'unavailable';
	panelEdgeEvidence: 'near' | 'interior' | 'unavailable';
	backgroundEvidence: 'regular' | 'textured' | 'mixed' | 'unavailable';
}

/** Optional image evidence supplied after OCR, without coupling grouping to pixels. */
export interface TextGroupClassificationContext {
	locale?: string;
	imageWidth?: number;
	imageHeight?: number;
	panelBounds?: Rect;
	pageMedianGlyphHeight?: number;
	backgroundUniformity?: number;
	localEdgeDensity?: number;
	hasRectangularFrame?: boolean;
	distanceToPanelEdge?: number;
	targetKindHint?: DetectedTextGroupKind;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PreparedComponent extends DetectedTextComponent {
	/** Unmodified detector evidence; grouping geometry is clamped separately. */
	source: DetectedTextComponent;
	direction: PPOcrGroupDirection;
	glyphScale: number;
	area: number;
	centerX: number;
	centerY: number;
	bubbleId?: number;
	panelId: string;
	bubbleOverlap: number;
	bubbleAssignmentAmbiguous: boolean;
	inferredPanel: boolean;
}

interface GroupingEdge {
	left: number;
	right: number;
	score: number;
}

interface FlattenedComponents {
	components: DetectedTextComponent[];
	rejected: PPOcrRejectedComponent[];
	duplicateIds: number[];
}

const CLASSIFICATION_KINDS: DetectedTextGroupKind[] = [
	'speech',
	'thought',
	'narration',
	'sign',
	'sfx',
	'borderless',
	'unknown'
];
const MAX_LOCAL_PAIR_EVALUATIONS = 64;
const MAX_SEPARATION_REASON_TRACES = 2_048;
export const MAX_PPOCR_GROUPING_COMPONENTS = 3_000;
export const MAX_PPOCR_GROUPING_BUBBLES = 512;
export const MAX_PPOCR_GROUPING_PANELS = 512;

const finite = (value: number): boolean => Number.isFinite(value);
const right = (rect: Rect): number => rect.x + rect.width;
const bottom = (rect: Rect): number => rect.y + rect.height;
const area = (rect: Rect): number => Math.max(0, rect.width) * Math.max(0, rect.height);
const centerX = (rect: Rect): number => rect.x + rect.width / 2;
const centerY = (rect: Rect): number => rect.y + rect.height / 2;

/** Locale-independent UTF-16 code-unit ordering for byte-stable plans and traces. */
function compareStrings(left: string, rightValue: string): number {
	return left < rightValue ? -1 : left > rightValue ? 1 : 0;
}

function throwIfGroupingCancelled(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error('PP-OCR grouping cancelled');
	error.name = 'AbortError';
	throw error;
}

function assertUniqueGroupingIdentities(
	bubbles: readonly BubbleRegion[],
	panels: readonly PPOcrPanelRegion[]
): void {
	const bubbleIds = new Set<number>();
	for (const bubble of bubbles) {
		if (bubbleIds.has(bubble.bubbleId)) {
			throw new PPOcrGroupingIdentityError('bubbles', String(bubble.bubbleId));
		}
		bubbleIds.add(bubble.bubbleId);
	}
	const panelIds = new Set<string>();
	for (const panel of panels) {
		if (panelIds.has(panel.panelId)) {
			throw new PPOcrGroupingIdentityError('panels', panel.panelId);
		}
		panelIds.add(panel.panelId);
	}
}

function declaredComponentCount(regions: readonly DetectedTextRegion[]): number {
	let count = 0;
	for (const region of regions) {
		count += region.sourceComponents?.length
			?? (region.sourceComponentIds?.length ? new Set(region.sourceComponentIds).size : 1);
		if (count > MAX_PPOCR_GROUPING_COMPONENTS) return count;
	}
	return count;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function quantize(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const ordered = [...values].sort((left, rightValue) => left - rightValue);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 0
		? (ordered[middle - 1] + ordered[middle]) / 2
		: ordered[middle];
}

function normalizeAngle(degrees: number): number {
	if (!finite(degrees)) return 0;
	let normalized = ((degrees + 90) % 180 + 180) % 180 - 90;
	if (normalized === 90) normalized = -90;
	return quantize(normalized);
}

function angleDistance(left: number, rightValue: number): number {
	const delta = Math.abs(normalizeAngle(left) - normalizeAngle(rightValue));
	return Math.min(delta, 180 - delta);
}

function rectPolygon(rect: Rect): [number, number][] {
	return [
		[rect.x, rect.y],
		[right(rect), rect.y],
		[right(rect), bottom(rect)],
		[rect.x, bottom(rect)]
	];
}

function validPolygon(polygon: readonly [number, number][]): boolean {
	return polygon.length >= 3 && polygon.every(([x, y]) => finite(x) && finite(y));
}

function polygonArea(polygon: readonly [number, number][]): number {
	let sum = 0;
	for (let index = 0; index < polygon.length; index += 1) {
		const [x1, y1] = polygon[index];
		const [x2, y2] = polygon[(index + 1) % polygon.length];
		sum += x1 * y2 - x2 * y1;
	}
	return Math.abs(sum) / 2;
}

function polygonBounds(polygon: readonly [number, number][]): Rect {
	const xs = polygon.map(([x]) => x);
	const ys = polygon.map(([, y]) => y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(0, Math.max(...xs) - x), height: Math.max(0, Math.max(...ys) - y) };
}

function pointOnSegment(
	x: number,
	y: number,
	from: readonly [number, number],
	to: readonly [number, number]
): boolean {
	const cross = (x - from[0]) * (to[1] - from[1]) - (y - from[1]) * (to[0] - from[0]);
	if (Math.abs(cross) > 1e-6) return false;
	return x >= Math.min(from[0], to[0]) - 1e-6
		&& x <= Math.max(from[0], to[0]) + 1e-6
		&& y >= Math.min(from[1], to[1]) - 1e-6
		&& y <= Math.max(from[1], to[1]) + 1e-6;
}

function pointInPolygon(x: number, y: number, polygon: readonly [number, number][]): boolean {
	let inside = false;
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		if (pointOnSegment(x, y, polygon[previous], polygon[index])) return true;
		const [xi, yi] = polygon[index];
		const [xj, yj] = polygon[previous];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function rectsIntersect(leftRect: Rect, rightRect: Rect): boolean {
	return leftRect.x < right(rightRect)
		&& right(leftRect) > rightRect.x
		&& leftRect.y < bottom(rightRect)
		&& bottom(leftRect) > rightRect.y;
}

/** Deterministic area sampling for arbitrary simple/concave polygon overlap. */
export function estimatePolygonOverlapRatio(
	subject: readonly [number, number][],
	container: readonly [number, number][],
	samplesPerAxis = 11
): number {
	if (!validPolygon(subject) || !validPolygon(container)) return 0;
	const subjectBounds = polygonBounds(subject);
	if (subjectBounds.width <= 0 || subjectBounds.height <= 0) return 0;
	if (!rectsIntersect(subjectBounds, polygonBounds(container))) return 0;
	let subjectSamples = 0;
	let overlappingSamples = 0;
	for (let row = 0; row < samplesPerAxis; row += 1) {
		const y = subjectBounds.y + subjectBounds.height * ((row + 0.5) / samplesPerAxis);
		for (let column = 0; column < samplesPerAxis; column += 1) {
			const x = subjectBounds.x + subjectBounds.width * ((column + 0.5) / samplesPerAxis);
			if (!pointInPolygon(x, y, subject)) continue;
			subjectSamples += 1;
			if (pointInPolygon(x, y, container)) overlappingSamples += 1;
		}
	}
	if (subjectSamples === 0) {
		const centroidX = subject.reduce((sum, [x]) => sum + x, 0) / subject.length;
		const centroidY = subject.reduce((sum, [, y]) => sum + y, 0) / subject.length;
		return pointInPolygon(centroidX, centroidY, container) ? 1 : 0;
	}
	return overlappingSamples / subjectSamples;
}

function localeUsesConventionalVerticalText(locale?: string): boolean {
	const normalized = locale?.trim().toLowerCase();
	// Detector-only callers may not know the locale yet; retain manga-safe auto
	// behavior. Explicit non-CJK locales must never turn a rotated horizontal
	// line into stacked vertical typography.
	if (!normalized || normalized === 'auto' || normalized === 'und') return true;
	const language = normalized.split(/[-_]/u)[0];
	return language === 'ja' || language === 'zh' || language === 'ko';
}

function directionFor(
	component: Pick<DetectedTextComponent, 'width' | 'height' | 'orientationDegrees'>,
	locale?: string
): PPOcrGroupDirection {
	const angle = Math.abs(normalizeAngle(component.orientationDegrees));
	const verticalText = localeUsesConventionalVerticalText(locale);
	if (angle >= 60) return verticalText ? 'vertical' : 'rotated';
	if (angle <= 30) {
		if (component.height > component.width * 1.45) return verticalText ? 'vertical' : 'rotated';
		if (component.width > component.height * 1.2) return 'horizontal';
		return 'ambiguous';
	}
	return 'rotated';
}

function glyphScaleFor(
	component: Pick<DetectedTextComponent, 'width' | 'height' | 'orientationDegrees'>,
	direction: PPOcrGroupDirection
): number {
	if (direction === 'horizontal') return Math.max(1, component.height);
	if (direction === 'vertical') return Math.max(1, component.width);
	return Math.max(1, Math.min(component.width, component.height));
}

function sanitizeRect(region: Rect, imageWidth: number, imageHeight: number): Rect | null {
	if (![region.x, region.y, region.width, region.height].every(finite)) return null;
	if (region.width <= 0 || region.height <= 0 || imageWidth <= 0 || imageHeight <= 0) return null;
	const x = clamp(region.x, 0, imageWidth);
	const y = clamp(region.y, 0, imageHeight);
	const nextRight = clamp(region.x + region.width, 0, imageWidth);
	const nextBottom = clamp(region.y + region.height, 0, imageHeight);
	if (nextRight <= x || nextBottom <= y) return null;
	return { x, y, width: nextRight - x, height: nextBottom - y };
}

function componentRejectionReason(
	componentId: number,
	geometry: Rect,
	polygon: readonly [number, number][] | undefined,
	imageWidth: number,
	imageHeight: number
): PPOcrRejectedComponent | null {
	if (!Number.isSafeInteger(componentId)
		|| ![geometry.x, geometry.y, geometry.width, geometry.height].every(finite)
		|| polygon?.some(([x, y]) => !finite(x) || !finite(y))) {
		return { componentId, reason: 'non-finite' };
	}
	if (geometry.width <= 0 || geometry.height <= 0) return { componentId, reason: 'degenerate' };
	if (polygon && (!validPolygon(polygon) || polygonArea(polygon) <= 0)) {
		return { componentId, reason: 'invalid-polygon' };
	}
	if (!sanitizeRect(geometry, imageWidth, imageHeight)) return { componentId, reason: 'out-of-page' };
	return null;
}

function sourceComponentFromRegion(
	region: DetectedTextRegion,
	componentId: number,
	imageWidth: number,
	imageHeight: number
): { component?: DetectedTextComponent; rejection?: PPOcrRejectedComponent } {
	const rawPolygon = region.polygon?.map(([x, y]) => [x, y] as [number, number]);
	const rejection = componentRejectionReason(componentId, region, rawPolygon, imageWidth, imageHeight);
	if (rejection) return { rejection };
	if (!finite(region.confidence)
		|| region.meanConfidence !== undefined && !finite(region.meanConfidence)
		|| region.maxConfidence !== undefined && !finite(region.maxConfidence)
		|| region.foregroundPixelCount !== undefined && !finite(region.foregroundPixelCount)) {
		return { rejection: { componentId, reason: 'non-finite' } };
	}
	const orientationDegrees = region.orientationDegrees
		?? (region.height > region.width * 1.45 ? -90 : 0);
	if (!finite(orientationDegrees)) return { rejection: { componentId, reason: 'non-finite' } };
	return {
		component: {
			componentId,
			polygon: rawPolygon ?? rectPolygon(region),
			x: region.x,
			y: region.y,
			width: region.width,
			height: region.height,
			confidence: finite(region.confidence) ? region.confidence : 0,
			meanConfidence: region.meanConfidence,
			maxConfidence: region.maxConfidence,
			foregroundPixelCount: region.foregroundPixelCount,
			orientationDegrees
		}
	};
}

function normalizeSuppliedComponent(
	component: DetectedTextComponent,
	imageWidth: number,
	imageHeight: number
): { component?: DetectedTextComponent; rejection?: PPOcrRejectedComponent } {
	const rejection = componentRejectionReason(
		component.componentId,
		component,
		component.polygon,
		imageWidth,
		imageHeight
	);
	if (rejection) return { rejection };
	if (!finite(component.orientationDegrees)
		|| !finite(component.confidence)
		|| component.meanConfidence !== undefined && !finite(component.meanConfidence)
		|| component.maxConfidence !== undefined && !finite(component.maxConfidence)
		|| component.foregroundPixelCount !== undefined && !finite(component.foregroundPixelCount)) {
		return { rejection: { componentId: component.componentId, reason: 'non-finite' } };
	}
	return {
		component: {
			...component,
			polygon: component.polygon.map(([x, y]) => [x, y] as [number, number])
		}
	};
}

function componentCanonicalKey(component: DetectedTextComponent): string {
	return JSON.stringify([
		component.componentId,
		component.x,
		component.y,
		component.width,
		component.height,
		component.orientationDegrees,
		component.polygon
	]);
}

function flattenComponents(
	regions: readonly DetectedTextRegion[],
	imageWidth: number,
	imageHeight: number
): FlattenedComponents {
	const candidates: DetectedTextComponent[] = [];
	const rejected: PPOcrRejectedComponent[] = [];
	for (const region of regions) {
		if (region.sourceComponents?.length) {
			for (const component of region.sourceComponents) {
				const normalized = normalizeSuppliedComponent(component, imageWidth, imageHeight);
				if (normalized.component) candidates.push(normalized.component);
				else if (normalized.rejection) rejected.push(normalized.rejection);
			}
			continue;
		}
		const ids = region.sourceComponentIds?.length
			? [...new Set(region.sourceComponentIds)]
			: [region.boxId];
		for (const componentId of ids) {
			const normalized = sourceComponentFromRegion(region, componentId, imageWidth, imageHeight);
			if (normalized.component) candidates.push(normalized.component);
			else if (normalized.rejection) rejected.push(normalized.rejection);
		}
	}
	candidates.sort((left, rightValue) =>
		left.componentId - rightValue.componentId
			|| compareStrings(componentCanonicalKey(left), componentCanonicalKey(rightValue))
	);
	const components: DetectedTextComponent[] = [];
	const countsById = new Map<number, number>();
	for (const candidate of candidates) {
		countsById.set(candidate.componentId, (countsById.get(candidate.componentId) ?? 0) + 1);
	}
	const duplicateIds = [...countsById.entries()]
		.filter(([, count]) => count > 1)
		.map(([componentId]) => componentId)
		.sort((left, rightValue) => left - rightValue);
	const duplicateIdSet = new Set(duplicateIds);
	for (const candidate of candidates) {
		// A repeated identity cannot safely select one arbitrary geometry. Reject
		// every occurrence so no detector evidence is silently overwritten.
		if (duplicateIdSet.has(candidate.componentId)) {
			rejected.push({ componentId: candidate.componentId, reason: 'duplicate-id' });
			continue;
		}
		components.push(candidate);
	}
	return {
		components,
		rejected: rejected.sort((left, rightValue) =>
			left.componentId - rightValue.componentId || compareStrings(left.reason, rightValue.reason)
		),
		duplicateIds
	};
}

function inferCuts(
	components: readonly DetectedTextComponent[],
	bubbles: readonly BubbleRegion[],
	dimension: number,
	axis: 'x' | 'y'
): number[] {
	const intervals = [
		...components.map((component) => axis === 'x'
			? [component.x, component.x + component.width] as const
			: [component.y, component.y + component.height] as const),
		...bubbles.map((bubble) => axis === 'x'
			? [bubble.x, bubble.x + bubble.width] as const
			: [bubble.y, bubble.y + bubble.height] as const)
	].filter(([start, end]) => finite(start) && finite(end) && end > start)
		.sort((left, rightValue) => left[0] - rightValue[0] || left[1] - rightValue[1]);
	if (intervals.length < 2) return [];
	const merged: Array<[number, number, number]> = [];
	for (const [start, end] of intervals) {
		const last = merged.at(-1);
		if (last && start <= last[1]) {
			last[1] = Math.max(last[1], end);
			last[2] += 1;
		} else {
			merged.push([start, end, 1]);
		}
	}
	const minimumGap = Math.max(24, dimension * 0.065);
	const cuts: number[] = [];
	for (let index = 0; index + 1 < merged.length; index += 1) {
		const gap = merged[index + 1][0] - merged[index][1];
		if (gap < minimumGap) continue;
		const leftEvidence = merged.slice(0, index + 1).reduce((sum, part) => sum + part[2], 0);
		const rightEvidence = merged.slice(index + 1).reduce((sum, part) => sum + part[2], 0);
		if (leftEvidence >= 2 && rightEvidence >= 2 || gap >= dimension * 0.12) {
			cuts.push(quantize((merged[index][1] + merged[index + 1][0]) / 2));
		}
	}
	return cuts;
}

function panelFromCuts(x: number, y: number, verticalCuts: number[], horizontalCuts: number[]): string {
	const column = verticalCuts.filter((cut) => x > cut).length;
	const row = horizontalCuts.filter((cut) => y > cut).length;
	return `inferred:${row}:${column}`;
}

function authoritativePanel(
	component: DetectedTextComponent,
	panels: readonly PPOcrPanelRegion[]
): string | undefined {
	let winner: { id: string; overlap: number; confidence: number } | undefined;
	for (const panel of panels) {
		const overlap = estimatePolygonOverlapRatio(component.polygon, panel.polygon, 9);
		if (overlap < 0.15) continue;
		const candidate = { id: panel.panelId, overlap, confidence: panel.confidence ?? 1 };
		if (!winner
			|| candidate.overlap > winner.overlap + 1e-6
			|| Math.abs(candidate.overlap - winner.overlap) <= 1e-6 && candidate.confidence > winner.confidence
			|| Math.abs(candidate.overlap - winner.overlap) <= 1e-6 && candidate.confidence === winner.confidence && candidate.id < winner.id
		) winner = candidate;
	}
	return winner?.id;
}

function assignBubble(
	component: DetectedTextComponent,
	bubbles: readonly BubbleRegion[],
	minimumOverlap: number,
	ambiguityRatio: number
): Omit<PPOcrComponentAssignment, 'componentId' | 'panelId'> {
	const candidates = bubbles.map((bubble) => ({
		bubble,
		overlap: estimatePolygonOverlapRatio(component.polygon, bubble.contour, 11),
		area: Math.max(1, polygonArea(bubble.contour))
	})).filter((candidate) => candidate.overlap >= Math.max(0.01, minimumOverlap * 0.35))
		.sort((left, rightValue) =>
			rightValue.overlap - left.overlap
				|| left.area - rightValue.area
				|| left.bubble.bubbleId - rightValue.bubble.bubbleId
		);
	const best = candidates[0];
	const second = candidates[1];
	if (!best || best.overlap < minimumOverlap) {
		return {
			overlapRatio: best?.overlap ?? 0,
			secondBestOverlapRatio: second?.overlap ?? 0,
			ambiguous: false,
			candidateBubbleIds: candidates.map((candidate) => candidate.bubble.bubbleId)
		};
	}
	const nestedScale = second ? Math.max(best.area, second.area) / Math.max(1, Math.min(best.area, second.area)) : Infinity;
	const ambiguous = Boolean(second
		&& nestedScale < 4
		&& second.overlap >= minimumOverlap
		&& second.overlap >= best.overlap * ambiguityRatio);
	return {
		bubbleId: ambiguous ? undefined : best.bubble.bubbleId,
		overlapRatio: best.overlap,
		secondBestOverlapRatio: second?.overlap ?? 0,
		ambiguous,
		candidateBubbleIds: candidates.map((candidate) => candidate.bubble.bubbleId)
	};
}

// ── Nested balloon instances ──────────────────────────────────────────────

/**
 * One balloon, two detector instances.
 *
 * rtmdet's export runs box-IoU NMS, and a lobe of a conjoined balloon has a box
 * IoU of roughly 0.3 against the whole balloon — so on a two-lobe balloon the
 * model can return the whole balloon AND one lobe, the lobe usually at a score
 * just above the 0.35 threshold. The grouper then finds every column of that
 * lobe inside two balloons of similar size, declares the assignment ambiguous
 * (`assignBubble`, nestedScale < 4), and refuses to group any of them: five
 * singletons typed `unknown`, each translated alone. Measured on a reader's
 * page 2026-08-26: whole balloon 0.89 / lobe 0.37, lobe 96% inside.
 *
 * Measured on real manga pages (136 pages, 773 balloons, wasm-960): 16
 * nested pairs with the smaller ≥ 0.9 inside the larger. In 13 the smaller is
 * the low-confidence one (0.35–0.47 — the lobe signature); in 3 the LARGER is
 * the ghost, a 0.37–0.45 blob over a cluster of real 0.53–0.59 balloons. So
 * the rule keeps the more confident instance of a nested pair, never simply
 * the larger or the smaller.
 */

/**
 * Fraction of the smaller instance that must lie inside the larger. The 16
 * corpus duplicates sit at 0.909–1.000; the two looser overlaps (0.820, 0.864)
 * were a ghost partly covering a neighbouring balloon, and those are decided
 * by the grouper's own ambiguity rule, not here.
 */
export const NESTED_BALLOON_CONTAINMENT = 0.9;

/**
 * Same bound `assignBubble` uses before it calls two enclosing balloons
 * ambiguous. Past it the grouper already prefers the inner balloon without
 * ambiguity, so a nested pair beyond this scale is a balloon drawn inside a
 * balloon, and both stay.
 */
export const NESTED_BALLOON_SCALE = 4;

const CONTAINMENT_SAMPLES_PER_AXIS = 15;

/** True when the two instances describe one balloon by the measured rule. */
export function balloonInstancesNested(left: BubbleRegion, right: BubbleRegion): boolean {
	const leftArea = Math.max(1, polygonArea(left.contour));
	const rightArea = Math.max(1, polygonArea(right.contour));
	const [smaller, larger] = leftArea <= rightArea ? [left, right] : [right, left];
	const scale = Math.max(leftArea, rightArea) / Math.min(leftArea, rightArea);
	if (scale >= NESTED_BALLOON_SCALE) return false;
	return estimatePolygonOverlapRatio(smaller.contour, larger.contour, CONTAINMENT_SAMPLES_PER_AXIS) >= NESTED_BALLOON_CONTAINMENT;
}

/**
 * Keep the more confident instance of every nested pair. Greedy in confidence
 * order (ties: larger area, then lower id), so a chain of three nested
 * instances keeps exactly the one the model believed most. Survivors keep
 * their relative order and are renumbered densely — `bubbleId === index` is
 * what the segmenters promise their consumers. The grouper passes
 * `renumber: false`: its caller keeps the full list and looks ids up in it.
 */
export function suppressNestedBalloonInstances(
	bubbles: readonly BubbleRegion[],
	options: { renumber?: boolean } = {}
): { bubbles: BubbleRegion[]; suppressed: BubbleRegion[] } {
	const byConfidence = [...bubbles].sort((left, right) =>
		right.confidence - left.confidence
			|| polygonArea(right.contour) - polygonArea(left.contour)
			|| left.bubbleId - right.bubbleId
	);
	const kept: BubbleRegion[] = [];
	const suppressed: BubbleRegion[] = [];
	for (const candidate of byConfidence) {
		if (kept.some((winner) => balloonInstancesNested(winner, candidate))) suppressed.push(candidate);
		else kept.push(candidate);
	}
	const ordered = kept.sort((left, right) => left.bubbleId - right.bubbleId);
	return {
		bubbles: options.renumber === false ? ordered : ordered.map((bubble, index) => ({ ...bubble, bubbleId: index })),
		suppressed: suppressed.sort((left, right) => left.bubbleId - right.bubbleId)
	};
}

// ── Balloon-first grouping ─────────────────────────────────────────────────

/**
 * A component at least this far inside its balloon is a MEMBER of it, and for
 * two members the balloon — not the gap rules — is the evidence that they
 * belong together: one balloon holds one speaker's words, however the
 * letterer staggered or stacked them. Below this the component is only
 * leaning into the balloon (an SFX drawn across its edge) and keeps the
 * ordinary gap rules.
 *
 * Measured on the reviewed corpus (2026-08-26, 545 labelled balloon members):
 * 504 sit at 1.0, 35 at 0.9–1.0, 4 at 0.7–0.9; the two below are a lone
 * column at 0.51 and a handwritten はぁ across a balloon's rim at 0.18 — the
 * assignment floor. Half: the balloon owns more of the box than the page does.
 */
export const BALLOON_MEMBER_OVERLAP = 0.5;

/**
 * Glyph-scale ratio two balloon members may differ by and still be one
 * utterance. Emphasis inside a balloon is set larger — a はい at 2.3× the
 * sentence under it, a shout at 2.8× — and both were split at the free-text
 * bound of 2.15. Same value as the satellite bound, which already admits a
 * fragment at this ratio.
 */
export const BALLOON_GLYPH_SCALE_RATIO = 3.5;

function rectGap(leftRect: Rect, rightRect: Rect): number {
	const dx = Math.max(leftRect.x - right(rightRect), rightRect.x - right(leftRect), 0);
	const dy = Math.max(leftRect.y - bottom(rightRect), rightRect.y - bottom(leftRect), 0);
	return Math.hypot(dx, dy);
}

function overlapLength(startA: number, endA: number, startB: number, endB: number): number {
	return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function evaluatePair(
	leftComponent: PreparedComponent,
	rightComponent: PreparedComponent,
	medianArea: number
): { score: number | null; reason?: PPOcrSeparationReason['reason']; satellite: boolean } {
	if (leftComponent.panelId !== rightComponent.panelId) {
		return { score: null, reason: 'panel', satellite: false };
	}
	if (leftComponent.bubbleId !== rightComponent.bubbleId) {
		return { score: null, reason: 'bubble-owner', satellite: false };
	}
	if (leftComponent.bubbleAssignmentAmbiguous || rightComponent.bubbleAssignmentAmbiguous) {
		return { score: null, reason: 'ambiguous-bubble', satellite: false };
	}
	// Same balloon (established above), both well inside it: the balloon says
	// these belong together. Direction, orientation and the column pitch still
	// apply — two speakers sharing a conjoined balloon sit a full pitch apart
	// (measured 2.93 glyphs against a within-utterance maximum of 1.75) — but
	// a column may start below where its neighbour ended, and may be set larger.
	// A component only leaning into the balloon (see `BALLOON_MEMBER_OVERLAP`)
	// never joins its members: the gap rules cannot tell a sigh drawn across
	// the rim from the column beside it, and the overlap is the one measurement
	// that can.
	const leftMember = leftComponent.bubbleId !== undefined && leftComponent.bubbleOverlap >= BALLOON_MEMBER_OVERLAP;
	const rightMember = rightComponent.bubbleId !== undefined && rightComponent.bubbleOverlap >= BALLOON_MEMBER_OVERLAP;
	if (leftMember !== rightMember) return { score: null, reason: 'balloon-rim', satellite: false };
	const sharedBalloon = leftMember && rightMember;
	const leftSatellite = leftComponent.area < medianArea * 0.34
		|| leftComponent.area < rightComponent.area * 0.42
			&& Math.max(leftComponent.width, leftComponent.height)
				< Math.max(rightComponent.width, rightComponent.height) * 0.52;
	const rightSatellite = rightComponent.area < medianArea * 0.34
		|| rightComponent.area < leftComponent.area * 0.42
			&& Math.max(rightComponent.width, rightComponent.height)
				< Math.max(leftComponent.width, leftComponent.height) * 0.52;
	const satellite = leftSatellite || rightSatellite;
	const directionsCompatible = leftComponent.direction === rightComponent.direction
		|| leftComponent.direction === 'ambiguous'
		|| rightComponent.direction === 'ambiguous';
	if (!directionsCompatible && !satellite) return { score: null, reason: 'direction', satellite };
	const orientationDelta = angleDistance(leftComponent.orientationDegrees, rightComponent.orientationDegrees);
	if (orientationDelta > (satellite ? 42 : leftComponent.bubbleId === undefined ? 20 : 30)) {
		return { score: null, reason: 'orientation', satellite };
	}
	const scaleRatio = Math.max(leftComponent.glyphScale, rightComponent.glyphScale)
		/ Math.max(1, Math.min(leftComponent.glyphScale, rightComponent.glyphScale));
	const xGap = Math.max(leftComponent.x - right(rightComponent), rightComponent.x - right(leftComponent), 0);
	const yGap = Math.max(leftComponent.y - bottom(rightComponent), rightComponent.y - bottom(leftComponent), 0);
	const effectiveDirection = leftComponent.direction === 'ambiguous' ? rightComponent.direction : leftComponent.direction;
	const primaryAxisGap = effectiveDirection === 'vertical'
		? yGap
		: effectiveDirection === 'horizontal'
			? xGap
			: rectGap(leftComponent, rightComponent);
	if (
		leftComponent.bubbleId === undefined
		&& rightComponent.bubbleId === undefined
		&& satellite
		&& scaleRatio > 2
		&& primaryAxisGap > Math.min(leftComponent.glyphScale, rightComponent.glyphScale) * 1.5
	) {
		return { score: null, reason: 'free-satellite-span', satellite };
	}
	if (scaleRatio > (satellite ? 3.5 : sharedBalloon ? BALLOON_GLYPH_SCALE_RATIO : leftComponent.bubbleId === undefined ? 1.75 : 2.15)) {
		return { score: null, reason: 'glyph-scale', satellite };
	}
	const glyph = median([leftComponent.glyphScale, rightComponent.glyphScale]);
	const xOverlap = overlapLength(leftComponent.x, right(leftComponent), rightComponent.x, right(rightComponent));
	const yOverlap = overlapLength(leftComponent.y, bottom(leftComponent), rightComponent.y, bottom(rightComponent));
	const xOverlapRatio = xOverlap / Math.max(1, Math.min(leftComponent.width, rightComponent.width));
	const yOverlapRatio = yOverlap / Math.max(1, Math.min(leftComponent.height, rightComponent.height));
	let geometricMatch = false;
	if (effectiveDirection === 'vertical') {
		const sameColumn = xOverlapRatio >= 0.3 && yGap <= glyph * 2.5;
		// A staggered column — the next one starting below where this one ends,
		// following the balloon's curve — overlaps its neighbour in x-pitch but
		// not in y. Seven of the 31 split balloons on a reader's device were this.
		const adjacentColumn = (yOverlapRatio >= 0.12 || sharedBalloon) && xGap <= glyph * 2.1;
		geometricMatch = sameColumn || adjacentColumn;
	} else if (effectiveDirection === 'horizontal') {
		const sameLine = yOverlapRatio >= 0.3 && xGap <= glyph * 2.5;
		const adjacentLine = (xOverlapRatio >= 0.12 || sharedBalloon) && yGap <= glyph * 1.9;
		geometricMatch = sameLine || adjacentLine;
	} else {
		geometricMatch = rectGap(leftComponent, rightComponent) <= glyph * 1.8;
	}
	if (!geometricMatch && satellite) {
		geometricMatch = rectGap(leftComponent, rightComponent) <= glyph * 2.2;
	}
	if (!geometricMatch) return { score: null, reason: 'geometry', satellite };
	const distance = Math.hypot(
		leftComponent.centerX - rightComponent.centerX,
		leftComponent.centerY - rightComponent.centerY
	) / Math.max(1, glyph);
	return {
		score: quantize(distance + orientationDelta / 45 + Math.log2(Math.max(1, scaleRatio))),
		satellite
	};
}

function unionBounds(components: readonly PreparedComponent[]): Rect {
	const x = Math.min(...components.map((component) => component.x));
	const y = Math.min(...components.map((component) => component.y));
	const x2 = Math.max(...components.map((component) => component.x + component.width));
	const y2 = Math.max(...components.map((component) => component.y + component.height));
	return { x, y, width: x2 - x, height: y2 - y };
}

function dominantComponentDirection(components: readonly PreparedComponent[]): PPOcrGroupDirection {
	const weighted = new Map<PPOcrGroupDirection, number>();
	for (const component of components) {
		weighted.set(component.direction, (weighted.get(component.direction) ?? 0) + component.area);
	}
	const ordered = [...weighted.entries()].sort((left, rightValue) =>
		rightValue[1] - left[1] || compareStrings(left[0], rightValue[0])
	);
	if (!ordered[0]) return 'ambiguous';
	if (ordered[0][0] === 'ambiguous' && ordered[1]) return ordered[1][0];
	return ordered[0][0];
}

function localeExplicitlyUsesCjkVerticalText(locale?: string): boolean {
	const language = locale?.trim().toLowerCase().split(/[-_]/u)[0];
	return language === 'ja' || language === 'zh' || language === 'ko';
}

/**
 * PP-OCR occasionally cuts outlined vertical manga copy into overlapping
 * horizontal strips. Reclassify only that high-margin shape as a vertical
 * semantic block. The explicit-locale, free-text, overlap, alignment, and
 * extent gates keep ordinary multiline dialogue on the existing path.
 */
function looksLikeStackedHorizontalCjkBlock(
	components: readonly PreparedComponent[],
	locale?: string
): boolean {
	if (!localeExplicitlyUsesCjkVerticalText(locale) || components.length < 5) return false;
	if (components.some((component) =>
		component.direction !== 'horizontal'
			|| component.bubbleId !== undefined
			|| component.bubbleAssignmentAmbiguous
			|| Math.abs(normalizeAngle(component.orientationDegrees)) > 15
	)) return false;

	const bounds = unionBounds(components);
	const medianHeight = median(components.map((component) => component.height));
	const medianWidth = median(components.map((component) => component.width));
	if (medianHeight <= 0
		|| medianWidth < medianHeight * 1.75
		|| bounds.height < bounds.width * 1.35
		|| bounds.height < medianHeight * 3.5
	) return false;

	const ordered = [...components].sort((left, rightValue) =>
		left.centerY - rightValue.centerY
			|| left.centerX - rightValue.centerX
			|| left.componentId - rightValue.componentId
	);
	const centerXs = ordered.map((component) => component.centerX);
	if (Math.max(...centerXs) - Math.min(...centerXs) > medianHeight * 0.55) return false;

	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		const centerAdvance = current.centerY - previous.centerY;
		const xOverlapRatio = overlapLength(
			previous.x,
			right(previous),
			current.x,
			right(current)
		) / Math.max(1, Math.min(previous.width, current.width));
		const yOverlapRatio = overlapLength(
			previous.y,
			bottom(previous),
			current.y,
			bottom(current)
		) / Math.max(1, Math.min(previous.height, current.height));
		if (centerAdvance < medianHeight * 0.35
			|| centerAdvance > medianHeight * 0.95
			|| xOverlapRatio < 0.72
			|| yOverlapRatio < 0.18
		) return false;
	}
	return true;
}

/**
 * Two rows of vertical columns in one balloon are one utterance, read row by
 * row.
 *
 * A right-to-left sweep across a balloon with a second row of columns below
 * the first interleaves the two sentences. A row break is visible in the
 * geometry: a horizontal line that crosses no column, with columns on both
 * sides, and a gap wider than any column-cut. Measured (2026-08-26): every
 * detector column-cut on the cached real pages (45 pages, 186 multi-column
 * balloons) is a punctuation gap of 0.25–0.5 glyph, and none of the 36
 * single-utterance balloons in the labelled real-page set has such a line at
 * all; stacked rows measure 1.20 (set-7/1), 1.27, 1.37, 1.47 (a reader's
 * pages) and 1.93 (a reviewed page). Plateau 0.5–1.2, value mid-plateau.
 *
 * This decides ORDER, never membership: the rows stayed one group in every
 * reviewed label (the balloon on a reviewed page holds two rows of one
 * speech; 声♥ over 丸聞こえだったから is one sentence across two lobes), and a
 * split here — shipped for one day — cut them into boxes that fought for the
 * balloon.
 */
export const COLUMN_ROW_GAP_GLYPHS = 0.85;

/**
 * The widest horizontal line through the cluster that crosses no column, in
 * glyph units; 0 when every partition by top edge is crossed by some column.
 */
export function widestColumnRowGap(components: readonly Rect[], glyph: number): number {
	if (components.length < 2) return 0;
	const byTop = [...components].sort((left, rightValue) => left.y - rightValue.y || left.x - rightValue.x);
	let widest = 0;
	let upperBottom = -Infinity;
	for (let split = 1; split < byTop.length; split += 1) {
		upperBottom = Math.max(upperBottom, bottom(byTop[split - 1]));
		const lowerTop = Math.min(...byTop.slice(split).map((component) => component.y));
		if (lowerTop > upperBottom) widest = Math.max(widest, (lowerTop - upperBottom) / Math.max(1, glyph));
	}
	return widest;
}

/**
 * Row index of each component (input order), rows separated by a clean
 * horizontal line at least `COLUMN_ROW_GAP_GLYPHS` wide.
 */
export function columnRowOf(components: readonly Rect[], glyph: number): number[] {
	const order = components.map((_, index) => index)
		.sort((left, rightValue) => components[left].y - components[rightValue].y || components[left].x - components[rightValue].x);
	const rowOf = new Array<number>(components.length).fill(0);
	let row = 0;
	let upperBottom = -Infinity;
	for (let position = 0; position < order.length; position += 1) {
		const component = components[order[position]];
		if (position > 0 && component.y - upperBottom >= COLUMN_ROW_GAP_GLYPHS * Math.max(1, glyph)) row += 1;
		rowOf[order[position]] = row;
		upperBottom = Math.max(upperBottom, bottom(component));
	}
	return rowOf;
}

function clusterValid(
	components: readonly PreparedComponent[],
	imageWidth: number,
	imageHeight: number
): { valid: boolean; reason?: PPOcrSeparationReason['reason'] } {
	if (components.length <= 1) return { valid: true };
	const bounds = unionBounds(components);
	const componentArea = components.reduce((sum, component) => sum + component.area, 0);
	const fillRatio = componentArea / Math.max(1, area(bounds));
	// Cluster admission deliberately uses only detector-level direction. The
	// semantic stacked-strip correction runs after grouping, so it cannot alter
	// which source components merge.
	const direction = dominantComponentDirection(components);
	const glyph = median(components.map((component) => component.glyphScale));
	const orientations = components
		.filter((component) => component.direction !== 'ambiguous')
		.map((component) => component.orientationDegrees);
	const spread = orientations.length < 2
		? 0
		: Math.max(...orientations.map((angle) => angleDistance(angle, orientations[0])));
	if (spread > 36) return { valid: false };
	const bubbleId = components[0].bubbleId;
	if (bubbleId !== undefined) {
		// A balloon's text is bounded by the balloon; the only cluster guard is
		// against a sparse snowball. There is deliberately no cap on how much
		// of the balloon's bounding box the text may fill: detector boxes
		// overhang the contour, and on a reader's device 11 small balloons whose
		// two columns filled 0.96–1.15 of the box were cut in two by one.
		if (fillRatio < 0.025) return { valid: false };
	} else {
		if (area(bounds) > imageWidth * imageHeight * 0.08) return { valid: false };
		if (fillRatio < 0.085) return { valid: false };
	}
	// The span cap is the one rejection that can cut ONE utterance in two, so
	// it applies to free text only: a balloon of thirteen columns is still one
	// sentence, and the balloon itself bounds the cluster. Reported by name so
	// the halves can be marked as continuing each other downstream.
	if (bubbleId === undefined) {
		if (direction === 'horizontal' && bounds.height > Math.max(glyph * 8.5, imageHeight * 0.22)) return { valid: false, reason: 'span-cap' };
		if (direction === 'vertical' && bounds.width > Math.max(glyph * 8.5, imageWidth * 0.22)) return { valid: false, reason: 'span-cap' };
	}

	// A punctuation/ruby fragment may attach to a nearby core, but it must not
	// become a transitive bridge between two body-text islands that are not
	// themselves locally compatible.
	const maximumArea = Math.max(...components.map((component) => component.area));
	const cores = components.filter((component) => component.area >= maximumArea * 0.45);
	if (cores.length > 1) {
		const visited = new Set<number>([0]);
		const queue = [0];
		const coreMedianArea = median(cores.map((component) => component.area));
		while (queue.length) {
			const index = queue.shift()!;
			for (let other = 0; other < cores.length; other += 1) {
				if (visited.has(other)) continue;
				if (evaluatePair(cores[index], cores[other], coreMedianArea).score === null) continue;
				visited.add(other);
				queue.push(other);
			}
		}
		if (visited.size !== cores.length) {
			return {
				valid: false,
				reason: bubbleId === undefined ? 'free-satellite-span' : undefined
			};
		}
	}
	return { valid: true };
}

/**
 * Reading order within one group. Vertical text reads columns right to left
 * and rows of columns top to bottom (`COLUMN_ROW_GAP_GLYPHS`); horizontal and
 * rotated text keep the plain sweep.
 */
function orderComponentsForReading(
	cluster: readonly PreparedComponent[],
	direction: PPOcrGroupDirection,
	angle: number
): PreparedComponent[] {
	const sweep = componentReadingOrder(direction, angle);
	if (direction !== 'vertical' || cluster.length < 2) return [...cluster].sort(sweep);
	const rows = columnRowOf(cluster, median(cluster.map((component) => component.glyphScale)));
	const rowByIndex = new Map(cluster.map((component, index) => [component, rows[index]]));
	return [...cluster].sort((left, rightValue) =>
		rowByIndex.get(left)! - rowByIndex.get(rightValue)! || sweep(left, rightValue));
}

function componentReadingOrder(direction: PPOcrGroupDirection, angle: number) {
	return (left: PreparedComponent, rightValue: PreparedComponent): number => {
		if (direction === 'vertical') {
			return rightValue.centerX - left.centerX
				|| left.centerY - rightValue.centerY
				|| left.componentId - rightValue.componentId;
		}
		if (direction === 'rotated') {
			const radians = angle * Math.PI / 180;
			const leftProjection = left.centerX * Math.cos(radians) + left.centerY * Math.sin(radians);
			const rightProjection = rightValue.centerX * Math.cos(radians) + rightValue.centerY * Math.sin(radians);
			return leftProjection - rightProjection || left.componentId - rightValue.componentId;
		}
		return left.centerY - rightValue.centerY
			|| left.centerX - rightValue.centerX
			|| left.componentId - rightValue.componentId;
	};
}

function initialClassification(
	group: PPOcrTextGroup,
	imageWidth: number,
	imageHeight: number,
	medianGlyph: number,
	nearestInGlyphs: number
): PPOcrTextClassification {
	if (group.inBubble) return { kind: 'speech', confidence: 0.99, reasons: ['bubble-overlap'] };
	const glyphRatio = group.trace.glyphScale / Math.max(1, medianGlyph);
	// A ±90° principal axis is normal evidence for a vertical Japanese column,
	// not proof of rotated display lettering/SFX.
	const rotation = group.direction === 'vertical' ? 0 : Math.abs(group.orientationDegrees ?? 0);
	const pageShortEdge = Math.max(1, Math.min(imageWidth, imageHeight));
	const edgeDistance = Math.min(group.x, group.y, imageWidth - right(group), imageHeight - bottom(group));
	const edgeRatio = edgeDistance / pageShortEdge;
	const regular = group.trace.orientationSpread <= 10;
	const aspect = Math.max(group.width / Math.max(1, group.height), group.height / Math.max(1, group.width));
	const componentCount = group.componentIds.length;
	group.trace.glyphScaleRatio = quantize(glyphRatio);
	group.trace.edgeDistanceRatio = quantize(edgeRatio);
	group.trace.nearestGroupDistanceInGlyphs = quantize(nearestInGlyphs);
	if (rotation >= 18 && glyphRatio >= 1.15
		|| glyphRatio >= 2.1 && (componentCount === 1 || group.trace.fillRatio < 0.28)) {
		return { kind: 'sfx', confidence: rotation >= 20 ? 0.82 : 0.72, reasons: ['display-scale-and-rotation'] };
	}
	if (regular && edgeRatio <= 0.065 && (componentCount >= 2 || aspect >= 2.8) && glyphRatio <= 1.55) {
		return { kind: 'narration', confidence: 0.78, reasons: ['regular-panel-edge-block'] };
	}
	if (regular && group.direction === 'horizontal' && componentCount <= 3 && aspect >= 2.5
		&& nearestInGlyphs >= 2.5 && glyphRatio <= 1.45) {
		return { kind: 'sign', confidence: 0.68, reasons: ['isolated-regular-wide-text'] };
	}
	if (regular && componentCount >= 2 && group.trace.fillRatio >= 0.16) {
		return { kind: 'borderless', confidence: 0.66, reasons: ['regular-unenclosed-text-block'] };
	}
	return { kind: 'unknown', confidence: 0.45, reasons: ['insufficient-class-margin'] };
}

function nearestGroupDistances(groups: readonly PPOcrTextGroup[], medianGlyph: number): Map<string, number> {
	const cellSize = Math.max(16, medianGlyph * 6);
	const buckets = new Map<string, PPOcrTextGroup[]>();
	const cell = (group: PPOcrTextGroup): [number, number] => [
		Math.floor(centerX(group) / cellSize),
		Math.floor(centerY(group) / cellSize)
	];
	for (const group of groups) {
		const [column, row] = cell(group);
		const key = `${group.panelId ?? 'page'}:${column}:${row}`;
		const bucket = buckets.get(key) ?? [];
		bucket.push(group);
		buckets.set(key, bucket);
	}
	const distances = new Map<string, number>();
	for (const group of groups) {
		const [column, row] = cell(group);
		let nearest = 99;
		for (let y = row - 1; y <= row + 1; y += 1) {
			for (let x = column - 1; x <= column + 1; x += 1) {
				const candidates = buckets.get(`${group.panelId ?? 'page'}:${x}:${y}`) ?? [];
				for (const candidate of candidates) {
					if (candidate.id === group.id) continue;
					nearest = Math.min(
						nearest,
						rectGap(group, candidate) / Math.max(1, group.trace.glyphScale)
					);
				}
			}
		}
		distances.set(group.id, quantize(nearest));
	}
	return distances;
}

function looksLexicallyLikeSfx(text: string): boolean {
	const compact = text.replace(/\s+/gu, '');
	if (!compact || compact.length > 16) return false;
	const kanaDominant = /^[\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヵヶ゛゜!?！？…・]+$/u.test(compact);
	const soundMarkers = /ッ|ー{2,}|(.)\1|[!！?？]{2,}/u.test(compact);
	return kanaDominant && soundMarkers;
}

function lexicalPriceSignEvidence(text: string): 'currency' | 'bare-numeric' | null {
	const compact = text.replace(/\s+/gu, '');
	if (/^(?:[¥￥$€£₩]\p{N}{1,9}(?:[.,]\p{N}{1,2})?|\p{N}{1,9}(?:[.,]\p{N}{1,2})?(?:円|ドル|ユーロ|ポンド|ウォン))$/u.test(compact)) {
		return 'currency';
	}
	return /^\p{N}{4,9}$/u.test(compact) ? 'bare-numeric' : null;
}

function isJapaneseLocale(locale?: string): boolean {
	return locale?.toLowerCase() === 'ja' || locale?.toLowerCase().startsWith('ja-') === true;
}

/**
 * These lexical checks are trace features, not standalone classification
 * rules. A short all-Han phrase can be a name, a sign, or dialogue; recording
 * that ambiguity is useful while promoting it to narration would be unsafe.
 */
function looksLikeJapaneseDateLabel(text: string, locale?: string): boolean {
	if (!isJapaneseLocale(locale)) return false;
	const compact = text.replace(/\s+/gu, '');
	return /^(?:今日|昨日|一昨日|明日|翌日|先日|今朝|今夜|翌朝|翌晩)$/u.test(compact)
		|| /^(?:\p{N}{1,4}年)?\p{N}{1,2}月\p{N}{1,2}日$/u.test(compact);
}

function looksLikeJapaneseCharacterName(text: string, locale?: string): boolean {
	if (!isJapaneseLocale(locale)) return false;
	const compact = text.replace(/\s+/gu, '');
	return /^\p{Script=Han}{2,6}$/u.test(compact)
		&& !looksLikeJapaneseDateLabel(compact, locale);
}

/**
 * Credit/meta lexicon: copyright marks, social handles, URLs, storefront
 * names, and Japanese staff-credit prefixes. Authorship metadata, not story
 * text — recognizing it is the first line of defense against providers
 * fabricating dialogue for garbage OCR of margin credits (report T5).
 */
function looksLikeCreditText(text: string): boolean {
	const compact = text.replace(/\s+/gu, '');
	if (!compact) return false;
	return /[©℗®™]/u.test(compact)
		|| /\(c\)/iu.test(compact)
		|| /@[A-Za-z0-9_]{3,}/u.test(compact)
		|| /(?:https?:\/\/|www\.|\.com\b|\.net\b|\.jp\b)/iu.test(compact)
		|| /(?:pixiv|fanbox|patreon|dlsite|melonbooks|comiket|とらのあな)/iu.test(compact)
		|| (compact.length <= 24
			&& /^(?:作画|原作|原案|漫画|イラスト|挿絵|著者?|編集|協力|翻訳|デザイン|発行)[:：・]?/u.test(compact));
}

/** Page markers: P.12, -12-, 12/200, or a bare small numeral. */
function looksLikePageMarker(text: string): boolean {
	const compact = text.replace(/\s+/gu, '');
	return /^(?:[Pp]\.?\p{N}{1,4}|[-‐–—ー]\p{N}{1,4}[-‐–—ー]|\p{N}{1,4}\/\p{N}{1,4}|\p{N}{1,3})$/u.test(compact);
}

/** Counter/measurement captions: 47reps, 60kg, 300kcal, 10回, 3セット… */
function looksLikeCounterOrMeasurement(text: string): boolean {
	const compact = text.replace(/\s+/gu, '');
	return /^\p{N}{1,4}(?:reps?|kg|kcal|cal|cm|mm|km|lbs?|sets?|min|sec|hrs?|回|本|組|周|秒|分|時間|キロ|セット)$/iu.test(compact);
}

const COUNTER_UNIT_TOKEN = /\p{N}{1,4}(?:reps?|kg|kcal|cal|cm|mm|km|lbs?|sets?|min|sec|hrs?|回|本|組|周|秒|分|時間|キロ|セット)/iu;

/**
 * A counter token merged with stray code fragments and/or a signature — the
 * live T5 case was a "47reps" badge grouped with the artist name into
 * "7 reps 47r あちゆむち". The discriminator against real dialogue that
 * merely mentions a quantity ("あと10kgがんばる"): after removing the
 * counter token, credit-mix remainders still contain latin/digit debris,
 * while natural Japanese prose does not; punctuation always bails.
 */
function looksLikeCounterCreditMix(text: string): boolean {
	const compact = text.replace(/\s+/gu, '');
	if (!compact || compact.length > 20) return false;
	if (/[。、！？!?…]/u.test(compact)) return false;
	if (!COUNTER_UNIT_TOKEN.test(compact)) return false;
	const remainder = compact.replace(COUNTER_UNIT_TOKEN, '');
	if (remainder.length === 0) return false; // pure counter → looksLikeCounterOrMeasurement
	if (!/[A-Za-z\p{N}]/u.test(remainder)) return false; // no code-like debris → prose
	return /^[\p{Script=Hiragana}\p{Script=Katakana}A-Za-z\p{N}ー・.]*$/u.test(remainder);
}

function finalizeRecognizedClassification(
	priorKind: DetectedTextGroupKind,
	kind: DetectedTextGroupKind,
	confidence: number,
	reasons: readonly string[],
	evidence: Omit<
		PPOcrTextClassificationDiagnostics,
		'priorKind' | 'finalKind' | 'transition'
	>
): PPOcrTextClassification {
	const transition = `${priorKind}->${kind}` as PPOcrTextClassificationTransition;
	const evidenceReasons = [
		...(evidence.framedCaption ? ['evidence-framed-caption'] : []),
		...(evidence.unframedExposition ? ['evidence-unframed-exposition'] : []),
		...(evidence.dateLabelLike ? ['evidence-date-label-like'] : []),
		...(evidence.characterNameLike ? ['evidence-character-name-like'] : []),
		...(evidence.profileBlockLike ? ['evidence-profile-block-like'] : []),
		`evidence-frame-${evidence.frameEvidence}`,
		`evidence-panel-edge-${evidence.panelEdgeEvidence}`,
		`evidence-background-${evidence.backgroundEvidence}`,
		`classification-prior-${priorKind}`,
		`classification-final-${kind}`,
		`classification-transition-${priorKind}-to-${kind}`
	];
	return {
		kind,
		confidence,
		reasons: [...new Set([...reasons, ...evidenceReasons])],
		diagnostics: {
			priorKind,
			finalKind: kind,
			transition,
			...evidence
		}
	};
}

export function classifyRecognizedTextGroup(
	group: PPOcrTextGroup,
	text: string,
	context: TextGroupClassificationContext = {}
): PPOcrTextClassification {
	const priorKind = group.groupKind ?? 'unknown';
	const dateLabelLike = looksLikeJapaneseDateLabel(text, context.locale);
	const characterNameLike = looksLikeJapaneseCharacterName(text, context.locale);
	if (group.inBubble) {
		const kind = context.targetKindHint === 'thought' ? 'thought' : 'speech';
		return finalizeRecognizedClassification(
			priorKind,
			kind,
			kind === 'thought' ? 0.82 : 0.99,
			kind === 'thought'
				? ['bubble-overlap', 'provider-thought-hint']
				: ['bubble-overlap'],
			{
				framedCaption: false,
				unframedExposition: false,
				dateLabelLike,
				characterNameLike,
				profileBlockLike: false,
				frameEvidence: 'unavailable',
				panelEdgeEvidence: 'unavailable',
				backgroundEvidence: 'unavailable'
			}
		);
	}
	const geometryKind = priorKind;
	const glyphRatio = group.trace.glyphScale
		/ Math.max(1, context.pageMedianGlyphHeight ?? group.trace.glyphScale);
	const rotation = group.direction === 'vertical'
		? 0
		: Math.abs(normalizeAngle(group.orientationDegrees ?? 0));
	const uniformity = clamp(context.backgroundUniformity ?? 0.5, 0, 1);
	const edgeDensity = clamp(context.localEdgeDensity ?? 0.3, 0, 1);
	const framed = context.hasRectangularFrame === true;
	const panelShortEdge = Math.max(1, Math.min(
		context.panelBounds?.width ?? context.imageWidth ?? 1_000,
		context.panelBounds?.height ?? context.imageHeight ?? 1_400
	));
	const distanceToPanelEdge = context.distanceToPanelEdge ?? panelShortEdge * 0.25;
	const nearPanelEdge = distanceToPanelEdge <= Math.max(
		(context.pageMedianGlyphHeight ?? group.trace.glyphScale) * 2.8,
		panelShortEdge * 0.08
	);
	const displayGeometry = rotation >= 18 || glyphRatio >= 2.2;
	const texturedBackground = uniformity <= 0.42 || edgeDensity >= 0.52;
	const lexicalSfx = looksLexicallyLikeSfx(text);
	const priceSignEvidence = lexicalPriceSignEvidence(text);
	const regularGeometry = rotation < 10
		&& glyphRatio <= 1.55
		&& group.trace.orientationSpread <= 10;
	const profileBlockLike = !framed
		&& regularGeometry
		&& group.direction === 'vertical'
		&& group.componentIds.length >= 3
		&& !lexicalSfx;
	const framedCaption = framed
		&& nearPanelEdge
		&& rotation < 10
		&& uniformity >= 0.68
		&& edgeDensity <= 0.32;
	const unframedExposition = !framed
		&& regularGeometry
		&& (dateLabelLike
			|| characterNameLike
			|| profileBlockLike
			|| geometryKind === 'narration');
	const frameEvidence: PPOcrTextClassificationDiagnostics['frameEvidence'] =
		context.hasRectangularFrame === undefined
			? 'unavailable'
			: framed ? 'present' : 'absent';
	const panelEdgeEvidence: PPOcrTextClassificationDiagnostics['panelEdgeEvidence'] =
		context.distanceToPanelEdge === undefined && context.panelBounds === undefined
			? 'unavailable'
			: nearPanelEdge ? 'near' : 'interior';
	const backgroundEvidence: PPOcrTextClassificationDiagnostics['backgroundEvidence'] =
		context.backgroundUniformity === undefined && context.localEdgeDensity === undefined
			? 'unavailable'
			: texturedBackground
				? 'textured'
				: uniformity >= 0.68 && edgeDensity <= 0.32
					? 'regular'
					: 'mixed';
	const finish = (
		kind: DetectedTextGroupKind,
		confidence: number,
		reasons: readonly string[]
	): PPOcrTextClassification => finalizeRecognizedClassification(
		geometryKind,
		kind,
		confidence,
		reasons,
		{
			framedCaption,
			unframedExposition,
			dateLabelLike,
			characterNameLike,
			profileBlockLike,
			frameEvidence,
			panelEdgeEvidence,
			backgroundEvidence
		}
	);

	// Non-dialogue meta text (credits, page markers, rep counters) must never
	// become *required* translation coverage: its OCR is usually garbage and
	// demanding a translation invites fabricated dialogue (report T5,
	// live-confirmed). Credit lexicon is unambiguous alone; bare numerals and
	// counters additionally need margin placement or caption geometry so
	// in-panel story text is never demoted.
	const creditLike = looksLikeCreditText(text);
	const pageMarkerLike = looksLikePageMarker(text)
		&& nearPanelEdge && !framed && rotation < 10 && glyphRatio <= 1.4;
	const counterLike = looksLikeCounterOrMeasurement(text)
		&& regularGeometry && !framed;
	// Lexical-only: the code-debris requirement inside the detector already
	// separates badges/signatures from prose, and panel-edge data proved
	// unavailable for exactly this case in live testing.
	const counterMixLike = looksLikeCounterCreditMix(text);
	if (creditLike || pageMarkerLike || counterLike || counterMixLike) {
		return finish('unknown', 0.85, [
			'non-dialogue-meta',
			...(creditLike ? ['credit-lexicon'] : []),
			...(pageMarkerLike ? ['page-marker-lexicon', 'panel-edge-placement'] : []),
			...(counterLike ? ['counter-lexicon'] : []),
			...(counterMixLike ? ['counter-credit-mix', 'panel-edge-placement'] : [])
		]);
	}

	// Explicit currency syntax is strong sign evidence. Bare digits are not:
	// years, dates, room numbers, and character profiles are common manga copy.
	// Keep the historical OCR-rescue case only when independent object/display
	// geometry corroborates it, and never override a narration prior.
	const corroboratedBareNumericSign = priceSignEvidence === 'bare-numeric'
		&& displayGeometry
		&& texturedBackground
		&& !framed
		&& !nearPanelEdge
		&& geometryKind !== 'narration';
	if (priceSignEvidence === 'currency' || corroboratedBareNumericSign) {
		return finish('sign', 0.82, ['lexical-currency-or-numeric-sign', 'free-text-placement']);
	}
	if (displayGeometry && texturedBackground && !framed
		&& geometryKind !== 'narration'
		&& geometryKind !== 'borderless'
		&& priceSignEvidence !== 'bare-numeric'
	) {
		return finish(
			'sfx',
			lexicalSfx ? 0.93 : 0.78,
			[
				rotation >= 18 ? 'rotated-display-geometry' : 'large-display-scale',
				'textured-background',
				...(lexicalSfx ? ['lexical-sfx-support'] : [])
			]
		);
	}
	if (framedCaption) {
		return finish('narration', 0.84, ['caption-frame', 'panel-edge-placement', 'regular-background']);
	}
	if (framed && (!nearPanelEdge || rotation >= 8)) {
		return finish(
			'sign',
			0.76,
			[
				'sign-or-object-frame',
				...(rotation >= 8 ? ['rotated-object-text'] : ['interior-object-placement'])
			]
		);
	}
	if (geometryKind !== 'narration'
		&& !framed && rotation < 8 && uniformity >= 0.72 && edgeDensity <= 0.18 && !nearPanelEdge
	) {
		return finish(
			'borderless',
			lexicalSfx ? 0.62 : 0.65,
			['unframed-floating-text', 'regular-low-edge-background']
		);
	}
	if (context.targetKindHint && context.targetKindHint !== 'speech' && context.targetKindHint !== 'thought') {
		const confidence = context.targetKindHint === geometryKind ? 0.9 : 0.7;
		return finish(
			context.targetKindHint,
			confidence,
			context.targetKindHint === geometryKind
				? ['geometry-provider-agreement']
				: ['provider-semantic-hint']
		);
	}
	// The geometry policy's regular narration/borderless decisions have a much
	// higher precision margin than free-form SFX guesses. Missing a strict pixel
	// threshold is absence of corroboration, not contradictory evidence, so keep
	// those regular labels unless one of the strong visual branches above won.
	// This prevents recognition from erasing ordinary readable text merely
	// because its background is neither uniformly blank nor strongly textured.
	if ((geometryKind === 'narration' || geometryKind === 'borderless')
		&& (group.classificationConfidence ?? 0) >= 0.65
	) {
		return finish(
			geometryKind,
			geometryKind === 'narration' ? 0.7 : 0.6,
			['regular-geometry-retained', 'no-strong-visual-contradiction']
		);
	}
	// SFX and sign guesses retain the stricter evidence requirement: they are
	// visually diverse and must not become a source of regular-text regressions.
	return geometryKind === 'sfx' && displayGeometry && lexicalSfx
		? finish('sfx', 0.7, ['weak-display-geometry', 'lexical-sfx-support'])
		: finish('unknown', 0.42, ['conflicting-or-insufficient-free-text-evidence']);
}

export function groupRawTextComponents(
	rawRegions: readonly DetectedTextRegion[],
	bubbleInput: readonly BubbleRegion[],
	imageWidth: number,
	imageHeight: number,
	options: PPOcrGroupingOptions = {}
): PPOcrGroupingResult {
	throwIfGroupingCancelled(options.signal);
	const inputComponentCount = declaredComponentCount(rawRegions);
	if (inputComponentCount > MAX_PPOCR_GROUPING_COMPONENTS) {
		throw new PPOcrGroupingInputLimitError('components', inputComponentCount, MAX_PPOCR_GROUPING_COMPONENTS);
	}
	if (bubbleInput.length > MAX_PPOCR_GROUPING_BUBBLES) {
		throw new PPOcrGroupingInputLimitError('bubbles', bubbleInput.length, MAX_PPOCR_GROUPING_BUBBLES);
	}
	if ((options.panels?.length ?? 0) > MAX_PPOCR_GROUPING_PANELS) {
		throw new PPOcrGroupingInputLimitError('panels', options.panels!.length, MAX_PPOCR_GROUPING_PANELS);
	}
	assertUniqueGroupingIdentities(bubbleInput, options.panels ?? []);
	// A second instance of a balloon it already has is what the segmenters drop;
	// cached and replayed inputs reach here without them, so drop it again. Ids
	// are the caller's — never renumbered here.
	const bubbles = suppressNestedBalloonInstances(bubbleInput, { renumber: false }).bubbles;
	const minimumOverlap = options.minimumBubbleOverlap ?? 0.18;
	const ambiguityRatio = options.ambiguityRatio ?? 0.82;
	const readingDirection = options.readingDirection ?? 'rtl';
	const { components, rejected, duplicateIds } = flattenComponents(rawRegions, imageWidth, imageHeight);
	throwIfGroupingCancelled(options.signal);
	const verticalCuts = options.panels?.length ? [] : inferCuts(components, bubbles, imageWidth, 'x');
	const horizontalCuts = options.panels?.length ? [] : inferCuts(components, bubbles, imageHeight, 'y');
	const assignments: PPOcrComponentAssignment[] = [];
	const prepared: PreparedComponent[] = components.map((source) => {
		const bounds = sanitizeRect(source, imageWidth, imageHeight)!;
		const clippedPolygon = source.polygon.map(([x, y]) => [
			clamp(x, 0, imageWidth),
			clamp(y, 0, imageHeight)
		] as [number, number]);
		const component: DetectedTextComponent = {
			...source,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			polygon: validPolygon(clippedPolygon) && polygonArea(clippedPolygon) > 0
				? clippedPolygon
				: rectPolygon(bounds),
			confidence: clamp(source.confidence, 0, 1),
			orientationDegrees: normalizeAngle(source.orientationDegrees)
		};
		const bubble = assignBubble(component, bubbles, minimumOverlap, ambiguityRatio);
		const explicitPanel = authoritativePanel(component, options.panels ?? []);
		const panelId = explicitPanel ?? panelFromCuts(
			component.x + component.width / 2,
			component.y + component.height / 2,
			verticalCuts,
			horizontalCuts
		);
		assignments.push({ componentId: component.componentId, panelId, ...bubble });
		const direction = directionFor(component, options.locale);
		return {
			...component,
			source,
			direction,
			glyphScale: glyphScaleFor(component, direction),
			area: Math.max(1, polygonArea(component.polygon)),
			centerX: component.x + component.width / 2,
			centerY: component.y + component.height / 2,
			bubbleId: bubble.bubbleId,
			panelId,
			bubbleOverlap: bubble.overlapRatio,
			bubbleAssignmentAmbiguous: bubble.ambiguous,
			inferredPanel: explicitPanel === undefined
		};
	});
	const medianComponentArea = Math.max(1, median(prepared.map((component) => component.area)));
	const parent = prepared.map((_, index) => index);
	const members = new Map(prepared.map((_, index) => [index, [index]]));
	const find = (index: number): number => {
		let cursor = index;
		while (parent[cursor] !== cursor) cursor = parent[cursor];
		while (parent[index] !== index) {
			const next = parent[index];
			parent[index] = cursor;
			index = next;
		}
		return cursor;
	};
	const bubbleById = new Map(bubbles.map((bubble) => [bubble.bubbleId, bubble]));
	const preparedIndexById = new Map(prepared.map((component, index) => [component.componentId, index]));
	const sharedRecognitionCropIds = new Set<number>();
	const sharedCropOwnershipSplits: number[] = [];
	// A detector rescue can deliberately keep two weak components in one
	// recognizer crop. They still retain independent polygons and bubble-first
	// assignments, but downstream code cannot split one recognized string across
	// two semantic groups without duplicating text. Preserve that explicit
	// must-link relation, and fail closed if ownership/geometry makes it unsafe.
	for (const region of rawRegions) {
		const sourceIds = [...new Set(region.sourceComponents?.map((component) => component.componentId) ?? [])]
			.sort((left, rightValue) => left - rightValue);
		if (sourceIds.length < 2) continue;
		const indexes = sourceIds.map((componentId) => preparedIndexById.get(componentId));
		if (indexes.some((index) => index === undefined)) continue;
		const roots = [...new Set((indexes as number[]).map(find))].sort((left, rightValue) => left - rightValue);
		if (roots.length < 2) continue;
		const combinedIndexes = roots.flatMap((rootIndex) => members.get(rootIndex) ?? []);
		const combined = combinedIndexes.map((index) => prepared[index]);
		const allPanelsInferred = combined.every((component) => component.inferredPanel);
		if (allPanelsInferred) {
			// Whitespace-derived panel cuts are advisory. A detector-owned shared
			// recognition crop is stronger evidence that these source components
			// belong together, so a cut through that crop must not duplicate the
			// recognized string into separate groups.
			const sharedPanelId = [...combined.map((component) => component.panelId)].sort(compareStrings)[0];
			for (const component of combined) {
				component.panelId = sharedPanelId;
				const assignment = assignments.find((candidate) => candidate.componentId === component.componentId);
				if (assignment) assignment.panelId = sharedPanelId;
			}
		}
		const sameOwnership = combined.every((component) =>
			component.panelId === combined[0].panelId
				&& component.bubbleId === combined[0].bubbleId
				&& !component.bubbleAssignmentAmbiguous
		);
		// Do not apply the ordinary page-area/cluster heuristics here. The detector
		// already admitted this exact pair under its stricter low-confidence rescue
		// contract, and applying the general group cap can reject valid pairs on a
		// small crop. Semantic ownership remains the boundary.
		//
		// When ownership disagrees, the two claims are irreconcilable: the detector
		// rescue is a heuristic pairing of two faint fragments, while the bubble
		// assignment is geometric evidence from a segmentation model. The
		// segmentation wins — drop the must-link and let the sources group
		// independently, which is the state that would have existed had the rescue
		// never fired. This used to throw; a page is not worth failing over a
		// heuristic pairing. The split is reported so the caller can re-key
		// recognition onto the individual sources (see the diagnostics field).
		if (!sameOwnership) {
			sharedCropOwnershipSplits.push(region.boxId);
			continue;
		}
		const winner = roots[0];
		members.set(winner, combinedIndexes);
		for (const loser of roots.slice(1)) {
			parent[loser] = winner;
			members.delete(loser);
		}
		for (const componentId of sourceIds) sharedRecognitionCropIds.add(componentId);
	}
	const edges: GroupingEdge[] = [];
	const separationReasons: PPOcrSeparationReason[] = [];
	let separationReasonsTruncated = false;
	let evaluatedPairs = 0;
	const xSorted = prepared.map((_, index) => index).sort((left, rightValue) =>
		prepared[left].centerX - prepared[rightValue].centerX
			|| prepared[left].centerY - prepared[rightValue].centerY
			|| prepared[left].componentId - prepared[rightValue].componentId
	);
	const maximumGlyph = Math.max(1, ...prepared.map((component) => component.glyphScale));
	for (let position = 0; position < xSorted.length; position += 1) {
		throwIfGroupingCancelled(options.signal);
		const leftIndex = xSorted[position];
		let localPairBudget = MAX_LOCAL_PAIR_EVALUATIONS;
		for (let next = position + 1; next < xSorted.length; next += 1) {
			const rightIndex = xSorted[next];
			if (prepared[rightIndex].x - right(prepared[leftIndex]) > maximumGlyph * 5) break;
			if (localPairBudget <= 0) break;
			localPairBudget -= 1;
			evaluatedPairs += 1;
			const compatibility = evaluatePair(
				prepared[leftIndex],
				prepared[rightIndex],
				medianComponentArea
			);
			if (compatibility.score !== null) {
				edges.push({ left: leftIndex, right: rightIndex, score: compatibility.score });
			} else if (compatibility.reason) {
				if (separationReasons.length < MAX_SEPARATION_REASON_TRACES) {
					separationReasons.push({
						componentIds: [
							Math.min(prepared[leftIndex].componentId, prepared[rightIndex].componentId),
							Math.max(prepared[leftIndex].componentId, prepared[rightIndex].componentId)
						],
						reason: compatibility.reason
					});
				} else {
					separationReasonsTruncated = true;
				}
			}
		}
	}
	edges.sort((left, rightValue) =>
		left.score - rightValue.score
			|| prepared[left.left].componentId - prepared[rightValue.left].componentId
			|| prepared[left.right].componentId - prepared[rightValue.right].componentId
	);
	let acceptedEdges = 0;
	/** Locally compatible pairs a span cap kept apart — one utterance in two groups. */
	const spanCapPairs: Array<[number, number]> = [];
	for (const edge of edges) {
		throwIfGroupingCancelled(options.signal);
		const leftRoot = find(edge.left);
		const rightRoot = find(edge.right);
		if (leftRoot === rightRoot) continue;
		const combinedIndexes = [...(members.get(leftRoot) ?? []), ...(members.get(rightRoot) ?? [])];
		const combined = combinedIndexes.map((index) => prepared[index]);
		const clusterCompatibility = clusterValid(combined, imageWidth, imageHeight);
		if (!clusterCompatibility.valid) {
			if (clusterCompatibility.reason === 'span-cap') spanCapPairs.push([edge.left, edge.right]);
			if (clusterCompatibility.reason) {
				if (separationReasons.length < MAX_SEPARATION_REASON_TRACES) {
					separationReasons.push({
						componentIds: [
							Math.min(prepared[edge.left].componentId, prepared[edge.right].componentId),
							Math.max(prepared[edge.left].componentId, prepared[edge.right].componentId)
						],
						reason: clusterCompatibility.reason
					});
				} else {
					separationReasonsTruncated = true;
				}
			}
			continue;
		}
		const winner = Math.min(leftRoot, rightRoot);
		const loser = Math.max(leftRoot, rightRoot);
		parent[loser] = winner;
		members.set(winner, combinedIndexes);
		members.delete(loser);
		acceptedEdges += 1;
	}
	const clusters = [...members.values()].map((indexes) => indexes.map((index) => prepared[index]));
	const provisional = clusters.map((cluster): PPOcrTextGroup => {
		const bounds = unionBounds(cluster);
		const stackedHorizontalVertical = looksLikeStackedHorizontalCjkBlock(cluster, options.locale);
		const direction = stackedHorizontalVertical ? 'vertical' : dominantComponentDirection(cluster);
		const orientations = cluster.map((component) => component.orientationDegrees);
		const orientationDegrees = normalizeAngle(median(orientations));
		// These detector fragments are row slices rather than true columns. Keep
		// their stable top-to-bottom evidence order while exposing vertical writing
		// mode to downstream translation/layout consumers.
		const ordered = orderComponentsForReading(
			cluster,
			stackedHorizontalVertical ? 'horizontal' : direction,
			orientationDegrees
		);
		const sourceComponents: DetectedTextComponent[] = ordered.map(({ source }) => ({
			...source,
			polygon: source.polygon.map(([x, y]) => [x, y] as [number, number])
		}));
		const componentIds = sourceComponents.map((component) => component.componentId);
		const bubbleId = cluster[0].bubbleId;
		const bubble = bubbleId === undefined ? undefined : bubbleById.get(bubbleId);
		const componentArea = cluster.reduce((sum, component) => sum + component.area, 0);
		const maximumComponentArea = Math.max(...cluster.map((component) => component.area));
		const satelliteCount = cluster.filter((component) =>
			component.area < maximumComponentArea * 0.45
		).length;
		const glyphScale = median(cluster.map((component) => component.glyphScale));
		const orientationSpread = orientations.length < 2
			? 0
			: Math.max(...orientations.map((angle) => angleDistance(angle, orientationDegrees)));
		const confidence = cluster.reduce((sum, component) => sum + component.confidence * component.area, 0)
			/ Math.max(1, componentArea);
		return {
			id: `ppocr-group:${componentIds.join('.')}`,
			boxId: 0,
			x: quantize(bounds.x),
			y: quantize(bounds.y),
			width: quantize(bounds.width),
			height: quantize(bounds.height),
			confidence: quantize(confidence),
			polygon: rectPolygon(bounds).map(([x, y]) => [quantize(x), quantize(y)]),
			orientationDegrees,
			components: sourceComponents,
			componentIds,
			sourceComponents,
			sourceComponentIds: componentIds,
			direction,
			writingMode: direction === 'vertical' ? 'vertical-rl' : direction === 'rotated' ? 'rotated' : 'horizontal-tb',
			inBubble: bubble !== undefined,
			bubbleId,
			panelId: cluster[0].panelId,
			bubbleOverlap: quantize(cluster.reduce((sum, component) => sum + component.bubbleOverlap, 0) / cluster.length),
			bubbleAssignmentAmbiguous: cluster.some((component) => component.bubbleAssignmentAmbiguous),
			contour: bubble?.contour,
			trace: {
				componentCount: componentIds.length,
				glyphScale: quantize(glyphScale),
				glyphScaleRatio: 1,
				orientationSpread: quantize(orientationSpread),
				fillRatio: quantize(componentArea / Math.max(1, area(bounds))),
				edgeDistanceRatio: 0,
				nearestGroupDistanceInGlyphs: 0,
				inferredPanel: cluster[0].inferredPanel,
				bubbleOverlap: quantize(cluster.reduce((sum, component) => sum + component.bubbleOverlap, 0) / cluster.length),
					reasons: [
					...(componentIds.some((componentId) => sharedRecognitionCropIds.has(componentId))
						? ['shared-recognition-crop']
						: []),
					...(stackedHorizontalVertical ? ['stacked-horizontal-strips-vertical-cjk'] : []),
					...(cluster.some((component) => component.bubbleAssignmentAmbiguous)
						? ['ambiguous-bubble-overlap']
						: []),
					...(satelliteCount > 0 ? ['satellite-ruby-or-punctuation'] : [])
				]
			}
		};
	});
	// A pair-specific "same row" tolerance produces a non-transitive comparator
	// (A≈B, B≈C, but A!≈C), which lets engine sort details change box IDs. Use
	// one page-wide reading band so the ordering is a strict total order.
	const readingBandHeight = Math.max(1, median(provisional.map((group) => group.trace.glyphScale)) * 1.5);
	// Within a band the horizontal sweep follows the page's reading direction:
	// right-to-left for manga, left-to-right for everything else. Only this term
	// changes — bands stay top-to-bottom and the tie-breaks stay identical, so the
	// comparator remains a strict total order in both directions.
	const sweep = readingDirection === 'ltr'
		? (left: Rect, rightValue: Rect): number => centerX(left) - centerX(rightValue)
		: (left: Rect, rightValue: Rect): number => centerX(rightValue) - centerX(left);
	provisional.sort((left, rightValue) => {
		const leftBand = Math.floor(centerY(left) / readingBandHeight);
		const rightBand = Math.floor(centerY(rightValue) / readingBandHeight);
		return leftBand - rightBand
			|| sweep(left, rightValue)
			|| centerY(left) - centerY(rightValue)
			|| left.componentIds[0] - rightValue.componentIds[0];
	});
	// A span-cap split leaves one utterance as two groups. Where the two are
	// consecutive in reading order and in the same bubble, the later one is
	// marked as continuing the earlier, so the layout stacks the halves top to
	// bottom rather than carving the balloon side by side and setting the
	// second half of a sentence to the left of the first.
	{
		const groupByComponent = new Map<number, PPOcrTextGroup>();
		for (const group of provisional) for (const componentId of group.componentIds) groupByComponent.set(componentId, group);
		for (const [left, rightIndex] of spanCapPairs) {
			const a = groupByComponent.get(prepared[left].componentId);
			const b = groupByComponent.get(prepared[rightIndex].componentId);
			if (!a || !b || a === b || a.bubbleId !== b.bubbleId) continue;
			const orderA = provisional.indexOf(a);
			const orderB = provisional.indexOf(b);
			if (Math.abs(orderA - orderB) !== 1) continue;
			const later = orderA > orderB ? a : b;
			if (!later.continuesPrevious) {
				later.continuesPrevious = true;
				later.trace.reasons.push('span-cap-continuation');
			}
		}
	}
	const medianGlyph = Math.max(1, median(provisional.map((group) => group.trace.glyphScale)));
	const nearestByGroup = nearestGroupDistances(provisional, medianGlyph);
	for (let index = 0; index < provisional.length; index += 1) {
		const group = provisional[index];
		group.boxId = index + 1;
		const classification = initialClassification(
			group,
			imageWidth,
			imageHeight,
			medianGlyph,
			nearestByGroup.get(group.id) ?? 99
		);
		group.groupKind = classification.kind;
		group.classificationConfidence = classification.confidence;
		group.classificationReasons = classification.reasons;
		group.trace.reasons = [...group.trace.reasons, ...classification.reasons];
	}
	const groupIdByComponent = new Map<number, string>();
	for (const group of provisional) {
		for (const componentId of group.componentIds) groupIdByComponent.set(componentId, group.id);
	}
	for (const assignment of assignments) assignment.groupId = groupIdByComponent.get(assignment.componentId);
	const seen = new Map<number, number>();
	for (const group of provisional) for (const componentId of group.componentIds) {
		seen.set(componentId, (seen.get(componentId) ?? 0) + 1);
	}
	const duplicateComponentIds = [...new Set([
		...duplicateIds,
		...[...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)
	])].sort((a, b) => a - b);
	const missingComponentIds = components.map((component) => component.componentId)
		.filter((id) => !seen.has(id)).sort((a, b) => a - b);
	const classificationCounts = Object.fromEntries(CLASSIFICATION_KINDS.map((kind) => [kind, 0])) as Record<DetectedTextGroupKind, number>;
	for (const group of provisional) classificationCounts[group.groupKind ?? 'unknown'] += 1;
	return {
		groups: provisional,
		assignments: assignments.sort((left, rightValue) => left.componentId - rightValue.componentId),
		diagnostics: {
			inputRegions: rawRegions.length,
			acceptedComponents: components.length,
			invalidComponents: rejected.filter((item) => item.reason !== 'duplicate-id').length,
			groups: provisional.length,
			assignedToBubbles: assignments.filter((assignment) => assignment.bubbleId !== undefined).length,
			freeComponents: assignments.filter((assignment) => assignment.bubbleId === undefined).length,
			ambiguousBubbleAssignments: assignments.filter((assignment) => assignment.ambiguous).length,
			duplicateComponentIds,
			missingComponentIds,
			inferredVerticalCuts: verticalCuts,
			inferredHorizontalCuts: horizontalCuts,
			classificationCounts,
			evaluatedPairs,
			candidateEdges: edges.length,
			acceptedEdges,
			processingMs: 0,
			rejectedComponents: rejected,
			sharedCropOwnershipSplits: [...new Set(sharedCropOwnershipSplits)].sort((a, b) => a - b),
			separationReasons: [...new Map(separationReasons.map((reason) => [
				`${reason.componentIds[0]}:${reason.componentIds[1]}:${reason.reason}`,
				reason
			])).values()].sort((left, rightValue) =>
				left.componentIds[0] - rightValue.componentIds[0]
					|| left.componentIds[1] - rightValue.componentIds[1]
					|| compareStrings(left.reason, rightValue.reason)
			),
			separationReasonsTruncated
		}
	};
}

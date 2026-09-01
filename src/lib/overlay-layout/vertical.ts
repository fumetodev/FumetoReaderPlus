import type {
	OverlayDirection,
	OverlayRenderLineV2,
	OverlayRenderRunV2,
	Point,
	Rect
} from '$lib/types/index.js';
import type { FontRunSpec, PreparedTextInput, TextLayoutPort } from './ports.js';
import { quantize } from './canonical.js';
import { coherentIntervalStack, safeBandIntervals } from './geometry.js';
import { paragraphDirection } from './bidi.js';

export const UNICODE_VERTICAL_ORIENTATION_VERSION = 'Unicode-17.0.0';

const CJK_LOCALE = /^(ja|zh|ko)(-|$)/i;
const UPRIGHT = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\uff01-\uff60\u3000-\u303f]/u;
const ROTATED = /[A-Za-z0-9\u0370-\u052f\u0600-\u08ff\u0900-\u097f\u0e00-\u0e7f]/u;
const KINSOKU_START = new Set([...',.!?:;)]}、。，．！？：；）］｝〉》」』】〕〗〙〛’”']);
const KINSOKU_END = new Set([...'([{〈《「『【〔〖〘〚‘“']);
const VERTICAL_FORMS = new Map<string, string>([
	['（', '︵'], ['）', '︶'], ['［', '﹇'], ['］', '﹈'], ['｛', '︷'], ['｝', '︸'],
	['…', '︙'], ['—', '︱'], ['ー', '｜']
]);

function directionFor(text: string, base: OverlayDirection): OverlayDirection {
	return paragraphDirection(text, base);
}

export function planVerticalText(input: {
	text: string;
	locale: string;
	rect: Rect;
	fontSize: number;
	lineHeight: number;
	fontRuns: FontRunSpec[];
	baseDirection: OverlayDirection;
	textLayout: TextLayoutPort;
	preparedInput: PreparedTextInput;
	polygon?: Point[];
	tailPolygon?: Point[];
	exclusionPolygons?: Point[][];
	padding?: number;
}): { lines: OverlayRenderLineV2[]; complete: boolean } {
	if (!CJK_LOCALE.test(input.locale)) return planRotatedBlocks(input);
	const segmenter = new Intl.Segmenter(input.locale, { granularity: 'grapheme' });
	const graphemes = [...segmenter.segment(input.text)];
	const constraints = verticalConstraints(input);
	const columns: typeof graphemes[] = [];
	let cursor = 0;
	while (cursor < graphemes.length && columns.length < constraints.length) {
		const constraint = constraints[columns.length];
		const capacity = Math.max(1, Math.floor((constraint.end - constraint.start) / input.lineHeight));
		let end = Math.min(graphemes.length, cursor + capacity);
		if (end < graphemes.length && KINSOKU_START.has(graphemes[end].segment) && end > cursor + 1) end -= 1;
		if (end > cursor && KINSOKU_END.has(graphemes[end - 1].segment) && end < graphemes.length) end -= 1;
		if (end <= cursor) end = Math.min(graphemes.length, cursor + 1);
		columns.push(graphemes.slice(cursor, end));
		cursor = end;
	}
	if (cursor < graphemes.length) return { lines: [], complete: false };

	const lines: OverlayRenderLineV2[] = columns.map((column, columnIndex) => {
		const constraint = constraints[columnIndex];
		const x = constraint.x;
		const usedHeight = column.length * input.lineHeight;
		const top = constraint.start + Math.max(0, (constraint.end - constraint.start - usedHeight) / 2);
		const startUtf16 = column[0]?.index ?? 0;
		const last = column[column.length - 1];
		const endUtf16 = last ? last.index + last.segment.length : startUtf16;
		const runs: OverlayRenderRunV2[] = column.map((grapheme, rowIndex) => {
			const sourceRun = input.fontRuns.find((run) => grapheme.index >= run.startUtf16 && grapheme.index < run.endUtf16) ?? input.fontRuns[0];
			const shouldRotate = ROTATED.test(grapheme.segment) && !UPRIGHT.test(grapheme.segment);
			return {
				text: VERTICAL_FORMS.get(grapheme.segment) ?? grapheme.segment,
				sourceRange: { startUtf16: grapheme.index, endUtf16: grapheme.index + grapheme.segment.length },
				fontKey: sourceRun.fontKey,
				origin: { x: quantize(x - input.fontSize / 2), y: quantize(top + (rowIndex + 0.8) * input.lineHeight) },
				rotationDegrees: shouldRotate ? 90 : 0,
				direction: directionFor(grapheme.segment, input.baseDirection)
			};
		});
		return {
			text: column.map((grapheme) => grapheme.segment).join(''),
			sourceRange: {
				startUtf16,
				endUtf16,
				startGrapheme: graphemes.indexOf(column[0]),
				endGrapheme: graphemes.indexOf(last) + 1
			},
			breakAfter: columnIndex === columns.length - 1 ? 'end' : 'legal',
			origin: { x: quantize(x), y: quantize(top) },
			baseline: quantize(x),
			advance: quantize(usedHeight),
			bounds: { x: quantize(x - input.lineHeight / 2), y: quantize(top), width: quantize(input.lineHeight), height: quantize(usedHeight) },
			availableInterval: { start: constraint.start, end: constraint.end },
			direction: input.baseDirection,
			runs
		};
	});
	return { lines, complete: true };
}

function verticalConstraints(input: Parameters<typeof planVerticalText>[0]): Array<{ x: number; start: number; end: number }> {
	const padding = input.padding ?? 0;
	const columns = Math.max(1, Math.floor((input.rect.width - padding * 2) / input.lineHeight));
	const centers = Array.from({ length: columns }, (_, index) => input.rect.x + input.rect.width - padding - (index + .5) * input.lineHeight);
	if (!input.polygon) return centers.map((x) => ({ x, start: input.rect.y + padding, end: input.rect.y + input.rect.height - padding }));
	const rotatedPolygon = input.polygon.map((point) => ({ x: point.y, y: point.x }));
	const rotatedTail = input.tailPolygon?.map((point) => ({ x: point.y, y: point.x }));
	const rotatedExclusions = input.exclusionPolygons?.map(
		(polygon) => polygon.map((point) => ({ x: point.y, y: point.x }))
	);
	const intervals = centers.map((x) => safeBandIntervals(
		rotatedPolygon,
		x - input.lineHeight / 2,
		x + input.lineHeight / 2,
		padding,
		rotatedTail,
		rotatedExclusions
	).map((interval) => ({
		start: Math.max(interval.start, input.rect.y + padding),
		end: Math.min(interval.end, input.rect.y + input.rect.height - padding)
	})).filter((interval) => interval.end - interval.start >= input.lineHeight));
	// Rounded contours naturally have unusable slivers at their left/right edges.
	// Search contiguous coherent stacks instead of requiring every theoretical
	// edge column to participate. Contiguity still prevents jumping across a tail
	// or a disconnected lobe.
	let best: { start: number; path: Array<{ start: number; end: number }>; capacity: number; area: number } | null = null;
	for (let start = 0; start < intervals.length; start += 1) {
		for (let end = start + 1; end <= intervals.length; end += 1) {
			const rows = intervals.slice(start, end);
			if (rows.some((row) => row.length === 0)) break;
			const path = coherentIntervalStack(rows);
			if (!path) break;
			const capacity = path.reduce((sum, interval) => sum + Math.max(0, Math.floor((interval.end - interval.start) / input.lineHeight)), 0);
			const area = path.reduce((sum, interval) => sum + interval.end - interval.start, 0);
			if (!best || capacity > best.capacity || (capacity === best.capacity && (path.length > best.path.length || (path.length === best.path.length && area > best.area)))) {
				best = { start, path, capacity, area };
			}
		}
	}
	return best?.path.map((interval, index) => ({ x: centers[best.start + index], start: interval.start, end: interval.end })) ?? [];
}

function planRotatedBlocks(input: Parameters<typeof planVerticalText>[0]): { lines: OverlayRenderLineV2[]; complete: boolean } {
	const columns = verticalConstraints(input);
	const constraints = columns.map((column) => ({ width: column.end - column.start, intervalStart: column.start, intervalEnd: column.end }));
	if (constraints.length === 0) return { lines: [], complete: false };
	const handle = input.textLayout.prepare(input.preparedInput);
	const layout = input.textLayout.layout(handle, constraints);
	const lines = layout.lines.map((line, index): OverlayRenderLineV2 => {
		const column = columns[index];
		const x = column.x;
		const y = column.start + (column.end - column.start - line.width) / 2;
		const fontRun = input.fontRuns.find((run) => line.startUtf16 < run.endUtf16 && line.endUtf16 > run.startUtf16) ?? input.fontRuns[0];
		const direction = directionFor(line.text, input.baseDirection);
		const runY = direction === 'rtl' ? y + line.width : y;
		return {
			text: line.text,
			sourceRange: {
				startUtf16: line.startUtf16,
				endUtf16: line.endUtf16,
				startGrapheme: line.startGrapheme,
				endGrapheme: line.endGrapheme
			},
			breakAfter: line.breakAfter,
			origin: { x: quantize(x), y: quantize(y) },
			baseline: quantize(x),
			advance: quantize(line.width),
			bounds: { x: quantize(x - input.lineHeight / 2), y: quantize(y), width: quantize(input.lineHeight), height: quantize(line.width) },
			availableInterval: { start: column.start, end: column.end },
			direction,
			runs: [{
				text: line.text,
				sourceRange: { startUtf16: line.startUtf16, endUtf16: line.endUtf16 },
				fontKey: fontRun.fontKey,
				origin: { x: quantize(x), y: quantize(runY) },
				rotationDegrees: 90,
				direction
			}]
		};
	});
	return { lines, complete: layout.complete };
}

export function runOriginAfter(origin: Point, advance: number, direction: OverlayDirection): Point {
	return { x: origin.x + (direction === 'rtl' ? -advance : advance), y: origin.y };
}

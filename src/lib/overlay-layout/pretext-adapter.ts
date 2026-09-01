import {
	clearCache as clearPretextCache,
	layoutNextLineRange,
	materializeLineRange,
	measureNaturalWidth,
	prepareWithSegments,
	setLocale,
	type LayoutCursor,
	type PreparedTextWithSegments
} from '@chenglou/pretext';
import type {
	LineWidthConstraint,
	PreparedTextHandle,
	PreparedTextInput,
	TextLayoutCacheDiagnostics,
	TextLayoutPort,
	TextLinePlan
} from './ports.js';
import { canonicalStringify, compareCanonicalText } from './canonical.js';

type CacheRecord = {
	handle: PreparedTextHandle;
	prepared: PreparedTextWithSegments;
	input: PreparedTextInput;
	bytes: number;
	lastUsed: number;
	graphemeStarts: number[];
};

const MAX_RECORDS = 256;
const MAX_BYTES = 16 * 1024 * 1024;
let activePretextLocale: string | null = null;
let pretextEpochRecords = 0;
let pretextEpochBytes = 0;

function estimateBytes(input: PreparedTextInput, prepared: PreparedTextWithSegments, key: string): number {
	return Math.max(256, key.length * 2 + input.text.length * 12 + prepared.segments.reduce((sum, segment) => sum + segment.length * 2 + 32, 0));
}

function resetPretextEpoch(): void {
	pretextEpochRecords = 0;
	pretextEpochBytes = 0;
}

function clearPretextEpoch(): void {
	clearPretextCache();
	resetPretextEpoch();
}

function ensurePretextLocale(locale: string): void {
	const normalized = Intl.getCanonicalLocales(locale)[0] ?? 'und';
	if (activePretextLocale === normalized) return;
	// Pretext 0.0.8 clears all of its package-global caches in setLocale().
	// Avoid repeating that work for every font-size miss, and keep this marker
	// module-global because separate adapter instances share the same dependency.
	setLocale(normalized);
	activePretextLocale = normalized;
	resetPretextEpoch();
}

function accountPretextPreparation(bytes: number): void {
	pretextEpochRecords += 1;
	pretextEpochBytes += bytes;
	// Pretext does not expose cache diagnostics or selective eviction. Bound its
	// internal caches in the same 256-record/16-MiB epochs as Fumeto's LRU while
	// avoiding a destructive global clear for every individual LRU victim.
	if (pretextEpochRecords >= MAX_RECORDS || pretextEpochBytes >= MAX_BYTES) clearPretextEpoch();
}

function fontShorthand(input: PreparedTextInput): string {
	const families = [...new Set(input.families?.length ? input.families : [input.family])];
	return `${input.weight} ${input.fontSize}px ${families.map((family) => `"${family.replaceAll('"', '\\"')}"`).join(', ')}`;
}

function sourceRange(text: string, lineText: string, cursor: number): { start: number; end: number; next: number } {
	const matchAt = (start: number): number | null => {
		let source = start;
		let visible = 0;
		while (visible < lineText.length && source < text.length) {
			if (text[source] === '\u00ad') {
				const paintsHyphen = visible === lineText.length - 1 && lineText[visible] === '-';
				source += 1;
				if (paintsHyphen) visible += 1;
				continue;
			}
			if (text[source] === '\r' && text[source + 1] === '\n' && lineText[visible] === '\n') {
				source += 2;
				visible += 1;
				continue;
			}
			const sourcePoint = text.codePointAt(source)!;
			const visiblePoint = lineText.codePointAt(visible)!;
			if (sourcePoint !== visiblePoint) return null;
			source += sourcePoint > 0xffff ? 2 : 1;
			visible += visiblePoint > 0xffff ? 2 : 1;
		}
		return visible === lineText.length ? source : null;
	};
	// First preserve intentional leading whitespace. If a previous legal or
	// explicit break consumed separator characters, advance only until a match.
	for (let start = cursor; start <= text.length; start += 1) {
		const end = matchAt(start);
		if (end !== null) return { start, end, next: end };
		if (start < text.length && !/[\s\u00ad]/u.test(text[start])) break;
	}
	throw new Error('Pretext line could not be mapped back to the authoritative source text');
}

/**
 * Pretext reports the selected ranges, while Fumeto owns the semantic break
 * classification used by scoring and exact fragment remeasurement. Unicode
 * break opportunities end at a prepared segment boundary. A nonzero grapheme
 * cursor is Pretext's explicit overflow path inside one segment (for example a
 * long Latin or Arabic word). Using source character categories here used to
 * mistake normal CJK segment boundaries for emergency word splits.
 */
export function classifyOverlayBreak(
	text: string,
	start: number,
	end: number,
	lineText: string,
	isEnd: boolean,
	endCursor: LayoutCursor
): TextLinePlan['lines'][number]['breakAfter'] {
	if (isEnd) return 'end';
	const following = text.slice(end).match(/^[\r\n]+/u);
	if (following) return 'explicit';
	if (lineText.endsWith('-') && text.slice(start, end).includes('\u00ad')) return 'hyphenated';
	// Pretext intentionally prefers these hard-hyphen opportunities even when
	// they occur inside an otherwise breakable segment.
	if (/[-\u058a\u2010\u2012-\u2014]$/u.test(lineText)) return 'legal';
	return endCursor.graphemeIndex > 0 ? 'emergency' : 'legal';
}

export class BoundedPretextAdapter implements TextLayoutPort {
	private readonly records = new Map<string, CacheRecord>();
	private readonly graphemeCache = new Map<string, { scopeId: string; starts: number[]; lastUsed: number }>();
	private clock = 0;
	private bytes = 0;
	private hits = 0;
	private misses = 0;
	private evictions = 0;

	prepare(input: PreparedTextInput): PreparedTextHandle {
		// This key never enters a render plan. Keeping the full canonical tuple is
		// faster than bytewise BigInt hashing on every candidate hit and eliminates
		// the possibility of an internal hash collision aliasing prepared metrics.
		const key = canonicalStringify(input);
		const existing = this.records.get(key);
		if (existing) {
			existing.lastUsed = ++this.clock;
			this.hits += 1;
			return existing.handle;
		}
		this.misses += 1;
		ensurePretextLocale(input.locale);
		const prepared = prepareWithSegments(
			input.text,
			fontShorthand(input),
			{ whiteSpace: 'pre-wrap', wordBreak: 'normal' }
		);
		const graphemeStarts = this.graphemeStarts(input);
		const handle: PreparedTextHandle = {
			key,
			scopeId: input.scopeId,
			text: input.text,
			fontSize: input.fontSize,
			lineHeight: input.lineHeight,
			direction: input.direction
		};
		const bytes = estimateBytes(input, prepared, key);
		this.records.set(key, { handle, prepared, input: { ...input }, bytes, lastUsed: ++this.clock, graphemeStarts });
		this.bytes += bytes;
		accountPretextPreparation(bytes);
		this.evict();
		return handle;
	}

	measure(input: PreparedTextInput): number {
		const handle = this.prepare(input);
		const record = this.records.get(handle.key);
		if (!record) throw new Error('Prepared overlay text handle was evicted');
		record.lastUsed = ++this.clock;
		return measureNaturalWidth(record.prepared);
	}

	layout(handle: PreparedTextHandle, constraints: LineWidthConstraint[]): TextLinePlan {
		const record = this.records.get(handle.key);
		if (!record) throw new Error('Prepared overlay text handle was evicted');
		record.lastUsed = ++this.clock;
		let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
		let sourceCursor = 0;
		const lines: TextLinePlan['lines'] = [];
		for (const constraint of constraints) {
			const range = layoutNextLineRange(record.prepared, cursor, constraint.width);
			if (!range) break;
			const materialized = materializeLineRange(record.prepared, range);
			const source = sourceRange(record.input.text, materialized.text, sourceCursor);
			sourceCursor = source.next;
			const startGrapheme = Math.max(0, record.graphemeStarts.findIndex((start) => start >= source.start));
			let endGrapheme = record.graphemeStarts.findIndex((start) => start >= source.end);
			if (endGrapheme < 0) endGrapheme = record.graphemeStarts.length - 1;
			const isEnd = range.end.segmentIndex >= record.prepared.segments.length;
			lines.push({
				text: materialized.text,
				width: materialized.width,
				startUtf16: source.start,
				endUtf16: source.end,
				startGrapheme,
				endGrapheme,
				breakAfter: classifyOverlayBreak(record.input.text, source.start, source.end, materialized.text, isEnd, range.end),
				constraint
			});
			cursor = range.end;
		}
		const complete = cursor.segmentIndex >= record.prepared.segments.length;
		return { lines, complete };
	}

	disposeScope(scopeId: string): void {
		let removed = false;
		for (const [key, record] of this.records) {
			if (record.handle.scopeId !== scopeId) continue;
			this.records.delete(key);
			this.bytes -= record.bytes;
			removed = true;
		}
		for (const [key, segmentation] of this.graphemeCache) {
			if (segmentation.scopeId === scopeId) {
				this.graphemeCache.delete(key);
				removed = true;
			}
		}
		if (removed) clearPretextEpoch();
	}

	private graphemeStarts(input: PreparedTextInput): number[] {
		const key = `${input.scopeId}\u0000${input.locale}\u0000${input.text}`;
		const existing = this.graphemeCache.get(key);
		if (existing) {
			existing.lastUsed = ++this.clock;
			return existing.starts;
		}
		const starts = [...new Intl.Segmenter(input.locale, { granularity: 'grapheme' }).segment(input.text)]
			.map((segment) => segment.index);
		starts.push(input.text.length);
		this.graphemeCache.set(key, { scopeId: input.scopeId, starts, lastUsed: ++this.clock });
		while (this.graphemeCache.size > MAX_RECORDS) {
			let oldest: [string, { scopeId: string; starts: number[]; lastUsed: number }] | undefined;
			for (const entry of this.graphemeCache) {
				if (!oldest
					|| entry[1].lastUsed < oldest[1].lastUsed
					|| (entry[1].lastUsed === oldest[1].lastUsed && compareCanonicalText(entry[0], oldest[0]) < 0)) oldest = entry;
			}
			if (!oldest) break;
			this.graphemeCache.delete(oldest[0]);
		}
		return starts;
	}

	private evict(): void {
		while (this.records.size > MAX_RECORDS || this.bytes > MAX_BYTES) {
			let oldest: [string, CacheRecord] | undefined;
			for (const entry of this.records) {
				if (!oldest
					|| entry[1].lastUsed < oldest[1].lastUsed
					|| (entry[1].lastUsed === oldest[1].lastUsed && compareCanonicalText(entry[0], oldest[0]) < 0)) oldest = entry;
			}
			if (!oldest) break;
			this.records.delete(oldest[0]);
			this.bytes -= oldest[1].bytes;
			this.evictions += 1;
		}
	}

	inspectCache(): TextLayoutCacheDiagnostics {
		return {
			records: this.records.size,
			bytes: this.bytes,
			hits: this.hits,
			misses: this.misses,
			evictions: this.evictions,
			maxRecords: MAX_RECORDS,
			maxBytes: MAX_BYTES
		};
	}
}

export const overlayTextLayout = new BoundedPretextAdapter();

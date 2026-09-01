import type {
	OverlayBackgroundPlan,
	OverlayCandidateScore,
	OverlayContainerV2,
	OverlayDirection,
	OverlayItemV2,
	OverlayRenderLineV2,
	OverlayRenderPlanV2,
	OverlayRenderRunV2,
	OverlayWritingMode,
	PageOverlayDataV2,
	PageTranslationEntry,
	PlannedOverlayItemV2,
	Point,
	Rect
} from '$lib/types/index.js';
import type {
	FontRegistryPort,
	FontRunSpec,
	OverlayLayoutDiagnostics,
	OverlayLayoutInput,
	OverlayLayoutService,
	OverlayLayoutSettingsV2,
	ProtectedRegionV2,
	TextLayoutPort
} from './ports.js';
import { canonicalStringify, compareCanonicalText, quantize, sha256, stableHash64 } from './canonical.js';
import { overlayDocumentForHash } from './schema.js';
import { overlayFontRegistry } from './font-registry.js';
import { overlayTextLayout } from './pretext-adapter.js';
import {
	clampRect,
	coherentIntervalStack,
	coherentSubWindowStack,
	partitionByDemand,
	polygonLobeSplit,
	polygonWaistSplit,
	usableWidthProfile,
	isFiniteRect,
	isSimplePolygon,
	polygonBounds,
	polygonPairOverlapRatio,
	polygonRectIntersectionArea,
	rectGap,
	rectInside,
	rectIntersectionArea,
	safeBandIntervals
} from './geometry.js';
import { planVerticalText } from './vertical.js';
import { insertSoftHyphens, originalIndexFor } from './hyphenation.js';
import { recordGate, recordGateResult } from './gate-telemetry.js';
import { bidiVisualOrder, paragraphDirection, requiresExplicitBidiRuns, resolveBidiRuns } from './bidi.js';
import { createCooperativeYieldBudget, type CooperativeYieldBudget } from './cooperative-yield.js';

export const OVERLAY_ALGORITHM_VERSION = 'overlay-layout-v2-policy-31';

/**
 * Bench-only switches.
 *
 * Nothing in the app sets these; a development bench does, so a candidate policy can be
 * measured against the shipped one on the same documents with the same fonts
 * before anything about it is decided. Every switch defaults to the shipped
 * behaviour, and none of them enters the layout input hash — an experiment is
 * not a plan the app may cache.
 */
export interface OverlayLayoutExperiments {
	/**
	 * Policy-29 shared regions, for A/B measurement: same-style-only free runs,
	 * no carve of side-by-side utterances, and plain top-K beam pruning.
	 */
	legacySharedRegions?: boolean;
	/** Override for HARMONIZATION_OUTLIER_RATIO (and the fill-refinement cap that mirrors it). */
	harmonizationOutlierRatio?: number;
	/** Log the assignment beam to the console. */
	debugAssignment?: boolean;
}

let experiments: OverlayLayoutExperiments = {};

export function setOverlayLayoutExperiments(next: OverlayLayoutExperiments): void {
	experiments = { ...next };
}

/** Entirely asterisk-wrapped tokens, e.g. "*flump*" or "*wiggle* *wiggle*". */
const ASTERISK_ONLY_SFX = /^\s*\*[^*]+\*(?:\s*\*[^*]+\*)*\s*$/u;

/**
 * Hard legibility minimum for the place-always degraded rung, expressed at a
 * 1200px page short edge (user decision: 2px@1200; absolute floor 2px). Below
 * this the item becomes a tap-to-reveal placement instead of shrinking further.
 */
export const LAST_RESORT_FONT_FLOOR_AT_1200 = 2;
const REVEAL_SCORE_TOTAL = 100000;

type RejectionReason =
	| 'out-of-page'
	| 'invalid-geometry'
	| 'protected-art'
	| 'below-readability-floor'
	| 'prominence-limit'
	| 'no-safe-intervals'
	| 'text-does-not-fit';

export interface OverlayCandidateTrace {
	candidateId: string;
	itemId: string;
	accepted: boolean;
	reason?: RejectionReason;
	/** Search window used for line breaking before a free-text card is tightened. */
	layoutRect: Rect;
	/** Final painted/interactive rectangle. */
	rect: Rect;
	fontSize: number;
	writingMode: OverlayWritingMode;
	fitMode?: 'standard' | 'compact' | 'degraded' | 'reveal';
	fitProfile?: string;
	score?: OverlayCandidateScore;
}

type Candidate = {
	id: string;
	item: PlannedOverlayItemV2;
	rect: Rect;
	score: OverlayCandidateScore;
	styleKey: string;
	typographyProfileId: string;
	contourBound: boolean;
	containerId?: string;
	/** Ordered stacked-column band — must survive the per-item assignment cap. */
	stackedBand?: boolean;
	/** A source-anchored cell of a shared region (experiment; a band in every other respect). */
	cell?: boolean;
	/** Height-locked window over an unbounded item's own source columns. */
	sourceRegion?: boolean;
};

type CandidateGeometry = {
	rect: Rect;
	contourBound: boolean;
	typographySamples: number;
	stackedBand?: boolean;
	cell?: boolean;
	sourceRegion?: boolean;
};

type TypographyProfile = {
	id: string;
	fitMode: 'standard' | 'compact' | 'degraded';
	lineHeightRatio: number;
	paddingScale: number;
	minimumPadding: number;
	lineCountScale: number;
	verticalBias: -1 | 0 | 1;
	penalty: number;
};

const STANDARD_TYPOGRAPHY_PROFILE: TypographyProfile = {
	id: 'standard',
	fitMode: 'standard',
	lineHeightRatio: 1.2,
	paddingScale: 1,
	minimumPadding: 2,
	lineCountScale: 1,
	verticalBias: 0,
	penalty: 0
};

/**
 * Place-always last resort (before tap-to-reveal): recover whitespace first,
 * then let the degraded floor drop the font toward the hard minimum. Explored
 * only when no readable profile produced a candidate.
 */
const DEGRADED_TYPOGRAPHY_PROFILE: TypographyProfile = {
	id: 'degraded-pad',
	fitMode: 'degraded',
	lineHeightRatio: 1.05,
	paddingScale: 0.2,
	minimumPadding: 0.5,
	lineCountScale: 1,
	verticalBias: 0,
	penalty: 40
};

function eligibleDialogue(item: OverlayItemV2): boolean {
	return item.type !== 'sfx'
		&& item.type !== 'unknown'
		&& !item.manual.rect
		&& item.manual.referenceFontSize === undefined
		&& item.manual.pinTypography !== true;
}

function typographyProfiles(
	item: OverlayItemV2,
	writingMode: OverlayWritingMode,
	contourBound: boolean,
	narrowContour = false
): TypographyProfile[] {
	if (
		writingMode !== 'horizontal-tb'
		|| !contourBound
		|| item.type === 'sfx'
		|| item.type === 'unknown'
		|| item.manual.rect
		|| item.manual.referenceFontSize !== undefined
	) {
		return eligibleDialogue(item)
			? [STANDARD_TYPOGRAPHY_PROFILE, DEGRADED_TYPOGRAPHY_PROFILE]
			: [STANDARD_TYPOGRAPHY_PROFILE];
	}
	if (narrowContour) {
		// Tall narrow vertical-source balloons: trade a little leading and
		// padding for line width before any compact/degraded rung is needed.
		return [
			STANDARD_TYPOGRAPHY_PROFILE,
			{ id: 'narrow-column', fitMode: 'compact', lineHeightRatio: 1.08, paddingScale: .6, minimumPadding: 1.5, lineCountScale: 1, verticalBias: 0, penalty: 6 },
			{ id: 'compact-full', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .75, minimumPadding: 1.5, lineCountScale: 1, verticalBias: 0, penalty: 8 },
			{ id: 'tight-full', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .35, minimumPadding: 1, lineCountScale: 1, verticalBias: 0, penalty: 16 },
			DEGRADED_TYPOGRAPHY_PROFILE
		];
	}

	// These profiles never lower the font-size floor or change the owning
	// contour. They recover space from generous dialogue spacing and try
	// coherent row stacks in wider parts of irregular bubbles, giving page-level
	// assignment collision-free alternatives without painting over manga art.
	return [
		STANDARD_TYPOGRAPHY_PROFILE,
		{ id: 'compact-full', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .75, minimumPadding: 1.5, lineCountScale: 1, verticalBias: 0, penalty: 8 },
		{ id: 'compact-center', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .75, minimumPadding: 1.5, lineCountScale: .75, verticalBias: 0, penalty: 10 },
		{ id: 'compact-upper', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .75, minimumPadding: 1.5, lineCountScale: .75, verticalBias: -1, penalty: 12 },
		{ id: 'compact-lower', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .75, minimumPadding: 1.5, lineCountScale: .75, verticalBias: 1, penalty: 12 },
		// Last-resort automatic dialogue profile. It keeps the same font glyphs and
		// contour validation while recovering padding that detector masks already
		// proved to be white bubble space.
		{ id: 'tight-full', fitMode: 'compact', lineHeightRatio: 1.1, paddingScale: .35, minimumPadding: 1, lineCountScale: 1, verticalBias: 0, penalty: 16 },
		DEGRADED_TYPOGRAPHY_PROFILE
	];
}

type PendingLayoutPlan = {
	work: Promise<OverlayRenderPlanV2>;
	controller: AbortController;
	scopeId: string;
	consumers: number;
	settled: boolean;
};

function topCandidatesForAssignment(candidates: Candidate[], limit = 16): Candidate[] {
	const sorted = [...candidates].sort((left, right) => left.score.total - right.score.total || compareCanonicalText(left.id, right.id));
	if (sorted.length <= limit) return sorted;
	// The stacked-column band scores worse than clean full-footprint
	// candidates in isolation — its value (siblings mutually collide without
	// it) only shows at page level, which per-item scoring cannot see. Keep
	// the best band through the cap by displacing the worst survivor.
	const retainBand = (selection: Candidate[]): Candidate[] => {
		// The band and (under the cells experiment) the cell are each kept
		// separately: both carry page-level value per-item scoring cannot see.
		// Without cells this is exactly the single-band retention it was.
		let kept = selection;
		for (const kind of ['band', 'cell'] as const) {
			const matches = (candidate: Candidate): boolean =>
				kind === 'cell' ? Boolean(candidate.cell) : Boolean(candidate.stackedBand) && !candidate.cell;
			if (kept.some(matches)) continue;
			const best = sorted.find(matches);
			if (!best) continue;
			// Evict the WORST-scored survivor, not whatever happens to sit last.
			// The dedup pass below appends geometry-duplicate backfill after the
			// diversity pass, so the tail is not score-ordered and dropping it can
			// discard a better candidate while a worse one stays. Ties break on the
			// canonical id so the choice stays deterministic.
			let worst = 0;
			for (let index = 1; index < kept.length; index += 1) {
				const delta = kept[index].score.total - kept[worst].score.total;
				if (delta > 0 || (delta === 0 && compareCanonicalText(kept[index].id, kept[worst].id) > 0)) {
					worst = index;
				}
			}
			kept = [...kept.filter((_, index) => index !== worst), best];
		}
		return kept;
	};
	const selected: Candidate[] = [];
	const selectedIds = new Set<string>();
	const geometries = new Set<string>();
	// Preserve placement diversity before retaining typography variants. Keeping
	// only the globally cheapest candidates can otherwise fill the page-level
	// beam with several font sizes at the same free-text rectangle and discard
	// the only collision-free anchor before assignment even begins.
	for (const candidate of sorted) {
		const geometry = canonicalStringify({
			rect: candidate.rect,
			writingMode: candidate.item.writingMode,
			typographyProfileId: candidate.typographyProfileId
		});
		if (geometries.has(geometry)) continue;
		geometries.add(geometry);
		selected.push(candidate);
		selectedIds.add(candidate.id);
		if (selected.length === limit) return retainBand(selected);
	}
	for (const candidate of sorted) {
		if (selectedIds.has(candidate.id)) continue;
		selected.push(candidate);
		if (selected.length === limit) break;
	}
	return retainBand(selected);
}

function collisionRects(candidate: Candidate): Rect[] {
	const ink = candidate.item.lines?.map((line) => line.bounds).filter(isFiniteRect) ?? [];
	return ink.length > 0 ? ink : [candidate.rect];
}

const SOFT_HYPHEN = '­';

/**
 * Everything needed to re-lay-out a chosen candidate at a different font size
 * (page-level harmonization down-clamps outliers after assignment).
 */
type RelayoutContext = {
	rect: Rect;
	profile: TypographyProfile;
	writingMode: OverlayWritingMode;
	contour?: Point[];
	tail?: Point[];
	exclusions?: Point[][];
	layoutText: string;
	fontRuns: FontRunSpec[];
	primary: FontRunSpec;
	direction: OverlayDirection;
	styleKey: string;
	preferredFloor: number;
	/**
	 * The painted rect was derived from the INK, not from this window.
	 *
	 * Free items paint a card tightened onto their own line boxes, so any pass
	 * that re-lays the text out has to recompute it. Refinement grows the font at
	 * the same window; the ink then outgrows a card measured at the old size, and
	 * the plan ships lines outside their own rect — which the fuzz gate catches
	 * as a clipping violation, because that is exactly what it is.
	 */
	tightInk?: boolean;
	paddingRatio?: number;
	/**
	 * The automatic free-text/sfx prominence cap this candidate was sized under
	 * (`automaticFreeTextFontCap`), carried so fill refinement honours it too.
	 * Refinement's ceiling used to be geometry and harmonization alone, and a
	 * short word that won a source-region window grew from the source's own
	 * stroke scale to whatever filled the window — exactly the prominence the
	 * cap exists to forbid. Absent means the cap was infinite (bounded
	 * containers, manual typography, no measurable source).
	 */
	glyphFontCap?: number;
	/**
	 * Growth is bounded by a region the item did not choose — a stacked band —
	 * so the fill refinement can run without a contour to keep the ink honest.
	 *
	 * Refinement used to require a contour outright, which excluded bands over a
	 * free run of vertical columns: `contourBound` is false there by
	 * construction, because the region is the columns' joint footprint rather
	 * than a balloon, so those bands kept whatever the font ladder landed on and
	 * never grew into the space the band reserved for them.
	 *
	 * Deliberately NOT manual rectangles, though they are equally bounded. A
	 * manual rectangle is a single geometry and so already earns the fine
	 * 32-sample ladder; there is no coarse-search deficit to make up. Including
	 * it would only have coupled user-drawn boxes to page-level harmonization,
	 * which can clamp a box the user sized deliberately.
	 *
	 * General free text stays excluded for a stronger reason: its painted card
	 * is the tight ink rect, so growing the font grows a white box into artwork,
	 * and that trade is the scorer's to make, not a refinement's.
	 */
	boundedRegion?: boolean;
};

/**
 * Conservative mimetic-SFX test for label-free pipelines (on-device OCR
 * entries carry no type labels). Katakana-only short text that repeats a
 * 1-3 mora unit (ドキドキ, ゴゴゴ, ザワザワ) or combines elongation/glottal
 * stop with exclamatory punctuation (ドーン!) is classic drawn onomatopoeia.
 * Katakana nouns (カフェ, ケーキ, メニュー) fail both branches, and hiragana
 * is deliberately excluded (もも/ちち are words, not effects).
 */
const MIMETIC_SFX_SHAPE = /^[゠-ヿㇰ-ㇿー々〜~ッ・\s!！?？‼⁉…。]+$/u;
export function looksLikeMimeticSfx(source: string): boolean {
	const text = source.trim();
	if (text.length < 2 || text.length > 14 || !MIMETIC_SFX_SHAPE.test(text)) return false;
	const core = text.replace(/[^゠-ヿㇰ-ㇿ]/gu, '');
	if (core.length < 2) return false;
	for (const unit of [1, 2, 3]) {
		if (core.length >= unit * 2 && core.length % unit === 0) {
			const head = core.slice(0, unit);
			if (core === head.repeat(core.length / unit)) return true;
		}
	}
	return /[ーッ]/u.test(core) && /[!！?？‼⁉…]/u.test(text);
}

/**
 * Whether this item is drawn sound effect rather than regular text.
 *
 * Extracted from the visibility filter because two other policies need the same
 * verdict and must not re-derive it: source-region geometry and column banding
 * are for text a reader reads, and neither should reshape lettering that is
 * part of the artwork. `item.type === 'sfx'` alone is not that verdict — drawn
 * SFX routinely defeats the region classifier, and `borderless` maps to
 * 'unknown', which is ALSO what ordinary unenclosed narration maps to. Treating
 * 'unknown' as SFX wholesale is what would make those policies dead code on
 * real pages; this is the discrimination that already exists.
 */
function isSfxTyped(item: OverlayItemV2, entry: PageTranslationEntry | undefined): boolean {
	// The adapter canonicalizes stored entry types to the region classifier's
	// verdict (adapter.ts canonicalInputEntries), so entry.type === item.type
	// carries no independent provider signal — the LLM's own label is
	// unobservable behind a confident classification. Treat it as unlabeled.
	const entryTypeUnknown = entry?.type === undefined || entry.type === 'unknown'
		|| entry.type === item.type;
	return item.type === 'sfx'
		// Policy-22: the LLM's own 'sfx' label decides even when the region
		// classifier confidently produced another type — 'sign' is the recurring
		// misclassification for drawn lettering.
		|| entry?.type === 'sfx'
		// Prompt-contract self-declared SFX: a translation composed entirely of
		// asterisk-wrapped tokens, unless a confident non-sign classification
		// contradicts it.
		|| ((item.type === 'unknown' || item.type === 'sign')
			&& entryTypeUnknown
			&& ASTERISK_ONLY_SFX.test(entry?.translated_text ?? ''))
		// Label-free pipelines: mimetic source text is the only signal.
		|| (item.type === 'unknown'
			&& entryTypeUnknown
			&& looksLikeMimeticSfx(entry?.original_text ?? ''));
}

/**
 * Policy-22 fill refinement: the candidate ladder samples sizes coarsely
 * (its step can exceed 10pt in a generous balloon), and assignment keeps the
 * best *sampled* size — leaving visible white space a between-rungs size
 * would have used. After assignment, bisect upward between the winning size
 * and the geometry ceiling on the 0.25 grid, re-running the same layout at
 * the SAME rect. A trial is accepted only if it stays inside the contour,
 * introduces no emergency breaks, and its line boxes stay clear of every
 * other placed item's ink (the page-level registry below). Growth is also
 * capped at the harmonization outlier threshold so a grown item can never
 * become a new outlier that harmonizePageFonts would clamp BELOW its
 * pre-refinement size. Degraded/reveal rungs and user-pinned typography are
 * left alone.
 */
const FILL_REFINEMENT_MAX_PROBES = 9;
async function maximizeSelectedFonts(
	selected: PlannedOverlayItemV2[],
	contexts: Map<string, RelayoutContext>,
	items: Map<string, OverlayItemV2>,
	textLayout: TextLayoutPort,
	scopeId: string,
	paddingRatio: number,
	locale: string,
	page: { width: number; height: number },
	yieldBudget: CooperativeYieldBudget
): Promise<void> {
	// Page-level ink registry: growth must never intersect another placed
	// item's line boxes (the eval's ink-collision invariant, and what a reader
	// perceives as overlapping text). Refined items update their own entry so
	// later refinements see the grown ink.
	const inkByItem = new Map<string, Rect[]>();
	for (const planned of selected) {
		if (planned.status === 'placed' && planned.lines?.length) {
			inkByItem.set(planned.itemId, planned.lines.map((line) => line.bounds));
		}
	}
	// Harmonization caps: mirror harmonizePageFonts' grouping and median
	// (computed from the post-harmonize sizes this pass receives) so growth
	// stops at the outlier threshold harmonize itself enforced.
	const harmonyCap = new Map<string, number>();
	{
		const groupSizes = new Map<string, { itemIds: string[]; sizes: number[] }>();
		for (const planned of selected) {
			if (planned.status !== 'placed' || !planned.font || !planned.lines?.length) continue;
			if (planned.fitMode === 'degraded' || planned.fitMode === 'reveal') continue;
			const item = items.get(planned.itemId);
			if (!item || !eligibleDialogue(item)) continue;
			const context = planned.winningCandidateId ? contexts.get(planned.winningCandidateId) : undefined;
			if (!hasOwnedRegion(context) || !context) continue;
			const key = `${context.styleKey}|${planned.writingMode ?? 'horizontal-tb'}`;
			const group = groupSizes.get(key) ?? { itemIds: [], sizes: [] };
			group.itemIds.push(planned.itemId);
			group.sizes.push(planned.font.size);
			groupSizes.set(key, group);
		}
		for (const group of groupSizes.values()) {
			if (group.itemIds.length < HARMONIZATION_MINIMUM_GROUP) continue;
			const sorted = [...group.sizes].sort((a, b) => a - b);
			const median = sorted[Math.floor(sorted.length / 2)];
			const cap = Math.floor((median * (experiments.harmonizationOutlierRatio ?? HARMONIZATION_OUTLIER_RATIO)) / 0.25) * 0.25;
			for (const itemId of group.itemIds) harmonyCap.set(itemId, cap);
		}
	}
	for (const planned of [...selected].sort((a, b) => compareCanonicalText(a.itemId, b.itemId))) {
		if (planned.status !== 'placed' || !planned.font || !planned.lines?.length) continue;
		if (planned.fitMode === 'degraded' || planned.fitMode === 'reveal') continue;
		const item = items.get(planned.itemId);
		if (!item || item.manual.referenceFontSize !== undefined) continue;
		const context = planned.winningCandidateId ? contexts.get(planned.winningCandidateId) : undefined;
		if (!hasOwnedRegion(context) || !context) continue;
		const neighborInk: Rect[] = [];
		for (const [otherId, rects] of inkByItem) {
			if (otherId !== planned.itemId) neighborInk.push(...rects);
		}
		const rect = context.rect;
		const geometryCeiling = quantize(Math.min(128, rect.height * 0.75, rect.width * 0.6), 0.25);
		const ceiling = Math.min(
			geometryCeiling,
			harmonyCap.get(planned.itemId) ?? Infinity,
			// The prominence cap free text was sized under holds through
			// refinement: growth into a generous window must not make the
			// replacement read louder than the lettering it covers.
			context.glyphFontCap ?? Infinity
		);
		let lo = planned.font.size;
		if (ceiling - lo <= 0.25) continue;
		let hi = ceiling;
		let best: { lines: OverlayRenderLineV2[]; lineHeight: number; size: number } | null = null;
		const writingMode = planned.writingMode ?? 'horizontal-tb';
		const attempt = (target: number): { lines: OverlayRenderLineV2[]; lineHeight: number } | null => {
			const lineHeight = quantize(target * context.profile.lineHeightRatio);
			const padding = quantize(Math.max(context.profile.minimumPadding, target * paddingRatio * context.profile.paddingScale));
			const laidOut = writingMode === 'vertical-rl'
				? planVerticalText({
					text: context.layoutText,
					locale,
					rect,
					fontSize: target,
					lineHeight,
					fontRuns: context.fontRuns,
					baseDirection: context.direction,
					textLayout,
					polygon: context.contour,
					tailPolygon: context.tail,
					exclusionPolygons: context.exclusions,
					padding,
					preparedInput: {
						scopeId, text: context.layoutText, locale,
						fontKey: context.primary.fontKey, family: context.primary.family, weight: context.primary.weight,
						families: [...new Set(context.fontRuns.map((run) => run.family))],
						fontSize: target, lineHeight, direction: context.direction, styleKey: context.styleKey
					}
				})
				: horizontalLines({
					text: context.layoutText,
					locale,
					rect,
					polygon: context.contour,
					tailPolygon: context.tail,
					exclusionPolygons: context.exclusions,
					fontSize: target,
					lineHeight,
					padding,
					fontRuns: context.fontRuns,
					direction: context.direction,
					styleKey: context.styleKey,
					scopeId,
					textLayout,
					lineCountScale: context.profile.lineCountScale,
					verticalBias: context.profile.verticalBias
				});
			if (!laidOut.complete || laidOut.lines.length === 0) return null;
			const inside = laidOut.lines.every((line) =>
				line.bounds.x >= rect.x - 1 / 64
				&& line.bounds.y >= rect.y - 1 / 64
				&& line.bounds.x + line.bounds.width <= rect.x + rect.width + 1 / 64
				&& line.bounds.y + line.bounds.height <= rect.y + rect.height + 1 / 64
			);
			if (!inside) return null;
			if (context.contour
				&& !inkInsideContour(laidOut.lines, context.contour, context.tail, padding, writingMode, context.exclusions)) return null;
			// Growth must not degrade wrap quality: a larger font that only fits by
			// chopping words mid-syllable is worse than the smaller clean layout.
			if (laidOut.lines.some((line) => line.breakAfter === 'emergency')) return null;
			const collides = laidOut.lines.some((line) =>
				neighborInk.some((other) => rectIntersectionArea(line.bounds, other) > 1 / 64));
			if (collides) return null;
			return { lines: laidOut.lines, lineHeight };
		};
		for (let probe = 0; probe < FILL_REFINEMENT_MAX_PROBES && hi - lo > 0.25; probe += 1) {
			await yieldBudget.checkpoint();
			const mid = quantize((lo + hi) / 2, 0.25);
			if (mid <= lo || mid > hi) break;
			const fit = attempt(mid);
			if (fit) {
				lo = mid;
				best = { ...fit, size: mid };
			} else {
				hi = quantize(mid - 0.25, 0.25);
			}
		}
		if (best && best.size > planned.font.size) {
			planned.lines = best.lines;
			planned.font = { ...planned.font, size: best.size, lineHeight: best.lineHeight };
			// A card tightened onto the ink was measured at the OLD size. Growing
			// the font without re-tightening ships lines outside their own rect.
			if (context.tightInk) {
				planned.rect = tightInkRect(
					best.lines,
					Math.max(1, quantize(Math.max(
						context.profile.minimumPadding,
						best.size * (context.paddingRatio ?? 0) * context.profile.paddingScale
					))),
					page
				);
			}
			inkByItem.set(planned.itemId, best.lines.map((line) => line.bounds));
		}
	}
}

/** Growth and clamping both apply where the region's extent is not the text's to choose. */
function hasOwnedRegion(context: RelayoutContext | undefined): boolean {
	return Boolean(context && (context.contour || context.boundedRegion));
}

/**
 * Whether re-laid-out lines stay inside the region a context owns.
 *
 * A balloon owns its contour and the scanline test decides. A stacked band
 * or a source-region window owns a rectangle and nothing else — there is no
 * contour to consult, and reaching for one is the crash `hasOwnedRegion`
 * made possible: it admits both kinds, so every pass it gates has to be able
 * to check both kinds.
 */
function inkInsideOwnedRegion(
	lines: OverlayRenderLineV2[],
	context: RelayoutContext,
	padding: number,
	writingMode: OverlayWritingMode
): boolean {
	if (context.contour) {
		return inkInsideContour(lines, context.contour, context.tail, padding, writingMode, context.exclusions);
	}
	const rect = context.rect;
	return lines.every((line) =>
		line.bounds.x >= rect.x - 1 / 64
		&& line.bounds.y >= rect.y - 1 / 64
		&& line.bounds.x + line.bounds.width <= rect.x + rect.width + 1 / 64
		&& line.bounds.y + line.bounds.height <= rect.y + rect.height + 1 / 64
	);
}

/**
 * How far above the page median a same-style placement may sit before it is
 * pulled back, and how far back it is pulled.
 *
 * These were 1.25/1.20, and the clamp is score-blind: it checks only that the
 * text still fits and stays inside the contour, so it will move an item to a
 * size the beam had ranked far worse. Measured on a real page, a two-word
 * balloon the beam sized at 89.0 -- with 99 already accepted as fitting at that
 * geometry -- came out at 57.75, eleven percent ink in its own balloon.
 *
 * 1.60/1.45 is the smallest widening that fully unclamps the real cases: on
 * nine pages and 22 items only two move at all, both of them short utterances
 * in generous balloons, and neither exceeds its own balloon. It is still a real
 * ceiling -- 2.00/1.70 is indistinguishable from switching harmonization off.
 *
 * There is no lower bound here and there should not be. This clamp only ever
 * shrinks; `maximizeSelectedFonts` already grows every eligible placement as
 * far as its geometry allows, so a lower clamp could only overflow balloons.
 */
export const HARMONIZATION_OUTLIER_RATIO = 1.6;
export const HARMONIZATION_TARGET_RATIO = 1.45;
export const HARMONIZATION_MINIMUM_GROUP = 3;

/**
 * Page-level font harmonization: same-style dialogue in a region someone owns
 * — a balloon contour, a stacked band, a rectangle the user drew — is clamped
 * toward the page median so one two-word bubble cannot tower over its
 * neighbors. Down-clamp only — shrinking is collision-monotone, so placements
 * chosen by assignment stay valid without re-running the beam.
 *
 * The membership test matches the fill refinement's exactly, and must: a
 * placement allowed to GROW without also being subject to the median clamp can
 * end up the one item towering over the page, which is the thing this exists to
 * prevent.
 */
function harmonizePageFonts(
	selected: PlannedOverlayItemV2[],
	contexts: Map<string, RelayoutContext>,
	items: Map<string, OverlayItemV2>,
	textLayout: TextLayoutPort,
	scopeId: string,
	paddingRatio: number,
	locale: string,
	page: { width: number; height: number }
): void {
	type Member = { planned: PlannedOverlayItemV2; context: RelayoutContext };
	const groups = new Map<string, Member[]>();
	for (const planned of selected) {
		if (planned.status !== 'placed' || !planned.font || !planned.lines?.length) continue;
		if (planned.fitMode === 'degraded' || planned.fitMode === 'reveal') continue;
		const item = items.get(planned.itemId);
		if (!item || !eligibleDialogue(item)) continue;
		const context = planned.winningCandidateId ? contexts.get(planned.winningCandidateId) : undefined;
		if (!hasOwnedRegion(context) || !context) continue;
		const key = `${context.styleKey}|${planned.writingMode ?? 'horizontal-tb'}`;
		const members = groups.get(key) ?? [];
		members.push({ planned, context });
		groups.set(key, members);
	}
	for (const key of [...groups.keys()].sort((left, right) => compareCanonicalText(left, right))) {
		const members = groups.get(key)!;
		if (members.length < HARMONIZATION_MINIMUM_GROUP) continue;
		const sizes = members.map((member) => member.planned.font!.size).sort((a, b) => a - b);
		const median = sizes[Math.floor(sizes.length / 2)];
		if (import.meta.env?.VITE_FUMETO_DEBUG_HARMONIZE) {
			console.info(`sample-stage:harmonize:${scopeId}|${key}|median=${median}|${members.map((m) => `${m.planned.itemId}:${m.planned.font!.size}`).join(',')}`);
		}
		for (const member of [...members].sort((a, b) => compareCanonicalText(a.planned.itemId, b.planned.itemId))) {
			const current = member.planned.font!.size;
			// Widening this band from 1.25 to 1.60 was policy-27's least
			// falsifiable change: the sweep showed only two items on nine pages
			// moving at all. Counting how often it still binds is how that stays
			// checkable as the corpus grows.
			if (!recordGateResult('harmonization-outlier', current > median * (experiments.harmonizationOutlierRatio ?? HARMONIZATION_OUTLIER_RATIO), median > 0 ? current / median : undefined)) continue;
			const target = Math.max(
				quantize(median * HARMONIZATION_TARGET_RATIO, 0.25),
				member.context.preferredFloor
			);
			if (target >= current) continue;
			const context = member.context;
			const lineHeight = quantize(target * context.profile.lineHeightRatio);
			const padding = quantize(Math.max(context.profile.minimumPadding, target * paddingRatio * context.profile.paddingScale));
			const laidOut = member.planned.writingMode === 'vertical-rl'
				? planVerticalText({
					text: context.layoutText,
					locale,
					rect: context.rect,
					fontSize: target,
					lineHeight,
					fontRuns: context.fontRuns,
					baseDirection: context.direction,
					textLayout,
					polygon: context.contour,
					tailPolygon: context.tail,
					exclusionPolygons: context.exclusions,
					padding,
					preparedInput: {
						scopeId, text: context.layoutText, locale,
						fontKey: context.primary.fontKey, family: context.primary.family, weight: context.primary.weight,
						families: [...new Set(context.fontRuns.map((run) => run.family))],
						fontSize: target, lineHeight, direction: context.direction, styleKey: context.styleKey
					}
				})
				: horizontalLines({
					text: context.layoutText,
					locale,
					rect: context.rect,
					polygon: context.contour,
					tailPolygon: context.tail,
					exclusionPolygons: context.exclusions,
					fontSize: target,
					lineHeight,
					padding,
					fontRuns: context.fontRuns,
					direction: context.direction,
					styleKey: context.styleKey,
					scopeId,
					textLayout,
					lineCountScale: context.profile.lineCountScale,
					verticalBias: context.profile.verticalBias
				});
			if (!laidOut.complete || laidOut.lines.length === 0) continue;
			// Containment is checked against the region the member OWNS. For a
			// balloon that is its contour. For a stacked band or the
			// height-locked window over an unenclosed vertical run — the
			// regions policy-26 admitted here — there is no contour, and the
			// check that pretended there was one (`context.contour!`) threw
			// "Cannot read properties of undefined (reading 'map')" out of the
			// planner on the first such outlier, which the reader reported as
			// "Layout failed" for every box on the page. The fill refinement
			// beside this pass guards the same call the same way.
			if (!inkInsideOwnedRegion(laidOut.lines, context, padding, member.planned.writingMode ?? 'horizontal-tb')) continue;
			member.planned.lines = laidOut.lines;
			member.planned.font = { ...member.planned.font!, size: target, lineHeight };
			// Same contract as the fill refinement: shrinking leaves an ink-derived
			// card too large rather than too small, but a card that no longer
			// matches its own text is a lie either way.
			if (context.tightInk) {
				member.planned.rect = tightInkRect(laidOut.lines, Math.max(1, padding), page);
			}
		}
	}
}

/**
 * Map line/run sourceRanges computed against soft-hyphenated layout text back
 * to indices in the original translation text, and strip embedded soft
 * hyphens from painted strings (pretext already renders the visible '-' on
 * hyphenated breaks as part of the run text).
 */
function remapLinesToOriginal(
	lines: OverlayRenderLineV2[],
	insertedAt: number[],
	originalText: string,
	locale: string
): OverlayRenderLineV2[] {
	const boundaries = [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(originalText)]
		.map((segment) => segment.index);
	const graphemeAt = (utf16: number): number => {
		let low = 0;
		let high = boundaries.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (boundaries[mid] < utf16) low = mid + 1;
			else high = mid;
		}
		return low;
	};
	const mapUtf16 = (index: number): number => originalIndexFor(index, insertedAt);
	return lines.map((line) => ({
		...line,
		text: line.text.split(SOFT_HYPHEN).join(''),
		sourceRange: {
			startUtf16: mapUtf16(line.sourceRange.startUtf16),
			endUtf16: mapUtf16(line.sourceRange.endUtf16),
			startGrapheme: graphemeAt(mapUtf16(line.sourceRange.startUtf16)),
			endGrapheme: graphemeAt(mapUtf16(line.sourceRange.endUtf16))
		},
		runs: line.runs.map((run) => ({
			...run,
			text: run.text.split(SOFT_HYPHEN).join(''),
			sourceRange: {
				startUtf16: mapUtf16(run.sourceRange.startUtf16),
				endUtf16: mapUtf16(run.sourceRange.endUtf16)
			}
		}))
	}));
}

function containerPairKey(left: string, right: string): string {
	return compareCanonicalText(left, right) <= 0 ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Pair relation for page-level assignment. Two exemptions make place-always
 * structural: reveal candidates have no inline ink (text renders in a popover),
 * and two contour-bound candidates in DIFFERENT containers cannot truly collide
 * when their contours are disjoint or erosion separated them. Near-duplicate
 * container pairs (overlap ratio above the erosion cap) keep full collision
 * resolution — their ink genuinely shares space.
 */
function pairRelation(
	left: Candidate,
	right: Candidate,
	nearDuplicatePairs: ReadonlySet<string>
): { overlap: boolean; gap: number } {
	if (left.typographyProfileId === 'reveal' || right.typographyProfileId === 'reveal') {
		return { overlap: false, gap: Number.POSITIVE_INFINITY };
	}
	if (left.contourBound && right.contourBound
		&& left.containerId && right.containerId
		&& left.containerId !== right.containerId
		&& !nearDuplicatePairs.has(containerPairKey(left.containerId, right.containerId))) {
		return { overlap: false, gap: candidateRelation(left, right).gap };
	}
	return candidateRelation(left, right);
}

function candidateRelation(left: Candidate, right: Candidate): { overlap: boolean; gap: number } {
	const rectangleOverlap = rectIntersectionArea(left.rect, right.rect);
	const rectangleGap = rectGap(left.rect, right.rect);
	// Planned ink is contained by its candidate rectangle. Most page-level
	// pairs are spatially distant, so resolve both collision and clearance from
	// their outer bounds without walking every line box.
	if (rectangleOverlap <= 1 / 64 && rectangleGap >= 4) return { overlap: false, gap: rectangleGap };
	const leftInk = collisionRects(left);
	const rightInk = collisionRects(right);
	const overlap = rectangleOverlap > 1 / 64
		&& leftInk.some((leftRect) => rightInk.some((rightRect) => rectIntersectionArea(leftRect, rightRect) > 1 / 64));
	let gap = Number.POSITIVE_INFINITY;
	for (const leftRect of leftInk) for (const rightRect of rightInk) gap = Math.min(gap, rectGap(leftRect, rightRect));
	return { overlap, gap: Number.isFinite(gap) ? gap : rectangleGap };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException('Overlay planning cancelled', 'AbortError');
}

function entryText(item: OverlayItemV2, translations: Map<string, PageTranslationEntry>): string {
	return item.manual.textOverride ?? translations.get(item.translationEntryId)?.translated_text ?? '';
}

function sourceRect(item: OverlayItemV2, input: OverlayLayoutInput): Rect | null {
	const sources = item.sourceIds
		.map((id) => input.document.sources.find((source) => source.id === id))
		.filter((source) => source !== undefined);
	if (sources.length === 0) return null;
	const left = Math.min(...sources.map((source) => source.bounds.x));
	const top = Math.min(...sources.map((source) => source.bounds.y));
	const right = Math.max(...sources.map((source) => source.bounds.x + source.bounds.width));
	const bottom = Math.max(...sources.map((source) => source.bounds.y + source.bounds.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

function candidateRects(item: OverlayItemV2, input: OverlayLayoutInput, writingMode: OverlayWritingMode): Rect[] {
	const page = input.document.sourceImage;
	if (item.manual.rect) return [{ ...item.manual.rect }];
	const container = input.document.containers.find((candidate) => candidate.id === item.containerId);
	const bounds = container ? polygonBounds(container.polygon) : sourceRect(item, input);
	if (!bounds) return [];
	if (container && container.kind !== 'free') {
		// A clipped edge bubble keeps its page-space contour. Moving the full
		// bounds inward would disconnect the candidate from that contour and let
		// scanline intervals escape the page. Use the visible intersection.
		const clip = (rect: Rect): Rect | null => {
			const left = Math.max(0, rect.x);
			const top = Math.max(0, rect.y);
			const right = Math.min(page.width, rect.x + rect.width);
			const bottom = Math.min(page.height, rect.y + rect.height);
			return right > left && bottom > top
				? { x: quantize(left), y: quantize(top), width: quantize(right - left), height: quantize(bottom - top) }
				: null;
		};
		const bbox = clip(bounds);
		if (!bbox) return [];
		const rects = [bbox];
		// Two-lobe ("peanut") bubbles additionally offer one tight rect per
		// lobe, so scoring judges occupancy per lobe, each item gravitates to
		// the lobe nearest its own source, and two items sharing a container
		// settle in different lobes through normal collision handling. The
		// bbox stays at index 0 — the reveal fallback and the primary
		// geometry take the first rect. Gated to the contour-bound path
		// (mirrors the predicate that sets contourPolygon in the fit loop).
		// A container holding a span-cap continuation — one sentence the
		// grouper had to cut — offers no per-lobe rects: they would seat the
		// halves side by side, and the second half would read first. Its
		// members keep the bbox and the band stack, nothing that carves.
		const continuation = input.document.items.some((candidate) =>
			candidate.containerId === container.id && candidate.continuesPrevious === true);
		if (!continuation && input.settings.mode === 'bubble-segmentation' && isSimplePolygon(container.polygon)) {
			const split = polygonWaistSplit(container.polygon);
			if (split) {
				for (const lobe of split.lobes) {
					const clipped = clip(lobe);
					if (clipped) rects.push(clipped);
				}
			}
		}
		return rects;
	}

	type ShapeFamily = 'width-biased' | 'height-biased';
	const preferred: ShapeFamily = writingMode === 'vertical-rl' ? 'height-biased' : 'width-biased';
	const reciprocal: ShapeFamily = preferred === 'width-biased' ? 'height-biased' : 'width-biased';
	const seen = new Set<string>();
	const result: Rect[] = [];
	const add = (factor: number, family: ShapeFamily, anchor: -1 | 0 | 1): void => {
		const orthogonal = Math.max(1, Math.sqrt(factor));
		const widthFactor = family === 'width-biased' ? factor : orthogonal;
		const heightFactor = family === 'height-biased' ? factor : orthogonal;
		const width = bounds.width * widthFactor;
		const height = bounds.height * heightFactor;
		let x = bounds.x - (width - bounds.width) / 2;
		let y = bounds.y - (height - bounds.height) / 2;
		if (family === 'width-biased') {
			if (anchor < 0) x = bounds.x;
			else if (anchor > 0) x = bounds.x + bounds.width - width;
		} else {
			if (anchor < 0) y = bounds.y;
			else if (anchor > 0) y = bounds.y + bounds.height - height;
		}
		const expanded = clampRect({ x, y, width, height }, page.width, page.height);
		const key = canonicalStringify(expanded);
		if (seen.has(key)) return;
		seen.add(key);
		result.push(expanded);
	};
	if (item.type === 'sfx') {
		// Automatic SFX stays centered on its source and uses only compact shape
		// families. A manual rectangle remains fully user-authoritative above.
		add(1, preferred, 0);
		for (const factor of [1.2, 1.45]) {
			add(factor, preferred, 0);
			add(factor, reciprocal, 0);
		}
		return result;
	}
	// The preferred aspect family gets edge/center anchors; the reciprocal
	// family stays available as a centered fallback for awkward source shapes.
	// This yields at most 21 source-containing rectangles, so eight font samples
	// evaluate every shape well inside the 256-candidate item budget.
	add(1, preferred, 0);
	for (const factor of [1.2, 1.45]) {
		for (const anchor of [-1, 0, 1] as const) add(factor, preferred, anchor);
		add(factor, reciprocal, 0);
	}
	for (const family of [preferred, reciprocal]) add(1.75, family, 0);
	for (const anchor of [-1, 0, 1] as const) add(2.1, preferred, anchor);
	add(2.1, reciprocal, 0);
	// Free text paints only its final tight ink card (not these search windows),
	// so broader source-anchored windows can safely find readable line breaks and
	// collision-free nearby whitespace without creating page-sized white boxes.
	for (const anchor of [-1, 0, 1] as const) add(2.6, preferred, anchor);
	add(2.6, reciprocal, 0);
	for (const family of [preferred, reciprocal]) add(3.2, family, 0);
	return result;
}

/**
 * A column is vertical text when it is this many times taller than it is wide.
 *
 * Measured against the labelled real pages, on
 * the same quantity the code compares — the MEDIAN of the item's own per-column
 * height/width:
 *
 *   should not fire   n=2    0.139 .. 0.593
 *   should fire       n=34   1.178 .. 15.500
 *
 * 1.8 sat INSIDE the positive population, above two of its 34 members
 * (set-5/30 r0 at 1.178, and 'Short line in a big balloon' r0 at 1.787 — a
 * hair). That is the same structural defect policy-27 catalogued five of: a
 * threshold outside the range real material occupies, here on the wrong side of
 * its own positives. The direction of the fix rests on the 34-strong positive
 * population alone and does not need the negative side at all.
 *
 * 0.85 is the middle of the plateau 0.6..1.1, every value of which scores 36/36.
 * Not the top edge, even though "square" (1.0) has a tidy physical reading: the
 * side that could plausibly move toward the boundary is the POSITIVE one, since
 * a two-character vertical run is nearly square, while horizontal lines of
 * Japanese sit far below (the one real negative is display SFX at 0.593; a plain
 * horizontal line measures ~0.23). So the room belongs below the lowest positive,
 * not above the highest negative.
 *
 * The negative population is n=2 and will stay thin: horizontal-set text is
 * genuinely rare in Japanese manga, so this is a property of the material and
 * not a gap more annotation closes. What bounds the risk instead is reach — this
 * fallback runs only when `sourceWritingMode` is undefined, which the adapter
 * produces for a 'rotated' run or a record written before the field existed.
 */
const VERTICAL_COLUMN_ASPECT = 0.85;

/**
 * Whether an item's detected source is a run of vertical columns.
 *
 * One verdict, three callers — `writingModes`, `stackedColumnBands` and the
 * source-region family below all have to agree, and a third threshold invented
 * in any one of them is a bug waiting to happen. The grouper's own
 * classification decides when it has one; the aspect fallback below covers
 * records written before `sourceWritingMode` existed and regions the grouper
 * could only call 'rotated'.
 *
 * The fallback measures the individual COLUMNS, not their union. The union was
 * the wrong quantity: one column of vertical text is always far taller than it
 * is wide, but a BLOCK of several columns is not — a nine-column balloon is
 * nearly square. Measured over the corpus's sixteen vertical regions, the union
 * aspect misses seven of them (0.59, 0.90, 0.97, 1.01, 1.61, 1.71 and one at
 * 0.14), while the median column aspect clusters at 7.2–15.5 against 0.14 for
 * genuinely horizontal text. Same threshold, right measurement.
 */
function hasVerticalSource(
	item: OverlayItemV2,
	source: Rect | null,
	columns?: readonly Rect[]
): boolean {
	if (item.sourceWritingMode) {
		recordGate('source-verticality-declared', 'fired');
		return item.sourceWritingMode === 'vertical-rl';
	}
	recordGate('source-verticality-declared', 'declined');
	const measured = columns?.length ? columns : source ? [source] : [];
	if (measured.length === 0) return false;
	const aspects = measured
		.map((rect) => (rect.width > 0 ? rect.height / rect.width : 0))
		.sort((left, right) => left - right);
	// Median, not mean: one spurious column from a detector split should not
	// decide the verdict for the run.
	const median = aspects[Math.floor(aspects.length / 2)];
	// Counted with the fallback distinguished from the grouper's own verdict:
	// this threshold was right and the quantity it compared was wrong, and only
	// the fallback path ever compared anything.
	return recordGateResult('source-verticality-aspect', median >= VERTICAL_COLUMN_ASPECT, median);
}

/** The item's own detected column rectangles, in document order. */
function sourceColumns(item: OverlayItemV2, input: OverlayLayoutInput): Rect[] {
	return item.sourceIds
		.map((id) => input.document.sources.find((candidate) => candidate.id === id)?.bounds)
		.filter((rect): rect is Rect => rect !== undefined);
}

/**
 * Width multipliers for the height-locked source-region family.
 *
 * Measured on real pages: a four-column narration group (380x590) is fully
 * usable at x1 and reaches 45px at x2; a single column (100x485) cannot hold
 * horizontal text at ANY readable size until about x2. So the ladder has to
 * start at 1 and reach past 3, and scoring picks — a narrow member simply finds
 * every window below x2 infeasible.
 */
const SOURCE_REGION_WIDTH_FACTORS = [1, 1.4, 1.9, 2.5, 3.2] as const;

/**
 * Widest gap, as a multiple of the COLUMN width, at which two unenclosed
 * vertical runs are still read as one block and share a band stack.
 *
 * The gap used to be divided by the narrower ITEM's width — a single column
 * for a one-column item and a whole block for a five-column one — so the same
 * gutter measured 1.9 on one page and 0.3 on the next. Measured per column
 * width, which is the grouper's own glyph unit, the true runs on the reviewed
 * real-manga pages sit at −2.6 … 1.1 (the overlapping ones are exactly the ones
 * that must share) and the one pair of blocks a letterer reads separately
 * (a page where a character is drawn between the blocks) sits at 7.9. The
 * grouper merges columns at 2.1 of this unit; 2.5 clears every run with margin
 * and is a third of the way to the nearest block. The audit names both sides.
 */
export const FREE_COLUMN_ADJACENCY_RATIO = 2.5;

/**
 * Side-by-side carve of a shared balloon (policy-30).
 *
 * Two neighbouring utterances are arranged along x when their centres are at
 * least this fraction of the narrower one's width apart. Measured on the
 * reviewed pages: the carved pair on a reviewed page sits at 1.6, and the
 * grouper's own gutter gate keeps fragments of one utterance out of this path
 * altogether (see `continuesPrevious`). A cell must seat a short paragraph —
 * two floor line boxes tall, about five ems across — and hold its member's
 * text at the floor with a margin; anything less falls back to the bands.
 */
export const CELL_SEPARATION_RATIO = 0.3;
export const CELL_MIN_WIDTH_LINES = 4;
export const CELL_MIN_HEIGHT_LINES = 2;
export const CELL_CAPACITY_MARGIN = 1.3;

/**
 * Height-locked windows over an unbounded item's own source columns.
 *
 * A vertical run is tall and narrow; its English is wide and short. Every
 * existing free family scales the orthogonal axis by sqrt(factor), so there has
 * never been a candidate that widens WITHOUT also growing taller, and the
 * winning card therefore lands inside the run rather than over it — measured at
 * 45% and 17% of the source region covered on two real pages, with the Japanese
 * still legible above and below the English.
 *
 * These windows keep the source's vertical extent and widen about its centre;
 * `clampRect` slides one near the page edge inward rather than truncating it.
 * They are additional candidates, so a genuinely better window elsewhere still
 * wins on score.
 *
 * Not for sound effects: `automaticFreeTextFontCap` and
 * `exceedsAutomaticSfxProminence` exist to stop replacement lettering
 * dominating a panel, and a source-locked box fights both.
 */
function sourceRegionWindows(
	item: OverlayItemV2,
	input: OverlayLayoutInput,
	container: OverlayContainerV2 | undefined,
	writingMode: OverlayWritingMode,
	entry: PageTranslationEntry | undefined
): Rect[] {
	if (writingMode !== 'horizontal-tb') return [];
	if (item.manual.rect || isSfxTyped(item, entry)) return [];
	if (!recordGateResult('source-region-free-container', !container || container.kind === 'free')) return [];
	const source = sourceRect(item, input);
	// The height-locked family itself: this is what put English over the
	// Japanese it replaces instead of beside it, and it exists only for a
	// vertical source.
	const vertical = source !== null && hasVerticalSource(item, source, sourceColumns(item, input));
	if (!recordGateResult('source-region-windows', vertical) || !source) return [];
	const page = input.document.sourceImage;
	const seen = new Set<string>();
	const result: Rect[] = [];
	for (const factor of SOURCE_REGION_WIDTH_FACTORS) {
		const width = Math.min(page.width, source.width * factor);
		const rect = clampRect(
			{ x: source.x - (width - source.width) / 2, y: source.y, width, height: source.height },
			page.width,
			page.height
		);
		const key = canonicalStringify(rect);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(rect);
	}
	return result;
}

/**
 * Ordered stacking for translations that must share one region.
 *
 * Under force-horizontal, a CJK bubble whose columns did not merge into one
 * group yields multiple items competing for the same footprint. Full-width
 * candidates can never coexist, so assignment used to hand the space to one
 * item and demote the rest to tap-to-reveal — in arbitrary reading order.
 * This emits one additional candidate per item: a horizontal band of the
 * shared region, assigned in reading order (item.order, direction-corrected
 * upstream) so the stack reads top to bottom. Bands are ADDITIONAL candidates —
 * the beam still prefers anything better — but any feasible stack beats a
 * reveal demotion by construction (REVEAL_SCORE_TOTAL).
 *
 * **Bands are proportioned by usable AREA, not by height.** Dividing the
 * region's height by character share is only correct if the region is a
 * rectangle, and a balloon is not one: a band across the waist of a conjoined
 * bubble, or across the top of an ellipse, holds a fraction of the ink that a
 * mid-body band of the same height does. Equal character counts therefore
 * bought wildly unequal space, and the short-changed member either shrank to
 * fit or fell out to reveal — the exact failure the stack exists to prevent.
 * `partitionByDemand` integrates the contour's own width profile, and snaps
 * boundaries onto necks, so a two-utterance conjoined bubble breaks at the
 * join with one utterance per lobe. That subsumes the old special case which
 * skipped band emission for two-lobe containers and left the lobes to be
 * matched by collision alone.
 *
 * A stack does not need holding together by scoring. Inside a container it
 * cannot come apart: a band is a subset of the container's own bbox, so the two
 * candidates collide and the beam has to choose one arrangement or the other.
 * For a free column run it could in principle, and a pairwise affinity bonus
 * was written for that — but it changed no outcome in any case that could be
 * constructed, including a beam of 1, so it is not here. Where it WOULD visibly
 * matter is where a member has genuinely better space of its own, and forcing
 * the stack there would be the wrong answer.
 *
 * Two shapes qualify:
 * - two or more automatic dialogue items sharing one detected bubble;
 * - a run of horizontally adjacent FREE items whose sources are vertical
 *   columns (sourceWritingMode, with the same conservative aspect fallback
 *   writingModes() uses for pre-policy-10 records). The band stays within
 *   the run's joint footprint; like every grown free candidate its art risk
 *   is arbitrated by boxGrowth and protected-art scoring, and the adjacency
 *   gap is kept tight so the strip between columns stays small. Items in
 *   different detected bubbles never coalesce — separate balloons are
 *   separate utterances.
 */
interface StackedBand {
	rect: Rect;
	contourBound: boolean;
}

/** Slices of the region sampled to build its usable-width profile. */
const BAND_PROFILE_SLICES = 64;

/** Region-anchored geometries for items that share a region: the reading-order band, and (experiment) the source-anchored cell. */
interface StackedRegions {
	bands: Map<string, StackedBand>;
	cells: Map<string, StackedBand>;
}

function stackedColumnBands(
	resolved: Array<{ item: OverlayItemV2; text: string }>,
	input: OverlayLayoutInput,
	minimumBandHeight: number,
	translations: Map<string, PageTranslationEntry>
): StackedRegions {
	const page = input.document.sourceImage;
	const result = new Map<string, StackedBand>();
	const cells = new Map<string, StackedBand>();
	const carve = !experiments.legacySharedRegions;

	/**
	 * Source-anchored cells for utterances set SIDE BY SIDE in one balloon
	 * (policy-30).
	 *
	 * A band divides the shared region top-to-bottom by demand and hands the
	 * slices out in reading order, which is right when the utterances are
	 * stacked and wrong when they sit side by side: the first utterance's band
	 * then spans BOTH lobes of a conjoined balloon and the second is squeezed
	 * under it. Lobe detection cannot rescue this on a real page — no shared
	 * balloon in the reviewed corpus shows a neck on its detector contour at any
	 * ratio up to 0.95; the mask contour smooths the join away. The sources
	 * already say where each utterance belongs: when the members' centres
	 * spread more along x than y, the balloon is carved at each gap between
	 * neighbouring sources, one cell per member, and each member gets its cell
	 * and nothing else (a cell offered beside the whole-balloon window loses to
	 * it in the beam and is starved by the sampling budget before that).
	 *
	 * Stacked utterances keep the demand bands: measured a wash either way, and
	 * the bands already snap to a neck where one is detectable. Fragments of one
	 * utterance the grouper split by its span cap arrive marked
	 * `continuesPrevious` and keep the bands too — two halves of a sentence set
	 * side by side would read left half first.
	 */
	const emitCells = (
		members: Array<{ item: OverlayItemV2; text: string }>,
		bounds: Rect,
		contourBound: boolean
	): void => {
		if (!carve || members.length < 2) return;
		if (members.some(({ item }) => item.continuesPrevious)) return;
		const sources = members.map((member) => ({ member, source: sourceRect(member.item, input), columns: sourceColumns(member.item, input) }));
		if (sources.some(({ source }) => !source)) return;
		const clip = (rect: Rect): Rect | null => {
			const clipped = clampRect(rect, page.width, page.height);
			return clipped.width > 0 && clipped.height > 0 ? clipped : null;
		};
		const centre = (rect: Rect, axis: 'x' | 'y') => axis === 'x' ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
		const extent = (rect: Rect, axis: 'x' | 'y') => axis === 'x' ? rect.width : rect.height;
		// The axis the utterances are arranged along is the one their CENTRES
		// spread on most. Narrow tall columns are disjoint along x almost
		// whenever two vertical utterances are not in one stack, so a
		// "disjoint along x" test carves a diagonal pair side to side when it
		// reads top to bottom.
		const spread = (axis: 'x' | 'y') => {
			const values = sources.map(({ source }) => centre(source!, axis));
			return Math.max(...values) - Math.min(...values);
		};
		if (!recordGateResult('cell-arrangement', spread('x') >= spread('y'), spread('y') > 0 ? spread('x') / spread('y') : undefined)) return;
		const axes: Array<'x'> = ['x'];
		const demand = (member: { text: string }) => Math.max(1, [...member.text].length);
		for (const axis of axes) {
			const sorted = [...sources].sort((left, right) => centre(left.source!, axis) - centre(right.source!, axis));
			const lo = axis === 'x' ? bounds.x : bounds.y;
			const hi = axis === 'x' ? bounds.x + bounds.width : bounds.y + bounds.height;
			const cuts: number[] = [];
			let ordered = true;
			for (let index = 0; index + 1 < sorted.length; index += 1) {
				const a = sorted[index].source!;
				const b = sorted[index + 1].source!;
				// Two sources count as arranged along this axis when their centres
				// are apart by a real fraction of the smaller one. Their boxes may
				// overlap: for a balloon the whitewash is the contour and for a free
				// run the cells tile the region, so a cut through a source erases
				// nothing it should not.
				const separation = (centre(b, axis) - centre(a, axis)) / Math.max(1, Math.min(extent(a, axis), extent(b, axis)));
				if (!recordGateResult('cell-separation', separation >= CELL_SEPARATION_RATIO, separation)) { ordered = false; break; }
				// The cut lives in the zone between a's far edge and b's near edge —
				// a gap or an overlap — and is positioned inside it by how much
				// text each side has to seat, which is what the demand bands do
				// for a stacked pair and what a midpoint cannot.
				const aEnd = axis === 'x' ? a.x + a.width : a.y + a.height;
				const bStart = axis === 'x' ? b.x : b.y;
				const zoneStart = Math.min(aEnd, bStart);
				const zoneEnd = Math.max(aEnd, bStart);
				const share = demand(sorted[index].member) / (demand(sorted[index].member) + demand(sorted[index + 1].member));
				cuts.push(Math.min(centre(b, axis), Math.max(centre(a, axis), zoneStart + share * (zoneEnd - zoneStart))));
			}
			if (!ordered) continue;
			const edges = [lo, ...cuts, hi];
			const rects = sorted.map((_, index) => {
				const start = quantize(Math.max(lo, edges[index]));
				const end = quantize(Math.min(hi, edges[index + 1]));
				return axis === 'x'
					? { x: start, y: quantize(bounds.y), width: end - start, height: quantize(bounds.y + bounds.height) - quantize(bounds.y) }
					: { x: quantize(bounds.x), y: start, width: quantize(bounds.x + bounds.width) - quantize(bounds.x), height: end - start };
			}).map(clip);
			// A cell must be able to seat a short paragraph: two line boxes at the
			// floor, about five ems across. Anything smaller is a sliver — a member
			// whose source lies mostly outside the region gets one — and the bands
			// give such a member a proper line where a cell cannot.
			if (!recordGateResult('cell-extent', rects.every((rect) => rect && rect.width >= CELL_MIN_WIDTH_LINES * minimumBandHeight && rect.height >= CELL_MIN_HEIGHT_LINES * minimumBandHeight))) continue;
			// A cell that cannot hold its member's text at the readability floor
			// is worse than the band it would replace. Rough capacity at the
			// floor: one line box per `minimumBandHeight`, glyphs at ~0.4 of it;
			// a contour-bound cell keeps about three quarters of its slab.
			const feasible = sorted.every(({ member }, index) => {
				const rect = rects[index]!;
				const lines = Math.floor(rect.height / minimumBandHeight);
				const perLine = rect.width / (0.4 * minimumBandHeight);
				const capacity = lines * perLine * (contourBound ? 0.75 : 1);
				return capacity >= CELL_CAPACITY_MARGIN * demand(member);
			});
			if (!recordGateResult('cell-capacity', feasible)) continue;
			sorted.forEach(({ member }, index) => cells.set(member.item.id, { rect: rects[index]!, contourBound }));
			return;
		}
	};
	const eligible = resolved.filter(({ item, text }) =>
		text.length > 0
		&& !item.manual.rect
		// Excluding every 'unknown' item made the free-column-run path below dead
		// code on real pages: `borderless` — ordinary unenclosed narration, the
		// exact text a column run is — maps to 'unknown' in the adapter, the same
		// as misclassified drawn lettering. `isSfxTyped` is the discrimination
		// that already exists for deciding whether to render such an item at all.
		&& !recordGateResult('band-eligibility-sfx', isSfxTyped(item, translations.get(item.translationEntryId)))
		// A member whose mode list excludes horizontal-tb (user pinned the
		// box vertical) can never use a band — counting it would reserve a
		// phantom slot that shrinks its siblings' bands.
		&& writingModes(item, sourceRect(item, input), input).includes('horizontal-tb'));
	if (eligible.length < 2) return { bands: result, cells };
	const rank = (
		left: { item: OverlayItemV2 },
		right: { item: OverlayItemV2 }
	) => (left.item.order - right.item.order) || compareCanonicalText(left.item.id, right.item.id);

	const emitBands = (
		members: Array<{ item: OverlayItemV2; text: string }>,
		bounds: Rect,
		contourBound: boolean,
		contour: Point[] | undefined
	): void => {
		if (members.length < 2) return;
		const clipLeft = Math.max(0, bounds.x);
		const clipTop = Math.max(0, bounds.y);
		const clipRight = Math.min(page.width, bounds.x + bounds.width);
		const clipBottom = Math.min(page.height, bounds.y + bounds.height);
		if (!(clipRight > clipLeft && clipBottom > clipTop)) return;
		// Quantize edges and take differences (never quantize spans
		// independently) so the final band's bottom can never round past the
		// page edge and fail rectInside by 1/64.
		const bandLeft = quantize(clipLeft);
		const bandWidth = quantize(clipRight) - bandLeft;
		if (!(bandWidth > 0)) return;
		const region: Rect = {
			x: bandLeft,
			y: quantize(clipTop),
			width: bandWidth,
			height: quantize(clipBottom) - quantize(clipTop)
		};
		const gap = Math.min(8, Math.max(4, region.height * 0.02));
		// Demand is grapheme count. At a shared font size in bands of equal
		// width, required height is proportional to total glyph advance, and
		// character count is its cheapest faithful proxy — the fonts are not
		// even loaded at this point in the plan. Getting the SHAPE right is
		// what mattered; this proxy was never the dominant error.
		const demands = members.map(({ text }) => Math.max(1, [...text].length));
		const profile = usableWidthProfile(contour, region, BAND_PROFILE_SLICES);
		const bands = partitionByDemand(region, profile, demands, {
			gap,
			// A band that cannot hold one line at the readability floor helps
			// nobody. Scaled, because a flat 12px is most of a line on a small
			// page and a rounding error on a large one.
			minBand: minimumBandHeight
		});
		if (!bands) return;
		members.forEach((member, index) => {
			const band = bands[index];
			if (!(band.height > 0)) return;
			result.set(member.item.id, {
				rect: { x: region.x, y: band.top, width: region.width, height: band.height },
				contourBound
			});
		});
	};

	/**
	 * One lobe per member, matched to the member whose own source sits in it.
	 *
	 * When a container has exactly as many lobes as utterances, the carve is
	 * already drawn — by the artist. Source position is ground truth for which
	 * utterance belongs in which lobe, and it beats reading order because it
	 * needs no assumption about direction: the text was detected where it was
	 * drawn. Horizontal bands cannot express this at all for lobes that sit
	 * side by side.
	 *
	 * `candidateRects` already offers these rects; what this adds is the group,
	 * so the pairing survives page-level pruning as a unit instead of each item
	 * separately hoping the other lands elsewhere.
	 */
	const emitLobeAssignment = (
		members: Array<{ item: OverlayItemV2; text: string }>,
		container: OverlayContainerV2
	): boolean => {
		const split = polygonLobeSplit(container.polygon, { maxLobes: members.length });
		if (!split || split.lobes.length !== members.length) return false;
		const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
		const pairs: Array<{ memberIndex: number; lobeIndex: number; distance: number }> = [];
		members.forEach((member, memberIndex) => {
			const source = sourceRect(member.item, input);
			if (!source) return;
			const from = centre(source);
			split.lobes.forEach((lobe, lobeIndex) => {
				const to = centre(lobe);
				pairs.push({ memberIndex, lobeIndex, distance: Math.hypot(from.x - to.x, from.y - to.y) });
			});
		});
		// Every member needs a source for the match to mean anything.
		if (pairs.length !== members.length * split.lobes.length) return false;
		pairs.sort((left, right) => left.distance - right.distance
			|| compareCanonicalText(members[left.memberIndex].item.id, members[right.memberIndex].item.id)
			|| left.lobeIndex - right.lobeIndex);
		const takenMembers = new Set<number>();
		const takenLobes = new Set<number>();
		const assigned: Array<{ member: (typeof members)[number]; lobe: Rect }> = [];
		for (const pair of pairs) {
			if (takenMembers.has(pair.memberIndex) || takenLobes.has(pair.lobeIndex)) continue;
			takenMembers.add(pair.memberIndex);
			takenLobes.add(pair.lobeIndex);
			assigned.push({ member: members[pair.memberIndex], lobe: split.lobes[pair.lobeIndex] });
		}
		if (assigned.length !== members.length) return false;
		// Validate every lobe before writing any of them. Bailing out halfway
		// leaves the earlier members holding a lobe each while the last has none,
		// and the band fallback below cannot be relied on to overwrite them
		// because it has its own reasons to decline.
		const clipped = assigned.map(({ member, lobe }) => ({
			member,
			rect: clampRect(lobe, page.width, page.height)
		}));
		if (!clipped.every(({ rect }) => rect.width > 0 && rect.height >= minimumBandHeight)) return false;
		for (const { member, rect } of clipped) {
			result.set(member.item.id, { rect, contourBound: true });
		}
		return true;
	};

	// Same-container groups.
	if (input.settings.mode === 'bubble-segmentation') {
		const byContainer = new Map<string, Array<{ item: OverlayItemV2; text: string }>>();
		for (const entry of eligible) {
			if (!entry.item.containerId) continue;
			const list = byContainer.get(entry.item.containerId) ?? [];
			list.push(entry);
			byContainer.set(entry.item.containerId, list);
		}
		for (const [containerId, members] of byContainer) {
			if (members.length < 2) continue;
			const container = input.document.containers.find((candidate) => candidate.id === containerId);
			if (!container || container.kind === 'free' || !isSimplePolygon(container.polygon)) continue;
			const bounds = polygonBounds(container.polygon);
			if (!bounds) continue;
			const ordered = [...members].sort(rank);
			// Conjoined bubbles carve themselves; everything else is banded.
			// Two utterances in a two-lobe bubble used to skip stacking entirely
			// and rely on the per-lobe rects finding their own homes through
			// collision alone — which produced nothing coupled, and nothing at
			// all once a third utterance made two lobes insufficient.
			// A continuation is one sentence the grouper had to cut; no carve —
			// lobes or cells — may set its halves side by side, because the
			// second half would then read first. Only the band stack applies.
			const continuation = ordered.some(({ item }) => item.continuesPrevious);
			if (!continuation && emitLobeAssignment(ordered, container)) continue;
			emitCells(ordered, bounds, true);
			emitBands(ordered, bounds, true, container.polygon);
		}
	}

	// Free vertical-column runs.
	const freeColumns = eligible
		.filter((entry) => !result.has(entry.item.id))
		.map((entry) => {
			const container = entry.item.containerId
				? input.document.containers.find((candidate) => candidate.id === entry.item.containerId)
				: undefined;
			if (container && container.kind !== 'free') return null;
			const source = sourceRect(entry.item, input);
			const columns = sourceColumns(entry.item, input);
			if (!source || !hasVerticalSource(entry.item, source, columns)) return null;
			// The run's own glyph unit: the median width of its detected columns.
			const widths = columns.map((column) => column.width).sort((left, right) => left - right);
			const columnWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : source.width;
			return { ...entry, source, columnWidth };
		})
		.filter((entry): entry is { item: OverlayItemV2; text: string; source: Rect; columnWidth: number } => entry !== null)
		.sort((left, right) => left.source.x - right.source.x || compareCanonicalText(left.item.id, right.item.id));
	let run: typeof freeColumns = [];
	const flushRun = (): void => {
		if (run.length >= 2) {
			const left = Math.min(...run.map((entry) => entry.source.x));
			const top = Math.min(...run.map((entry) => entry.source.y));
			const right = Math.max(...run.map((entry) => entry.source.x + entry.source.width));
			const bottom = Math.max(...run.map((entry) => entry.source.y + entry.source.height));
			emitBands(
				[...run].sort(rank),
				{ x: left, y: top, width: right - left, height: bottom - top },
				false,
				// No contour: a free run's region is the joint footprint of the
				// columns, so its usable width really is the rectangle's.
				undefined
			);
		}
		run = [];
	};
	for (const entry of freeColumns) {
		const previous = run[run.length - 1];
		if (previous) {
			const gapX = entry.source.x - (previous.source.x + previous.source.width);
			const overlapY = Math.min(previous.source.y + previous.source.height, entry.source.y + entry.source.height)
				- Math.max(previous.source.y, entry.source.y);
			const minHeight = Math.min(previous.source.height, entry.source.height);
			// Detector boxes on tightly-set columns routinely overlap by a
			// pixel or two — a small negative gap is still adjacency.
			//
			// The positive bound was 1x the column width, on the reasoning that a
			// tight bound keeps the art strip a band spans small. That is below
			// every unenclosed run it was written for: columns inside a BALLOON
			// are gutted at 0.10-0.97x their width (mostly 0.4-0.8), but
			// unenclosed narration breathes, and the four-column narration run on
			// ` Unbounded column run over art.png` is gutted at 1.84, 2.13 and
			// 1.97. This path only ever sees free items, so raising the bound
			// cannot loosen anything inside a balloon; and the strip a band spans
			// between columns of one text block is blank paper, not artwork.
			//
			// 2.5 clears that maximum with margin and stays near the grouper's own
			// 2.1-glyph merge gate.
			//
			// Read those three numbers for what they are, which the policy-27
			// record did not. They are gaps between the four COLUMNS OF ONE ITEM.
			// This gate compares gaps between separate ITEMS, and no page in the
			// corpus has two free items to compare — every free region in it is
			// alone on its page, so the gate has never run on real material at
			// all. The proxy is defensible, because the case this exists for is
			// several utterances over the columns of one run, where the item gaps
			// ARE those column gaps. It is still a proxy, and the only value the
			// gate has ever actually been shown is 0.565, from a synthetic scene.
			// `gate-exemptions.json` carries this as the "separated free blocks"
			// gap; closing it needs pages with two free runs on them.
			const minWidth = Math.min(previous.source.width, entry.source.width);
			const columnWidth = Math.min(previous.columnWidth, entry.columnWidth);
			// Policy-30: speech beside narration is still one run of columns on
			// the artwork, so style keys no longer have to match; and two runs
			// whose boxes overlap are exactly the ones that must share a region
			// rather than fight for it, so overlap counts as adjacency. On the
			// reviewed pages three of the five adjacent free pairs mix types, and
			// both tap-to-reveal demotions were runs whose boxes overlapped.
			const adjacent = (carve || entry.item.styleKey === previous.item.styleKey)
				&& (carve || gapX >= -0.2 * minWidth)
				&& recordGateResult('free-column-adjacency', gapX <= columnWidth * FREE_COLUMN_ADJACENCY_RATIO, columnWidth > 0 ? gapX / columnWidth : undefined)
				&& recordGateResult('free-column-overlap', overlapY >= minHeight * 0.5, minHeight > 0 ? overlapY / minHeight : undefined);
			if (!adjacent) flushRun();
		}
		run.push(entry);
	}
	flushRun();
	return { bands: result, cells };
}

function writingModes(item: OverlayItemV2, source: Rect | null, input: OverlayLayoutInput): OverlayWritingMode[] {
	if (input.settings.orientationPolicy === 'force-horizontal') return ['horizontal-tb'];
	if (item.manual.writingMode) return [item.manual.writingMode];
	if (input.writingModeOverride) return [input.writingModeOverride];
	// Records created before sourceWritingMode existed receive only a
	// conservative tall-column hint, and only while preservation is enabled.
	return hasVerticalSource(item, source, sourceColumns(item, input))
		? ['vertical-rl', 'horizontal-tb']
		: ['horizontal-tb'];
}

function fontSizes(
	rect: Rect,
	floor: number,
	item: OverlayItemV2,
	sampleCount = 12,
	ceilingCap = Number.POSITIVE_INFINITY
): number[] {
	// A minimum is a one-sided constraint. Nearest-step quantization can round a
	// scaled floor down (for example 7.033 -> 7.0) and make the planner reject its
	// own only candidate, so always round the readability floor upward.
	const readableFloor = Math.ceil((floor - Number.EPSILON) * 4) / 4;
	if (item.manual.referenceFontSize) return [quantize(item.manual.pinTypography ? item.manual.referenceFontSize : Math.max(readableFloor, item.manual.referenceFontSize), .25)];
	// Let short translations actually fill generous containers. Fit, contour,
	// and ink validation below are the authority; a conservative geometric cap
	// here previously caused the known underfilled-bubble regression.
	const ceiling = Math.max(readableFloor, Math.min(128, rect.height * 0.75, rect.width * 0.6, ceilingCap));
	const step = Math.max(.25, (ceiling - readableFloor) / Math.max(1, sampleCount - 1));
	const result: number[] = [];
	for (let value = ceiling; value >= readableFloor && result.length < sampleCount; value -= step) result.push(Math.max(readableFloor, quantize(value, 0.25)));
	if (!result.includes(readableFloor)) result.push(readableFloor);
	return [...new Set(result)];
}

function medianSourceGlyphScale(item: OverlayItemV2, input: OverlayLayoutInput): number | undefined {
	const scales = item.sourceIds.flatMap((id) => {
		const source = input.document.sources.find((candidate) => candidate.id === id);
		if (!source) return [];
		if (item.sourceWritingMode === 'vertical-rl') return [source.bounds.width];
		if (item.sourceWritingMode === 'horizontal-tb') return [source.bounds.height];
		return [Math.abs(source.orientationDegrees) >= 45 ? source.bounds.width : source.bounds.height];
	}).filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
	if (scales.length === 0) return undefined;
	const middle = Math.floor(scales.length / 2);
	return scales.length % 2 ? scales[middle] : (scales[middle - 1] + scales[middle]) / 2;
}

function graphemeCount(text: string, locale: string): number {
	return [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(text)].length;
}

const SFX_FONT_CAP_RATIO = 0.9;
const FREE_TEXT_FONT_CAP_RATIO = 1.0;

/**
 * Automatic sfx and free-standing text sit directly on artwork, so their card
 * is pure occlusion — unlike balloon dialogue there is no detected white space
 * to reclaim. Cap the em by the source lettering's stroke thickness (PP-OCR
 * bounds, median across the item's merged sources) so the replacement never
 * reads more prominently than the lettering it covers; longer translations
 * wrap into more lines at source scale instead of growing the font. Readability
 * floors still win below the cap, and manual geometry or a pinned size is an
 * explicit user decision that bypasses it.
 */
function automaticFreeTextFontCap(
	item: OverlayItemV2,
	input: OverlayLayoutInput,
	container: OverlayContainerV2 | undefined
): number {
	if (item.manual.rect || item.manual.referenceFontSize !== undefined) return Number.POSITIVE_INFINITY;
	const scale = medianSourceGlyphScale(item, input);
	if (scale === undefined) return Number.POSITIVE_INFINITY;
	if (item.type === 'sfx') return scale * SFX_FONT_CAP_RATIO * input.settings.fontScale;
	if (container && container.kind !== 'free') return Number.POSITIVE_INFINITY;
	return scale * FREE_TEXT_FONT_CAP_RATIO * input.settings.fontScale;
}

/**
 * Contextual sizing owns its own per-item readability floor. The manual slider
 * is disabled while this policy is enabled, so carrying its stale value into
 * planning makes a previously selected large minimum unexpectedly authoritative.
 *
 * PP-OCR's line/column thickness is the closest production measure of the
 * source lettering's visual prominence. Scale that by the square root of the
 * source/target grapheme ratio (text consumes area in two dimensions), then
 * keep it within resolution-relative readability bounds. The 0.7 factor maps
 * tight detector ink bounds to the font em used by the layout engine while
 * retaining enough room for a longer target-language phrase.
 */
function contextualFontFloor(
	item: OverlayItemV2,
	input: OverlayLayoutInput,
	targetText: string,
	sourceText: string,
	configuredFloor: number
): number {
	if (!input.settings.variableFontSizing || item.manual.referenceFontSize !== undefined) {
		return configuredFloor;
	}
	const pageScale = Math.min(input.document.sourceImage.width, input.document.sourceImage.height) / 1200;
	const scale = input.settings.fontScale;
	const automaticMinimum = 10 * pageScale * scale;
	const automaticMaximum = 28 * pageScale * scale;
	const sourceGlyphScale = medianSourceGlyphScale(item, input);
	if (sourceGlyphScale === undefined) return automaticMinimum;

	const sourceLength = Math.max(1, graphemeCount(sourceText.trim(), input.document.locale));
	const targetLength = Math.max(1, graphemeCount(targetText.trim(), input.document.locale));
	const expansionAdjustment = Math.max(0.5, Math.min(1.25, Math.sqrt(sourceLength / targetLength)));
	const prominenceFloor = sourceGlyphScale * expansionAdjustment * 0.7 * scale;
	return Math.max(automaticMinimum, Math.min(automaticMaximum, prominenceFloor));
}

function regularReadableRescueFloor(
	item: OverlayItemV2,
	input: OverlayLayoutInput,
	targetText: string,
	sourceText: string,
	preferredFloor: number,
	contourBound: boolean
): number {
	if (
		!contourBound
		|| item.type === 'sfx'
		|| item.type === 'unknown'
		|| item.manual.rect
		|| item.manual.referenceFontSize !== undefined
	) return preferredFloor;

	// A configured minimum is the preferred automatic size, not a reason to drop
	// recognized dialogue. The rescue floor remains resolution-relative and is
	// also tied to the source glyph scale and source/target expansion. This lets
	// long English translations reuse the whole detected bubble while avoiding an
	// arbitrary collapse to microscopic text.
	const pageScale = Math.min(input.document.sourceImage.width, input.document.sourceImage.height) / 1200;
	const absoluteReadableFloor = 16 * pageScale * input.settings.fontScale;
	const sourceLength = Math.max(1, graphemeCount(sourceText.trim(), input.document.locale));
	const targetLength = Math.max(1, graphemeCount(targetText.trim(), input.document.locale));
	const expansion = Math.max(.2, Math.min(1, Math.sqrt(sourceLength / targetLength)));
	const sourceScale = medianSourceGlyphScale(item, input);
	const sourceRelativeFloor = sourceScale === undefined
		? preferredFloor * .72
		: sourceScale * expansion * .42 * input.settings.fontScale;
	return Math.min(preferredFloor, Math.max(absoluteReadableFloor, sourceRelativeFloor));
}

function exceedsAutomaticSfxProminence(
	item: OverlayItemV2,
	rect: Rect,
	source: Rect | null,
	page: { width: number; height: number }
): boolean {
	if (item.type !== 'sfx' || item.manual.rect || !source) return false;
	const sourceArea = Math.max(1, source.width * source.height);
	const sourceLongAxis = Math.max(1, source.width, source.height);
	const candidateArea = rect.width * rect.height;
	return candidateArea > sourceArea * 2
		|| Math.max(rect.width, rect.height) > sourceLongAxis * 1.5
		|| candidateArea > page.width * page.height * 0.08;
}

function protectedOverlap(rect: Rect, region: ProtectedRegionV2): number {
	if (region.rect) return rectIntersectionArea(rect, region.rect);
	if (region.polygon) return polygonRectIntersectionArea(region.polygon, rect);
	return 0;
}

function hardProtectedOverlap(rect: Rect, regions: ProtectedRegionV2[]): boolean {
	return regions.some((region) => region.hard && protectedOverlap(rect, region) > 0);
}

function sampledMapArea(rect: Rect, map: Float32Array | undefined, mapWidth: number | undefined, mapHeight: number | undefined, pageWidth: number, pageHeight: number): number {
	if (!map || !mapWidth || !mapHeight || map.length < mapWidth * mapHeight) return 0;
	const left = Math.max(0, Math.floor(rect.x / pageWidth * mapWidth));
	const top = Math.max(0, Math.floor(rect.y / pageHeight * mapHeight));
	const right = Math.min(mapWidth, Math.ceil((rect.x + rect.width) / pageWidth * mapWidth));
	const bottom = Math.min(mapHeight, Math.ceil((rect.y + rect.height) / pageHeight * mapHeight));
	let sum = 0;
	let count = 0;
	const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 32));
	for (let y = top; y < bottom; y += step) for (let x = left; x < right; x += step) {
		sum += Math.max(0, Math.min(1, map[y * mapWidth + x] ?? 0));
		count += 1;
	}
	return count > 0 ? sum / count * rect.width * rect.height : 0;
}

function softProtectedArea(rect: Rect, regions: ProtectedRegionV2[], input: OverlayLayoutInput): number {
	const explicit = regions.reduce((sum, region) => sum + (!region.hard ? protectedOverlap(rect, region) : 0), 0);
	const page = input.document.sourceImage;
	const saliency = sampledMapArea(rect, input.smartSizing?.saliencyMap, input.smartSizing?.saliencyW, input.smartSizing?.saliencyH, page.width, page.height);
	const edges = sampledMapArea(rect, input.smartSizing?.edgeDensityMap, input.smartSizing?.edgeDensityW, input.smartSizing?.edgeDensityH, page.width, page.height);
	return explicit + saliency + edges * .5;
}

function runPlans(
	line: { text: string; startUtf16: number; endUtf16: number; width: number },
	fontRuns: FontRunSpec[],
	input: {
		direction: OverlayDirection;
		locale: string;
		fontSize: number;
		lineHeight: number;
		styleKey: string;
		scopeId: string;
		textLayout: TextLayoutPort;
		intervalStart: number;
		intervalWidth: number;
		baseline: number;
		forceExactMeasurement: boolean;
	}
): { runs: OverlayRenderRunV2[]; advance: number; left: number; fits: boolean } {
	const overlapping = fontRuns.filter((run) => run.endUtf16 > line.startUtf16 && run.startUtf16 < line.endUtf16);
	const primary = overlapping[0] ?? fontRuns[0];
	const authoritative = fontRuns.map((run) => run.text).join('').slice(line.startUtf16, line.endUtf16);
	if (authoritative !== line.text) {
		const advance = line.width;
		const left = input.intervalStart + (input.intervalWidth - advance) / 2;
		return { runs: [{
			text: line.text,
			sourceRange: { startUtf16: line.startUtf16, endUtf16: line.endUtf16 },
			fontKey: primary.fontKey,
			origin: { x: quantize(input.direction === 'rtl' ? left + advance : left), y: input.baseline },
			rotationDegrees: 0,
			direction: input.direction
		}], advance, left, fits: advance <= input.intervalWidth + 1 / 64 };
	}

	if (!input.forceExactMeasurement && fontRuns.length === 1 && !requiresExplicitBidiRuns(line.text, input.direction)) {
		// Pretext already shaped and measured this exact single-family,
		// single-direction line. Re-measuring it for every geometry/font candidate
		// is redundant (and dominates dense 30-overlay pages). Mixed fonts and bidi
		// still take the explicit fragment path below so their visual origins use
		// exact per-run metrics.
		const advance = line.width;
		const left = input.intervalStart + (input.intervalWidth - advance) / 2;
		const direction = input.direction;
		return {
			advance,
			left,
			fits: advance <= input.intervalWidth + 1 / 64,
			runs: [{
				text: line.text,
				sourceRange: { startUtf16: line.startUtf16, endUtf16: line.endUtf16 },
				fontKey: fontRuns[0].fontKey,
				origin: {
					x: quantize(direction === 'rtl' ? left + advance : left),
					y: input.baseline
				},
				rotationDegrees: 0,
				direction
			}]
		};
	}
	const bidi = resolveBidiRuns(line.text, input.direction, input.locale);
	const fragments: Array<{
		text: string;
		startUtf16: number;
		endUtf16: number;
		font: FontRunSpec;
		level: number;
		direction: OverlayDirection;
		width: number;
	}> = [];
	for (const directional of bidi) {
		const directionalStart = line.startUtf16 + directional.startUtf16;
		const directionalEnd = line.startUtf16 + directional.endUtf16;
		for (const font of overlapping) {
			const start = Math.max(directionalStart, font.startUtf16);
			const end = Math.min(directionalEnd, font.endUtf16);
			if (end <= start) continue;
			const text = line.text.slice(start - line.startUtf16, end - line.startUtf16);
			const width = input.textLayout.measure({
				scopeId: input.scopeId,
				text,
				locale: input.locale,
				fontKey: font.fontKey,
				family: font.family,
				families: [font.family],
				weight: font.weight,
				fontSize: input.fontSize,
				lineHeight: input.lineHeight,
				direction: directional.direction,
				styleKey: input.styleKey
			});
			fragments.push({ text, startUtf16: start, endUtf16: end, font, level: directional.level, direction: directional.direction, width });
		}
	}
	const advance = fragments.reduce((sum, fragment) => sum + fragment.width, 0);
	const left = input.intervalStart + (input.intervalWidth - advance) / 2;
	const positions = new Array<number>(fragments.length);
	let cursor = left;
	for (const index of bidiVisualOrder(fragments.map((fragment) => ({
		startUtf16: fragment.startUtf16,
		endUtf16: fragment.endUtf16,
		level: fragment.level,
		direction: fragment.direction
	})))) {
		positions[index] = cursor;
		cursor += fragments[index].width;
	}
	return {
		advance,
		left,
		fits: advance <= input.intervalWidth + 1 / 64,
		runs: fragments.map((fragment, index) => ({
			text: fragment.text,
			sourceRange: { startUtf16: fragment.startUtf16, endUtf16: fragment.endUtf16 },
			fontKey: fragment.font.fontKey,
			origin: {
				x: quantize(positions[index] + (fragment.direction === 'rtl' ? fragment.width : 0)),
				y: input.baseline
			},
			rotationDegrees: 0,
			direction: fragment.direction
		}))
	};
}

function horizontalLines(input: {
	text: string;
	locale: string;
	rect: Rect;
	polygon?: Point[];
	tailPolygon?: Point[];
	exclusionPolygons?: Point[][];
	fontSize: number;
	lineHeight: number;
	padding: number;
	fontRuns: FontRunSpec[];
	direction: OverlayDirection;
	styleKey: string;
	scopeId: string;
	textLayout: TextLayoutPort;
	lineCountScale?: number;
	verticalBias?: -1 | 0 | 1;
}): { lines: OverlayRenderLineV2[]; complete: boolean } {
	const availableLines = Math.max(1, Math.floor((input.rect.height - input.padding * 2) / input.lineHeight));
	const maxLines = Math.max(1, Math.min(availableLines, Math.floor(availableLines * (input.lineCountScale ?? 1))));
	const stackTop = (lineCount: number) => {
		const spareHeight = Math.max(0, input.rect.height - lineCount * input.lineHeight);
		const verticalInset = Math.min(input.padding, spareHeight / 2);
		const minimum = input.rect.y + verticalInset;
		const maximum = input.rect.y + input.rect.height - verticalInset - lineCount * input.lineHeight;
		const travel = Math.max(0, maximum - minimum);
		return minimum + travel * ((input.verticalBias ?? 0) + 1) / 2;
	};
	const bandRows = (lineCount: number, top: number) =>
		Array.from({ length: lineCount }, (_, index) => safeBandIntervals(
			input.polygon!,
			top + index * input.lineHeight,
			top + (index + 1) * input.lineHeight,
			input.padding,
			input.tailPolygon,
			input.exclusionPolygons
		).map((interval) => ({
			start: Math.max(interval.start, input.rect.x + input.padding),
			end: Math.min(interval.end, input.rect.x + input.rect.width - input.padding)
		})).filter((interval) => interval.end > interval.start));
	// Multi-lobe signature of the most recent contour band grid: some band
	// splits into ≥2 intervals (side-by-side lobes) or comes back empty
	// between occupied ones (staggered lobes). Gates the sub-window fallback
	// so single-lobe shapes keep their byte-identical placements.
	let lastRows: Array<Array<{ start: number; end: number }>> | null = null;
	const buildConstraints = (lineCount: number) => {
		const top = stackTop(lineCount);
		if (!input.polygon) {
			return Array.from({ length: lineCount }, () => ({
				width: Math.max(1, input.rect.width - input.padding * 2),
				intervalStart: input.rect.x + input.padding,
				intervalEnd: input.rect.x + input.rect.width - input.padding
			}));
		}
		const rows = bandRows(lineCount, top);
		lastRows = rows;
		const stack = coherentIntervalStack(rows);
		return stack?.map((interval) => ({
			width: interval.end - interval.start,
			intervalStart: interval.start,
			intervalEnd: interval.end
		})) ?? [];
	};
	const multiLobeSignature = (): boolean =>
		lastRows !== null && lastRows.some((row) => row.length >= 2 || row.length === 0);
	let constraints = buildConstraints(maxLines);
	if (constraints.length === 0 && !(input.polygon && multiLobeSignature())) {
		return { lines: [], complete: false };
	}
	const primary = input.fontRuns.find((run) => run.text.trim().length > 0) ?? input.fontRuns[0];
	const handle = input.textLayout.prepare({
		scopeId: input.scopeId,
		text: input.text,
		locale: input.locale,
		fontKey: primary.fontKey,
		family: primary.family,
		families: [...new Set(input.fontRuns.map((run) => run.family))],
		weight: primary.weight,
		fontSize: input.fontSize,
		lineHeight: input.lineHeight,
		direction: input.direction,
		styleKey: input.styleKey
	});
	type LineLayout = ReturnType<TextLayoutPort['layout']>;
	const composeLines = (layoutResult: LineLayout, top: number): { lines: OverlayRenderLineV2[]; measuredFits: boolean } => {
		let measuredFits = true;
		const lines = layoutResult.lines.map((line, index): OverlayRenderLineV2 => {
			const direction = input.direction;
			const baseline = quantize(top + index * input.lineHeight + input.fontSize);
			const plannedRuns = runPlans(line, input.fontRuns, {
				direction,
				locale: input.locale,
				fontSize: input.fontSize,
				lineHeight: input.lineHeight,
				styleKey: input.styleKey,
				scopeId: input.scopeId,
				textLayout: input.textLayout,
				intervalStart: line.constraint.intervalStart,
				intervalWidth: line.constraint.width,
				baseline,
				// Emergency grapheme breaks change shaping context. The suffix after an
				// emergency break can change as well, so both sides must be re-prepared
				// and measured as the exact painted fragment.
				forceExactMeasurement: line.breakAfter === 'emergency'
					|| (index > 0 && layoutResult.lines[index - 1].breakAfter === 'emergency')
			});
			if (!plannedRuns.fits) measuredFits = false;
			const origin = {
				x: quantize(direction === 'rtl' ? plannedRuns.left + plannedRuns.advance : plannedRuns.left),
				y: baseline
			};
			return {
				text: line.text,
				sourceRange: {
					startUtf16: line.startUtf16,
					endUtf16: line.endUtf16,
					startGrapheme: line.startGrapheme,
					endGrapheme: line.endGrapheme
				},
				breakAfter: line.breakAfter,
				origin,
				baseline: origin.y,
				advance: quantize(plannedRuns.advance),
				bounds: {
					x: quantize(plannedRuns.left),
					y: quantize(top + index * input.lineHeight),
					width: quantize(plannedRuns.advance),
					height: quantize(input.lineHeight)
				},
				availableInterval: { start: line.constraint.intervalStart, end: line.constraint.intervalEnd },
				direction,
				runs: plannedRuns.runs
			};
		});
		return { lines, measuredFits };
	};

	/**
	 * Multi-lobe fallback: anchor the band grid at the full-height stack top
	 * and place the text in the best contiguous sub-window of bands (one
	 * lobe), instead of demanding a single chain across the whole contour —
	 * which a peanut shape either lacks entirely or only offers at neck
	 * height, capping the font at the neck. Mirrors verticalConstraints'
	 * column sub-window search.
	 */
	const subWindowAttempt = (): { lines: OverlayRenderLineV2[]; complete: boolean } | null => {
		if (!input.polygon) return null;
		const gridTop = stackTop(maxLines);
		const rows = bandRows(maxLines, gridTop);
		if (!rows.some((row) => row.length >= 2 || row.length === 0)) return null;
		const window = coherentSubWindowStack(rows);
		if (!window) return null;
		const toConstraints = (path: typeof window.path) => path.map((interval) => ({
			width: interval.end - interval.start,
			intervalStart: interval.start,
			intervalEnd: interval.end
		}));
		let top = gridTop + window.start * input.lineHeight;
		let windowLayout = input.textLayout.layout(handle, toConstraints(window.path));
		if (windowLayout.lines.length > 0 && windowLayout.lines.length < window.path.length) {
			// Re-pick the widest contiguous run of exactly the realized line
			// count — the sub-window analogue of the full path's recentering.
			const exact = coherentSubWindowStack(rows, { exactLength: windowLayout.lines.length });
			if (exact && exact.path.length === windowLayout.lines.length) {
				windowLayout = input.textLayout.layout(handle, toConstraints(exact.path));
				top = gridTop + exact.start * input.lineHeight;
			}
		}
		if (windowLayout.lines.length === 0) return null;
		const composed = composeLines(windowLayout, top);
		return { complete: windowLayout.complete && composed.measuredFits, lines: composed.lines };
	};

	if (constraints.length === 0) {
		// Only reachable for a multi-lobe contour (see the early return above).
		return subWindowAttempt() ?? { lines: [], complete: false };
	}
	let layout = input.textLayout.layout(handle, constraints);
	if (layout.lines.length > 0 && layout.lines.length < maxLines) {
		const recentered = buildConstraints(layout.lines.length);
		if (recentered.length === layout.lines.length) {
			const widthsChanged = recentered.some((constraint, index) => {
				const prior = layout.lines[index].constraint;
				return constraint.width !== prior.width
					|| constraint.intervalStart !== prior.intervalStart
					|| constraint.intervalEnd !== prior.intervalEnd;
			});
			if (widthsChanged) layout = input.textLayout.layout(handle, recentered);
		}
	}
	const top = stackTop(layout.lines.length);
	const composed = composeLines(layout, top);
	const fullResult = { complete: layout.complete && composed.measuredFits, lines: composed.lines };
	if (!fullResult.complete && multiLobeSignature()) {
		// The full-height chain exists but can't fit the text (e.g. it lives
		// in one lobe, or is neck-limited): a lobe sub-window may still fit
		// this size. Only a COMPLETE fallback wins — otherwise keep the full
		// attempt so degraded/reveal behavior is unchanged.
		const fallback = subWindowAttempt();
		if (fallback?.complete) return fallback;
	}
	return fullResult;
}

function inkInsideContour(
	lines: OverlayRenderLineV2[],
	polygon: Point[],
	tailPolygon: Point[] | undefined,
	padding: number,
	writingMode: OverlayWritingMode,
	exclusionPolygons?: Point[][]
): boolean {
	if (tailPolygon && lines.some((line) => polygonRectIntersectionArea(tailPolygon, line.bounds) > 1 / 64)) return false;
	if (exclusionPolygons
		&& lines.some((line) => exclusionPolygons.some(
			(exclusion) => polygonRectIntersectionArea(exclusion, line.bounds) > 1 / 64
		))) return false;
	if (writingMode === 'horizontal-tb') {
		return lines.every((line) => safeBandIntervals(
			polygon,
			line.bounds.y,
			line.bounds.y + line.bounds.height,
			padding,
			tailPolygon,
			exclusionPolygons
		).some((interval) => line.bounds.x >= interval.start - 1 / 64 && line.bounds.x + line.bounds.width <= interval.end + 1 / 64));
	}
	const rotatedPolygon = polygon.map((point) => ({ x: point.y, y: point.x }));
	const rotatedTail = tailPolygon?.map((point) => ({ x: point.y, y: point.x }));
	const rotatedExclusions = exclusionPolygons?.map(
		(exclusion) => exclusion.map((point) => ({ x: point.y, y: point.x }))
	);
	return lines.every((line) => safeBandIntervals(
		rotatedPolygon,
		line.bounds.x,
		line.bounds.x + line.bounds.width,
		padding,
		rotatedTail,
		rotatedExclusions
	).some((interval) => line.bounds.y >= interval.start - 1 / 64 && line.bounds.y + line.bounds.height <= interval.end + 1 / 64));
}

/**
 * Slightly overlapping neighbor contours (detector mask bleed on adjacent
 * balloons) get the shared region subtracted from BOTH sides' usable
 * intervals, so contour-bound ink provably stays on its own side. Pairs
 * overlapping beyond EROSION_MAX_OVERLAP_RATIO are near-duplicate detections:
 * eroding those would gut both interiors, so they are reported instead.
 */
const EROSION_MAX_OVERLAP_RATIO = 0.4;

function neighborContourExclusions(document: PageOverlayDataV2): {
	exclusions: Map<string, Point[][]>;
	nearDuplicates: Array<[string, string]>;
	nearDuplicatePairs: Set<string>;
} {
	const exclusions = new Map<string, Point[][]>();
	const nearDuplicates: Array<[string, string]> = [];
	const nearDuplicatePairs = new Set<string>();
	const containers = document.containers
		.filter((container) => container.kind !== 'free' && isSimplePolygon(container.polygon))
		.sort((left, right) => compareCanonicalText(left.id, right.id));
	for (let left = 0; left < containers.length; left += 1) {
		for (let right = left + 1; right < containers.length; right += 1) {
			const ratio = polygonPairOverlapRatio(containers[left].polygon, containers[right].polygon);
			if (ratio <= 0) continue;
			if (recordGateResult('erosion-overlap', ratio > EROSION_MAX_OVERLAP_RATIO)) {
				nearDuplicates.push([containers[left].id, containers[right].id]);
				nearDuplicatePairs.add(containerPairKey(containers[left].id, containers[right].id));
				continue;
			}
			const forLeft = exclusions.get(containers[left].id) ?? [];
			forLeft.push(containers[right].polygon);
			exclusions.set(containers[left].id, forLeft);
			const forRight = exclusions.get(containers[right].id) ?? [];
			forRight.push(containers[left].polygon);
			exclusions.set(containers[right].id, forRight);
		}
	}
	return { exclusions, nearDuplicates, nearDuplicatePairs };
}

function tightInkRect(
	lines: OverlayRenderLineV2[],
	padding: number,
	page: { width: number; height: number }
): Rect {
	const left = Math.min(...lines.map((line) => line.bounds.x));
	const top = Math.min(...lines.map((line) => line.bounds.y));
	const right = Math.max(...lines.map((line) => line.bounds.x + line.bounds.width));
	const bottom = Math.max(...lines.map((line) => line.bounds.y + line.bounds.height));
	return clampRect({
		x: left - padding,
		y: top - padding,
		width: right - left + padding * 2,
		height: bottom - top + padding * 2
	}, page.width, page.height);
}

/**
 * Weight on the fraction of an unbounded item's source left showing.
 *
 * Swept at 0/5/10/20/40/80 against the committed pages: the outcome plateaus
 * from 10 and is flat by 40, so 20 sits mid-plateau. Comfortably above the 1-3
 * point noise floor of raggedness and displacement, three orders of magnitude
 * below the emergency-break term, and small enough never to drag a card across
 * protected artwork.
 */
const SOURCE_UNCOVERED_WEIGHT = 20;

/**
 * Weight on how much FLATTER an unbounded item's painted card is than its own
 * source region permits (width/height beyond the allowance below).
 *
 * `boxGrowth` measures AREA and cannot see shape: the wide flat bar that
 * horizontal English makes of a short vertical utterance often has LESS area
 * than the tall column it replaces, so nothing in the score resisted it, and
 * a short phrase took a one-line card several source-widths across when a
 * two-line card at the same font was sitting in the ladder.
 *
 * The quantity is the card's own aspect (width/height), charged only past
 * `max(allowance, source aspect)` — the source's shape is ground truth, so a
 * wide caption that was WIDE IN THE ORIGINAL keeps its one-line card, and a
 * narrow vertical run is where the term bites. Deliberately NOT width per
 * source width: a long sentence over a single 34px column makes every
 * feasible card many source-widths across, and normalizing by source width
 * let that unavoidable ratio dominate the score and crush the font
 * (measured on the unbounded fixture: 26.75 → 20.25 before this form).
 * Aspect is font-scale-invariant, so the term steers the WRAP, not the size.
 *
 * Wrap quality still wins locally: orphan (15) and hyphenated-break (6)
 * costs stay above what one avoided aspect unit pays back, so the term flips
 * near-ties, not wraps. Region-anchored bands are exempt (their extent is
 * the shared region's, not the item's decision), and so is SFX, whose
 * prominence machinery owns its footprint.
 */
const WIDTH_GROWTH_WEIGHT = 3;

/**
 * Card aspect (width/height) an unbounded card may take for free, whatever
 * its source's shape. Two stacked lines of a short phrase land near 2; a
 * one-line card of the same phrase lands at 5-12. A genuinely short single
 * word ("Huh?!") stays inside the allowance on one line, which is right —
 * it has no narrower alternative.
 */
const WIDTH_GROWTH_ASPECT_ALLOWANCE = 3.5;

/**
 * Cost of one hyphenated line break.
 *
 * Tightening the hyphenation patterns took the corpus from 21 breaks to 6; this
 * takes the remaining 6 to 2, and it does so for NO font size — mean font is
 * 46.34 without it and 46.54 with it, because the breaks it removes are
 * near-ties between two windows rather than the only way to fit.
 *
 * The obvious reading of the earlier measurement was that a score penalty is a
 * weak lever: 8 per hyphen, used INSTEAD of the pattern gate, only reached 16 of
 * 21. That was true of the case measured and false of this one. What is left
 * after the gate is a different population — a handful of coin-flips between
 * windows — and a small tie-breaker is exactly the right tool for those. The
 * clearest case is a vertical shop sign, which took its own footprint's width in
 * seven lines with two hyphens at 25.8px, and takes a wider window in three
 * lines with none at 32.3px.
 *
 * Swept at 0/3/6/12/24. 6 and 12 are identical; 24 starts buying the last break
 * with real size (a conjoined balloon drops 59.0 to 48.5 to shed one hyphen),
 * which is the wrong trade. Three orders of magnitude below the emergency-break
 * term, because a chopped word is not a near-tie with anything.
 *
 * The gate on this number is the corpus-wide count in the bench baseline, not
 * a lab fixture: the tie needs a source narrow enough to hyphenate in but wide
 * enough to be worth trying, and no synthetic page built for it reproduced that
 * — every attempt came out either comfortably feasible or outright infeasible.
 */
const HYPHENATED_BREAK_WEIGHT = 6;

/**
 * Feather width as a fraction of the page's short edge; plate padding and
 * corner radius as fractions of the font em.
 *
 * Rendered at four settings each over the committed pages and looked at.
 *
 * Feather (0, 0.008, 0.014, 0.022): zero leaves a visible rectangle edge
 * against tone; above about 0.02 the ramps from adjacent columns merge and the
 * gutters between them stop being artwork again. 0.014 is roughly 15px on a
 * 1055px page, which is under a quarter of a typical 65px gutter.
 *
 * Plate padding and radius (0.10/0.15, 0.22/0.30, 0.36/0.45, 0.22/0): on this
 * corpus the four are close to indistinguishable, because the erasure carries
 * most of the coverage and none of the committed pages sets text over genuinely
 * dark artwork. So the choice is margin, not measurement: the functional
 * minimum is small — a line box is `lineHeight` tall with the baseline at one
 * em, so descenders reach about 0.02em past it, and side bearings want another
 * 0.05em — and 0.22em is comfortably clear of that without reading as a box.
 */
const SOFT_EDGE_RATIO = 0.014;
const PLATE_PADDING_EM = 0.22;
const PLATE_RADIUS_EM = 0.3;

/**
 * The soft-edged whitewash for an item with no balloon.
 *
 * A bounded item paints its contour, which covers every source inside it. An
 * unbounded one paints its own card — and a card tightened onto horizontal
 * English cannot cover the tall narrow run of vertical Japanese it replaces, so
 * the original stays legible around it. The erasure is a separate shape for
 * exactly that reason: it is sized by the SOURCE, while the card stays sized by
 * the ink, which is what keeps `boxGrowth` and protected-art scoring honest.
 *
 * One rectangle per detected COLUMN, not one over their union: the gutters
 * between a run's columns are artwork, and on a four-column narration block
 * with typical gutters they are well over half the block's width.
 *
 * A stacked band erases its own slice of the shared region instead. The stack
 * tiles the region between them; erasing each member's whole column would leave
 * the strips between bands showing.
 */
function unboundedBackground(input: {
	item: OverlayItemV2;
	container: OverlayContainerV2 | undefined;
	contour: Point[] | undefined;
	sources: Rect[];
	band: Rect | undefined;
	fontSize: number;
	page: { width: number; height: number };
}): Partial<OverlayBackgroundPlan> {
	if (input.contour || input.item.manual.rect) return {};
	if (input.container && input.container.kind !== 'free') return {};
	const regions = input.band ? [input.band] : input.sources;
	const clamped = regions
		.map((rect) => clampRect(rect, input.page.width, input.page.height))
		.filter((rect) => rect.width > 0 && rect.height > 0);
	if (clamped.length === 0) return {};
	const shortEdge = Math.min(input.page.width, input.page.height);
	return {
		erasureRects: clamped,
		softEdgePx: quantize(shortEdge * SOFT_EDGE_RATIO),
		platePadding: quantize(input.fontSize * PLATE_PADDING_EM),
		plateRadius: quantize(input.fontSize * PLATE_RADIUS_EM)
	};
}

function scoreCandidate(input: {
	rect: Rect;
	lines: OverlayRenderLineV2[];
	fontSize: number;
	floor: number;
	source: Rect | null;
	protectedArea: number;
	freeLayout: boolean;
	/**
	 * True when the window's position and extent are the shared REGION's, not
	 * this item's own.
	 *
	 * Two score terms then measure the wrong thing and have to stand down.
	 * `displacement` compares the card's centre with the item's own column, but a
	 * band's centre is the group's centre by construction — left in, it cost
	 * bands 2-4 points and three utterances over one adjacent column run
	 * scattered back onto their own columns and overlapped. `sourceUncovered`
	 * asks whether the card covers the item's own source, but a band covers one
	 * slice of each member's column on purpose; it is the STACK that covers the
	 * region, and charging each member for the other members' slices cost the
	 * band a further 15 points.
	 */
	regionAnchored: boolean;
	/** SFX keeps its own prominence machinery; the width-growth term stands down. */
	sfx: boolean;
	pageWidth: number;
	pageHeight: number;
	settings: OverlayLayoutSettingsV2;
	typographyCompression: number;
}): OverlayCandidateScore {
	const rectArea = input.rect.width * input.rect.height;
	const inkArea = input.lines.reduce((sum, line) => sum + line.advance * input.fontSize, 0);
	const occupancy = rectArea > 0 ? inkArea / rectArea : 0;
	const occupancyPenalty = occupancy < 0.5 ? (0.5 - occupancy) * 110 : occupancy > 0.85 ? (occupancy - 0.85) * 110 : 0;
	const advances = input.lines.map((line) => line.advance);
	const mean = advances.reduce((sum, value) => sum + value, 0) / Math.max(1, advances.length);
	const raggedness = advances.reduce((sum, value) => sum + Math.abs(value - mean), 0) / Math.max(1, advances.length * mean);
	const orphanPenalty = advances.length > 1 && advances[advances.length - 1] < mean * 0.35 ? 1 : 0;
	const emergencyBreaks = input.lines.filter((line) => line.breakAfter === 'emergency').length;
	const hyphenatedBreaks = input.regionAnchored
		? 0
		: input.lines.filter((line) => line.breakAfter === 'hyphenated').length;
	const displacement = input.source ? Math.hypot(
		input.rect.x + input.rect.width / 2 - input.source.x - input.source.width / 2,
		input.rect.y + input.rect.height / 2 - input.source.y - input.source.height / 2
	) : 0;
	const boxGrowth = input.source ? Math.max(0, rectArea / Math.max(1, input.source.width * input.source.height) - 1) : 0;
	const sourceAspect = input.source && input.source.height > 0
		? input.source.width / input.source.height
		: Number.POSITIVE_INFINITY;
	const widthGrowth = input.freeLayout && !input.regionAnchored && !input.sfx && input.rect.height > 0
		? Math.max(0, input.rect.width / input.rect.height - Math.max(WIDTH_GROWTH_ASPECT_ALLOWANCE, sourceAspect))
		: 0;
	// How much of the original this placement leaves on the page.
	//
	// A balloon's whitewash is its contour, so a bounded item covers every source
	// inside it whatever the card does. An unbounded item's whitewash IS the card,
	// and nothing else in this function notices when the card sits beside the text
	// it replaces rather than over it: `displacement` compares centres, and a wide
	// short card centred on a tall narrow column scores zero there while leaving
	// the top and bottom of every column legible. Measured on real pages at 45%
	// and 17% of the source region covered, which reads as Japanese, English,
	// Japanese down the page.
	const sourceUncovered = input.freeLayout && !input.regionAnchored && input.source
		? 1 - rectIntersectionArea(input.rect, input.source)
			/ Math.max(1, input.source.width * input.source.height)
		: 0;
	let displacementComponent = displacement / 100;
	if (input.freeLayout && !input.regionAnchored && input.source) {
		const sourceCenterX = input.source.x + input.source.width / 2;
		const sourceCenterY = input.source.y + input.source.height / 2;
		const candidateCenterX = input.rect.x + input.rect.width / 2;
		const candidateCenterY = input.rect.y + input.rect.height / 2;
		const towardCenterX = input.pageWidth / 2 - sourceCenterX;
		const towardCenterY = input.pageHeight / 2 - sourceCenterY;
		const centerDistance = Math.hypot(towardCenterX, towardCenterY);
		const inwardProjection = centerDistance > 0
			? Math.max(0, ((candidateCenterX - sourceCenterX) * towardCenterX + (candidateCenterY - sourceCenterY) * towardCenterY) / centerDistance)
			: 0;
		const sourceDiagonal = Math.max(1, Math.hypot(input.source.width, input.source.height));
		// Prefer source-anchored growth toward the page margin when two candidates
		// otherwise displace equally. Manga artwork is usually inward from signs,
		// captions, and SFX detected near an edge.
		displacementComponent = (displacement + inwardProjection) / sourceDiagonal * 8;
	}
	const score: OverlayCandidateScore = {
		total: 0,
		emergencyBreaks,
		protectedArtOverlap: quantize(input.protectedArea),
		fontPreference: quantize((input.floor / input.fontSize) * 30),
		typographyCompression: quantize(input.typographyCompression),
		occupancyPenalty: quantize(occupancyPenalty),
		sourceUncovered: quantize(sourceUncovered),
		hyphenatedBreaks,
		raggedness: quantize(raggedness * 10),
		orphanPenalty,
		displacement: quantize(displacementComponent),
		boxGrowth: quantize(boxGrowth),
		widthGrowth: quantize(widthGrowth),
		collisionPenalty: 0,
		styleConsistency: 0
	};
	score.total = quantize(
		score.emergencyBreaks * 1000
		+ score.protectedArtOverlap * input.settings.protectedArtWeight
		+ score.fontPreference
		+ (score.typographyCompression ?? 0)
		+ score.occupancyPenalty
		+ (score.sourceUncovered ?? 0) * SOURCE_UNCOVERED_WEIGHT
		+ (score.hyphenatedBreaks ?? 0) * HYPHENATED_BREAK_WEIGHT
		+ score.raggedness
		+ score.orphanPenalty * 15
		+ score.displacement
		+ score.boxGrowth * (input.freeLayout ? 12 : 3)
		+ (score.widthGrowth ?? 0) * WIDTH_GROWTH_WEIGHT
	);
	return score;
}

function assignment(
	candidates: Map<string, Candidate[]>,
	beamWidth: number,
	unplacedReasons: Map<string, PlannedOverlayItemV2['unplacedReason']>,
	nearDuplicatePairs: ReadonlySet<string> = new Set()
): PlannedOverlayItemV2[] {
	type State = { choices: Candidate[]; score: number };
	const outputItemIds = [...candidates.keys()].sort();
	// Place the most constrained item first. ID order is durable identity, not a
	// spatial heuristic; assigning an easy box first can consume the only safe row
	// stack of a neighboring narrow bubble and falsely label the latter a conflict.
	const itemIds = [...outputItemIds].sort((left, right) =>
		(candidates.get(left)?.length ?? 0) - (candidates.get(right)?.length ?? 0)
			|| compareCanonicalText(left, right));
	let beam: State[] = [{ choices: [], score: 0 }];
	for (const itemId of itemIds) {
		const options = candidates.get(itemId)!;
		if (experiments.debugAssignment) {
			console.info(`[assign] ${itemId} options=${options.length} beam=${beam.length}`);
			for (const option of options) console.info(`[assign]   ${option.id} rect=${[option.rect.x, option.rect.y, option.rect.width, option.rect.height].map(Math.round).join(',')} band=${option.stackedBand ? 1 : 0} cell=${option.cell ? 1 : 0} font=${option.item.font?.size} lines=${option.item.lines?.length} total=${option.score.total}`);
		}
		const next: State[] = [];
		for (const state of beam) {
			for (const option of options) {
				let collisionPenalty = 0;
				let stylePenalty = 0;
				let rejected = false;
				for (const chosen of state.choices) {
					const relation = pairRelation(option, chosen, nearDuplicatePairs);
					if (relation.overlap) {
						rejected = true;
						break;
					}
					if (relation.gap < 4) collisionPenalty += 4 - relation.gap;
					if (option.styleKey === chosen.styleKey && option.item.font && chosen.item.font) {
						stylePenalty += Math.abs(option.item.font.size - chosen.item.font.size) / Math.max(option.item.font.size, chosen.item.font.size);
					}
				}
				if (rejected) continue;
				next.push({ choices: [...state.choices, option], score: state.score + option.score.total + collisionPenalty + stylePenalty * 2 });
			}
		}
		if (experiments.debugAssignment) console.info(`[assign] ${itemId} next=${next.length}${next.length ? ` best=${Math.min(...next.map((state) => state.score))}` : ''}`);
		if (next.length === 0) continue;
		const ranked = next.sort((left, right) => left.score - right.score
			|| compareCanonicalText(
				left.choices.map((choice) => choice.id).join('|'),
				right.choices.map((choice) => choice.id).join('|')
			));
		beam = ranked.slice(0, Math.max(1, beamWidth));
		// A region-anchored candidate's value is page-level — its siblings only
		// fit BECAUSE it took a band — and per-item scores cannot see it. Plain
		// top-K pruning dropped the hypothesis one item before the sibling that
		// needed it: on a real page the state "neighbour takes its band" was the
		// 33rd of 32 and the nested run demoted to tap-to-reveal. So the best
		// state in which the item just placed took its band or cell survives.
		if (!experiments.legacySharedRegions) {
			for (const kind of ['band', 'cell'] as const) {
				const anchored = (state: State): boolean => {
					const choice = state.choices[state.choices.length - 1];
					return kind === 'cell' ? Boolean(choice.cell) : Boolean(choice.stackedBand) && !choice.cell;
				};
				if (beam.some(anchored)) continue;
				const best = ranked.find(anchored);
				if (best) beam.push(best);
			}
		}
	}
	const best = beam[0];
	const selected = new Map(best?.choices.map((choice) => {
		let collisionPenalty = 0;
		let styleConsistency = 0;
		for (const other of best.choices) {
			if (other.id === choice.id) continue;
			const relation = pairRelation(choice, other, nearDuplicatePairs);
			if (relation.gap < 4) collisionPenalty += 4 - relation.gap;
			if (choice.styleKey === other.styleKey && choice.item.font && other.item.font) {
				styleConsistency += Math.abs(choice.item.font.size - other.item.font.size) / Math.max(choice.item.font.size, other.item.font.size);
			}
		}
		const score = choice.item.score ? {
			...choice.item.score,
			collisionPenalty: quantize(collisionPenalty),
			styleConsistency: quantize(styleConsistency),
			total: quantize(choice.item.score.total + collisionPenalty + styleConsistency * 2)
		} : undefined;
		return [choice.item.itemId, { ...choice.item, score }] as const;
	}) ?? []);
	return outputItemIds.map((itemId) => selected.get(itemId) ?? {
		itemId,
		status: 'unplaced',
		unplacedReason: (candidates.get(itemId)?.length ?? 0) > 0
			? 'collision-conflict'
			: unplacedReasons.get(itemId) ?? 'text-does-not-fit'
	});
}

export function normalizedOverlayLayoutInput(input: OverlayLayoutInput): unknown {
	const authority = overlayDocumentForHash(input.document);
	const mapIdentity = (map: Float32Array | undefined) => map
		? stableHash64(Array.from(map, (value) => quantize(value, 1 / 4096)))
		: undefined;
	return {
		document: {
			...authority,
			sources: [...authority.sources].sort((left, right) => compareCanonicalText(left.id, right.id)),
			containers: [...authority.containers].sort((left, right) => compareCanonicalText(left.id, right.id)),
			items: [...authority.items].sort((left, right) => compareCanonicalText(left.id, right.id))
		},
		translations: [...input.translations].sort((left, right) => compareCanonicalText(left.id ?? '', right.id ?? '')),
		settings: input.settings,
		protectedRegions: [...(input.protectedRegions ?? [])].sort((left, right) => compareCanonicalText(canonicalStringify(left), canonicalStringify(right))),
		smartSizing: input.smartSizing ? {
			typeMultipliers: input.smartSizing.typeMultipliers,
			edgeDensityW: input.smartSizing.edgeDensityW,
			edgeDensityH: input.smartSizing.edgeDensityH,
			edgeDensityFingerprint: mapIdentity(input.smartSizing.edgeDensityMap),
			saliencyW: input.smartSizing.saliencyW,
			saliencyH: input.smartSizing.saliencyH,
			saliencyFingerprint: mapIdentity(input.smartSizing.saliencyMap),
			headRegions: [...(input.smartSizing.headRegions ?? [])].sort((left, right) => compareCanonicalText(canonicalStringify(left), canonicalStringify(right)))
		} : undefined,
		writingModeOverride: input.writingModeOverride,
		algorithmVersion: OVERLAY_ALGORITHM_VERSION
	};
}

export class JointOverlayLayoutService implements OverlayLayoutService {
	private requests = 0;
	private coalesced = 0;
	private lastPlanId: string | null = null;
	private readonly pending = new Map<string, PendingLayoutPlan>();
	private readonly traces = new Map<string, OverlayCandidateTrace[]>();

	constructor(
		private readonly fonts: FontRegistryPort = overlayFontRegistry,
		private readonly textLayout: TextLayoutPort = overlayTextLayout,
		private readonly options: { traceCandidates?: boolean } = {}
	) {}

	async plan(input: OverlayLayoutInput, signal?: AbortSignal): Promise<OverlayRenderPlanV2> {
		throwIfAborted(signal);
		this.requests += 1;
		const inputHash = await computeOverlayLayoutInputHash(input);
		throwIfAborted(signal);
		let pending = this.pending.get(inputHash);
		if (pending?.controller.signal.aborted) {
			this.pending.delete(inputHash);
			pending = undefined;
		}
		if (pending) {
			this.coalesced += 1;
			return this.consume(pending, signal);
		}
		const controller = new AbortController();
		pending = {
			work: Promise.resolve(null as never),
			controller,
			scopeId: input.scopeId,
			consumers: 0,
			settled: false
		};
		const entry = pending;
		entry.work = this.compute(input, inputHash, controller.signal).finally(() => {
			entry.settled = true;
			if (this.pending.get(inputHash) === entry) this.pending.delete(inputHash);
		});
		this.pending.set(inputHash, entry);
		return this.consume(entry, signal);
	}

	private consume(pending: PendingLayoutPlan, signal?: AbortSignal): Promise<OverlayRenderPlanV2> {
		pending.consumers += 1;
		return new Promise((resolve, reject) => {
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				pending.consumers = Math.max(0, pending.consumers - 1);
				if (pending.consumers === 0 && !pending.settled) pending.controller.abort();
			};
			const abort = () => {
				signal?.removeEventListener('abort', abort);
				release();
				reject(new DOMException('Overlay planning cancelled', 'AbortError'));
			};
			signal?.addEventListener('abort', abort, { once: true });
			pending.work.then(
				(value) => { signal?.removeEventListener('abort', abort); release(); resolve(value); },
				(error) => { signal?.removeEventListener('abort', abort); release(); reject(error); }
			);
			if (signal?.aborted) abort();
		});
	}

	private async compute(input: OverlayLayoutInput, inputHash: string, signal?: AbortSignal): Promise<OverlayRenderPlanV2> {
		const translations = new Map(input.translations.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
		const containersForVisibility = new Map(input.document.containers.map((container) => [container.id, container]));
		const visibleItems = input.document.items.filter((item) => {
			// Hidden and removed items stay on the record (undo, carry-forward,
			// the page's box list) and are simply not planned.
			if (item.manual.hidden || item.manual.removed) return false;
			// Policy-21c: free-floating SFX renders only when sfxOverlays is on.
			// Official releases leave drawn sound effects untranslated. Text
			// inside a detected balloon is never filtered regardless of its
			// type. Drawn SFX routinely defeats the region classifier
			// (borderless/unknown groupKind → item.type 'unknown'), so when the
			// classifier had no confident class the translation entry's 'sfx'
			// label decides — and when the LLM's label is ALSO unconfident, a
			// translation composed entirely of asterisk-wrapped tokens
			// ("*flump*") is the prompt contract's self-declared SFX styling.
			if (!input.settings.sfxOverlays && isSfxTyped(item, translations.get(item.translationEntryId))) {
				const container = item.containerId ? containersForVisibility.get(item.containerId) : undefined;
				if (!container || container.kind === 'free') return false;
			}
			return true;
		});
		const resolved = visibleItems.map((item) => ({ item, text: entryText(item, translations) }));
		const runsByItem = new Map<string, FontRunSpec[]>();
		for (const { item, text } of resolved) runsByItem.set(item.id, this.fonts.resolveRuns(text, input.document.locale, item.styleKey));
		const allRuns = [...runsByItem.values()].flat();
		// The trailing '-' covers hyphenated-break glyphs introduced by soft
		// hyphenation before the per-item texts are transformed.
		await this.fonts.ensureReady([...new Set(allRuns.map((run) => run.fontKey))], `${resolved.map(({ text }) => text).join('')}${SOFT_HYPHEN}-`);
		throwIfAborted(signal);

		const page = input.document.sourceImage;
		const configuredFloor = Math.max(1, input.settings.minimumFontSizeAt1200 * (Math.min(page.width, page.height) / 1200) * input.settings.fontScale);
		const lastResortFloor = Math.max(
			2,
			LAST_RESORT_FONT_FLOOR_AT_1200 * (Math.min(page.width, page.height) / 1200) * input.settings.fontScale
		);
		const protectedRegions: ProtectedRegionV2[] = [
			...(input.protectedRegions ?? []),
			...(input.smartSizing?.headRegions ?? []).map((head) => ({
				kind: 'head' as const,
				rect: { x: head.x, y: head.y, width: head.w, height: head.h },
				hard: true
			}))
		];
		// Band stacking needs the readability floor to size its minimum band, so
		// it runs here rather than beside the other per-page precomputation.
		const stackedRegions = stackedColumnBands(
			resolved,
			input,
			// One line box at the floor, with the old flat 12px as a lower bound
			// so small pages do not become more permissive than before.
			Math.max(12, Math.ceil(configuredFloor * STANDARD_TYPOGRAPHY_PROFILE.lineHeightRatio)),
			translations
		);
		const contourNeighbors = neighborContourExclusions(input.document);
		const hyphenationByItem = new Map<string, { insertedAt: number[]; originalText: string }>();
		const relayoutContexts = new Map<string, RelayoutContext>();
		const candidates = new Map<string, Candidate[]>();
		const unplacedReasons = new Map<string, PlannedOverlayItemV2['unplacedReason']>();
		const traces: OverlayCandidateTrace[] = [];
		const recordTrace = (trace: OverlayCandidateTrace): void => {
			if (this.options.traceCandidates) traces.push(trace);
		};
		let operationCount = 0;
		const warnings: string[] = [];
		for (const [left, right] of contourNeighbors.nearDuplicates) {
			warnings.push(`Containers ${left} and ${right} overlap like duplicates; erosion skipped`);
		}
		const yieldBudget = createCooperativeYieldBudget();

		for (const { item, text } of resolved.sort((left, right) => compareCanonicalText(left.item.id, right.item.id))) {
			throwIfAborted(signal);
			const fontRuns = runsByItem.get(item.id)!;
			if (text.length === 0 || fontRuns.length === 0) {
				candidates.set(item.id, []);
				unplacedReasons.set(item.id, 'text-does-not-fit');
				warnings.push(`Item ${item.id} has no renderable text`);
				continue;
			}
			const source = sourceRect(item, input);
			// The individual detected columns, not their union: the whitewash for an
			// unbounded item erases each of them and leaves the gutters between.
			const sourceRects = sourceColumns(item, input);
			const sourceText = translations.get(item.translationEntryId)?.original_text ?? '';
			const preferredFloor = contextualFontFloor(item, input, text, sourceText, configuredFloor);
			const container = input.document.containers.find((candidate) => candidate.id === item.containerId);
			const polygonValid = container ? isSimplePolygon(container.polygon) : false;
			if (container && !polygonValid) warnings.push(`Container ${container.id} used rectangular fallback`);
			// A saved rectangle is an explicit replacement geometry. Continuing to
			// intersect it with the detector's original contour makes a move or resize
			// appear to work during the gesture and then fail when text is centered in
			// the new rectangle. Automatic dialogue remains contour-bound; a manual
			// rectangle owns both its layout and painted background.
			const contourPolygon = !item.manual.rect && container && container.kind !== 'free' && polygonValid && input.settings.mode === 'bubble-segmentation'
				? container.polygon
				: undefined;
			const exclusionPolygons = contourPolygon && container
				? contourNeighbors.exclusions.get(container.id)
				: undefined;
			const modes = writingModes(item, source, input);
			const stackedCell = stackedRegions.cells.get(item.id);
			// A carved member has its cell; the band it would otherwise share is
			// the arrangement the cell exists to replace.
			const stackedBand = stackedCell ? undefined : stackedRegions.bands.get(item.id);
			const entry = translations.get(item.translationEntryId);
			const geometriesByMode = new Map(modes.map((writingMode) => {
				const primary = candidateRects(item, input, writingMode);
				const sourceWindows = sourceRegionWindows(item, input, container, writingMode, entry);
				// Divide the evaluation budget across the rects so every geometry
				// is FULLY evaluated (the budget is a hard break — an
				// under-provisioned late rect would be silently starved).
				// 1 rect → 32 samples, 2 → 18, 3 → 12, 4 → 9.
				//
				// A SINGLE geometry always earns the fine 32-sample search,
				// contour-bound or not. Gating on `contourPolygon` alone dropped
				// two classes to the coarse 8: a saved manual rectangle (exactly
				// one rect, and deliberately not contour-bound), and EVERY
				// balloon whenever the user is in auto-fit or text-replacement
				// mode, since contourPolygon additionally requires
				// bubble-segmentation. Both then searched font sizes on a step
				// four times coarser and settled visibly smaller. One geometry
				// costs at most modes × 1 × 32 ≤ 64 of the 256 budget.
				//
				// Only multi-rect FREE containers keep the coarse 8: they offer
				// 15-21 search windows, where the divisor clamps to 8 anyway.
				const rectCount = primary.length
					+ sourceWindows.length
					+ (stackedBand && writingMode === 'horizontal-tb' ? 1 : 0)
					+ (stackedCell && writingMode === 'horizontal-tb' ? 1 : 0);
				const samples = contourPolygon || rectCount === 1
					? Math.max(8, Math.min(32, Math.floor(256 / (7 * rectCount))))
					: 8;
				// A carved member gets its cell and nothing else. Left beside the
				// whole-region window, the cell loses in the beam to per-item scores
				// that cannot see the sibling it was carved for, and the extra
				// window costs it the fine font ladder as well.
				const exclusiveCell = Boolean(stackedCell) && writingMode === 'horizontal-tb';
				const geometries: CandidateGeometry[] = (exclusiveCell ? [] : primary).map((rect) => ({
					rect,
					contourBound: Boolean(contourPolygon),
					typographySamples: samples
				}));
				// Ordered stacked-column band, then the height-locked source-region
				// family. Both are spliced in near the front — never index 0 (the
				// reveal fallback and primary geometry take the first rect), but
				// early enough that the budget's hard break can never starve them
				// behind a long free-candidate tail. The source-region windows go
				// after the band: where an item has both, the band is the answer
				// for a shared region and the windows are the answer for an item
				// that owns its own.
				let insertAt = 1;
				if (stackedCell && writingMode === 'horizontal-tb') {
					geometries.splice(insertAt, 0, {
						rect: stackedCell.rect,
						contourBound: stackedCell.contourBound && Boolean(contourPolygon),
						typographySamples: samples,
						stackedBand: true,
						cell: true
					});
					insertAt += 1;
				}
				if (stackedBand && writingMode === 'horizontal-tb') {
					geometries.splice(insertAt, 0, {
						rect: stackedBand.rect,
						contourBound: stackedBand.contourBound && Boolean(contourPolygon),
						typographySamples: samples,
						stackedBand: true
					});
					insertAt += 1;
				}
				for (const rect of exclusiveCell ? [] : sourceWindows) {
					geometries.splice(insertAt, 0, {
						rect,
						contourBound: false,
						typographySamples: samples,
						sourceRegion: true
					});
					insertAt += 1;
				}
				return [writingMode, geometries] as const;
			}));
			const direction = paragraphDirection(text, input.document.baseDirection);
			// Soft hyphens give pretext legal break opportunities inside long
			// Latin words (narrow balloons otherwise fragment via emergency
			// breaks). LTR horizontal only; CJK/short words pass through with
			// insertedAt empty. The patterns are en-US, so the document's target
			// locale gates them too — `insertSoftHyphens` enforces that itself.
			// Ranges are remapped to the original text after assignment so
			// persisted plans never leak U+00AD indices.
			let layoutText = text;
			let itemFontRuns = fontRuns;
			if (modes.length === 1 && modes[0] === 'horizontal-tb' && direction === 'ltr') {
				const hyphenated = insertSoftHyphens(text, input.document.locale);
				if (hyphenated.insertedAt.length > 0) {
					layoutText = hyphenated.text;
					itemFontRuns = this.fonts.resolveRuns(layoutText, input.document.locale, item.styleKey);
					hyphenationByItem.set(item.id, { insertedAt: hyphenated.insertedAt, originalText: text });
				}
			}
			const primary = itemFontRuns.find((run) => run.text.trim().length > 0) ?? itemFontRuns[0];
			const automaticGlyphFontCap = automaticFreeTextFontCap(item, input, container);
			const accepted: Candidate[] = [];
			const rejectedReasons: Array<RejectionReason | undefined> = [];
			let evaluated = 0;
			const rectangleCount = Math.max(0, ...[...geometriesByMode.values()].map((geometries) => geometries.length));
			outer: for (let rectIndex = 0; rectIndex < rectangleCount; rectIndex += 1) {
				for (const writingMode of modes) {
					const geometry = geometriesByMode.get(writingMode)![rectIndex];
					if (!geometry) continue;
					const rect = geometry.rect;
					const candidateContour = geometry.contourBound ? contourPolygon : undefined;
					const candidateTail = geometry.contourBound ? container?.tailPolygon : undefined;
					const minimumFloor = regularReadableRescueFloor(
						item, input, text, sourceText, preferredFloor, geometry.contourBound
					);
					const candidateHashPrefix = `[${canonicalStringify(rect)},${canonicalStringify(writingMode)},`;
					// Contour-bound items have one geometry and can spend the budget on a
					// fine typography search. Free items search up to 15 distinct shapes;
					// eight sizes cover every shape without starving the reciprocal aspect
					// family or thrashing preparation caches.
					for (const profile of typographyProfiles(item, writingMode, geometry.contourBound, geometry.contourBound && rect.height > 1.6 * rect.width)) {
						// The degraded rung is a last resort: pay for it only when every
						// readable profile at this geometry came up empty.
						if (profile.fitMode === 'degraded' && accepted.length > 0) continue;
						const profileFloor = profile.fitMode === 'degraded'
							? Math.min(lastResortFloor, minimumFloor)
							: profile.id === 'tight-full' ? minimumFloor : preferredFloor;
						const sizes = fontSizes(
							rect,
							profileFloor,
							item,
							geometry.typographySamples,
							automaticGlyphFontCap
						);
						for (const fontSize of sizes) {
						if (evaluated >= Math.min(256, input.settings.maxCandidatesPerItem)) break outer;
						evaluated += 1;
						operationCount += 1;
						await yieldBudget.checkpoint();
						const lineHeight = quantize(fontSize * profile.lineHeightRatio);
							const padding = quantize(Math.max(profile.minimumPadding, fontSize * input.settings.paddingRatio * profile.paddingScale));
						const candidateId = `${item.id}:${stableHash64(`${candidateHashPrefix}${canonicalStringify(fontSize)},${canonicalStringify(profile.id)}]`)}`;
							const trace: OverlayCandidateTrace = {
								candidateId, itemId: item.id, accepted: false, layoutRect: rect, rect, fontSize, writingMode,
							fitMode: profile.fitMode, fitProfile: profile.id
						};
						if (!isFiniteRect(rect)) trace.reason = 'invalid-geometry';
						else if (!rectInside(rect, page.width, page.height)) trace.reason = 'out-of-page';
						else if (exceedsAutomaticSfxProminence(item, rect, source, page)) trace.reason = 'prominence-limit';
							else if (fontSize < profileFloor) trace.reason = 'below-readability-floor';
						if (trace.reason) {
							rejectedReasons.push(trace.reason);
							recordTrace(trace);
							continue;
						}

						const laidOut = writingMode === 'vertical-rl'
							? planVerticalText({
								text: layoutText,
								locale: input.document.locale,
								rect,
								fontSize,
								lineHeight,
								fontRuns: itemFontRuns,
								baseDirection: direction,
								textLayout: this.textLayout,
								polygon: candidateContour,
								tailPolygon: candidateTail,
								exclusionPolygons: geometry.contourBound ? exclusionPolygons : undefined,
								padding,
								preparedInput: {
									scopeId: input.scopeId, text: layoutText, locale: input.document.locale,
									fontKey: primary.fontKey, family: primary.family, weight: primary.weight,
									families: [...new Set(itemFontRuns.map((run) => run.family))],
									fontSize, lineHeight, direction, styleKey: item.styleKey
								}
							})
							: horizontalLines({
								text: layoutText,
								locale: input.document.locale,
								rect,
								polygon: candidateContour,
								tailPolygon: candidateTail,
								exclusionPolygons: geometry.contourBound ? exclusionPolygons : undefined,
								fontSize,
								lineHeight,
								padding,
								fontRuns: itemFontRuns,
								direction,
								styleKey: item.styleKey,
								scopeId: input.scopeId,
								textLayout: this.textLayout,
								lineCountScale: profile.lineCountScale,
								verticalBias: profile.verticalBias
							});
						if (!laidOut.complete || laidOut.lines.length === 0) {
							trace.reason = candidateContour ? 'text-does-not-fit' : 'no-safe-intervals';
							rejectedReasons.push(trace.reason);
							recordTrace(trace);
							continue;
						}
						const lineBoundsInsideCandidate = laidOut.lines.every((line) =>
							line.bounds.x >= rect.x - 1 / 64
							&& line.bounds.y >= rect.y - 1 / 64
							&& line.bounds.x + line.bounds.width <= rect.x + rect.width + 1 / 64
							&& line.bounds.y + line.bounds.height <= rect.y + rect.height + 1 / 64
						);
						if (!lineBoundsInsideCandidate) {
							trace.reason = 'out-of-page';
							rejectedReasons.push(trace.reason);
							recordTrace(trace);
							continue;
						}
							if (candidateContour && !inkInsideContour(laidOut.lines, candidateContour, candidateTail, padding, writingMode, exclusionPolygons)) {
							trace.reason = 'no-safe-intervals';
							rejectedReasons.push(trace.reason);
							recordTrace(trace);
								continue;
							}
							const renderedRect = !candidateContour && container?.kind === 'free' && !item.manual.rect
								? tightInkRect(laidOut.lines, Math.max(1, padding), page)
								: rect;
							trace.rect = renderedRect;
							// Search geometry can be much larger than the final free-text card.
							// Judge protected art against what is actually painted. Detected bubble
							// contours are authoritative existing white space, and manual geometry is
							// explicitly user-owned.
							if (!candidateContour && !item.manual.rect && hardProtectedOverlap(renderedRect, protectedRegions)) {
								trace.reason = 'protected-art';
								rejectedReasons.push(trace.reason);
								recordTrace(trace);
								continue;
							}
							const score = scoreCandidate({
								rect: renderedRect,
								lines: laidOut.lines,
								fontSize,
								floor: preferredFloor,
								source,
								protectedArea: softProtectedArea(renderedRect, protectedRegions, input),
							freeLayout: !container || container.kind === 'free',
							regionAnchored: Boolean(geometry.stackedBand),
							sfx: isSfxTyped(item, entry),
							pageWidth: page.width,
							pageHeight: page.height,
							settings: input.settings,
							typographyCompression: profile.penalty
						});
						trace.accepted = true;
						trace.score = score;
						recordTrace(trace);
							relayoutContexts.set(candidateId, {
								rect,
								profile,
								writingMode,
								contour: candidateContour,
								tail: candidateTail,
								exclusions: geometry.contourBound ? exclusionPolygons : undefined,
								boundedRegion: Boolean(geometry.stackedBand || geometry.sourceRegion),
								tightInk: renderedRect !== rect,
								glyphFontCap: Number.isFinite(automaticGlyphFontCap) ? automaticGlyphFontCap : undefined,
								layoutText,
								fontRuns: itemFontRuns,
								primary,
								direction,
								styleKey: item.styleKey,
								preferredFloor,
								paddingRatio: input.settings.paddingRatio
							});
							accepted.push({
								id: candidateId,
								rect: renderedRect,
							score,
							styleKey: item.styleKey,
							typographyProfileId: profile.id,
							contourBound: geometry.contourBound,
							containerId: container?.id,
							stackedBand: geometry.stackedBand,
							cell: geometry.cell,
							sourceRegion: geometry.sourceRegion,
							item: {
								itemId: item.id,
								status: 'placed',
								fitMode: profile.fitMode,
									rect: renderedRect,
								rotationDegrees: item.manual.rotationDegrees ?? 0,
								writingMode,
								background: {
									fill: '#ffffff',
									polygon: candidateContour,
									...unboundedBackground({
										item,
										container,
										contour: candidateContour,
										sources: sourceRects,
										band: geometry.stackedBand ? rect : undefined,
										fontSize,
										page
									})
								},
								clipPolygon: candidateContour,
								font: { fontKey: primary.fontKey, family: primary.family, weight: primary.weight, size: fontSize, lineHeight },
								lines: laidOut.lines,
								winningCandidateId: candidateId,
								score
							}
						});
					}
				}
			}
		}
			const policyAccepted = input.settings.orientationPolicy === 'preserve-source'
				&& !item.manual.writingMode
				&& modes[0] === 'vertical-rl'
				&& accepted.some((candidate) => candidate.item.writingMode === 'vertical-rl')
				? accepted.filter((candidate) => candidate.item.writingMode === 'vertical-rl')
				: accepted;
			const assignable = topCandidatesForAssignment(policyAccepted);
			// Place-always: every dialogue item with valid geometry carries a
			// zero-ink tap-to-reveal candidate as its terminal fallback. It
			// paints only the whitewashed contour (or source card); the text
			// renders in a popover, so it can never collide and dialogue can
			// never be dropped.
			if (eligibleDialogue(item)) {
				const revealRect = geometriesByMode.get(modes[0])?.[0]?.rect
					?? (source ? clampRect(source, page.width, page.height) : null);
				if (revealRect && isFiniteRect(revealRect) && rectInside(revealRect, page.width, page.height)) {
					const revealId = `${item.id}:reveal`;
					const revealScore: OverlayCandidateScore = {
						total: REVEAL_SCORE_TOTAL,
						emergencyBreaks: 0,
						protectedArtOverlap: 0,
						fontPreference: 0,
						typographyCompression: 0,
						occupancyPenalty: 0,
						raggedness: 0,
						orphanPenalty: 0,
						displacement: 0,
						boxGrowth: 0,
						collisionPenalty: 0,
						styleConsistency: 0
					};
					assignable.push({
						id: revealId,
						rect: revealRect,
						score: revealScore,
						styleKey: item.styleKey,
						typographyProfileId: 'reveal',
						contourBound: Boolean(contourPolygon),
						containerId: container?.id,
						item: {
							itemId: item.id,
							status: 'placed',
							fitMode: 'reveal',
							rect: revealRect,
							rotationDegrees: item.manual.rotationDegrees ?? 0,
							writingMode: modes[0],
							background: { fill: '#ffffff', polygon: contourPolygon },
							clipPolygon: contourPolygon,
							lines: [],
							winningCandidateId: revealId,
							score: revealScore
						}
					});
					recordTrace({
						candidateId: revealId, itemId: item.id, accepted: true,
						layoutRect: revealRect, rect: revealRect, fontSize: 0,
						writingMode: modes[0], fitMode: 'reveal', fitProfile: 'reveal',
						score: revealScore
					});
				}
			}
			candidates.set(item.id, assignable);
			if (assignable.length === 0) {
				unplacedReasons.set(item.id,
					rejectedReasons.length > 0 && rejectedReasons.every((reason) => reason === 'prominence-limit') ? 'prominence-limit'
						: rejectedReasons.length > 0 && rejectedReasons.every((reason) => reason === 'protected-art') ? 'protected-art-conflict'
						: rejectedReasons.includes('below-readability-floor') ? 'below-readability-floor'
							: rejectedReasons.includes('invalid-geometry') || rejectedReasons.includes('out-of-page') ? 'invalid-geometry'
								: 'text-does-not-fit'
				);
			}
		}

		throwIfAborted(signal);
		const selected = assignment(candidates, input.settings.beamWidth, unplacedReasons, contourNeighbors.nearDuplicatePairs);
		harmonizePageFonts(
			selected,
			relayoutContexts,
			new Map(visibleItems.map((item) => [item.id, item])),
			this.textLayout,
			input.scopeId,
			input.settings.paddingRatio,
			input.document.locale,
			page
		);
		// Refinement runs AFTER harmonization on purpose: growing fonts first
		// shifts the group median, which flips harmonize's clamp decisions for
		// items the refinement never touched. Harmonize must see pure assignment
		// sizes; growth is then capped at the post-harmonize outlier threshold
		// so no refined item becomes an outlier harmonize would have clamped.
		if (!import.meta.env?.VITE_FUMETO_NO_FILL_REFINEMENT) await maximizeSelectedFonts(
			selected,
			relayoutContexts,
			new Map(visibleItems.map((item) => [item.id, item])),
			this.textLayout,
			input.scopeId,
			input.settings.paddingRatio,
			input.document.locale,
			page,
			yieldBudget
		);
		for (const planned of selected) {
			const hyphenation = hyphenationByItem.get(planned.itemId);
			if (hyphenation && planned.lines && planned.lines.length > 0) {
				planned.lines = remapLinesToOriginal(
					planned.lines,
					hyphenation.insertedAt,
					hyphenation.originalText,
					input.document.locale
				);
			}
		}
		const allItems = selected.sort((left, right) => compareCanonicalText(left.itemId, right.itemId));
		const settingsFingerprint = await sha256(input.settings);
		const draft: Omit<OverlayRenderPlanV2, 'planId'> = {
			renderPlanVersion: 1,
			inputHash,
			algorithmVersion: OVERLAY_ALGORITHM_VERSION,
			documentRevision: input.document.documentRevision,
			sourceImage: { width: page.width, height: page.height },
			fontSetFingerprint: this.fonts.fingerprint(),
			settingsFingerprint,
			items: allItems,
			diagnostics: {
				placed: allItems.filter((item) => item.status === 'placed').length,
				unplaced: allItems.filter((item) => item.status === 'unplaced').length,
				candidatesEvaluated: operationCount,
				cacheHit: false,
				warnings: [...new Set(warnings)].sort(),
				operationCount
			}
		};
		const plan: OverlayRenderPlanV2 = { ...draft, planId: await sha256(draft) };
		if (this.options.traceCandidates) this.traces.set(plan.planId, traces);
		this.lastPlanId = plan.planId;
		return plan;
	}

	inspectTraces(planId: string): OverlayCandidateTrace[] {
		return [...(this.traces.get(planId) ?? [])];
	}

	inspect(): OverlayLayoutDiagnostics {
		return {
			algorithmVersion: OVERLAY_ALGORITHM_VERSION,
			requests: this.requests,
			coalesced: this.coalesced,
			lastPlanId: this.lastPlanId,
			textCache: this.textLayout.inspectCache(),
			fonts: this.fonts.inspect()
		};
	}

	clearScope(scopeId: string): void {
		for (const pending of this.pending.values()) {
			if (pending.scopeId === scopeId) pending.controller.abort();
		}
		this.textLayout.disposeScope(scopeId);
	}
}

export function computeOverlayLayoutInputHash(input: OverlayLayoutInput): Promise<string> {
	return sha256(normalizedOverlayLayoutInput(input));
}

export const overlayLayoutService = new JointOverlayLayoutService();

export const DEFAULT_OVERLAY_LAYOUT_SETTINGS: OverlayLayoutSettingsV2 = {
	mode: 'bubble-segmentation',
	minimumFontSizeAt1200: 10,
	fontScale: 1,
	orientationPolicy: 'force-horizontal',
	variableFontSizing: false,
	sfxOverlays: true,
	paddingRatio: 0.15,
	protectedArtWeight: 0.05,
	maxCandidatesPerItem: 256,
	beamWidth: 32
};

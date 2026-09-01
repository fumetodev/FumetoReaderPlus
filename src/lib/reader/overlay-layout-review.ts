import * as m from '$lib/paraglide/messages.js';
import type {
	OverlayItemV2,
	OverlayRenderPlanV2,
	OverlayUnplacedReason,
	PageOverlayDataV2,
	Rect
} from '$lib/types/index.js';
import { clampRect, isFiniteRect, polygonBounds } from '$lib/overlay-layout/geometry.js';

export interface OverlayLayoutReviewItem {
	itemId: string;
	reason: OverlayUnplacedReason;
	detail: string;
	/**
	 * The detector was not confident what this text even is. Surfaced so the
	 * reader can say "we were not sure about this one" instead of asserting a
	 * layout reason for a block it may have misread entirely.
	 */
	uncertainType: boolean;
}

/**
 * Below this, the classifier is guessing.
 *
 * The production classifier's own scale: an unenclosed text block scores 0.66
 * and the `insufficient-class-margin` fallback scores 0.45, so the line sits
 * between them (`ppocr-grouping.ts` — `classifyGroup`). An item with no
 * recorded confidence is not treated as uncertain: absence means the field
 * predates policy 29 or the type never came from the classifier, and inventing
 * doubt for every legacy record would put a caveat on the whole page.
 */
const UNCERTAIN_CLASSIFICATION_BELOW = 0.55;

/**
 * Whether this item's `type` is a guess rather than a classification.
 *
 * `'unknown'` is the laundering point: the adapter maps BOTH `borderless` —
 * ordinary unenclosed narration, which is real dialogue-adjacent text a reader
 * wants — and a genuine classification failure onto it. Type alone therefore
 * cannot separate "we know this is not speech" from "we do not know what this
 * is", which is why the confidence travels with the item.
 */
function uncertainlyTyped(item: OverlayItemV2): boolean {
	if (item.type !== 'unknown') return false;
	const confidence = item.classificationConfidence;
	return typeof confidence === 'number' && confidence < UNCERTAIN_CLASSIFICATION_BELOW;
}

/**
 * Items the reader never asks the user about.
 *
 * Only SFX. This deliberately no longer includes `'unknown'`: that exclusion
 * treated "unclassified" as if it meant "not dialogue", so the text the
 * detector was LEAST sure about — and therefore the most likely to be laid out
 * badly — was the text the reader offered the least help with. An unenclosed
 * narration block that shrank to an unreadable size, or failed to place at all,
 * got no explanation and no way in. SFX stay out because their suppression is a
 * deliberate typographic decision (prominence-capped, and switchable off
 * wholesale), not an admission of ignorance.
 */
function reviewable(item: OverlayItemV2 | undefined): item is OverlayItemV2 {
	return Boolean(item) && item!.type !== 'sfx';
}

const REVIEW_DETAILS: Record<OverlayUnplacedReason, () => string> = {
	'invalid-geometry': () => m.reader_review_invalid_geometry(),
	'font-unavailable': () => m.reader_review_font_unavailable(),
	'unsupported-runtime': () => m.reader_review_unsupported_runtime(),
	'below-readability-floor': () => m.reader_review_below_readability_floor(),
	'protected-art-conflict': () => m.reader_review_protected_art_conflict(),
	'collision-conflict': () => m.reader_review_collision_conflict(),
	'manual-constraint-conflict': () => m.reader_review_manual_constraint_conflict(),
	'prominence-limit': () => m.reader_review_prominence_limit(),
	'text-does-not-fit': () => m.reader_review_text_does_not_fit(),
	cancelled: () => m.reader_review_cancelled()
};

/**
 * What an uncertainly-typed item says instead of a layout reason.
 *
 * Naming a precise placement cause for a block the detector could not classify
 * would be a confident answer resting on an unconfident premise: if the region
 * was misread, the reason it "does not fit its bubble" is not the useful fact.
 * Say what is actually known, and offer the way in.
 */
const UNCERTAIN_REVIEW_DETAIL = () => m.reader_review_uncertain();

export function regularOverlayLayoutReviews(
	plan: Readonly<OverlayRenderPlanV2> | null,
	document: Readonly<PageOverlayDataV2> | null
): OverlayLayoutReviewItem[] {
	if (!plan || !document) return [];
	const items = new Map(document.items.map((item) => [item.id, item]));
	return plan.items.flatMap((planned) => {
		if (planned.status !== 'unplaced') return [];
		const item = items.get(planned.itemId);
		if (!reviewable(item)) return [];
		const reason = planned.unplacedReason ?? 'text-does-not-fit';
		const uncertainType = uncertainlyTyped(item);
		return [{
			itemId: planned.itemId,
			reason,
			detail: uncertainType ? UNCERTAIN_REVIEW_DETAIL() : REVIEW_DETAILS[reason](),
			uncertainType
		}];
	});
}

export interface OverlayDegradedReviewItem {
	itemId: string;
	fitMode: 'degraded' | 'reveal';
	detail: string;
	uncertainType: boolean;
}

const DEGRADED_DETAILS: Record<'degraded' | 'reveal', () => string> = {
	degraded: () => m.reader_review_degraded(),
	reveal: () => m.reader_review_reveal()
};

/**
 * Place-always leftovers: items that rendered via the degraded font rung or
 * as tap-to-reveal placements. These replace the old page banner with
 * per-bubble affordances.
 */
export function degradedOverlayLayoutReviews(
	plan: Readonly<OverlayRenderPlanV2> | null,
	document: Readonly<PageOverlayDataV2> | null
): OverlayDegradedReviewItem[] {
	if (!plan || !document) return [];
	const items = new Map(document.items.map((item) => [item.id, item]));
	return plan.items.flatMap((planned) => {
		if (planned.status !== 'placed') return [];
		if (planned.fitMode !== 'degraded' && planned.fitMode !== 'reveal') return [];
		const item = items.get(planned.itemId);
		if (!reviewable(item)) return [];
		return [{
			itemId: planned.itemId,
			fitMode: planned.fitMode,
			detail: DEGRADED_DETAILS[planned.fitMode](),
			uncertainType: uncertainlyTyped(item)
		}];
	});
}

function sourceUnion(document: Readonly<PageOverlayDataV2>, sourceIds: readonly string[]): Rect | null {
	const sources = sourceIds.flatMap((id) => {
		const source = document.sources.find((candidate) => candidate.id === id);
		return source && isFiniteRect(source.bounds) ? [source.bounds] : [];
	});
	if (sources.length === 0) return null;
	const left = Math.min(...sources.map((rect) => rect.x));
	const top = Math.min(...sources.map((rect) => rect.y));
	const right = Math.max(...sources.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...sources.map((rect) => rect.y + rect.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Unplaced plan items have no winning rectangle. Use only authoritative page
 * geometry to anchor the editor: saved manual geometry, then the owning bubble,
 * then the recognized source union. No synthetic bubble is fabricated.
 */
export function overlayLayoutReviewRect(
	document: Readonly<PageOverlayDataV2>,
	itemId: string
): Rect | null {
	const item = document.items.find((candidate) => candidate.id === itemId);
	if (!item) return null;
	const container = item.containerId
		? document.containers.find((candidate) => candidate.id === item.containerId)
		: undefined;
	const candidate = item.manual.rect && isFiniteRect(item.manual.rect)
		? item.manual.rect
		: container ? polygonBounds(container.polygon)
			: sourceUnion(document, item.sourceIds);
	if (!candidate || !isFiniteRect(candidate)) return null;
	return clampRect(candidate, document.sourceImage.width, document.sourceImage.height);
}

/**
 * Drop furigana (ruby) columns before a merged group's lines are concatenated.
 *
 * The detector emits every ruby column as its own text line, so without this the
 * translator receives the pronunciation guide spliced into the dialogue:
 * `赤色…！？` arrives as `あかいろ赤色…！?`, `起きろ伏黒` as `お起きろふしぐろ伏黑`.
 * Measured on mainstream shonen, where 69% of blocks carry ruby, that is 91% of all
 * character errors and takes page CER from 0.078 to 0.333
 *.
 *
 * Ruby has a local geometric signature, so the test is pairwise rather than measured
 * against anything global: it is roughly half-height type, printed hard against a
 * thicker column, spanning part of that column and never running longer than it.
 *
 * Two guards are load-bearing and both were found by regression, not by design:
 *
 *   - The thicker partner must itself have produced text. A wide region the recogniser
 *     returned nothing for is art or a bold SFX; letting one license a drop deleted
 *     every dialogue column in two bubbles during development.
 *   - A punctuation-only line is never dropped. Trailing `……` columns are thin for a
 *     reason that has nothing to do with ruby, and an earlier revision ate them.
 *
 * This runs after recognition and affects only which lines contribute *text*. Group
 * geometry, detector lineage and V2 source identity are untouched, which is deliberate:
 * the ruby component stays in the group so the overlay fill still covers the ruby
 * pixels instead of leaving them showing under the translated text.
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import { isMeaningfulOcrText } from './ocr-text-filter.js';

/** A partner must be at least this much thicker than the line it annotates. */
export const RUBY_THICKNESS_RATIO = 1.6;
/** Perpendicular gap to the partner, in units of the partner's glyph size. */
export const RUBY_ADJACENCY_RATIO = 0.8;
/** Share of the candidate's reading-axis span that must lie inside the partner's. */
export const RUBY_SPAN_COVERAGE = 0.7;

type Axis = (region: DetectedTextRegion) => number;
type Extent = (region: DetectedTextRegion) => readonly [number, number];

/**
 * Suppress ruby lines from a group's ordered raw regions.
 *
 * @param ordered Raw regions in reading order, as `rawRegionsForGroup` returns them.
 * @param textById Recognized text per raw box ID. Boxes the recognizer dropped are absent.
 * @returns The subset that should contribute text, in the input order.
 */
export function suppressRubyLines(
	ordered: readonly DetectedTextRegion[],
	textById: ReadonlyMap<number, string>
): DetectedTextRegion[] {
	if (ordered.length < 2) return [...ordered];

	// Same vertical predicate sortRawRegionsInReadingOrder uses, so a group is read
	// along one axis by every stage that touches it.
	const verticalLayout =
		ordered.filter((region) => region.height > region.width * 1.5).length > ordered.length / 2;

	/** Cross-axis extent — the glyph size, independent of how many characters the line holds. */
	const glyph: Axis = verticalLayout ? (region) => region.width : (region) => region.height;
	/** Reading-axis extent. */
	const length: Axis = verticalLayout ? (region) => region.height : (region) => region.width;
	const span: Extent = verticalLayout
		? (region) => [region.y, region.y + region.height]
		: (region) => [region.x, region.x + region.width];
	const perpendicular: Extent = verticalLayout
		? (region) => [region.x, region.x + region.width]
		: (region) => [region.y, region.y + region.height];

	const hasText = (region: DetectedTextRegion): boolean =>
		isMeaningfulOcrText(textById.get(region.boxId) ?? '');

	const kept = ordered.filter((candidate) => {
		// Punctuation-only lines are thin for unrelated reasons; never treat one as ruby.
		if (!hasText(candidate)) return true;

		const [candidateStart, candidateEnd] = span(candidate);
		const candidateSpan = candidateEnd - candidateStart;
		if (candidateSpan <= 0) return true;
		const [candidateNear, candidateFar] = perpendicular(candidate);

		return !ordered.some((partner) => {
			if (partner === candidate) return false;
			if (glyph(partner) < RUBY_THICKNESS_RATIO * glyph(candidate)) return false;
			// Ruby annotates text. An unrecognized region is art, not a base column.
			if (!hasText(partner)) return false;
			// Ruby annotates a span of its base column, so it never runs longer.
			if (length(candidate) > length(partner)) return false;

			const [partnerStart, partnerEnd] = span(partner);
			const overlap = Math.min(candidateEnd, partnerEnd) - Math.max(candidateStart, partnerStart);
			if (overlap < RUBY_SPAN_COVERAGE * candidateSpan) return false;

			const [partnerNear, partnerFar] = perpendicular(partner);
			const gap = Math.max(0, Math.max(candidateNear, partnerNear) - Math.min(candidateFar, partnerFar));
			return gap <= RUBY_ADJACENCY_RATIO * glyph(partner);
		});
	});

	// A group must never lose all of its text. If every line looks like ruby the
	// premise is wrong, so fall back to the untouched set.
	return kept.length > 0 ? kept : [...ordered];
}

import type { DetectedTextGroupKind, DetectedTextRegion } from '$lib/types/index.js';

/** Production text classes whose translation is required for an atomic page result. */
export const REQUIRED_TRANSLATION_KINDS = new Set<DetectedTextGroupKind>([
	'speech',
	'thought',
	'narration',
	'sign',
	'borderless'
]);

/**
 * Below this normalized (softmax) recognizer confidence a group's OCR text is
 * too shaky to *demand* a translation — forcing coverage on garbage corners
 * providers into fabricating dialogue (report T5). Demoted groups may still
 * be translated; their omission just cannot fail the page.
 */
export const REQUIRED_RECOGNITION_CONFIDENCE = 0.45;

/** SFX and genuinely unknown detections are best-effort and never fail a page. */
export function isRequiredTranslationRegion(region: DetectedTextRegion): boolean {
	// Older/non-PP-OCR records have no classifier result. Treat them
	// conservatively as regular text so provider omissions cannot disappear.
	if (region.groupKind === undefined) return true;
	if (!REQUIRED_TRANSLATION_KINDS.has(region.groupKind)) return false;
	return region.recognitionConfidence === undefined
		|| region.recognitionConfidence >= REQUIRED_RECOGNITION_CONFIDENCE;
}

export interface OverlayCoverageDiagnostics {
	acceptedIds: number[];
	missingRequiredIds: number[];
	optionalMissingIds: number[];
	duplicateIds: number[];
	unmappedIds: string[];
	requiredCount: number;
	translatedRequiredCount: number;
}

export type TranslationCoverageFailureReason = 'malformed' | 'incomplete' | 'invalid-output';

/**
 * A retryable, privacy-safe page-level failure. It intentionally contains
 * counts and canonical detector IDs only; source OCR text is never included.
 */
export class TranslationCoverageError extends Error {
	readonly code = 'TRANSLATION_COVERAGE_INCOMPLETE';
	readonly retryable = true;

	constructor(
		readonly reason: TranslationCoverageFailureReason,
		readonly recognizedCount: number,
		readonly translatedCount: number,
		readonly missingRequiredIds: readonly number[] = []
	) {
		const detail = reason === 'malformed'
			? 'The translation provider returned malformed numbered output.'
			: reason === 'invalid-output'
				? 'One or more required text blocks produced invalid translated output.'
				: `The translation provider returned ${translatedCount} of ${recognizedCount} required text blocks.`;
		super(`${detail} Retry this page.`);
		this.name = 'TranslationCoverageError';
	}
}

export function isTranslationCoverageError(error: unknown): error is TranslationCoverageError {
	return error instanceof TranslationCoverageError
		|| Boolean(error && typeof error === 'object'
			&& (error as { code?: unknown }).code === 'TRANSLATION_COVERAGE_INCOMPLETE');
}


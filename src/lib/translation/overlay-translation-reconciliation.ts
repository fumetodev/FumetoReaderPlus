import type {
	DetectedTextRegion,
	OverlayEntry,
	PageTranslationEntryDraft
} from '$lib/types/index.js';
import type { LLMResponse } from './llm-types.js';
import { parseOverlayResponse, type TranslationParseStatus } from './full-page-prompt.js';
import {
	TranslationCoverageError,
	isRequiredTranslationRegion,
	type OverlayCoverageDiagnostics
} from './translation-coverage.js';

export interface ReconciledOverlayTranslation {
	entries: PageTranslationEntryDraft[];
	overlayEntries: OverlayEntry[];
	status: TranslationParseStatus;
	coverage: OverlayCoverageDiagnostics;
	repairResponse?: LLMResponse;
}

interface ReconcileOverlayTranslationOptions {
	initialResponse: LLMResponse;
	regions: DetectedTextRegion[];
	authoritativeOriginals: ReadonlyMap<number, string>;
	requestRepair: (missingRequiredIds: readonly number[]) => Promise<LLMResponse>;
	validateResponse?: (response: LLMResponse) => void;
	onRepairing?: () => void;
}

function canonicalMerge(
	regions: readonly DetectedTextRegion[],
	left: ReturnType<typeof parseOverlayResponse>,
	right: ReturnType<typeof parseOverlayResponse> | undefined
): Pick<ReconciledOverlayTranslation, 'entries' | 'overlayEntries'> {
	const entriesById = new Map<number, PageTranslationEntryDraft>();
	const overlaysById = new Map<number, OverlayEntry>();
	for (const parsed of right ? [left, right] : [left]) {
		for (const entry of parsed.entries) {
			if (entry.boxId !== undefined && !entriesById.has(entry.boxId)) entriesById.set(entry.boxId, entry);
		}
		for (const entry of parsed.overlayEntries) {
			if (!overlaysById.has(entry.boxId)) overlaysById.set(entry.boxId, entry);
		}
	}
	const orderedIds = regions.map((region) => region.boxId).filter((id) => entriesById.has(id));
	return {
		entries: orderedIds.map((id, order) => ({ ...entriesById.get(id)!, order })),
		overlayEntries: orderedIds.flatMap((id) => {
			const entry = overlaysById.get(id);
			return entry ? [entry] : [];
		})
	};
}

function mergedCoverage(
	regions: readonly DetectedTextRegion[],
	authoritativeOriginals: ReadonlyMap<number, string>,
	acceptedIds: readonly number[],
	initial: OverlayCoverageDiagnostics,
	repair?: OverlayCoverageDiagnostics
): OverlayCoverageDiagnostics {
	const authoritativeRegions = regions.filter((region) => authoritativeOriginals.has(region.boxId));
	const requiredIds = authoritativeRegions.filter(isRequiredTranslationRegion).map((region) => region.boxId);
	const optionalIds = authoritativeRegions.filter((region) => !isRequiredTranslationRegion(region)).map((region) => region.boxId);
	const accepted = new Set(acceptedIds);
	return {
		acceptedIds: [...accepted].sort((a, b) => a - b),
		missingRequiredIds: requiredIds.filter((id) => !accepted.has(id)).sort((a, b) => a - b),
		optionalMissingIds: optionalIds.filter((id) => !accepted.has(id)).sort((a, b) => a - b),
		duplicateIds: [...new Set([...initial.duplicateIds, ...(repair?.duplicateIds ?? [])])].sort((a, b) => a - b),
		unmappedIds: [...new Set([...initial.unmappedIds, ...(repair?.unmappedIds ?? [])])].sort(),
		requiredCount: requiredIds.length,
		translatedRequiredCount: requiredIds.filter((id) => accepted.has(id)).length
	};
}

/**
 * Reconcile provider output against canonical PP-OCR IDs. Exactly one
 * missing-only repair is allowed, and no caller receives a partial result.
 */
export async function reconcileOverlayTranslation(
	options: ReconcileOverlayTranslationOptions
): Promise<ReconciledOverlayTranslation> {
	options.validateResponse?.(options.initialResponse);
	const initial = parseOverlayResponse(
		options.initialResponse.content,
		options.regions,
		options.authoritativeOriginals
	);
	if (initial.status === 'malformed') {
		throw new TranslationCoverageError(
			'malformed',
			initial.coverage.requiredCount,
			initial.coverage.translatedRequiredCount,
			initial.coverage.missingRequiredIds
		);
	}

	let repairResponse: LLMResponse | undefined;
	let repair: ReturnType<typeof parseOverlayResponse> | undefined;
	if (initial.coverage.missingRequiredIds.length > 0) {
		options.onRepairing?.();
		repairResponse = await options.requestRepair(initial.coverage.missingRequiredIds);
		options.validateResponse?.(repairResponse);
		repair = parseOverlayResponse(
			repairResponse.content,
			options.regions,
			options.authoritativeOriginals
		);
		if (repair.status === 'malformed') {
			throw new TranslationCoverageError(
				'malformed',
				initial.coverage.requiredCount,
				initial.coverage.translatedRequiredCount,
				initial.coverage.missingRequiredIds
			);
		}
	}

	const merged = canonicalMerge(options.regions, initial, repair);

	// Classifier-certain non-dialogue meta (credits, page markers, counters —
	// 'non-dialogue-meta' reason) must never render: providers sometimes
	// translate those boxes despite the skip instruction, and any output for
	// them is fabrication fuel (report T5, live-confirmed). Dropping them here
	// covers vision and text-only paths alike; the ids simply count as
	// optional-missing in coverage.
	const metaBoxIds = new Set(
		options.regions
			.filter((region) => region.classificationReasons?.includes('non-dialogue-meta'))
			.map((region) => region.boxId)
	);
	if (metaBoxIds.size > 0) {
		merged.entries = merged.entries
			.filter((entry) => entry.boxId === undefined || !metaBoxIds.has(entry.boxId))
			.map((entry, order) => ({ ...entry, order }));
		merged.overlayEntries = merged.overlayEntries.filter((entry) => !metaBoxIds.has(entry.boxId));
	}

	const coverage = mergedCoverage(
		options.regions,
		options.authoritativeOriginals,
		merged.entries.flatMap((entry) => entry.boxId === undefined ? [] : [entry.boxId]),
		initial.coverage,
		repair?.coverage
	);
	if (coverage.missingRequiredIds.length > 0) {
		throw new TranslationCoverageError(
			'incomplete',
			coverage.requiredCount,
			coverage.translatedRequiredCount,
			coverage.missingRequiredIds
		);
	}

	return {
		...merged,
		status: merged.entries.length > 0 ? 'ok' : 'empty',
		coverage,
		repairResponse
	};
}

export function aggregateTranslationUsage(
	initial: LLMResponse,
	repair?: LLMResponse
): Pick<LLMResponse, 'model' | 'usage'> {
	return {
		model: repair?.model || initial.model,
		usage: {
			prompt_tokens: initial.usage.prompt_tokens + (repair?.usage.prompt_tokens ?? 0),
			completion_tokens: initial.usage.completion_tokens + (repair?.usage.completion_tokens ?? 0)
		}
	};
}


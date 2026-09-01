/** Pure comparison/statistics helpers shared by OCR benchmark evidence tests. */

export interface ComparableRegion {
	boxId: number;
	x: number;
	y: number;
	width: number;
	height: number;
	confidence: number;
}

export interface ComparableRecognition {
	boxId: number;
	text: string;
	confidence: number;
}

export interface ComparableBlock {
	blockIndex: number;
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Stable, ID-keyed sequence diagnostics.
 *
 * `mismatchedIndices` is retained for report compatibility, but its values are
 * always indices into the reference sequence. Candidate-only entries therefore
 * appear in `unexpectedIds` and never contribute a candidate index to that
 * array.
 */
export interface KeyedSequenceDiagnostics {
	mismatchedIndices: number[];
	missingIds: number[];
	unexpectedIds: number[];
	reorderedIds: number[];
}

export interface RegionSequenceComparison extends KeyedSequenceDiagnostics {
	equivalent: boolean;
	referenceCount: number;
	candidateCount: number;
	countMatch: boolean;
	orderAndIdMatch: boolean;
	geometryMismatchIds: number[];
	confidenceMismatchIds: number[];
	maxCoordinateDeltaPx: number;
	maxConfidenceDelta: number;
	minimumIoU: number;
}

export interface TextSequenceComparison extends KeyedSequenceDiagnostics {
	equivalent: boolean;
	referenceCount: number;
	candidateCount: number;
	countMatch: boolean;
	orderAndIdMatch: boolean;
	exactStrings: boolean;
	contentMismatchIds: number[];
	confidenceMismatchIds: number[];
	characterErrorRate: number;
	maxConfidenceDelta: number;
}

export interface BlockSequenceComparison extends KeyedSequenceDiagnostics {
	equivalent: boolean;
	referenceCount: number;
	candidateCount: number;
	countMatch: boolean;
	orderAndIdMatch: boolean;
	exactStrings: boolean;
	contentMismatchIds: number[];
	geometryMismatchIds: number[];
	characterErrorRate: number;
	maxCoordinateDeltaPx: number;
}

export interface DistributionSummary {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
}

function finiteNonNegative(name: string, value: number): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a finite non-negative number`);
	}
}

function finiteField(record: Record<string, unknown>, field: string): boolean {
	return typeof record[field] === 'number' && Number.isFinite(record[field]);
}

export function comparableRegionFailures(value: unknown, label: string): string[] {
	if (!value || typeof value !== 'object') return [`${label} is not an object`];
	const record = value as Record<string, unknown>;
	const failures: string[] = [];
	if (typeof record.boxId !== 'number' || !Number.isSafeInteger(record.boxId) || record.boxId < 0) {
		failures.push(`${label}.boxId is invalid`);
	}
	for (const field of ['x', 'y', 'width', 'height'] as const) {
		const coordinate = Number(record[field]);
		const invalidRange = field === 'width' || field === 'height'
			? coordinate <= 0
			: coordinate < 0;
		if (!finiteField(record, field) || invalidRange) {
			failures.push(`${label}.${field} is invalid`);
		}
	}
	if (!finiteField(record, 'confidence') || Number(record.confidence) < 0 || Number(record.confidence) > 1) {
		failures.push(`${label}.confidence is invalid`);
	}
	return failures;
}

export function comparableRecognitionFailures(value: unknown, label: string): string[] {
	if (!value || typeof value !== 'object') return [`${label} is not an object`];
	const record = value as Record<string, unknown>;
	const failures: string[] = [];
	if (typeof record.boxId !== 'number' || !Number.isSafeInteger(record.boxId) || record.boxId < 0) {
		failures.push(`${label}.boxId is invalid`);
	}
	if (typeof record.text !== 'string') failures.push(`${label}.text is invalid`);
	if (!finiteField(record, 'confidence') || Number(record.confidence) < 0 || Number(record.confidence) > 1) {
		failures.push(`${label}.confidence is invalid`);
	}
	return failures;
}

export function comparableBlockFailures(value: unknown, label: string): string[] {
	if (!value || typeof value !== 'object') return [`${label} is not an object`];
	const record = value as Record<string, unknown>;
	const failures: string[] = [];
	if (typeof record.blockIndex !== 'number' || !Number.isSafeInteger(record.blockIndex) || record.blockIndex < 0) {
		failures.push(`${label}.blockIndex is invalid`);
	}
	if (typeof record.text !== 'string') failures.push(`${label}.text is invalid`);
	for (const field of ['x', 'y', 'width', 'height'] as const) {
		const coordinate = Number(record[field]);
		const invalidRange = field === 'width' || field === 'height'
			? coordinate <= 0
			: coordinate < 0;
		if (!finiteField(record, field) || invalidRange) {
			failures.push(`${label}.${field} is invalid`);
		}
	}
	return failures;
}

function assertSequenceFields(
	label: string,
	values: readonly unknown[],
	validate: (value: unknown, itemLabel: string) => string[]
): void {
	const failures = values.flatMap((value, index) => validate(value, `${label}[${index}]`));
	if (failures.length) throw new RangeError(failures.join('; '));
}

function assertUniqueIds<T>(
	label: string,
	values: readonly T[],
	getId: (value: T) => number
): void {
	const seen = new Set<number>();
	const duplicates = new Set<number>();
	for (const value of values) {
		const id = getId(value);
		if (seen.has(id)) duplicates.add(id);
		seen.add(id);
	}
	if (duplicates.size > 0) {
		throw new RangeError(`${label} IDs must be unique; duplicate IDs: ${[...duplicates].join(', ')}`);
	}
}

function reorderedSharedIds(referenceIds: readonly number[], candidateIds: readonly number[]): number[] {
	const referenceSet = new Set(referenceIds);
	const candidateSet = new Set(candidateIds);
	const referenceSharedOrder = referenceIds.filter((id) => candidateSet.has(id));
	const candidateSharedOrder = candidateIds.filter((id) => referenceSet.has(id));
	return referenceSharedOrder.filter((id, index) => candidateSharedOrder[index] !== id);
}

function referenceMismatchIndices(
	referenceIds: readonly number[],
	...mismatchIdGroups: readonly (readonly number[])[]
): number[] {
	const mismatchIds = new Set(mismatchIdGroups.flat());
	return referenceIds.flatMap((id, index) => mismatchIds.has(id) ? [index] : []);
}

export function regionIoU(a: ComparableRegion, b: ComparableRegion): number {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
	const union = a.width * a.height + b.width * b.height - intersection;
	return union > 0 ? intersection / union : 0;
}

export function compareRegionSequences(
	reference: readonly ComparableRegion[],
	candidate: readonly ComparableRegion[],
	options: { coordinateTolerancePx?: number; confidenceTolerance?: number; minimumIoU?: number } = {}
): RegionSequenceComparison {
	assertSequenceFields('reference regions', reference, comparableRegionFailures);
	assertSequenceFields('candidate regions', candidate, comparableRegionFailures);
	assertUniqueIds('reference region box', reference, (item) => item.boxId);
	assertUniqueIds('candidate region box', candidate, (item) => item.boxId);
	const coordinateTolerancePx = options.coordinateTolerancePx ?? 1;
	const confidenceTolerance = options.confidenceTolerance ?? 1e-3;
	const minimumIoU = options.minimumIoU ?? 0.98;
	finiteNonNegative('coordinateTolerancePx', coordinateTolerancePx);
	finiteNonNegative('confidenceTolerance', confidenceTolerance);
	if (!Number.isFinite(minimumIoU) || minimumIoU < 0 || minimumIoU > 1) {
		throw new RangeError('minimumIoU must be between zero and one');
	}

	const referenceIds = reference.map((item) => item.boxId);
	const candidateIds = candidate.map((item) => item.boxId);
	const referenceIdSet = new Set(referenceIds);
	const candidateIdSet = new Set(candidateIds);
	const candidateById = new Map(candidate.map((item) => [item.boxId, item]));
	const missingIds = referenceIds.filter((id) => !candidateIdSet.has(id));
	const unexpectedIds = candidateIds.filter((id) => !referenceIdSet.has(id));
	const reorderedIds = reorderedSharedIds(referenceIds, candidateIds);
	const geometryMismatchIds: number[] = [];
	const confidenceMismatchIds: number[] = [];
	const orderAndIdMatch = referenceIds.length === candidateIds.length
		&& referenceIds.every((id, index) => id === candidateIds[index]);
	let maxCoordinateDeltaPx = 0;
	let maxConfidenceDelta = 0;
	let observedMinimumIoU = 1;
	for (const expected of reference) {
		const actual = candidateById.get(expected.boxId);
		if (!actual) continue;
		const coordinateDelta = Math.max(
			Math.abs(expected.x - actual.x),
			Math.abs(expected.y - actual.y),
			Math.abs(expected.width - actual.width),
			Math.abs(expected.height - actual.height)
		);
		const confidenceDelta = Math.abs(expected.confidence - actual.confidence);
		const iou = regionIoU(expected, actual);
		maxCoordinateDeltaPx = Math.max(maxCoordinateDeltaPx, coordinateDelta);
		maxConfidenceDelta = Math.max(maxConfidenceDelta, confidenceDelta);
		observedMinimumIoU = Math.min(observedMinimumIoU, iou);
		if (coordinateDelta > coordinateTolerancePx || iou < minimumIoU) {
			geometryMismatchIds.push(expected.boxId);
		}
		if (confidenceDelta > confidenceTolerance) confidenceMismatchIds.push(expected.boxId);
	}
	if (missingIds.length > 0 || unexpectedIds.length > 0) observedMinimumIoU = 0;
	const countMatch = reference.length === candidate.length;
	const mismatchedIndices = referenceMismatchIndices(
		referenceIds,
		missingIds,
		reorderedIds,
		geometryMismatchIds,
		confidenceMismatchIds
	);
	return {
		equivalent: countMatch
			&& orderAndIdMatch
			&& missingIds.length === 0
			&& unexpectedIds.length === 0
			&& geometryMismatchIds.length === 0
			&& confidenceMismatchIds.length === 0,
		referenceCount: reference.length,
		candidateCount: candidate.length,
		countMatch,
		orderAndIdMatch,
		mismatchedIndices,
		missingIds,
		unexpectedIds,
		reorderedIds,
		geometryMismatchIds,
		confidenceMismatchIds,
		maxCoordinateDeltaPx,
		maxConfidenceDelta,
		minimumIoU: observedMinimumIoU
	};
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				current[j - 1] + 1,
				previous[j] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
		}
		previous = current;
	}
	return previous[b.length];
}

export function compareRecognitionSequences(
	reference: readonly ComparableRecognition[],
	candidate: readonly ComparableRecognition[],
	confidenceTolerance = 1e-3
): TextSequenceComparison {
	assertSequenceFields('reference recognition', reference, comparableRecognitionFailures);
	assertSequenceFields('candidate recognition', candidate, comparableRecognitionFailures);
	assertUniqueIds('reference recognition box', reference, (item) => item.boxId);
	assertUniqueIds('candidate recognition box', candidate, (item) => item.boxId);
	finiteNonNegative('confidenceTolerance', confidenceTolerance);
	let totalCharacters = 0;
	let totalEdits = 0;
	let maxConfidenceDelta = 0;
	const candidateById = new Map(candidate.map((item) => [item.boxId, item]));
	const referenceIds = reference.map((item) => item.boxId);
	const candidateIds = candidate.map((item) => item.boxId);
	const referenceIdSet = new Set(referenceIds);
	const candidateIdSet = new Set(candidateIds);
	const missingIds = referenceIds.filter((id) => !candidateIdSet.has(id));
	const unexpectedIds = candidateIds.filter((id) => !referenceIdSet.has(id));
	const reorderedIds = reorderedSharedIds(referenceIds, candidateIds);
	const contentMismatchIds: number[] = [];
	const confidenceMismatchIds: number[] = [];
	const orderAndIdMatch = referenceIds.length === candidateIds.length
		&& referenceIds.every((id, index) => id === candidateIds[index]);
	for (const expected of reference) {
		const actual = candidateById.get(expected.boxId);
		if (!actual) {
			totalCharacters += Math.max(1, expected.text.length);
			totalEdits += expected.text.length;
			continue;
		}
		totalCharacters += Math.max(1, expected.text.length);
		totalEdits += levenshtein(expected.text, actual.text);
		const confidenceDelta = Math.abs(expected.confidence - actual.confidence);
		maxConfidenceDelta = Math.max(maxConfidenceDelta, confidenceDelta);
		if (expected.text !== actual.text) contentMismatchIds.push(expected.boxId);
		if (confidenceDelta > confidenceTolerance) confidenceMismatchIds.push(expected.boxId);
	}
	for (const actual of candidate) {
		if (referenceIdSet.has(actual.boxId)) continue;
		totalCharacters += Math.max(1, actual.text.length);
		totalEdits += actual.text.length;
	}
	const countMatch = reference.length === candidate.length;
	const exactStrings = missingIds.length === 0
		&& unexpectedIds.length === 0
		&& contentMismatchIds.length === 0;
	const mismatchedIndices = referenceMismatchIndices(
		referenceIds,
		missingIds,
		reorderedIds,
		contentMismatchIds,
		confidenceMismatchIds
	);
	return {
		equivalent: countMatch
			&& orderAndIdMatch
			&& exactStrings
			&& confidenceMismatchIds.length === 0,
		referenceCount: reference.length,
		candidateCount: candidate.length,
		countMatch,
		orderAndIdMatch,
		exactStrings,
		mismatchedIndices,
		missingIds,
		unexpectedIds,
		reorderedIds,
		contentMismatchIds,
		confidenceMismatchIds,
		characterErrorRate: totalCharacters > 0 ? totalEdits / totalCharacters : 0,
		maxConfidenceDelta
	};
}

export function compareBlockSequences(
	reference: readonly ComparableBlock[],
	candidate: readonly ComparableBlock[],
	coordinateTolerancePx = 1
): BlockSequenceComparison {
	assertSequenceFields('reference blocks', reference, comparableBlockFailures);
	assertSequenceFields('candidate blocks', candidate, comparableBlockFailures);
	assertUniqueIds('reference block', reference, (item) => item.blockIndex);
	assertUniqueIds('candidate block', candidate, (item) => item.blockIndex);
	finiteNonNegative('coordinateTolerancePx', coordinateTolerancePx);
	let maxCoordinateDeltaPx = 0;
	let totalCharacters = 0;
	let totalEdits = 0;
	const candidateById = new Map(candidate.map((item) => [item.blockIndex, item]));
	const referenceIds = reference.map((item) => item.blockIndex);
	const candidateIds = candidate.map((item) => item.blockIndex);
	const referenceIdSet = new Set(referenceIds);
	const candidateIdSet = new Set(candidateIds);
	const missingIds = referenceIds.filter((id) => !candidateIdSet.has(id));
	const unexpectedIds = candidateIds.filter((id) => !referenceIdSet.has(id));
	const reorderedIds = reorderedSharedIds(referenceIds, candidateIds);
	const contentMismatchIds: number[] = [];
	const geometryMismatchIds: number[] = [];
	const orderAndIdMatch = referenceIds.length === candidateIds.length
		&& referenceIds.every((id, index) => id === candidateIds[index]);
	for (const expected of reference) {
		const actual = candidateById.get(expected.blockIndex);
		if (!actual) {
			totalCharacters += Math.max(1, expected.text.length);
			totalEdits += expected.text.length;
			continue;
		}
		const coordinateDelta = Math.max(
			Math.abs(expected.x - actual.x),
			Math.abs(expected.y - actual.y),
			Math.abs(expected.width - actual.width),
			Math.abs(expected.height - actual.height)
		);
		maxCoordinateDeltaPx = Math.max(maxCoordinateDeltaPx, coordinateDelta);
		totalCharacters += Math.max(1, expected.text.length);
		totalEdits += levenshtein(expected.text, actual.text);
		if (expected.text !== actual.text) contentMismatchIds.push(expected.blockIndex);
		if (coordinateDelta > coordinateTolerancePx) geometryMismatchIds.push(expected.blockIndex);
	}
	for (const actual of candidate) {
		if (referenceIdSet.has(actual.blockIndex)) continue;
		totalCharacters += Math.max(1, actual.text.length);
		totalEdits += actual.text.length;
	}
	const countMatch = reference.length === candidate.length;
	const exactStrings = missingIds.length === 0
		&& unexpectedIds.length === 0
		&& contentMismatchIds.length === 0;
	const mismatchedIndices = referenceMismatchIndices(
		referenceIds,
		missingIds,
		reorderedIds,
		contentMismatchIds,
		geometryMismatchIds
	);
	return {
		equivalent: countMatch
			&& orderAndIdMatch
			&& exactStrings
			&& geometryMismatchIds.length === 0,
		referenceCount: reference.length,
		candidateCount: candidate.length,
		countMatch,
		orderAndIdMatch,
		exactStrings,
		mismatchedIndices,
		missingIds,
		unexpectedIds,
		reorderedIds,
		contentMismatchIds,
		geometryMismatchIds,
		characterErrorRate: totalCharacters > 0 ? totalEdits / totalCharacters : 0,
		maxCoordinateDeltaPx
	};
}

export function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) throw new RangeError('Cannot calculate a percentile of an empty sample');
	if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
		throw new RangeError('quantile must be between zero and one');
	}
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.some((value) => !Number.isFinite(value))) throw new RangeError('Samples must be finite');
	const index = (sorted.length - 1) * quantile;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
	if (values.length === 0) throw new RangeError('Cannot summarize an empty sample');
	const min = Math.min(...values);
	const max = Math.max(...values);
	return {
		count: values.length,
		min,
		max,
		mean: values.reduce((sum, value) => sum + value, 0) / values.length,
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95)
	};
}

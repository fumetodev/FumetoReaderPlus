import type {
	OverlayContainerV2,
	OverlayItemV2,
	OverlayRenderPlanV2,
	OverlaySourceV2,
	PageOverlayDataV2,
	Point,
	Rect
} from '$lib/types/index.js';
import { canonicalClone, canonicalStringify, sha256 } from './canonical.js';

export type OverlayDecodeResult =
	| { kind: 'absent' }
	| { kind: 'v2'; value: PageOverlayDataV2 }
	| { kind: 'legacy'; schemaVersion: 0 | 1 }
	| { kind: 'future'; schemaVersion: number }
	| { kind: 'malformed'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function validPoint(value: unknown): value is Point {
	return isRecord(value) && finite(value.x) && finite(value.y);
}

function validPolygon(value: unknown, allowEmpty = false): value is Point[] {
	return Array.isArray(value) && (allowEmpty || value.length >= 3) && value.every(validPoint);
}

function validRect(value: unknown): value is Rect {
	return isRecord(value)
		&& finite(value.x)
		&& finite(value.y)
		&& finite(value.width)
		&& finite(value.height)
		&& value.width > 0
		&& value.height > 0;
}

function validSource(value: unknown): value is OverlaySourceV2 {
	return isRecord(value)
		&& nonEmpty(value.id)
		&& validPolygon(value.polygon)
		&& validRect(value.bounds)
		&& finite(value.confidence)
		&& value.confidence >= 0
		&& value.confidence <= 1
		&& finite(value.orientationDegrees);
}

function validContainer(value: unknown): value is OverlayContainerV2 {
	return isRecord(value)
		&& nonEmpty(value.id)
		&& ['speech', 'thought', 'narration', 'sign', 'panel', 'free'].includes(String(value.kind))
		&& ['detected', 'inferred', 'manual'].includes(String(value.origin))
		&& validPolygon(value.polygon)
		&& (value.tailPolygon === undefined || validPolygon(value.tailPolygon))
		&& Array.isArray(value.sourceIds)
		&& value.sourceIds.every(nonEmpty)
		&& (value.confidence === undefined || finite(value.confidence));
}

function validItem(value: unknown): value is OverlayItemV2 {
	if (!isRecord(value) || !isRecord(value.manual)) return false;
	const manual = value.manual;
	return nonEmpty(value.id)
		&& nonEmpty(value.translationEntryId)
		&& Array.isArray(value.sourceIds)
		&& value.sourceIds.every(nonEmpty)
		&& (value.containerId === undefined || nonEmpty(value.containerId))
		&& ['speech', 'thought', 'narration', 'sign', 'sfx', 'unknown'].includes(String(value.type))
		&& Number.isSafeInteger(value.order)
		&& nonEmpty(value.styleKey)
		&& (value.sourceWritingMode === undefined
			|| ['horizontal-tb', 'vertical-rl'].includes(String(value.sourceWritingMode)))
		&& (value.continuesPrevious === undefined || typeof value.continuesPrevious === 'boolean')
		&& (manual.rect === undefined || validRect(manual.rect))
		&& (manual.rotationDegrees === undefined || finite(manual.rotationDegrees))
		&& (manual.referenceFontSize === undefined || finite(manual.referenceFontSize))
		&& (manual.writingMode === undefined || ['horizontal-tb', 'vertical-rl'].includes(String(manual.writingMode)))
		&& (manual.pinGeometry === undefined || typeof manual.pinGeometry === 'boolean')
		&& (manual.pinTypography === undefined || typeof manual.pinTypography === 'boolean')
		&& (manual.textOverride === undefined || typeof manual.textOverride === 'string')
		&& (manual.hidden === undefined || typeof manual.hidden === 'boolean')
		&& (manual.removed === undefined || typeof manual.removed === 'boolean');
}

export function decodeOverlayData(value: unknown): OverlayDecodeResult {
	if (value === undefined || value === null) return { kind: 'absent' };
	if (!isRecord(value)) return { kind: 'malformed', reason: 'Overlay payload is not an object' };
	if (value.schemaVersion === undefined) {
		return Array.isArray(value.regions) || Array.isArray(value.entries)
			? { kind: 'legacy', schemaVersion: 0 }
			: { kind: 'malformed', reason: 'Overlay schemaVersion is missing' };
	}
	if (!Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) {
		return { kind: 'malformed', reason: 'Overlay schemaVersion is invalid' };
	}
	if (value.schemaVersion === 1) return { kind: 'legacy', schemaVersion: 1 };
	if (Number(value.schemaVersion) > 2) return { kind: 'future', schemaVersion: Number(value.schemaVersion) };
	if (
		value.schemaVersion !== 2
		|| !Number.isSafeInteger(value.documentRevision)
		|| Number(value.documentRevision) < 1
		|| !isRecord(value.sourceImage)
		|| !finite(value.sourceImage.width)
		|| !finite(value.sourceImage.height)
		|| Number(value.sourceImage.width) <= 0
		|| Number(value.sourceImage.height) <= 0
		|| !nonEmpty(value.sourceImage.fingerprint)
		|| !nonEmpty(value.locale)
		|| !['ltr', 'rtl', 'auto'].includes(String(value.baseDirection))
		|| !Array.isArray(value.sources)
		|| !value.sources.every(validSource)
		|| !Array.isArray(value.containers)
		|| !value.containers.every(validContainer)
		|| !Array.isArray(value.items)
		|| !value.items.every(validItem)
	) return { kind: 'malformed', reason: 'Overlay V2 contract validation failed' };

	const sourceIds = new Set((value.sources as OverlaySourceV2[]).map((source) => source.id));
	const containerIds = new Set((value.containers as OverlayContainerV2[]).map((container) => container.id));
	const itemIds = new Set<string>();
	if (sourceIds.size !== value.sources.length || containerIds.size !== value.containers.length) {
		return { kind: 'malformed', reason: 'Overlay V2 IDs must be unique' };
	}
	for (const container of value.containers as OverlayContainerV2[]) {
		if (container.sourceIds.some((id) => !sourceIds.has(id))) {
			return { kind: 'malformed', reason: `Container ${container.id} references an unknown source` };
		}
	}
	for (const item of value.items as OverlayItemV2[]) {
		if (itemIds.has(item.id)) return { kind: 'malformed', reason: 'Overlay item IDs must be unique' };
		itemIds.add(item.id);
		if (item.sourceIds.some((id) => !sourceIds.has(id))) {
			return { kind: 'malformed', reason: `Item ${item.id} references an unknown source` };
		}
		if (item.containerId && !containerIds.has(item.containerId)) {
			return { kind: 'malformed', reason: `Item ${item.id} references an unknown container` };
		}
	}

	return { kind: 'v2', value: canonicalClone(value as unknown as PageOverlayDataV2) };
}

export function assertOverlayDataV2(value: unknown): PageOverlayDataV2 {
	const decoded = decodeOverlayData(value);
	if (decoded.kind !== 'v2') throw new TypeError(`Expected overlay schema V2; received ${decoded.kind}`);
	return decoded.value;
}

export function overlayDocumentForHash(document: PageOverlayDataV2): Omit<PageOverlayDataV2, 'cachedPlan'> {
	const { cachedPlan: _cachedPlan, ...authority } = document;
	return authority;
}

export async function hashOverlayDocument(document: PageOverlayDataV2): Promise<string> {
	return sha256(overlayDocumentForHash(document));
}

export async function isValidCachedPlan(
	document: PageOverlayDataV2,
	inputHash: string,
	expected: { algorithmVersion: string; fontFingerprint: string; settingsFingerprint: string }
): Promise<boolean> {
	const cache = document.cachedPlan;
	if (!cache || cache.inputHash !== inputHash) return false;
	const plan = cache.plan;
	if (
		plan?.renderPlanVersion !== 1
		|| plan.inputHash !== inputHash
		|| plan.documentRevision !== document.documentRevision
		|| plan.algorithmVersion !== expected.algorithmVersion
		|| plan.fontSetFingerprint !== expected.fontFingerprint
		|| plan.settingsFingerprint !== expected.settingsFingerprint
		|| plan.sourceImage.width !== document.sourceImage.width
		|| plan.sourceImage.height !== document.sourceImage.height
		|| !Array.isArray(plan.items)
	) return false;
	try {
		const { planId, ...authority } = plan;
		return planId === await sha256(authority) && canonicalStringify(plan).length > 0;
	} catch {
		return false;
	}
}

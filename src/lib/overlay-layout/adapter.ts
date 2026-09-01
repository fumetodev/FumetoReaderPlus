import type {
	DetectedTextComponent,
	DetectedTextRegion,
	OverlayContainerV2,
	OverlayEntry,
	OverlayItemV2,
	OverlaySourceV2,
	PageOverlayDataV2,
	PageOverlayDraft,
	PageTranslationEntry,
	PageTranslationEntryDraft,
	Point,
	Rect
} from '$lib/types/index.js';
import { canonicalStringify, compareCanonicalText, stableOverlayId } from './canonical.js';

/**
 * The overlay document's locale, resolved from the configured target language.
 *
 * This locale is the TRANSLATION TARGET, not the source, and it decides
 * typography — soft hyphenation above all, which applies en-US patterns and is
 * gated on it. An empty or missing settings field must resolve to the app's own
 * default target here rather than falling through to the `'und'` below: `'und'`
 * is not English, so a dropped locale would silently stop hyphenating for
 * English readers and every balloon would answer with a smaller font. Every
 * production caller of the two constructors goes through this, and
 * `validate:overlay-layout` fails if one stops.
 */
export function overlayTargetLocale(targetLanguage: string | null | undefined): string {
	return targetLanguage?.trim() || 'en';
}

export interface OverlayDraftAdapterInput {
	draft: PageOverlayDraft;
	entries: PageTranslationEntryDraft[];
	sourceImage: { width: number; height: number; fingerprint: string };
	locale: string;
	baseDirection?: 'ltr' | 'rtl' | 'auto';
	documentRevision?: number;
	pipeline?: string;
}

interface SourceSeed {
	componentId: number;
	polygon: Point[];
	bounds: Rect;
	confidence: number;
	orientationDegrees: number;
	foregroundPixelCount?: number;
	meanConfidence?: number;
	maxConfidence?: number;
}

interface AdaptedItem {
	draftItem: OverlayEntry;
	region?: DetectedTextRegion;
	translation: PageTranslationEntry;
	sourceIds: string[];
	semanticType: OverlayItemV2['type'];
	actualBubbleKey?: string;
	bubblePolygon?: Point[];
}

const rectPolygon = (rect: Rect): Point[] => [
	{ x: rect.x, y: rect.y },
	{ x: rect.x + rect.width, y: rect.y },
	{ x: rect.x + rect.width, y: rect.y + rect.height },
	{ x: rect.x, y: rect.y + rect.height }
];

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function positiveRect(rect: Rect): boolean {
	return finite(rect.x)
		&& finite(rect.y)
		&& finite(rect.width)
		&& finite(rect.height)
		&& rect.width > 0
		&& rect.height > 0;
}

function comparePoints(left: Point, right: Point): number {
	return left.x - right.x || left.y - right.y;
}

function comparePointLists(left: Point[], right: Point[]): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const comparison = comparePoints(left[index], right[index]);
		if (comparison !== 0) return comparison;
	}
	return left.length - right.length;
}

/**
 * Normalize only the polygon's representation, never its geometry. Detector
 * contours can start at any vertex (and can arrive clockwise or
 * counter-clockwise); durable source identity must not depend on either.
 */
function canonicalPolygon(points: Point[]): Point[] | undefined {
	if (points.length < 3 || points.some((point) => !finite(point.x) || !finite(point.y))) return undefined;
	const candidates: Point[][] = [];
	for (const sequence of [points, [...points].reverse()]) {
		for (let offset = 0; offset < sequence.length; offset += 1) {
			candidates.push(sequence.slice(offset).concat(sequence.slice(0, offset)).map((point) => ({ ...point })));
		}
	}
	candidates.sort(comparePointLists);
	return candidates[0];
}

function tuplePolygon(points?: [number, number][]): Point[] | undefined {
	if (!points) return undefined;
	return canonicalPolygon(points.map(([x, y]) => ({ x, y })));
}

function polygonBounds(polygon: Point[]): Rect {
	const xs = polygon.map((point) => point.x);
	const ys = polygon.map((point) => point.y);
	return {
		x: Math.min(...xs),
		y: Math.min(...ys),
		width: Math.max(...xs) - Math.min(...xs),
		height: Math.max(...ys) - Math.min(...ys)
	};
}

function regionRect(region: DetectedTextRegion): Rect {
	return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function overlayRect(entry: OverlayEntry): Rect {
	return {
		x: entry.customX ?? entry.x,
		y: entry.customY ?? entry.y,
		width: entry.customWidth ?? entry.width,
		height: entry.customHeight ?? entry.height
	};
}

function boundedConfidence(value: number): number {
	return Math.min(1, Math.max(0, finite(value) ? value : 0));
}

function sourceSeedFromComponent(component: DetectedTextComponent): SourceSeed {
	const componentBounds = {
		x: component.x,
		y: component.y,
		width: component.width,
		height: component.height
	};
	const polygon = tuplePolygon(component.polygon)
		?? (positiveRect(componentBounds) ? rectPolygon(componentBounds) : undefined);
	if (!polygon) throw new TypeError(`PP-OCR component ${component.componentId} has invalid source geometry`);
	const derivedBounds = polygonBounds(polygon);
	// The polygon is the authoritative raw detector geometry. Keeping an
	// independently supplied AABB here can create a durable source whose bounds
	// do not enclose its own polygon (and used to expose native/WASM drift).
	// Always derive the persisted bounds from the canonical polygon instead.
	if (!positiveRect(derivedBounds)) {
		throw new TypeError(`PP-OCR component ${component.componentId} has zero-area source geometry`);
	}
	return {
		componentId: component.componentId,
		polygon,
		bounds: derivedBounds,
		confidence: boundedConfidence(component.confidence),
		orientationDegrees: finite(component.orientationDegrees) ? component.orientationDegrees : 0,
		foregroundPixelCount: component.foregroundPixelCount,
		meanConfidence: component.meanConfidence,
		maxConfidence: component.maxConfidence
	};
}

function fallbackSourceSeed(region: DetectedTextRegion, componentId: number): SourceSeed {
	const bounds = regionRect(region);
	if (!positiveRect(bounds)) throw new TypeError(`Detected region ${region.boxId} has zero-area source geometry`);
	return {
		componentId,
		// A bubble contour is container geometry. It must never be promoted to a
		// source polygon, even for compatibility inputs without raw components.
		polygon: tuplePolygon(region.polygon) ?? rectPolygon(bounds),
		bounds,
		confidence: boundedConfidence(region.confidence),
		orientationDegrees: finite(region.orientationDegrees) ? region.orientationDegrees : 0,
		foregroundPixelCount: region.foregroundPixelCount,
		meanConfidence: region.meanConfidence,
		maxConfidence: region.maxConfidence
	};
}

function sourceSeedsForRegion(region: DetectedTextRegion): SourceSeed[] {
	if (region.sourceComponents?.length) {
		const seeds = region.sourceComponents.map(sourceSeedFromComponent);
		const actualIds = seeds.map((seed) => seed.componentId);
		const declaredIds = region.sourceComponentIds;
		if (declaredIds?.length) {
			const actual = [...new Set(actualIds)].sort((left, right) => left - right);
			const declared = [...new Set(declaredIds)].sort((left, right) => left - right);
			if (canonicalStringify(actual) !== canonicalStringify(declared)) {
				throw new TypeError(`Detected region ${region.boxId} has incomplete raw-component lineage`);
			}
		}
		return seeds;
	}

	const declaredIds = [...new Set(region.sourceComponentIds ?? [region.boxId])];
	if (declaredIds.length !== 1) {
		throw new TypeError(
			`Detected region ${region.boxId} declares ${declaredIds.length} components without their polygons`
		);
	}
	return [fallbackSourceSeed(region, declaredIds[0])];
}

function normalizedEntry(
	entry: PageTranslationEntryDraft,
	seed: unknown,
	identitySourceIds: readonly string[] = []
): PageTranslationEntry {
	const id = entry.id || stableOverlayId('entry', [
		seed,
		...(identitySourceIds.length
			? ['sources', [...identitySourceIds]]
			: ['unboxed', entry.order, entry.original_text, entry.type ?? 'unknown', entry.speaker ?? ''])
	]);
	const { boxId: _detectorLabel, ...durable } = entry;
	return { ...durable, id };
}

function productionSemanticType(region?: DetectedTextRegion): OverlayItemV2['type'] | undefined {
	switch (region?.groupKind) {
		case 'speech':
		case 'thought':
		case 'narration':
		case 'sign':
		case 'sfx':
			return region.groupKind;
		case 'borderless':
		case 'unknown':
			return 'unknown';
		default:
			return undefined;
	}
}

function semanticTypeFor(entry: OverlayEntry, region?: DetectedTextRegion): OverlayItemV2['type'] {
	// PP-OCR recognition/classification is backend-independent and therefore
	// authoritative. Provider-returned type labels remain useful only for paths
	// (such as VLM-native) that do not have a production classifier result.
	return productionSemanticType(region) ?? entry.type ?? 'unknown';
}

/**
 * The classifier's own confidence in the kind it chose, quantized to 0.01.
 *
 * Only carried when the PRODUCTION classifier decided the type. A
 * provider-supplied `entry.type` is a label from a translation backend, not a
 * measured classification, and reporting a confidence for it would invite the
 * reader to trust a number nobody computed.
 *
 * Quantized because this field enters the layout input hash: raw classifier
 * floats would make two otherwise identical documents miss each other's cached
 * plan over a difference that cannot move a glyph.
 */
function classificationConfidenceFor(region?: DetectedTextRegion): number | undefined {
	if (productionSemanticType(region) === undefined) return undefined;
	const value = region?.classificationConfidence;
	if (!finite(value) || value < 0 || value > 1) return undefined;
	return Math.round(value * 100) / 100;
}

function styleKeyFor(type: OverlayItemV2['type']): string {
	switch (type) {
		case 'speech': return 'dialogue';
		case 'thought': return 'thought';
		case 'narration': return 'narration';
		case 'sign': return 'sign';
		case 'sfx': return 'sfx';
		case 'unknown': return 'unknown';
	}
}

function sourceSort(left: OverlaySourceV2, right: OverlaySourceV2): number {
	return left.bounds.y - right.bounds.y
		|| left.bounds.x - right.bounds.x
		|| left.bounds.height - right.bounds.height
		|| left.bounds.width - right.bounds.width
		|| compareCanonicalText(left.id, right.id);
}

function bubbleEvidence(
	region: DetectedTextRegion | undefined,
	draftItem: OverlayEntry
): { key: string; polygon: Point[] } | undefined {
	if (!region) return undefined;
	const polygon = tuplePolygon(region.contour)
		?? (region.inBubble ? tuplePolygon(draftItem.contour) : undefined);
	if (!polygon || (region.bubbleId === undefined && !region.inBubble)) return undefined;
	return {
		key: region.bubbleId === undefined
			? `contour:${canonicalStringify(polygon)}`
			: `bubble:${region.bubbleId}`,
		polygon
	};
}

function freeContainerPolygon(item: AdaptedItem): Point[] {
	const bounds = item.region ? regionRect(item.region) : overlayRect(item.draftItem);
	const polygon = tuplePolygon(item.region?.polygon) ?? rectPolygon(bounds);
	return canonicalPolygon(polygon) ?? rectPolygon(bounds);
}

export function createOverlayDocumentV2(input: OverlayDraftAdapterInput): {
	document: PageOverlayDataV2;
	entries: PageTranslationEntry[];
} {
	const pageSeed = [input.sourceImage.fingerprint, input.sourceImage.width, input.sourceImage.height];
	const pipeline = input.pipeline ?? 'overlay-adapter';

	const regionByBox = new Map<number, DetectedTextRegion>();
	for (const region of input.draft.regions) {
		if (regionByBox.has(region.boxId)) throw new TypeError(`Duplicate detected region boxId ${region.boxId}`);
		regionByBox.set(region.boxId, region);
	}

	const sourceByComponentId = new Map<number, OverlaySourceV2>();
	const sourceSignatureByComponentId = new Map<number, string>();
	const sourceIdsByBox = new Map<number, string[]>();
	for (const region of input.draft.regions) {
		const regionSourceIds: string[] = [];
		for (const seed of sourceSeedsForRegion(region)) {
			if (!Number.isSafeInteger(seed.componentId)) {
				throw new TypeError(`Detected region ${region.boxId} has an invalid component ID`);
			}
			const signature = canonicalStringify({
				polygon: seed.polygon,
				bounds: seed.bounds,
				orientationDegrees: seed.orientationDegrees
			});
			const existingSignature = sourceSignatureByComponentId.get(seed.componentId);
			if (existingSignature !== undefined && existingSignature !== signature) {
				throw new TypeError(`PP-OCR component ${seed.componentId} has conflicting source geometry`);
			}
			let source = sourceByComponentId.get(seed.componentId);
			if (!source) {
				// The detector pipeline is diagnostic metadata, not durable identity.
				// Equivalent page-space source geometry must keep the same source ID
				// when a user switches between on-device and off-device translation.
				const id = stableOverlayId('source', [pageSeed, signature]);
				if ([...sourceByComponentId.values()].some((candidate) => candidate.id === id)) {
					throw new TypeError('Distinct PP-OCR components have indistinguishable source geometry');
				}
				source = {
					id,
					detectorRef: { pipeline, label: String(seed.componentId) },
					polygon: seed.polygon,
					bounds: seed.bounds,
					confidence: seed.confidence,
					orientationDegrees: seed.orientationDegrees
				};
				sourceByComponentId.set(seed.componentId, source);
				sourceSignatureByComponentId.set(seed.componentId, signature);
			}
			if (!regionSourceIds.includes(source.id)) regionSourceIds.push(source.id);
		}
		sourceIdsByBox.set(region.boxId, regionSourceIds);
	}
	const sources = [...sourceByComponentId.values()].sort(sourceSort);
	const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
	const sortSourceIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort((left, right) =>
		(sourceOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
			|| compareCanonicalText(left, right));
	const canonicalInputEntries = input.entries.map((entry) => {
		const region = entry.boxId === undefined ? undefined : regionByBox.get(entry.boxId);
		const semanticType = productionSemanticType(region);
		// A provider 'sfx' label survives canonicalization: the classifier cannot
		// recognize drawn lettering (it yields sign/unknown for exactly those
		// regions), and the SFX visibility gate needs the provider's claim.
		// Region-derived typing still owns the ITEM type via semanticTypeFor.
		if (entry.type === 'sfx') return entry;
		return semanticType === undefined || entry.type === semanticType
			? entry
			: { ...entry, type: semanticType };
	});
	const normalizedAtInputIndex = canonicalInputEntries.map((entry) => normalizedEntry(
		entry,
		pageSeed,
		entry.boxId === undefined ? [] : sortSourceIds(sourceIdsByBox.get(entry.boxId) ?? [])
	));
	const normalizedEntries = [...normalizedAtInputIndex].sort((left, right) =>
		left.order - right.order || compareCanonicalText(left.id, right.id));
	const entryByBox = new Map<number, PageTranslationEntry>();
	canonicalInputEntries.forEach((entry, index) => {
		if (entry.boxId !== undefined) entryByBox.set(entry.boxId, normalizedAtInputIndex[index]);
	});

	const adaptedItems: AdaptedItem[] = [];
	for (let index = 0; index < input.draft.entries.length; index += 1) {
		const draftItem = input.draft.entries[index];
		const translation = entryByBox.get(draftItem.boxId) ?? normalizedAtInputIndex[index];
		if (!translation) continue;
		const region = regionByBox.get(draftItem.boxId);
		const evidence = bubbleEvidence(region, draftItem);
		adaptedItems.push({
			draftItem,
			region,
			translation,
			sourceIds: sourceIdsByBox.get(draftItem.boxId) ?? [],
			semanticType: semanticTypeFor(draftItem, region),
			actualBubbleKey: evidence?.key,
			bubblePolygon: evidence?.polygon
		});
	}

	// OCR block segmentation can split one balloon's dialogue into several
	// blocks whose translations come back as the same sentence (seen live with
	// loose handwritten columns: two identical-text items in one balloon, the
	// loser of placement whitewashing the winner as a tap-to-reveal). Same
	// bubble + same effective text is one dialogue unit: keep the first by
	// order, give it the duplicates' source lineage, and drop the rest.
	// Items with manual edits are never merged away.
	const duplicateOfKept = new Map<AdaptedItem, AdaptedItem>();
	{
		const keptByText = new Map<string, AdaptedItem>();
		for (const item of adaptedItems) {
			if (!item.actualBubbleKey) continue;
			const effectiveText = (item.draftItem.customTranslation ?? item.translation.translated_text ?? '')
				.replace(/\s+/gu, ' ')
				.trim();
			if (effectiveText.length === 0) continue;
			const hasManualState = item.draftItem.customX !== undefined
				|| item.draftItem.customY !== undefined
				|| item.draftItem.customWidth !== undefined
				|| item.draftItem.customHeight !== undefined
				|| item.draftItem.customRotation !== undefined
				|| item.draftItem.customFontSize !== undefined
				|| item.draftItem.customVerticalText !== undefined
				|| item.draftItem.customTranslation !== undefined
				|| item.draftItem.settingsImmune
				|| item.draftItem.isHidden;
			if (hasManualState) continue;
			const key = `${item.actualBubbleKey}\u0000${effectiveText}`;
			const kept = keptByText.get(key);
			if (!kept) {
				keptByText.set(key, item);
				continue;
			}
			kept.sourceIds = sortSourceIds([...kept.sourceIds, ...item.sourceIds]);
			duplicateOfKept.set(item, kept);
		}
	}
	const dedupedItems = adaptedItems.filter((item) => !duplicateOfKept.has(item));

	const containerByItem = new Map<AdaptedItem, OverlayContainerV2>();
	const bubbleMembers = new Map<string, AdaptedItem[]>();
	for (const item of dedupedItems) {
		if (!item.actualBubbleKey) continue;
		const members = bubbleMembers.get(item.actualBubbleKey) ?? [];
		members.push(item);
		bubbleMembers.set(item.actualBubbleKey, members);
	}

	const containerRecords: Array<{ sortKey: string; container: OverlayContainerV2 }> = [];
	for (const [bubbleKey, members] of bubbleMembers) {
		const polygons = members
			.map((member) => member.bubblePolygon)
			.filter((polygon): polygon is Point[] => polygon !== undefined);
		const signatures = [...new Set(polygons.map((polygon) => canonicalStringify(polygon)))];
		if (signatures.length !== 1) throw new TypeError(`${bubbleKey} has conflicting detected contours`);
		const polygon = polygons[0];
		const sourceIds = sortSourceIds(members.flatMap((member) => member.sourceIds));
		const kind: OverlayContainerV2['kind'] = members.every((member) => member.semanticType === 'thought')
			? 'thought'
			: 'speech';
		const confidence = members.reduce((maximum, member) =>
			Math.max(maximum, boundedConfidence(member.region?.confidence ?? 0)), 0);
		const container: OverlayContainerV2 = {
			id: stableOverlayId('container', [pageSeed, 'detected-bubble', polygon]),
			kind,
			origin: 'detected',
			polygon,
			sourceIds,
			confidence
		};
		for (const member of members) containerByItem.set(member, container);
		containerRecords.push({ sortKey: `0:${canonicalStringify(polygon)}`, container });
	}

	for (const item of dedupedItems) {
		if (containerByItem.has(item)) continue;
		const polygon = freeContainerPolygon(item);
		const container: OverlayContainerV2 = {
			id: stableOverlayId('container', [pageSeed, 'free', item.translation.id, item.sourceIds, polygon]),
			kind: 'free',
			origin: 'inferred',
			polygon,
			sourceIds: sortSourceIds(item.sourceIds),
			confidence: item.region ? boundedConfidence(item.region.confidence) : undefined
		};
		containerByItem.set(item, container);
		containerRecords.push({
			sortKey: `1:${String(item.translation.order).padStart(12, '0')}:${container.id}`,
			container
		});
	}
	const containers = containerRecords
		.sort((left, right) => compareCanonicalText(left.sortKey, right.sortKey))
		.map((record) => record.container);

	const items: OverlayItemV2[] = [];
	for (const adapted of dedupedItems) {
		const { draftItem, translation, semanticType } = adapted;
		const container = containerByItem.get(adapted);
		const itemId = translation.overlayItemId
			|| stableOverlayId('item', [pageSeed, translation.id]);
		translation.overlayItemId = itemId;
		const hasManualRect = draftItem.customX !== undefined
			|| draftItem.customY !== undefined
			|| draftItem.customWidth !== undefined
			|| draftItem.customHeight !== undefined;
		items.push({
			id: itemId,
			translationEntryId: translation.id,
			sourceIds: [...adapted.sourceIds],
			containerId: container?.id,
			type: semanticType,
			order: translation.order,
			styleKey: styleKeyFor(semanticType),
			classificationConfidence: classificationConfidenceFor(adapted.region),
			sourceWritingMode: adapted.region?.writingMode === 'horizontal-tb'
				|| adapted.region?.writingMode === 'vertical-rl'
				? adapted.region.writingMode
				: undefined,
			continuesPrevious: adapted.region?.continuesPrevious ? true : undefined,
			manual: {
				rect: hasManualRect ? overlayRect(draftItem) : undefined,
				rotationDegrees: draftItem.customRotation,
				referenceFontSize: draftItem.customFontSize,
				writingMode: draftItem.customVerticalText === undefined
					? undefined
					: draftItem.customVerticalText ? 'vertical-rl' : 'horizontal-tb',
				pinGeometry: draftItem.settingsImmune || hasManualRect || undefined,
				pinTypography: draftItem.settingsImmune || draftItem.customFontSize !== undefined || undefined,
				textOverride: draftItem.customTranslation,
				hidden: draftItem.isHidden || undefined
			}
		});
	}
	items.sort((left, right) => left.order - right.order || compareCanonicalText(left.id, right.id));

	return {
		document: {
			schemaVersion: 2,
			documentRevision: input.documentRevision ?? 1,
			sourceImage: { ...input.sourceImage },
			locale: input.locale || 'und',
			baseDirection: input.baseDirection ?? 'auto',
			sources,
			containers,
			items
		},
		entries: normalizedEntries
	};
}

export function createEmptyOverlayDocumentV2(input: Omit<OverlayDraftAdapterInput, 'draft' | 'entries'>): PageOverlayDataV2 {
	return {
		schemaVersion: 2,
		documentRevision: input.documentRevision ?? 1,
		sourceImage: { ...input.sourceImage },
		locale: input.locale || 'und',
		baseDirection: input.baseDirection ?? 'auto',
		sources: [],
		containers: [],
		items: []
	};
}

export function ensureStableTranslationEntries(
	entries: PageTranslationEntryDraft[],
	seed: unknown
): PageTranslationEntry[] {
	return entries.map((entry) => normalizedEntry(entry, seed));
}

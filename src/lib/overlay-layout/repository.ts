import { PageTranslationMissingError } from '$lib/i18n/errors.js';
import Dexie from 'dexie';
import { randomUUID } from '$lib/util/uuid.js';
import { db } from '$lib/db/index.js';
import type {
	OrphanedOverlayEdit,
	OverlayManualConstraintsV2,
	PageOverlayDataV2,
	PageTranslation,
	PageTranslationEntry,
	Translation,
	TranslationRegion,
	VolumeTranslationJob
} from '$lib/types/index.js';
import { canonicalClone, canonicalStringify, stableOverlayId } from './canonical.js';
import { assertOverlayDataV2, decodeOverlayData } from './schema.js';

export type OverlayPageRead =
	| { status: 'ready'; pageTranslation: PageTranslation; overlay: PageOverlayDataV2 | null; legacyPurged: boolean }
	| { status: 'missing'; pageTranslation: null; overlay: null; legacyPurged: boolean }
	| { status: 'invalidated'; pageTranslation: PageTranslation | null; overlay: null; legacyPurged: true }
	| { status: 'future'; pageTranslation: PageTranslation; overlay: null; schemaVersion: number; legacyPurged: boolean }
	| { status: 'malformed'; pageTranslation: PageTranslation; overlay: null; reason: string; legacyPurged: boolean };

type OverlayDatabase = Pick<typeof db, 'transaction' | 'page_translations' | 'inpainted_pages' | 'regions' | 'translations' | 'volume_translation_jobs'>;

function newest(records: PageTranslation[]): PageTranslation | null {
	return [...records].sort((left, right) => {
		const time = right.created_at.localeCompare(left.created_at);
		return time || right.id.localeCompare(left.id);
	})[0] ?? null;
}

/** Anything the reader set: geometry, typography, wording, visibility, deletion. */
export function hasManualEdit(manual: OverlayManualConstraintsV2 | undefined): boolean {
	return Boolean(manual) && Object.values(manual!).some((value) => value !== undefined);
}

const durableContent = (record: PageTranslation) => ({
	entries: record.entries,
	overlay_data: record.overlay_data,
	orphaned_edits: record.orphaned_edits
});

/**
 * Take on what the repository actually wrote — but only where it differs in
 * CONTENT.
 *
 * The reader must see the durable document: that is how a manual edit carried
 * across a re-translation reaches the screen. But `put` also CANONICALIZES
 * (keys sorted, `undefined` dropped), and the progressive preview compares
 * serialized snapshots at a given `documentRevision` — so adopting a record
 * that is byte-different and content-identical made the final commit look like
 * "same revision, different content", which the preview rejects by throwing.
 * The page was already on disk by then, so it read as a failed translation
 * whose translations were nonetheless correct.
 *
 * Comparing canonically means only a real change is adopted, and a real change
 * always arrives with a bumped revision (see `carryForwardEdits`).
 */
export function adoptDurableRecord(target: PageTranslation, durable: PageTranslation | undefined): void {
	if (!durable) return;
	if (canonicalStringify(durableContent(target)) === canonicalStringify(durableContent(durable))) return;
	target.entries = durable.entries;
	target.overlay_data = durable.overlay_data;
	if (durable.orphaned_edits) target.orphaned_edits = durable.orphaned_edits;
	else delete target.orphaned_edits;
}

function sanitizeEntry(entry: PageTranslationEntry): PageTranslationEntry {
	if (!entry.id) throw new TypeError('Page translation entries require stable IDs before persistence');
	const { boxId: _diagnosticBoxId, ...durable } = entry;
	return durable;
}

function sanitizeRecord(record: PageTranslation): PageTranslation {
	const entries = record.entries.map(sanitizeEntry);
	const overlay = record.overlay_data === undefined ? undefined : assertOverlayDataV2(record.overlay_data);
	const linkError = overlay ? validateRecordLinks(overlay, entries) : null;
	if (linkError) throw new TypeError(linkError);
	return canonicalClone({
		...record,
		entries,
		overlay_data: overlay
	});
}

function validateRecordLinks(document: PageOverlayDataV2, entries: PageTranslationEntry[]): string | null {
	const entryIds = new Set(entries.map((entry) => entry.id));
	if (entryIds.size !== entries.length) return 'Page translation entry IDs must be unique';
	const itemIds = new Set(document.items.map((item) => item.id));
	for (const item of document.items) {
		if (!entryIds.has(item.translationEntryId)) return `Overlay item ${item.id} references an unknown translation entry`;
	}
	for (const entry of entries) {
		if (entry.overlayItemId && !itemIds.has(entry.overlayItemId)) return `Translation entry ${entry.id} references an unknown overlay item`;
		const linked = entry.overlayItemId ? document.items.find((item) => item.id === entry.overlayItemId) : undefined;
		if (linked && linked.translationEntryId !== entry.id) return `Translation entry ${entry.id} has an inconsistent overlay item link`;
	}
	return null;
}

export class OverlayUndoStaleError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number) {
		super(`Overlay document moved from revision ${expectedRevision} to ${actualRevision}; the undo snapshot is stale`);
		this.name = 'OverlayUndoStaleError';
	}
}

export class PageOverlayRepository {
	constructor(private readonly database: OverlayDatabase = db) {}

	async load(volumeUuid: string, pageIndex: number): Promise<OverlayPageRead> {
		return this.database.transaction(
			'rw',
			this.database.page_translations,
			this.database.inpainted_pages,
			async () => {
				const records = await this.database.page_translations
					.where('[volume_uuid+page_index]')
					.equals([volumeUuid, pageIndex])
					.toArray();
				const legacyIds: string[] = [];
				for (const record of records) {
					const decoded = decodeOverlayData((record as PageTranslation).overlay_data);
					if (decoded.kind === 'legacy') legacyIds.push((record as PageTranslation).id);
				}
				if (legacyIds.length > 0) {
					await this.database.page_translations.bulkDelete(legacyIds);
					await this.database.inpainted_pages.delete([volumeUuid, pageIndex]);
				}

				const survivors = (records as PageTranslation[]).filter((record) => !legacyIds.includes(record.id));
				const latest = newest(survivors);
				if (!latest) {
					return legacyIds.length > 0
						? { status: 'invalidated', pageTranslation: null, overlay: null, legacyPurged: true }
						: { status: 'missing', pageTranslation: null, overlay: null, legacyPurged: false };
				}

				const decoded = decodeOverlayData(latest.overlay_data);
				if (decoded.kind === 'absent') {
					if (legacyIds.length > 0) return {
						status: 'invalidated' as const,
						pageTranslation: canonicalClone(latest),
						overlay: null,
						legacyPurged: true as const
					};
					return {
						status: 'ready' as const,
						pageTranslation: canonicalClone(latest),
						overlay: null,
						legacyPurged: false
					};
				}
				if (decoded.kind === 'v2') {
					const linkError = validateRecordLinks(decoded.value, latest.entries);
					if (linkError) return {
						status: 'malformed' as const,
						pageTranslation: canonicalClone(latest),
						overlay: null,
						reason: linkError,
						legacyPurged: legacyIds.length > 0
					};
					return {
						status: 'ready',
						pageTranslation: canonicalClone({ ...latest, overlay_data: decoded.value }),
						overlay: decoded.value,
						legacyPurged: legacyIds.length > 0
					};
				}
				if (decoded.kind === 'future') {
					return {
						status: 'future',
						pageTranslation: canonicalClone(latest),
						overlay: null,
						schemaVersion: decoded.schemaVersion,
						legacyPurged: legacyIds.length > 0
					};
				}
				return {
					status: 'malformed',
					pageTranslation: canonicalClone(latest),
					overlay: null,
					reason: decoded.kind === 'malformed' ? decoded.reason : 'Legacy overlay survived invalidation',
					legacyPurged: legacyIds.length > 0
				};
			}
		);
	}

	/** Decode all renderable page records for resumable volume jobs. */
	async listVolume(volumeUuid: string): Promise<PageTranslation[]> {
		const records = await this.database.page_translations.where('volume_uuid').equals(volumeUuid).toArray() as PageTranslation[];
		const pageIndexes = [...new Set(records.map((record) => record.page_index))].sort((a, b) => a - b);
		const result: PageTranslation[] = [];
		for (const pageIndex of pageIndexes) {
			const read = await this.load(volumeUuid, pageIndex);
			if (read.status === 'future') {
				throw new Error(`Overlay schema ${read.schemaVersion} requires a newer app`);
			}
			if (read.status === 'malformed') throw new Error(read.reason);
			if (read.status === 'ready' && read.pageTranslation) result.push(read.pageTranslation);
		}
		return result;
	}

	async put(record: PageTranslation, signal?: AbortSignal): Promise<PageTranslation> {
		if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
		let durable = sanitizeRecord(record);
		await this.database.transaction('rw', [this.database.page_translations, this.database.inpainted_pages], async () => {
			if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
			durable = await this.carryForwardEdits(durable);
			await this.database.page_translations.put(durable);
			await this.database.inpainted_pages.delete([durable.volume_uuid, durable.page_index]);
			if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
		});
		return durable;
	}

	/**
	 * A reader's edits outlive the machine's output.
	 *
	 * A re-translation writes a NEW record and `newest()` prefers it, so every
	 * manual edit on the page used to vanish the moment the reader tapped
	 * Re-translate — while Help promised the opposite. Sources are content-
	 * hashed from detector geometry, so a re-run over the same page yields the
	 * same source IDs: an item on the new record whose sources are exactly an
	 * edited item's sources on the record being replaced inherits that item's
	 * `manual`. Edits whose sources vanished are parked on the record as
	 * `orphaned_edits`, listed to the reader, never dropped in silence.
	 *
	 * Runs inside the caller's transaction against the record the new one
	 * replaces. An item the new record already constrains (a revision, a
	 * checkpoint of an edited page) keeps its own; only untouched items inherit.
	 */
	private async carryForwardEdits(next: PageTranslation): Promise<PageTranslation> {
		const document = next.overlay_data;
		if (!document) return next;
		const records = await this.database.page_translations
			.where('[volume_uuid+page_index]')
			.equals([next.volume_uuid, next.page_index])
			.toArray() as PageTranslation[];
		// The read precedes the write inside the same transaction, so every row
		// here is pre-write state — INCLUDING one that shares the new record's
		// id. The volume batch keys its rows `vol_trans_<volume>_<page>`, so a
		// re-run of the batch overwrites the row in place; excluding the same id
		// would make that path drop every edit with no orphan to show for it.
		const previous = newest(records);
		if (!previous) return next;
		const decoded = decodeOverlayData(previous.overlay_data);
		if (decoded.kind !== 'v2') return next;
		const edited = decoded.value.items.filter((item) => hasManualEdit(item.manual));
		const carried: OrphanedOverlayEdit[] = [...(previous.orphaned_edits ?? [])];
		if (edited.length === 0 && carried.length === 0) return next;
		const key = (sourceIds: readonly string[]): string => [...sourceIds].sort().join('\u0000');
		const byKey = new Map(document.items.map((item) => [key(item.sourceIds), item]));
		const previousEntries = new Map(previous.entries.map((entry) => [entry.id, entry]));
		const items = document.items.map((item) => ({ ...item, manual: { ...item.manual } }));
		let changed = false;
		for (const item of edited) {
			const target = byKey.get(key(item.sourceIds));
			const targetIndex = target ? items.findIndex((candidate) => candidate.id === target.id) : -1;
			if (targetIndex >= 0 && !hasManualEdit(items[targetIndex].manual)) {
				items[targetIndex] = { ...items[targetIndex], manual: canonicalClone(item.manual) };
				changed = true;
				continue;
			}
			const entry = previousEntries.get(item.translationEntryId);
			carried.push({
				itemId: item.id,
				sourceIds: [...item.sourceIds],
				manual: canonicalClone(item.manual),
				translatedText: item.manual.textOverride ?? entry?.translated_text ?? '',
				originalText: entry?.original_text ?? ''
			});
		}
		// An orphan whose sources reappear on this page is an edit coming home.
		const remaining: OrphanedOverlayEdit[] = [];
		for (const orphan of carried) {
			const target = byKey.get(key(orphan.sourceIds));
			const targetIndex = target ? items.findIndex((candidate) => candidate.id === target.id) : -1;
			if (targetIndex >= 0 && !hasManualEdit(items[targetIndex].manual)) {
				items[targetIndex] = { ...items[targetIndex], manual: canonicalClone(orphan.manual) };
				changed = true;
			} else {
				remaining.push(orphan);
			}
		}
		// A carried edit — or a parked orphan, which the box list shows — makes
		// this a different document from the one the pipeline built, so it gets
		// a different revision: the progressive preview has already published
		// the pipeline's document under the incoming revision, and it refuses —
		// by throwing — to commit other content under the same number.
		const mutated = changed || remaining.length > 0;
		const withEdits: PageTranslation = {
			...next,
			overlay_data: mutated ? { ...document, items, documentRevision: document.documentRevision + 1 } : document,
			...(remaining.length > 0 ? { orphaned_edits: remaining } : {})
		};
		return sanitizeRecord(withEdits);
	}

	async putImported(record: PageTranslation): Promise<PageTranslation> {
		const decoded = decodeOverlayData(record.overlay_data);
		if (decoded.kind === 'legacy') throw new Error('Legacy overlay imports are not supported; regenerate the page');
		if (decoded.kind === 'future') throw new Error(`Overlay schema ${decoded.schemaVersion} requires a newer app`);
		if (decoded.kind === 'malformed') throw new Error(decoded.reason);
		return this.put(record);
	}

	/** Atomically publish page payloads and the lightweight resumable job checkpoint. */
	async putCheckpoint(
		records: PageTranslation[],
		checkpoint: VolumeTranslationJob,
		signal?: AbortSignal
	): Promise<void> {
		let durable = records.map(sanitizeRecord);
		await this.database.transaction(
			'rw',
			this.database.page_translations,
			this.database.inpainted_pages,
			this.database.volume_translation_jobs,
			async () => {
				if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
				const carried: PageTranslation[] = [];
				for (const record of durable) carried.push(await this.carryForwardEdits(record));
				durable = carried;
				if (durable.length > 0) await this.database.page_translations.bulkPut(durable);
				for (const record of durable) {
					await this.database.inpainted_pages.delete([record.volume_uuid, record.page_index]);
				}
				await this.database.volume_translation_jobs.put(checkpoint);
				if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
			}
		);
	}

	async updateDocument(
		volumeUuid: string,
		pageIndex: number,
		mutate: (document: PageOverlayDataV2, entries: PageTranslationEntry[]) => void
	): Promise<PageTranslation> {
		return this.database.transaction(
			'rw',
			this.database.page_translations,
			this.database.inpainted_pages,
			async () => {
				const records = await this.database.page_translations
					.where('[volume_uuid+page_index]')
					.equals([volumeUuid, pageIndex])
					.toArray() as PageTranslation[];
				const latest = newest(records);
				if (!latest) throw new PageTranslationMissingError();
				const document = assertOverlayDataV2(latest.overlay_data);
				const entries = canonicalClone(latest.entries);
				mutate(document, entries);
				document.documentRevision += 1;
				delete document.cachedPlan;
				const updated = sanitizeRecord({ ...latest, entries, overlay_data: document });
				await this.database.page_translations.put(updated);
				await this.database.inpainted_pages.delete([volumeUuid, pageIndex]);
				return updated;
			}
		);
	}

	async updateManualConstraints(
		volumeUuid: string,
		pageIndex: number,
		itemId: string,
		manual: OverlayManualConstraintsV2
	): Promise<PageTranslation> {
		return this.updateDocument(volumeUuid, pageIndex, (document) => {
			const item = document.items.find((candidate) => candidate.id === itemId);
			if (!item) throw new Error(`Overlay item ${itemId} does not exist`);
			item.manual = canonicalClone(manual);
		});
	}

	async replaceDocument(
		volumeUuid: string,
		pageIndex: number,
		nextDocument: PageOverlayDataV2
	): Promise<PageTranslation> {
		return this.updateDocument(volumeUuid, pageIndex, (document) => {
			const next = assertOverlayDataV2(nextDocument);
			document.sourceImage = next.sourceImage;
			document.locale = next.locale;
			document.baseDirection = next.baseDirection;
			document.sources = next.sources;
			document.containers = next.containers;
			document.items = next.items;
		});
	}

	async persistCachedPlan(
		volumeUuid: string,
		pageIndex: number,
		inputHash: string,
		plan: import('$lib/types/index.js').OverlayRenderPlanV2
	): Promise<void> {
		await this.database.transaction('rw', this.database.page_translations, async () => {
			const records = await this.database.page_translations
				.where('[volume_uuid+page_index]')
				.equals([volumeUuid, pageIndex])
				.toArray() as PageTranslation[];
			const latest = newest(records);
			if (!latest) return;
			const document = assertOverlayDataV2(latest.overlay_data);
			if (plan.documentRevision !== document.documentRevision || plan.inputHash !== inputHash) return;
			document.cachedPlan = { inputHash, plan: canonicalClone(plan) };
			await this.database.page_translations.put(sanitizeRecord({ ...latest, overlay_data: document }));
		});
	}

	/**
	 * Delete is a flag, not a removal.
	 *
	 * It used to drop the item, its translation entry and every source and
	 * container nothing else referenced — the one edit no undo could reverse
	 * and the one a re-translation could not carry forward. The item stays on
	 * the record marked `removed`; nothing plans, paints or exports it, the
	 * page's box list shows it as deleted, and `restoreItem` brings it back.
	 */
	async deleteItem(volumeUuid: string, pageIndex: number, itemId: string): Promise<PageTranslation> {
		return this.updateManualConstraintsWith(volumeUuid, pageIndex, itemId, (manual) => ({ ...manual, removed: true }));
	}

	async restoreItem(volumeUuid: string, pageIndex: number, itemId: string): Promise<PageTranslation> {
		return this.updateManualConstraintsWith(volumeUuid, pageIndex, itemId, (manual) => {
			const { removed: _removed, ...rest } = manual;
			return rest;
		});
	}

	/** Back to automatic placement; the reader's own wording stays unless asked. */
	async resetManual(
		volumeUuid: string,
		pageIndex: number,
		itemId: string,
		options: { keepText?: boolean } = {}
	): Promise<PageTranslation> {
		return this.updateManualConstraintsWith(volumeUuid, pageIndex, itemId, (manual) =>
			options.keepText && manual.textOverride !== undefined ? { textOverride: manual.textOverride } : {});
	}

	private async updateManualConstraintsWith(
		volumeUuid: string,
		pageIndex: number,
		itemId: string,
		mutate: (manual: OverlayManualConstraintsV2) => OverlayManualConstraintsV2
	): Promise<PageTranslation> {
		return this.updateDocument(volumeUuid, pageIndex, (document) => {
			const item = document.items.find((candidate) => candidate.id === itemId);
			if (!item) throw new Error(`Overlay item ${itemId} does not exist`);
			item.manual = canonicalClone(mutate(item.manual));
		});
	}

	/**
	 * Every item's manual constraints as the durable record has them, or null
	 * when the page has no translation. This is what an undo snapshot is taken
	 * from: the live store is not a safe source, because the box editor
	 * previews its sliders by writing the draft straight into it.
	 */
	async readManualConstraints(
		volumeUuid: string,
		pageIndex: number
	): Promise<Map<string, OverlayManualConstraintsV2> | null> {
		const records = await this.database.page_translations
			.where('[volume_uuid+page_index]')
			.equals([volumeUuid, pageIndex])
			.toArray() as PageTranslation[];
		const latest = newest(records);
		const decoded = latest ? decodeOverlayData(latest.overlay_data) : null;
		if (!decoded || decoded.kind !== 'v2') return null;
		return new Map(decoded.value.items.map((item) => [item.id, canonicalClone(item.manual)]));
	}

	/**
	 * One-level undo: put every item's manual constraints back the way a
	 * snapshot had them. With `expectedRevision` the restore only applies to
	 * the document revision the edit produced — anything else wrote in between
	 * (a re-translation, an edit from another surface) and the snapshot no
	 * longer describes a state anyone saw.
	 */
	async restoreManualSnapshot(
		volumeUuid: string,
		pageIndex: number,
		snapshot: ReadonlyMap<string, OverlayManualConstraintsV2>,
		expectedRevision?: number
	): Promise<PageTranslation> {
		return this.updateDocument(volumeUuid, pageIndex, (document) => {
			if (expectedRevision !== undefined && document.documentRevision !== expectedRevision) {
				throw new OverlayUndoStaleError(expectedRevision, document.documentRevision);
			}
			for (const item of document.items) {
				const manual = snapshot.get(item.id);
				if (manual) item.manual = canonicalClone(manual);
			}
		});
	}

	async discardOrphanedEdit(volumeUuid: string, pageIndex: number, itemId: string): Promise<PageTranslation> {
		return this.database.transaction('rw', this.database.page_translations, async () => {
			const records = await this.database.page_translations
				.where('[volume_uuid+page_index]')
				.equals([volumeUuid, pageIndex])
				.toArray() as PageTranslation[];
			const latest = newest(records);
			if (!latest) throw new PageTranslationMissingError();
			const remaining = (latest.orphaned_edits ?? []).filter((orphan) => orphan.itemId !== itemId);
			const { orphaned_edits: _orphans, ...rest } = latest;
			const updated: PageTranslation = canonicalClone(remaining.length > 0 ? { ...rest, orphaned_edits: remaining } : rest);
			await this.database.page_translations.put(updated);
			return updated;
		});
	}

	async appendManualRegions(input: {
		volumeUuid: string;
		pageIndex: number;
		sourceImage: { width: number; height: number; fingerprint: string };
		locale: string;
		baseDirection: 'ltr' | 'rtl' | 'auto';
		regions: Array<{ region: TranslationRegion; translation: Translation }>;
	}): Promise<{ pageTranslation: PageTranslation; removedRegionIds: string[] }> {
		return this.database.transaction(
			'rw',
			this.database.page_translations,
			this.database.inpainted_pages,
			this.database.regions,
			this.database.translations,
			async () => {
				const records = await this.database.page_translations
					.where('[volume_uuid+page_index]')
					.equals([input.volumeUuid, input.pageIndex])
					.toArray() as PageTranslation[];
				const latest = newest(records);
				let document: PageOverlayDataV2;
				let entries: PageTranslationEntry[];
				if (latest?.overlay_data) {
					document = assertOverlayDataV2(latest.overlay_data);
					entries = canonicalClone(latest.entries);
				} else {
					document = {
						schemaVersion: 2,
						documentRevision: 1,
						sourceImage: input.sourceImage,
						locale: input.locale,
						baseDirection: input.baseDirection,
						sources: [],
						containers: [],
						items: []
					};
					entries = latest ? canonicalClone(latest.entries) : [];
				}
				let order = entries.length;
				for (const { region, translation } of input.regions) {
					const seed = [input.volumeUuid, input.pageIndex, region.id];
					const entryId = stableOverlayId('entry', seed);
					const sourceId = stableOverlayId('source', seed);
					const containerId = stableOverlayId('container', seed);
					const itemId = stableOverlayId('item', seed);
					const bounds = { x: region.x, y: region.y, width: region.width, height: region.height };
					const polygon = [
						{ x: bounds.x, y: bounds.y },
						{ x: bounds.x + bounds.width, y: bounds.y },
						{ x: bounds.x + bounds.width, y: bounds.y + bounds.height },
						{ x: bounds.x, y: bounds.y + bounds.height }
					];
					document.sources.push({ id: sourceId, polygon, bounds, confidence: 1, orientationDegrees: 0 });
					document.containers.push({ id: containerId, kind: 'free', origin: 'manual', polygon, sourceIds: [sourceId], confidence: 1 });
					document.items.push({
						id: itemId,
						translationEntryId: entryId,
						sourceIds: [sourceId],
						containerId,
						type: 'speech',
						order,
						styleKey: 'dialogue',
						manual: {}
					});
					entries.push({
						id: entryId,
						overlayItemId: itemId,
						order: order++,
						original_text: translation.original_text ?? '',
						translated_text: translation.translated_text,
						type: 'speech'
					});
				}
				if (latest?.overlay_data) document.documentRevision += 1;
				delete document.cachedPlan;
				const pageTranslation = sanitizeRecord(latest ? {
					...latest,
					entries,
					overlay_data: document
				} : {
					id: randomUUID(),
					volume_uuid: input.volumeUuid,
					page_index: input.pageIndex,
					entries,
					model: 'manual-conversion',
					prompt_tokens: 0,
					completion_tokens: 0,
					created_at: new Date().toISOString(),
					overlay_data: document
				});
				await this.database.page_translations.put(pageTranslation);
				await this.database.inpainted_pages.delete([input.volumeUuid, input.pageIndex]);
				const removedRegionIds = input.regions.map(({ region }) => region.id);
				await this.database.regions.bulkDelete(removedRegionIds);
				for (const id of removedRegionIds) await this.database.translations.where('region_id').equals(id).delete();
				return { pageTranslation, removedRegionIds };
			}
		);
	}

	async purgeLegacyJobCheckpoints(volumeUuid: string): Promise<number | null> {
		return this.database.transaction('rw', this.database.page_translations, this.database.inpainted_pages, async () => {
			const records = await this.database.page_translations.where('volume_uuid').equals(volumeUuid).toArray() as PageTranslation[];
			const legacy = records.filter((record) => decodeOverlayData(record.overlay_data).kind === 'legacy');
			if (legacy.length === 0) return null;
			await this.database.page_translations.bulkDelete(legacy.map((record) => record.id));
			for (const pageIndex of new Set(legacy.map((record) => record.page_index))) {
				await this.database.inpainted_pages.delete([volumeUuid, pageIndex]);
			}
			return Math.min(...legacy.map((record) => record.page_index));
		});
	}
}

export const pageOverlayRepository = new PageOverlayRepository();

export const overlayPageRange = (volumeUuid: string): [unknown, unknown] => [
	[volumeUuid, Dexie.minKey],
	[volumeUuid, Dexie.maxKey]
];

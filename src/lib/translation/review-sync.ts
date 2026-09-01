import type { PageTranslationEntryDraft, VolumePageTranslation } from '$lib/types/index.js';
import { ensureStableTranslationEntries } from '$lib/overlay-layout/index.js';

/** Preserve stable translation/item identity while applying provider review output. */
export function applyReviewRevisions(
	pageTranslation: VolumePageTranslation,
	revisedEntries: PageTranslationEntryDraft[]
): void {
	const originalEntries = pageTranslation.entries;
	const originalByOrder = new Map(originalEntries.map((entry) => [entry.order, entry]));
	const revised = revisedEntries.map((entry, index) => {
		const original = originalByOrder.get(entry.order) ?? originalEntries[index];
		return {
			...entry,
			id: entry.id ?? original?.id,
			overlayItemId: entry.overlayItemId ?? original?.overlayItemId,
			boxId: undefined
		};
	});
	pageTranslation.entries = ensureStableTranslationEntries(revised, ['review', pageTranslation.page_index]);

	if (!pageTranslation.overlay_data) return;
	pageTranslation.overlay_data.documentRevision += 1;
	delete pageTranslation.overlay_data.cachedPlan;
}

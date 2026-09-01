import type { FumetoSettings } from '$lib/settings/settings.js';
import type { OverlayManualConstraintsV2, PageOverlayDataV2, PageTranslationEntry } from '$lib/types/index.js';
import { PageOverlayPlanController } from './controller.js';
import { OverlayLayoutError } from './errors.js';
import { overlayLayoutSettingsFromApp } from './settings.js';

/** Plans an ephemeral edit and rejects confirmation when its pinned contract cannot fit. */
export async function validateOverlayManualConstraints(input: {
	document: PageOverlayDataV2;
	translations: PageTranslationEntry[];
	itemId: string;
	manual: OverlayManualConstraintsV2;
	settings: Readonly<FumetoSettings>;
	fontScale?: number;
	scopeId: string;
	signal?: AbortSignal;
}): Promise<void> {
	if (input.manual.hidden) return;
	const document = structuredClone(input.document);
	const item = document.items.find((candidate) => candidate.id === input.itemId);
	if (!item) throw new OverlayLayoutError('invalid-document', `Overlay item ${input.itemId} does not exist`);
	item.manual = structuredClone(input.manual);
	delete document.cachedPlan;
	const controller = new PageOverlayPlanController();
	try {
		const plan = await controller.request({
			scopeId: input.scopeId,
			document,
			translations: input.translations,
			settings: overlayLayoutSettingsFromApp(input.settings, input.fontScale)
		}, { signal: input.signal });
		const outcome = plan.items.find((candidate) => candidate.itemId === input.itemId);
		if (!outcome || outcome.status !== 'placed') {
			throw new OverlayLayoutError(
				'manual-constraint-conflict',
				'The pinned geometry and typography cannot contain this text.',
				{ itemId: input.itemId, reason: outcome?.unplacedReason ?? 'missing-plan-item' }
			);
		}
	} finally {
		controller.invalidate(input.scopeId);
	}
}

/**
 * Start a manual full-page translation of the page the reader is showing.
 *
 * One definition for every surface that offers "translate this page again":
 * the compact Translate action, the status dialog's Try again, and whatever
 * comes next. The controller reports its own failures through its snapshot,
 * so the returned promise never rejects — a tap must not become an unhandled
 * rejection.
 */
import { get } from 'svelte/store';
import { settings } from '$lib/settings/settings.js';
import {
	currentPageIndex,
	currentVolume,
	isOverlayMode,
	readerSessionId,
	readerTargetEpoch
} from '$lib/stores/reader-state.js';
import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
import { areOcrModelsReady } from '$lib/detection/ocr-model-manager.js';
import { openOcrModelPrompt } from '$lib/detection/ocr-model-gate.js';

function beginRun(volumeUuid: string): void {
	if (get(settings).overlayEnabled && !get(isOverlayMode)) isOverlayMode.set(true);
	void readerPageTranslationController.requestManual({
		readerSessionId: get(readerSessionId),
		targetEpoch: get(readerTargetEpoch),
		volumeUuid,
		pageIndex: get(currentPageIndex)
	}).catch(() => {
		// Reported via the controller snapshot.
	});
}

export function startCurrentPageTranslation(): boolean {
	const volumeUuid = get(currentVolume)?.volume_uuid;
	if (!volumeUuid) return false;
	// The page and target are read when the run actually starts, so a download
	// that takes a minute still translates the page the reader is looking at
	// rather than the one they tapped on.
	void (async () => {
		if (await areOcrModelsReady()) {
			beginRun(volumeUuid);
			return;
		}
		openOcrModelPrompt(() => {
			const current = get(currentVolume)?.volume_uuid ?? volumeUuid;
			beginRun(current);
		});
	})();
	return true;
}

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

export function startCurrentPageTranslation(): boolean {
	const volumeUuid = get(currentVolume)?.volume_uuid;
	if (!volumeUuid) return false;
	if (get(settings).overlayEnabled && !get(isOverlayMode)) isOverlayMode.set(true);
	void readerPageTranslationController.requestManual({
		readerSessionId: get(readerSessionId),
		targetEpoch: get(readerTargetEpoch),
		volumeUuid,
		pageIndex: get(currentPageIndex)
	}).catch(() => {
		// Reported via the controller snapshot.
	});
	return true;
}

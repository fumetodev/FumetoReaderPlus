/**
 * The interactive side of the vision-model download.
 *
 * A reader who taps Translate on a fresh install should be offered the
 * download where they are, not sent to Settings to find it. This holds the
 * request the tap made so the sheet can resume it: download, then translate,
 * without a second tap.
 *
 * Non-interactive callers (batch translation, revision passes) keep the plain
 * guard inside the OCR pipeline — a background job has no one to ask.
 */
import { writable } from 'svelte/store';

export const ocrModelPromptOpen = writable(false);

let resumeAfterDownload: (() => void) | null = null;

/** Offer the download, and remember what the user was trying to do. */
export function openOcrModelPrompt(onReady: () => void): void {
	resumeAfterDownload = onReady;
	ocrModelPromptOpen.set(true);
}

/** Run the deferred action; called by the sheet once every model is present. */
export function resumeAfterOcrModels(): void {
	const resume = resumeAfterDownload;
	resumeAfterDownload = null;
	ocrModelPromptOpen.set(false);
	resume?.();
}

/**
 * Close without resuming. Returns whether the sheet was open, so the Android
 * back handler can consume the press exactly when it dismissed something.
 */
export function dismissOcrModelPrompt(): boolean {
	let wasOpen = false;
	ocrModelPromptOpen.update((open) => {
		wasOpen = open;
		return false;
	});
	resumeAfterDownload = null;
	return wasOpen;
}

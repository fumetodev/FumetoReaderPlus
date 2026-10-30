/**
 * Moving the owner of a replaced encoder-decoder model onto the model that replaced it.
 *
 * FumetoTranslate replaced the first model (`manga-ja-en-v1`). The old one is no longer offered, but it is not taken
 * from anyone who has it: it keeps translating until its successor is on the device and has passed its probe. Then
 * the selection moves to the successor (in page mode, its default) and the old model's files are deleted, about
 * 440 MB. Someone who has the old model files but chose another model keeps that choice; only the files go.
 *
 * The handoff never runs while a volume translation is running, which started with the old model's label: it runs
 * once the download finishes if nothing is translating, when the last job ends, and at every startup.
 *
 * Until they download, the next on-device translation offers the successor once (`offerEncDecReplacement`).
 */
import { get, writable } from 'svelte/store';
import { settings } from '$lib/settings/settings.js';
import { activeHyMT2Variant, ENCDEC_HYMT2_VARIANTS, HYMT2_VARIANTS, isEncDecVariant, type EncDecVariant } from './gguf-model-manager.js';
import {
	encdecModelDownloadStates,
	encdecModelFolderExists,
	isEncDecModelDownloading,
	isEncDecModelReady,
	removeEncDecModelFiles
} from './encdec-model-manager.js';

/** The replaced models that may still be on a device, each with its successor. */
function replacements(): Array<{ old: EncDecVariant; successor: EncDecVariant }> {
	const out: Array<{ old: EncDecVariant; successor: EncDecVariant }> = [];
	for (const old of ENCDEC_HYMT2_VARIANTS) {
		const successor = HYMT2_VARIANTS[old].replacedBy;
		if (HYMT2_VARIANTS[old].deprecated && successor && isEncDecVariant(successor)) out.push({ old, successor });
	}
	return out;
}

const handoffListeners = new Set<(old: EncDecVariant, successor: EncDecVariant) => void>();

/**
 * Told after a handoff moved the selection. Settings keeps a draft of the selection while it is open, and an apply of
 * that stale draft would put the deleted model back.
 */
export function onEncDecHandoff(listener: (old: EncDecVariant, successor: EncDecVariant) => void): () => void {
	handoffListeners.add(listener);
	return () => handoffListeners.delete(listener);
}

let running: Promise<boolean> | null = null;

/** Runs every handoff that is due. Resolves true when any selection moved or any old model was removed. */
export function completeEncDecHandoff(): Promise<boolean> {
	running ??= handOff().finally(() => {
		running = null;
	});
	return running;
}

async function handOff(): Promise<boolean> {
	let changed = false;
	for (const { old, successor } of replacements()) {
		if (!(await encdecModelFolderExists(old))) continue;
		if (isEncDecModelDownloading(successor) || !(await isEncDecModelReady(successor))) continue;
		const { activeRunDescriptors } = await import('./volume-translation-service.js');
		if (activeRunDescriptors().length > 0) {
			console.warn(`[encdec] ${successor} is ready; ${old} is replaced once the running translation job ends`);
			continue;
		}
		const { encdecAvailable, releaseEncDec, translateWithEncDec } = await import('./encdec-translator.js');
		if (!encdecAvailable()) continue;
		// The files are the right size; prove they are the right files before the old model goes. A download that
		// was interrupted after its last byte but before its own probe would otherwise replace a working model.
		try {
			const probe = (await translateWithEncDec(successor, '行くぞ！')).trim();
			if (!/[A-Za-z]/.test(probe)) continue;
		} catch {
			continue;
		}
		if (activeHyMT2Variant() === old) {
			settings.patch({ hyMT2Variant: successor, encdecMode: 'page' });
			for (const listener of handoffListeners) listener(old, successor);
		}
		await releaseEncDec();
		await removeEncDecModelFiles(old).catch(() => undefined);
		encdecModelDownloadStates[old].set({ status: 'idle', error: undefined, progress: undefined });
		console.warn(`[encdec] ${old} replaced by ${successor}; its files were removed`);
		changed = true;
	}
	return changed;
}

/** The one-time offer of a replaced model's successor, while it is showing. */
export const encdecReplacementOffer = writable<{ successor: EncDecVariant; sizeLabel: string } | null>(null);

/**
 * Called when an on-device translation starts. If it runs on a replaced model whose successor is not on the device
 * and the offer was never shown, shows it once. Never blocks or fails the translation.
 */
export async function offerEncDecReplacement(): Promise<void> {
	try {
		if (get(settings).encdecReplacementNoticeShown) return;
		const variant = activeHyMT2Variant();
		const replacement = replacements().find((r) => r.old === variant);
		if (!replacement) return;
		const { successor } = replacement;
		if (isEncDecModelDownloading(successor) || (await isEncDecModelReady(successor))) return;
		settings.patch({ encdecReplacementNoticeShown: true });
		// '~448MB' → '448 MB', as a sentence spells a size.
		encdecReplacementOffer.set({ successor, sizeLabel: HYMT2_VARIANTS[successor].sizeLabel.replace(/^~/, '').replace(/(\d)([A-Za-z])/, '$1 $2') });
	} catch (error) {
		console.warn('[encdec] replacement offer failed:', error);
	}
}

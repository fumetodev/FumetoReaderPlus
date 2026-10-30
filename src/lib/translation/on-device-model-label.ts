/**
 * The `model` string stored with a translation the on-device pipeline made.
 *
 * It says which model was selected and which recognizer read the page. The
 * page pipeline, the volume job and the single-region path all write one, and
 * each used to spell out the stock model's name for itself, so a page
 * translated by a fine-tune was recorded as the stock model's work.
 *
 * The variant is an argument and nothing is imported at runtime, so the rule
 * can be read and tested without the model manager behind it.
 */
import type { HyMT2Variant } from './gguf-model-manager.js';

/**
 * These names are written into the user's library, so one that has shipped is
 * never renamed. `stock` keeps the string every record carried before the
 * label followed the selection, so the records the stock model made are
 * already right. Older records made by another model still carry that string.
 */
const RECORD_NAMES: Record<HyMT2Variant, string> = {
	stock: 'hymt2-1.25bit',
	'manga-v2': 'hymt2-manga-v2',
	'manga-v3': 'hymt2-manga-v3',
	'manga-v5': 'hymt2-manga-v5',
	'index-manga-v1': 'index-translate-manga-v1',
	fumetotranslate: 'fumetotranslate',
	'manga-ja-en-v1': 'manga-ja-en-v1',
	custom: 'custom-gguf'
};

/**
 * Models with a page mode and a line mode record which one made the translation
 * (`on-device-fumetotranslate-page-ppocr`), so pages of one volume made in
 * different modes can be told apart. The mode defaults to page, the setting's
 * default.
 */
const MODEL_HAS_MODES: Partial<Record<HyMT2Variant, true>> = { fumetotranslate: true };

export function onDeviceModelLabel(variant: HyMT2Variant, ocrProvider: string, encdecMode: 'page' | 'line' = 'page'): string {
	const name = MODEL_HAS_MODES[variant] ? `${RECORD_NAMES[variant]}-${encdecMode}` : RECORD_NAMES[variant];
	return `on-device-${name}-${ocrProvider}`;
}

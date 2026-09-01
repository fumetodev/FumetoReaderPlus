/**
 * Debug-only pipeline overrides for the model-candidate eval suite (Tier-2
 * end-to-end runs). Default state is empty = production behavior; the ONLY
 * setter is the debug-gated `window.__fumeto_model_candidates` host, so
 * release builds can never activate these.
 *
 * Consulted at the pipeline's bubble seams (`full-page-service`,
 * `on-device-service`) and the recognizer seam (`ppocr-text-extractor`).
 */

import type { BubbleRegion } from './bubble-geometry.js';
import type { BubbleProviderId } from './candidates/layout-provider-types.js';

export interface ModelCandidateOverrides {
	/** Replace bubble detection ('none' = ablation: empty bubble set). */
	bubbleProvider?: BubbleProviderId;
	/** Replace PP-OCR recognition with manga-ocr on the same raw regions. */
	recognizer?: 'manga-ocr';
}

let current: ModelCandidateOverrides = {};

export function getModelCandidateOverrides(): ModelCandidateOverrides {
	return { ...current };
}

export function setModelCandidateOverrides(next: ModelCandidateOverrides): ModelCandidateOverrides {
	current = { bubbleProvider: next.bubbleProvider, recognizer: next.recognizer };
	console.info('[model-candidates] overrides set:', JSON.stringify(current));
	return getModelCandidateOverrides();
}

export function clearModelCandidateOverrides(): void {
	current = {};
	console.info('[model-candidates] overrides cleared');
}

/**
 * Bubble seam: returns replacement bubbles, or null for production behavior.
 * Candidate failures degrade to [] like the production catch.
 */
export async function overrideBubblesForEval(
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<BubbleRegion[] | null> {
	const provider = current.bubbleProvider;
	if (!provider) return null;
	if (provider === 'none') return [];
	try {
		const { detectLayoutWithProvider } = await import('./candidates/layout-provider.js');
		const layout = await detectLayoutWithProvider(provider, imageBlob, options);
		return layout.bubbles;
	} catch (err) {
		console.warn(`[model-candidates] bubble override '${provider}' failed; using empty set:`, err);
		return [];
	}
}

/**
 * Recognizer seam: manga-ocr over the same raw line regions, mapped into the
 * PP-OCR result contract. manga-ocr emits no confidence — a fixed 0.9 keeps
 * downstream coverage semantics from demoting override output.
 */
export async function overrideRecognitionForEval(
	imageFile: File,
	rawRegions: ReadonlyArray<{ boxId: number; x: number; y: number; width: number; height: number }>,
	options: { signal?: AbortSignal } = {}
): Promise<Array<{ boxId: number; text: string; confidence: number }> | null> {
	if (current.recognizer !== 'manga-ocr') return null;
	const { initMangaOcr, recognizeCropWithMangaOcr } = await import(
		'./candidates/manga-ocr-recognizer.js'
	);
	await initMangaOcr();
	const bitmap = await createImageBitmap(imageFile);
	try {
		const results: Array<{ boxId: number; text: string; confidence: number }> = [];
		for (const region of rawRegions) {
			if (options.signal?.aborted) {
				throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
			}
			try {
				const result = await recognizeCropWithMangaOcr(bitmap, region, { signal: options.signal });
				if (result.text.trim().length > 0) {
					results.push({ boxId: region.boxId, text: result.text.trim(), confidence: 0.9 });
				}
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') throw err;
				console.warn(`[model-candidates] manga-ocr failed on region ${region.boxId}:`, err);
			}
		}
		return results;
	} finally {
		bitmap.close();
	}
}

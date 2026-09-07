/**
 * Production layout detection built on the bespoke rtmdet-manga model
 * (Apache-2.0, trained on the SAM3-bootstrapped manga_layout_dataset).
 *
 * Backend preference, resolved once per session and demoted on failure:
 *   1. rtmdet-native — Android ORT/XNNPACK bridge, fp32-1024 (~1.1 s/page)
 *   2. rtmdet-wasm   — ort-web, fp32-960 (~3.6 s/page on a phone)
 *
 * On Android the native engine falls back to the APK's own bundled model asset,
 * so tier 1 resolves without any pushed file. Elsewhere — the desktop shell, or
 * an Android device whose native bridge failed — rtmdet-wasm reads the model
 * from the app-data `models/` directory, where the vision-model download
 * manager (ocr-model-manager.ts) puts it on first use. Each page's timing goes
 * to the desktop process log as `[perf] layout.detect`.
 *
 * There is deliberately no third tier. A legacy YOLO11n segmenter used to sit
 * here as a safety net, but it was an Ultralytics/AGPL-3.0 artifact that could
 * not be redistributed in a closed-source build, and it was removed on
 * 2026-07-24. When every rtmdet backend fails, `detectLayout` throws and callers
 * degrade to PP-OCR auto-fit boxes — which is what the old net effectively did
 * anyway, since it returned bubbles only and no panels.
 */

import { perfMark } from '$lib/util/perf.js';
import type { BubbleRegion } from './bubble-geometry.js';
import type { CandidateAuxBox } from './candidates/layout-provider-types.js';

export type LayoutSource = 'rtmdet-native' | 'rtmdet-wasm';

export interface LayoutDetection {
	bubbles: BubbleRegion[];
	/** Panel/frame boxes when the active backend provides them (rtmdet only). */
	panels: CandidateAuxBox[];
	source: LayoutSource;
}

let preferredSource: LayoutSource | null = null;

async function resolvePreferredSource(): Promise<LayoutSource> {
	if (preferredSource) return preferredSource;
	try {
		const { isCandidateAvailable } = await import('./candidates/candidate-model-files.js');
		const { isRtmdetNativeBridgeAvailable } = await import(
			'./candidates/rtmdet-native-segmenter.js'
		);
		// Bridge presence is enough: the native engine falls back to the APK's
		// bundled model asset when no pushed file exists.
		// `isCandidateAvailable` is still consulted so the resolution log tells us
		// whether the wasm tier has a model to load, but it is not a gate: with no
		// tier below it, trying and failing is strictly better than not trying.
		if (isRtmdetNativeBridgeAvailable()) {
			preferredSource = 'rtmdet-native';
		} else {
			const wasmReady = await isCandidateAvailable('rtmdet-manga');
			if (!wasmReady) {
				console.warn('[layout] rtmdet-manga model not present; wasm tier will load on demand');
			}
			preferredSource = 'rtmdet-wasm';
		}
	} catch {
		preferredSource = 'rtmdet-wasm';
	}
	console.log(`[layout] backend resolved: ${preferredSource}`);
	return preferredSource;
}

/** Demote to the next backend, or null when this was the last one. */
function demote(from: LayoutSource): LayoutSource | null {
	if (from !== 'rtmdet-native') return null;
	console.warn(`[layout] backend ${from} failed; demoting to rtmdet-wasm for this session`);
	preferredSource = 'rtmdet-wasm';
	return 'rtmdet-wasm';
}

async function detectWith(
	source: LayoutSource,
	imageBlob: Blob,
	options: { signal?: AbortSignal }
): Promise<LayoutDetection> {
	switch (source) {
		case 'rtmdet-native': {
			const { detectLayoutWithRtmdetNative } = await import(
				'./candidates/rtmdet-native-segmenter.js'
			);
			const result = await detectLayoutWithRtmdetNative(imageBlob, options);
			return { bubbles: result.bubbles, panels: result.panels, source };
		}
		case 'rtmdet-wasm': {
			const { detectLayoutWithRtmdetManga } = await import(
				'./candidates/rtmdet-manga-segmenter.js'
			);
			const result = await detectLayoutWithRtmdetManga(imageBlob, options);
			return { bubbles: result.bubbles, panels: result.panels, source };
		}
	}
}

/**
 * Detect bubbles and panels with the best working backend.
 * Throws only when every rtmdet backend fails — callers keep their existing
 * catch-and-continue handling and degrade to PP-OCR auto-fit boxes.
 */
export async function detectLayout(
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<LayoutDetection> {
	let source: LayoutSource = await resolvePreferredSource();
	for (;;) {
		const started = performance.now();
		try {
			const detection = await detectWith(source, imageBlob, options);
			perfMark('layout.detect', performance.now() - started, {
				backend: source,
				bubbles: detection.bubbles.length,
				panels: detection.panels.length
			});
			return detection;
		} catch (error) {
			const next: LayoutSource | null = options.signal?.aborted ? null : demote(source);
			if (next === null) throw error;
			source = next;
		}
	}
}

/** Test hook: reset the cached backend choice. */
export function resetLayoutDetectorForTest(): void {
	preferredSource = null;
}

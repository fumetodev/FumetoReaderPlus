/**
 * Unified bubble/layout provider entry for the model-candidate eval suite.
 * `none` is the ablation. Candidate providers throw if their model files are missing —
 * callers use `candidateAvailability()` to build the run matrix first.
 */

import { isCandidateAvailable } from './candidate-model-files.js';
import type { BubbleProviderId, CandidateLayoutResult } from './layout-provider-types.js';

export type { BubbleProviderId, CandidateLayoutResult } from './layout-provider-types.js';

export const ALL_BUBBLE_PROVIDERS: readonly BubbleProviderId[] = [
	'comic-layout',
	'rtdetr',
	'yolov8-bubble',
	'rtmdet-manga',
	'rtmdet-native',
	'none'
];

export async function isBubbleProviderAvailable(id: BubbleProviderId): Promise<boolean> {
	if (id === 'none') return true;
	if (id === 'rtmdet-native') {
		// The bridge is authoritative: it reports true for either an
		// adb-pushed model file or the APK's bundled asset.
		const { isRtmdetNativeBridgeAvailable } = await import('./rtmdet-native-segmenter.js');
		return isRtmdetNativeBridgeAvailable();
	}
	return isCandidateAvailable(id);
}

export async function detectLayoutWithProvider(
	id: BubbleProviderId,
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<CandidateLayoutResult> {
	switch (id) {
		case 'none':
			return { providerId: 'none', bubbles: [], panels: [], textRegions: [], inferenceMs: 0 };
		case 'comic-layout': {
			const { detectLayoutWithComicLayout } = await import('./comic-layout-segmenter.js');
			return detectLayoutWithComicLayout(imageBlob, options);
		}
		case 'rtdetr': {
			const { detectLayoutWithRtdetr } = await import('./rtdetr-detector.js');
			return detectLayoutWithRtdetr(imageBlob, options);
		}
		case 'yolov8-bubble': {
			const { detectBubblesWithYolov8 } = await import('./yolov8-bubble-segmenter.js');
			return detectBubblesWithYolov8(imageBlob, options);
		}
		case 'rtmdet-manga': {
			const { detectLayoutWithRtmdetManga } = await import('./rtmdet-manga-segmenter.js');
			return detectLayoutWithRtmdetManga(imageBlob, options);
		}
		case 'rtmdet-native': {
			const { detectLayoutWithRtmdetNative } = await import('./rtmdet-native-segmenter.js');
			return detectLayoutWithRtmdetNative(imageBlob, options);
		}
	}
}

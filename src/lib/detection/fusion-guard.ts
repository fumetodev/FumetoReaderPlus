/**
 * Fusion guard for PP-OCR text detection.
 *
 * At coarse detector input sizes, the DB probability map can physically merge
 * text columns belonging to *different* balloons into one connected component.
 * The fused region then fails recognition (an entire multi-balloon block
 * squashed into one height-48 crop) and every involved balloon silently loses
 * its text. The adaptive input target makes this rare; this guard catches the
 * residual cases by geometry — a single raw text region that substantially
 * covers two or more detected bubbles is not plausible dialogue — and retries
 * detection once at the escalated (native-resolution-bounded) target.
 *
 * The retry is accepted only when it yields strictly more raw regions, so a
 * false-positive suspect can never make a page worse.
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import type { BubbleRegion } from './bubble-geometry.js';
import {
	detectTextRegionsForRecognition,
	ppocrDetectorEscalatedTargetSize,
	type PPOcrDetectorRunOptions,
	type PPOcrRecognitionDetection
} from './ppocr-detector.js';

/**
 * A raw region counts as fused with a bubble when it covers at least this
 * fraction of the bubble's bounding-box area. Adjacent balloons overlap
 * slightly at the box level, but a genuine per-column region covers only a
 * sliver of a neighboring bubble; the verified fusion case covered 0.56 and
 * 0.69 of its two bubbles.
 */
const FUSION_MIN_BUBBLE_COVERAGE = 0.35;

function intersectionArea(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number }
): number {
	const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return width > 0 && height > 0 ? width * height : 0;
}

/** Raw regions whose box substantially covers two or more distinct bubbles. */
export function fusedRegionSuspects(
	rawRegions: readonly DetectedTextRegion[],
	bubbles: readonly BubbleRegion[]
): DetectedTextRegion[] {
	if (bubbles.length < 2) return [];
	return rawRegions.filter((region) => {
		let covered = 0;
		for (const bubble of bubbles) {
			const bubbleArea = bubble.width * bubble.height;
			if (bubbleArea <= 0) continue;
			if (intersectionArea(region, bubble) >= bubbleArea * FUSION_MIN_BUBBLE_COVERAGE) {
				covered += 1;
				if (covered >= 2) return true;
			}
		}
		return false;
	});
}

export interface FusionRetryMetrics {
	suspects: number;
	escalatedTarget: number;
	rawRegionsBefore: number;
	rawRegionsAfter: number;
	accepted: boolean;
	retryMs: number;
}

/**
 * Re-run text detection at the escalated input target when the raw regions
 * look fused across bubbles. Returns the original detection unchanged when
 * nothing is suspect or the retry does not improve region separation.
 */
export async function resolveTextDetectionFusion(
	imageBlob: Blob,
	detection: PPOcrRecognitionDetection,
	bubbles: readonly BubbleRegion[],
	options: PPOcrDetectorRunOptions = {}
): Promise<PPOcrRecognitionDetection> {
	const suspects = fusedRegionSuspects(detection.rawRegions, bubbles);
	if (suspects.length === 0) return detection;
	const escalatedTarget = ppocrDetectorEscalatedTargetSize(
		Math.max(detection.imageWidth, detection.imageHeight)
	);
	const started = performance.now();
	let retry: PPOcrRecognitionDetection;
	try {
		retry = await detectTextRegionsForRecognition(imageBlob, {
			...options,
			deferGrouping: true,
			targetLongestEdge: escalatedTarget
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		console.warn('[ppocr-det] Fusion retry failed; keeping original detection', error);
		return detection;
	}
	const accepted = retry.rawRegions.length > detection.rawRegions.length;
	const metrics: FusionRetryMetrics = {
		suspects: suspects.length,
		escalatedTarget,
		rawRegionsBefore: detection.rawRegions.length,
		rawRegionsAfter: retry.rawRegions.length,
		accepted,
		retryMs: performance.now() - started
	};
	console.info('[ppocr-det] fusion-retry metrics', JSON.stringify(metrics));
	return accepted ? { ...retry, mergedRegions: [] } : detection;
}

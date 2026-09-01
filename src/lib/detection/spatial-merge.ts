/**
 * PP-OCR/bubble integration boundary.
 *
 * Raw components are assigned to bubbles by polygon coverage before grouping.
 * The shared grouping engine owns local-scale, direction, panel, and cluster
 * policy; translation producers should never globally merge first.
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import type { BubbleRegion } from './bubble-geometry.js';
import {
	estimatePolygonOverlapRatio,
	groupRawTextComponents,
	type PPOcrGroupingOptions
} from './ppocr-grouping.js';

export interface MergedTextRegion extends DetectedTextRegion {
	inBubble: boolean;
	bubbleId?: number;
	contour?: [number, number][];
}

/** Group accepted raw text components after assigning them to bubble polygons. */
export function mergeTextWithBubbles(
	textRegions: DetectedTextRegion[],
	bubbles: BubbleRegion[],
	imageWidth: number,
	imageHeight: number,
	options: PPOcrGroupingOptions = {}
): MergedTextRegion[] {
	return groupRawTextComponents(textRegions, bubbles, imageWidth, imageHeight, options).groups;
}


import type { BubbleRegion } from '../bubble-geometry.js';

export type BubbleProviderId =
	| 'comic-layout'
	| 'rtdetr'
	| 'yolov8-bubble'
	| 'rtmdet-manga'
	| 'rtmdet-native'
	| 'none';

export interface CandidateAuxBox {
	x: number;
	y: number;
	width: number;
	height: number;
	confidence: number;
}

export interface CandidateLayoutResult {
	providerId: BubbleProviderId;
	/** Bubble stand-ins in the production `BubbleRegion` contract. */
	bubbles: BubbleRegion[];
	/** Panel/frame boxes when the model provides them (aux evidence). */
	panels: CandidateAuxBox[];
	/** Balloon-level text-region boxes when provided (aux evidence). */
	textRegions: CandidateAuxBox[];
	/**
	 * Balloon instances the segmenter dropped as a second instance of a balloon
	 * it kept (`suppressNestedBalloonInstances`, ppocr-grouping.ts). Evidence for the lab; never fed
	 * to the grouper.
	 */
	suppressedBubbles?: BubbleRegion[];
	inferenceMs: number;
}

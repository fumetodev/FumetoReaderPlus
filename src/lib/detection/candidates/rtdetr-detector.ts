/**
 * aoiandroid/rtdetrv4-x-manga109s_v2 candidate: RT-DETRv4-X detector with
 * classes body(0)/text(1)/frame(2)/face(3) at 1280², boxes returned directly
 * in ORIGINAL image coordinates (the graph consumes `orig_target_sizes`).
 * Boxes only — bubble stand-ins get synthesized rounded-rect contours;
 * `frame` boxes are surfaced as panel evidence.
 */

import type { BubbleRegion } from '../bubble-geometry.js';
import { createCandidateSession, ortTensor } from './candidate-model-files.js';
import { blobToImageBitmap, imageDataToCHW, resizeImage } from './preprocess.js';
import type { CandidateAuxBox, CandidateLayoutResult } from './layout-provider-types.js';

const MODEL_FILE = 'rtdetrv4-manga109.onnx';
const INPUT_SIZE = 1280;
const CONFIDENCE_THRESHOLD = 0.5;
// Classes: 0 body, 1 text, 2 frame, 3 face — only text/frame matter here.
const CLASS_TEXT = 1;
const CLASS_FRAME = 2;

/** 16-point rounded-rectangle polygon approximating a balloon outline. */
export function roundedRectContour(
	x: number,
	y: number,
	width: number,
	height: number
): [number, number][] {
	const radius = Math.min(width, height) * 0.25;
	const points: [number, number][] = [];
	const corners: Array<[number, number, number]> = [
		[x + width - radius, y + radius, -Math.PI / 2], // top-right arc start
		[x + width - radius, y + height - radius, 0], // bottom-right
		[x + radius, y + height - radius, Math.PI / 2], // bottom-left
		[x + radius, y + radius, Math.PI] // top-left
	];
	for (const [cx, cy, startAngle] of corners) {
		for (let i = 0; i < 4; i++) {
			const angle = startAngle + (i / 3) * (Math.PI / 2);
			points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
		}
	}
	return points;
}

export async function detectLayoutWithRtdetr(
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<CandidateLayoutResult> {
	const session = await createCandidateSession(MODEL_FILE);
	const ort = await ortTensor();
	const bitmap = await blobToImageBitmap(imageBlob);
	try {
		if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
		const imageData = resizeImage(bitmap, INPUT_SIZE, INPUT_SIZE);
		const chw = imageDataToCHW(imageData, '01');
		const started = performance.now();
		const output = await session.run({
			images: new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]),
			orig_target_sizes: new ort.Tensor(
				'int64',
				BigInt64Array.from([BigInt(bitmap.width), BigInt(bitmap.height)]),
				[1, 2]
			)
		});
		const inferenceMs = performance.now() - started;

		const labels = output.labels.data as BigInt64Array | Int32Array;
		const boxes = output.boxes.data as Float32Array;
		const scores = output.scores.data as Float32Array;
		const count = scores.length;

		const bubbles: BubbleRegion[] = [];
		const panels: CandidateAuxBox[] = [];
		for (let i = 0; i < count; i++) {
			if (scores[i] < CONFIDENCE_THRESHOLD) continue;
			const label = Number(labels[i]);
			const x1 = boxes[i * 4];
			const y1 = boxes[i * 4 + 1];
			const x2 = boxes[i * 4 + 2];
			const y2 = boxes[i * 4 + 3];
			const box = {
				x: Math.max(0, x1),
				y: Math.max(0, y1),
				width: Math.max(0, Math.min(bitmap.width, x2) - Math.max(0, x1)),
				height: Math.max(0, Math.min(bitmap.height, y2) - Math.max(0, y1)),
				confidence: scores[i]
			};
			if (box.width < 10 || box.height < 10) continue;
			if (label === CLASS_TEXT) {
				bubbles.push({
					bubbleId: bubbles.length,
					...box,
					contour: roundedRectContour(box.x, box.y, box.width, box.height)
				});
			} else if (label === CLASS_FRAME) {
				panels.push(box);
			}
			// CLASS_BODY / face boxes are irrelevant to overlay evaluation.
		}
		return { providerId: 'rtdetr', bubbles, panels, textRegions: [], inferenceMs };
	} finally {
		bitmap.close();
	}
}

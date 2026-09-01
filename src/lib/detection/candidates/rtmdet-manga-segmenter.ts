/**
 * rtmdet-manga candidate: this project's own RTMDet-Ins-s fine-tune
 * (Apache-2.0 stack), published at huggingface.co/fumetodev/rtmdet-manga-layout-onnx.
 * Classes: balloon(0), panel(1), text_dialogue(2), text_free(3).
 *
 * mmdeploy end2end export, static 1024: post-NMS outputs `dets` [1,N,5]
 * (x1,y1,x2,y2,score), `labels` [1,N] int64, `masks` [1,N,1024,1024]
 * sigmoid probabilities — all in INPUT (letterboxed 1024) coordinates.
 * Preprocessing follows the mmdet convention the model was trained with:
 * keep-ratio resize, TOP-LEFT gray-114 padding (not centered), BGR channel
 * order, per-channel mean/std normalization (no /255).
 */

import { traceMaskContour } from '../bubble-geometry.js';
import type { BubbleRegion } from '../bubble-geometry.js';
import { suppressNestedBalloonInstances } from '../ppocr-grouping.js';
import { createCandidateSession, ortTensor } from './candidate-model-files.js';
import { blobToImageBitmap } from './preprocess.js';
import type { CandidateAuxBox, CandidateLayoutResult } from './layout-provider-types.js';

const MODEL_FILE = 'rtmdet-manga-layout.onnx';
// 960 export: 96.4% balloon agreement with the 1024 reference at IoU 0.95,
// -14% inference time; int8 PTQ collapses this model (deep-feature error
// accumulation — needs QAT), so speed comes from resolution + threads.
const INPUT_SIZE = 960;
const SCORE_THRESHOLD = 0.35;
const MASK_THRESHOLD = 0.5;
const MEAN_BGR = [103.53, 116.28, 123.675] as const;
const STD_BGR = [57.375, 57.12, 58.395] as const;
const CLASS_BALLOON = 0;
const CLASS_PANEL = 1;

export interface RtmdetInstance {
	classId: number;
	confidence: number;
	/** Box in original-image coordinates. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Contour in original-image coordinates (balloons only). */
	contour?: [number, number][];
}

/**
 * Map mmdeploy end2end outputs (input-space) to original-image instances.
 * Pure function — unit-tested with synthetic tensors.
 */
export function mapRtmdetOutputs(
	dets: Float32Array,
	labels: ArrayLike<number | bigint>,
	masks: Float32Array,
	options: {
		count: number;
		inputSize: number;
		scale: number;
		originalWidth: number;
		originalHeight: number;
		scoreThreshold?: number;
	}
): RtmdetInstance[] {
	const { count, inputSize, scale, originalWidth, originalHeight } = options;
	const threshold = options.scoreThreshold ?? SCORE_THRESHOLD;
	const planeSize = inputSize * inputSize;
	const instances: RtmdetInstance[] = [];
	for (let i = 0; i < count; i++) {
		const score = dets[i * 5 + 4];
		if (score < threshold) continue;
		const classId = Number(labels[i]);
		const x1 = Math.max(0, Math.min(dets[i * 5] / scale, originalWidth));
		const y1 = Math.max(0, Math.min(dets[i * 5 + 1] / scale, originalHeight));
		const x2 = Math.max(0, Math.min(dets[i * 5 + 2] / scale, originalWidth));
		const y2 = Math.max(0, Math.min(dets[i * 5 + 3] / scale, originalHeight));
		if (x2 - x1 < 4 || y2 - y1 < 4) continue;
		const instance: RtmdetInstance = {
			classId,
			confidence: score,
			x: x1,
			y: y1,
			width: x2 - x1,
			height: y2 - y1
		};
		if (classId === CLASS_BALLOON) {
			const mask = new Uint8Array(planeSize);
			const offset = i * planeSize;
			for (let p = 0; p < planeSize; p++) {
				mask[p] = masks[offset + p] >= MASK_THRESHOLD ? 1 : 0;
			}
			const bx = Math.max(0, Math.floor(dets[i * 5]));
			const by = Math.max(0, Math.floor(dets[i * 5 + 1]));
			const bw = Math.max(1, Math.min(inputSize - bx, Math.ceil(dets[i * 5 + 2]) - bx));
			const bh = Math.max(1, Math.min(inputSize - by, Math.ceil(dets[i * 5 + 3]) - by));
			const traced = traceMaskContour(mask, bx, by, bw, bh, inputSize, inputSize);
			if (traced.length >= 3) {
				instance.contour = traced.map(([px, py]) => [
					Math.max(0, Math.min(px / scale, originalWidth)),
					Math.max(0, Math.min(py / scale, originalHeight))
				]);
			}
		}
		instances.push(instance);
	}
	return instances;
}

/** Keep-ratio resize with mmdet-style top-left gray-114 padding. */
function topLeftLetterbox(
	bitmap: ImageBitmap,
	inputSize: number
): { imageData: ImageData; scale: number } {
	const scale = Math.min(inputSize / bitmap.width, inputSize / bitmap.height);
	const canvas = new OffscreenCanvas(inputSize, inputSize);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Unable to create letterbox canvas context');
	ctx.fillStyle = 'rgb(114,114,114)';
	ctx.fillRect(0, 0, inputSize, inputSize);
	ctx.drawImage(bitmap, 0, 0, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
	return { imageData: ctx.getImageData(0, 0, inputSize, inputSize), scale };
}

/** ImageData → CHW Float32Array, BGR order, (px − mean)/std on 0-255 values. */
function imageDataToBgrNormalized(imageData: ImageData): Float32Array {
	const { data, width, height } = imageData;
	const planeSize = width * height;
	const chw = new Float32Array(3 * planeSize);
	for (let i = 0; i < planeSize; i++) {
		const r = data[i * 4];
		const g = data[i * 4 + 1];
		const b = data[i * 4 + 2];
		chw[i] = (b - MEAN_BGR[0]) / STD_BGR[0];
		chw[planeSize + i] = (g - MEAN_BGR[1]) / STD_BGR[1];
		chw[2 * planeSize + i] = (r - MEAN_BGR[2]) / STD_BGR[2];
	}
	return chw;
}

export async function detectLayoutWithRtmdetManga(
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<CandidateLayoutResult> {
	const session = await createCandidateSession(MODEL_FILE);
	const ort = await ortTensor();
	const bitmap = await blobToImageBitmap(imageBlob);
	try {
		if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
		const { imageData, scale } = topLeftLetterbox(bitmap, INPUT_SIZE);
		const chw = imageDataToBgrNormalized(imageData);
		const started = performance.now();
		const output = await session.run({
			input: new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE])
		});
		const inferenceMs = performance.now() - started;

		const dets = output.dets as { dims: readonly number[]; data: Float32Array };
		const labels = output.labels as { data: ArrayLike<number | bigint> };
		const masks = output.masks as { data: Float32Array };
		if (!dets || !labels || !masks) throw new Error('rtmdet-manga output tensors not recognized');

		const instances = mapRtmdetOutputs(dets.data, labels.data, masks.data, {
			count: dets.dims[1],
			inputSize: INPUT_SIZE,
			scale,
			originalWidth: bitmap.width,
			originalHeight: bitmap.height
		});

		const detectedBubbles: BubbleRegion[] = [];
		const panels: CandidateAuxBox[] = [];
		const textRegions: CandidateAuxBox[] = [];
		for (const instance of instances) {
			const aux = {
				x: instance.x,
				y: instance.y,
				width: instance.width,
				height: instance.height,
				confidence: instance.confidence
			};
			if (instance.classId === CLASS_BALLOON && instance.contour) {
				detectedBubbles.push({ bubbleId: detectedBubbles.length, ...aux, contour: instance.contour });
			} else if (instance.classId === CLASS_PANEL) {
				panels.push(aux);
			} else if (instance.classId !== CLASS_BALLOON) {
				textRegions.push(aux);
			}
		}
		const { bubbles, suppressed } = suppressNestedBalloonInstances(detectedBubbles);
		return { providerId: 'rtmdet-manga', bubbles, panels, textRegions, suppressedBubbles: suppressed, inferenceMs };
	} finally {
		bitmap.close();
	}
}

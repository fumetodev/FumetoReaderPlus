/**
 * Generalized YOLO instance-segmentation decode for candidate models.
 *
 * Handles the two export layouts seen in the candidates:
 * - classic anchor-free head: dets `[1, 4+nc+32, N]` (or transposed
 *   `[1, N, 4+nc+32]`) with cx/cy/w/h + per-class scores + 32 mask coeffs,
 *   needing NMS — the current bubble-seg's layout;
 * - end-to-end (YOLO26) head: dets `[1, N, 6+32]` with x1/y1/x2/y2 +
 *   score + class + 32 coeffs, NMS-free.
 *
 * Mask building generalizes `bubble-segmenter.ts` `buildInstanceMask` to a
 * parameterized proto size; contour tracing reuses the shared
 * `traceMaskContour` export.
 */

import { detectionIoU, traceMaskContour } from '../bubble-geometry.js';
import type { LetterboxInfo } from './preprocess.js';

export interface SegTensorLike {
	dims: readonly number[];
	data: Float32Array;
}

export interface DecodedSegInstance {
	classId: number;
	confidence: number;
	/** Original-image-space box. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Simplified polygon in original image space (empty if mask degenerate). */
	contour: [number, number][];
}

export interface YoloSegDecodeOptions {
	numClasses: number;
	confidenceThreshold: number;
	nmsIouThreshold?: number;
	/** Restrict output to these class ids (others discarded). */
	classFilter?: readonly number[];
	originalWidth: number;
	originalHeight: number;
	letterbox: LetterboxInfo;
	maxInstances?: number;
}

interface RawDetection {
	cx: number;
	cy: number;
	w: number;
	h: number;
	classId: number;
	confidence: number;
	maskCoeffs: Float32Array;
}

const MASK_COEFFS = 32;

function sigmoid(value: number): number {
	return 1 / (1 + Math.exp(-value));
}

/** Read raw detections from either supported head layout. */
export function readYoloSegDetections(
	dets: SegTensorLike,
	options: Pick<YoloSegDecodeOptions, 'numClasses' | 'confidenceThreshold'>
): { detections: RawDetection[]; endToEnd: boolean } {
	const { numClasses, confidenceThreshold } = options;
	const classicChannels = 4 + numClasses + MASK_COEFFS;
	const e2eChannels = 6 + MASK_COEFFS;
	const [, d1, d2] = dets.dims;
	const detections: RawDetection[] = [];

	const readClassic = (count: number, channelStride: boolean) => {
		// channelStride=true → [1, C, N] (value(c,i) = data[c*N + i]);
		// false → [1, N, C] (value(c,i) = data[i*C + c]).
		const C = classicChannels;
		const N = count;
		const at = channelStride
			? (c: number, i: number) => dets.data[c * N + i]
			: (c: number, i: number) => dets.data[i * C + c];
		for (let i = 0; i < N; i++) {
			let best = 0;
			let bestClass = -1;
			for (let c = 0; c < numClasses; c++) {
				const raw = at(4 + c, i);
				// Classic heads may emit logits or probabilities; sigmoid only
				// when the value is outside [0,1].
				const score = raw >= 0 && raw <= 1 ? raw : sigmoid(raw);
				if (score > best) {
					best = score;
					bestClass = c;
				}
			}
			if (best < confidenceThreshold) continue;
			const maskCoeffs = new Float32Array(MASK_COEFFS);
			for (let c = 0; c < MASK_COEFFS; c++) maskCoeffs[c] = at(4 + numClasses + c, i);
			detections.push({
				cx: at(0, i),
				cy: at(1, i),
				w: at(2, i),
				h: at(3, i),
				classId: bestClass,
				confidence: best,
				maskCoeffs
			});
		}
	};

	if (d2 === classicChannels && d1 !== classicChannels) {
		readClassic(d1, false);
		return { detections, endToEnd: false };
	}
	if (d1 === classicChannels) {
		readClassic(d2, true);
		return { detections, endToEnd: false };
	}
	if (d2 === e2eChannels) {
		for (let i = 0; i < d1; i++) {
			const base = i * e2eChannels;
			const confidence = dets.data[base + 4];
			if (confidence < confidenceThreshold) continue;
			const x1 = dets.data[base];
			const y1 = dets.data[base + 1];
			const x2 = dets.data[base + 2];
			const y2 = dets.data[base + 3];
			const maskCoeffs = new Float32Array(MASK_COEFFS);
			for (let c = 0; c < MASK_COEFFS; c++) maskCoeffs[c] = dets.data[base + 6 + c];
			detections.push({
				cx: (x1 + x2) / 2,
				cy: (y1 + y2) / 2,
				w: x2 - x1,
				h: y2 - y1,
				classId: Math.round(dets.data[base + 5]),
				confidence,
				maskCoeffs
			});
		}
		return { detections, endToEnd: true };
	}
	throw new Error(`Unrecognized YOLO seg head layout [1,${d1},${d2}] for ${classicChannels}/${e2eChannels} channels`);
}

/** Generalized proto-mask builder (variable proto size / input size). */
export function buildSegInstanceMask(
	det: RawDetection,
	protoData: Float32Array,
	protoSize: number,
	letterbox: LetterboxInfo,
	originalWidth: number,
	originalHeight: number
): Uint8Array {
	const mask = new Uint8Array(originalWidth * originalHeight);
	const protoScale = protoSize / letterbox.inputSize;
	const lx1 = det.cx - det.w / 2;
	const ly1 = det.cy - det.h / 2;
	const lx2 = det.cx + det.w / 2;
	const ly2 = det.cy + det.h / 2;
	const px1 = Math.max(0, Math.floor(lx1 * protoScale));
	const py1 = Math.max(0, Math.floor(ly1 * protoScale));
	const px2 = Math.min(protoSize - 1, Math.ceil(lx2 * protoScale));
	const py2 = Math.min(protoSize - 1, Math.ceil(ly2 * protoScale));

	for (let py = py1; py <= py2; py++) {
		for (let px = px1; px <= px2; px++) {
			let sum = 0;
			for (let c = 0; c < MASK_COEFFS; c++) {
				sum += det.maskCoeffs[c] * protoData[c * protoSize * protoSize + py * protoSize + px];
			}
			if (sigmoid(sum) < 0.5) continue;
			const imgX1 = Math.max(0, Math.floor((px / protoScale - letterbox.padLeft) / letterbox.scale));
			const imgY1 = Math.max(0, Math.floor((py / protoScale - letterbox.padTop) / letterbox.scale));
			const imgX2 = Math.min(
				originalWidth,
				Math.ceil(((px + 1) / protoScale - letterbox.padLeft) / letterbox.scale)
			);
			const imgY2 = Math.min(
				originalHeight,
				Math.ceil(((py + 1) / protoScale - letterbox.padTop) / letterbox.scale)
			);
			for (let imgY = imgY1; imgY < imgY2; imgY++) {
				mask.fill(1, imgY * originalWidth + imgX1, imgY * originalWidth + imgX2);
			}
		}
	}
	return mask;
}

/** Full decode: detections + protos → per-instance boxes and contours. */
export function decodeYoloSegOutputs(
	dets: SegTensorLike,
	protos: SegTensorLike,
	options: YoloSegDecodeOptions
): DecodedSegInstance[] {
	const { detections, endToEnd } = readYoloSegDetections(dets, options);
	const nmsThreshold = options.nmsIouThreshold ?? 0.5;

	let kept = detections;
	if (!endToEnd) {
		kept = [];
		const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
		for (const det of sorted) {
			if (kept.every((other) => detectionIoU(det, other) < nmsThreshold)) kept.push(det);
		}
	}
	if (options.classFilter) {
		const allowed = new Set(options.classFilter);
		kept = kept.filter((det) => allowed.has(det.classId));
	}
	kept = kept
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, options.maxInstances ?? 64);

	const protoSize = protos.dims[2];
	const results: DecodedSegInstance[] = [];
	for (const det of kept) {
		const box = {
			x1: det.cx - det.w / 2,
			y1: det.cy - det.h / 2,
			x2: det.cx + det.w / 2,
			y2: det.cy + det.h / 2
		};
		const originalBox = {
			x: Math.max(0, (box.x1 - options.letterbox.padLeft) / options.letterbox.scale),
			y: Math.max(0, (box.y1 - options.letterbox.padTop) / options.letterbox.scale)
		};
		const originalRight = Math.min(
			options.originalWidth,
			(box.x2 - options.letterbox.padLeft) / options.letterbox.scale
		);
		const originalBottom = Math.min(
			options.originalHeight,
			(box.y2 - options.letterbox.padTop) / options.letterbox.scale
		);
		const width = originalRight - originalBox.x;
		const height = originalBottom - originalBox.y;
		if (width < 10 || height < 10) continue;

		const mask = buildSegInstanceMask(
			det,
			protos.data,
			protoSize,
			options.letterbox,
			options.originalWidth,
			options.originalHeight
		);
		const contour = traceMaskContour(
			mask,
			Math.floor(originalBox.x),
			Math.floor(originalBox.y),
			Math.ceil(width),
			Math.ceil(height),
			options.originalWidth,
			options.originalHeight
		);
		results.push({
			classId: det.classId,
			confidence: det.confidence,
			x: originalBox.x,
			y: originalBox.y,
			width,
			height,
			contour
		});
	}
	return results;
}

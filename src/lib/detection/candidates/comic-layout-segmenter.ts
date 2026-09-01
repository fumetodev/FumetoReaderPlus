/**
 * comic-layout-yolo26s candidate: instance segmentation with classes
 * frame(0) / text(1) / balloon(2) at 1280px, NMS-free e2e head [1,300,38]
 * + protos [1,32,320,320] (host-exported ONNX; see
 * scripts/export-comic-layout-onnx.py).
 */

import type { BubbleRegion } from '../bubble-geometry.js';
import { createCandidateSession, ortTensor } from './candidate-model-files.js';
import { blobToImageBitmap, imageDataToCHW, letterboxImage } from './preprocess.js';
import { decodeYoloSegOutputs } from './yolo-seg-decode.js';
import type { CandidateAuxBox, CandidateLayoutResult } from './layout-provider-types.js';

const MODEL_FILE = 'comic-layout-yolo26s.onnx';
const INPUT_SIZE = 1280;
const CONFIDENCE_THRESHOLD = 0.25;
const CLASS_FRAME = 0;
const CLASS_TEXT = 1;
const CLASS_BALLOON = 2;

export async function detectLayoutWithComicLayout(
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<CandidateLayoutResult> {
	const session = await createCandidateSession(MODEL_FILE);
	const ort = await ortTensor();
	const bitmap = await blobToImageBitmap(imageBlob);
	try {
		if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
		const { imageData, info } = letterboxImage(bitmap, INPUT_SIZE);
		const chw = imageDataToCHW(imageData, '01');
		const started = performance.now();
		const output = await session.run({
			images: new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE])
		});
		const inferenceMs = performance.now() - started;

		const tensors = Object.values(output) as Array<{ dims: readonly number[]; data: Float32Array }>;
		const protos = tensors.find((t) => t.dims.length === 4 && t.dims[1] === 32);
		const dets = tensors.find((t) => t.dims.length === 3);
		if (!protos || !dets) throw new Error('comic-layout output tensors not recognized');

		const instances = decodeYoloSegOutputs(dets, protos, {
			numClasses: 3,
			confidenceThreshold: CONFIDENCE_THRESHOLD,
			originalWidth: bitmap.width,
			originalHeight: bitmap.height,
			letterbox: info
		});

		const bubbles: BubbleRegion[] = [];
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
			if (instance.classId === CLASS_BALLOON) {
				bubbles.push({ bubbleId: bubbles.length, ...aux, contour: instance.contour });
			} else if (instance.classId === CLASS_FRAME) {
				panels.push(aux);
			} else if (instance.classId === CLASS_TEXT) {
				textRegions.push(aux);
			}
		}
		return { providerId: 'comic-layout', bubbles, panels, textRegions, inferenceMs };
	} finally {
		bitmap.close();
	}
}

/**
 * kitsumed/yolov8m_seg-speech-bubble candidate: single speech-bubble class,
 * classic YOLOv8 seg head [1,37,N] + protos, dynamic input (run at 640 like
 * the model's training default). Also the fallback mask-based candidate when
 * the comic-layout export is unavailable.
 */

import type { BubbleRegion } from '../bubble-geometry.js';
import { createCandidateSession, ortTensor } from './candidate-model-files.js';
import { blobToImageBitmap, imageDataToCHW, letterboxImage } from './preprocess.js';
import { decodeYoloSegOutputs } from './yolo-seg-decode.js';
import type { CandidateLayoutResult } from './layout-provider-types.js';

const MODEL_FILE = 'yolov8-bubble-seg.onnx';
const INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.3;

export async function detectBubblesWithYolov8(
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
		if (!protos || !dets) throw new Error('yolov8-bubble output tensors not recognized');

		const instances = decodeYoloSegOutputs(dets, protos, {
			numClasses: 1,
			confidenceThreshold: CONFIDENCE_THRESHOLD,
			nmsIouThreshold: 0.5,
			originalWidth: bitmap.width,
			originalHeight: bitmap.height,
			letterbox: info
		});

		const bubbles: BubbleRegion[] = instances.map((instance, index) => ({
			bubbleId: index,
			x: instance.x,
			y: instance.y,
			width: instance.width,
			height: instance.height,
			confidence: instance.confidence,
			contour: instance.contour
		}));
		return { providerId: 'yolov8-bubble', bubbles, panels: [], textRegions: [], inferenceMs };
	} finally {
		bitmap.close();
	}
}

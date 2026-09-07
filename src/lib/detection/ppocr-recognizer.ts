/**
 * PP-OCRv6 small text recognition via native Android ORT or ONNX Runtime Web.
 *
 * Takes detected text regions (from ppocr-detector.ts), crops them from the source
 * image, and runs the PP-OCR recognition model to extract text strings.
 *
 * The model is loaded lazily and can be released after a batch to free the
 * selected native session or WASM heap allocation.
 *
 * Model: official PP-OCRv6 small rec ONNX (~21 MB), served from /models/
 * Dictionary: official PP-OCRv6 multilingual dictionary, served from /models/
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import { perfMark } from '$lib/util/perf.js';
import { ortWasmBaseUrl } from './ort-wasm-paths.js';
import { loadPPOcrWasmModelBuffer } from './ppocr-wasm-model-loader.js';
import {
	DEFAULT_NATIVE_PPOCR_RECOGNIZER_CONFIG,
	getNativePPOcrRuntimeInfo,
	initializeNativePPOcrRecognizer,
	isNativePPOcrRecognizerAvailable,
	recognizeTextRegionsNative,
	releaseNativePPOcrRecognizer,
	type NativePPOcrConfig,
	type NativePPOcrRecognition
} from './native-ppocr-detector.js';

// Model and dictionary paths — bundled in static/models/
export const PPOCR_RECOGNIZER_MODEL_PATH = '/models/ppocr-rec-v6-small.onnx';
export const PPOCR_RECOGNIZER_DICTIONARY_PATH = '/models/ppocrv6_dict.txt';

// Recognition parameters
export const PPOCR_RECOGNIZER_IMAGE_HEIGHT = 48; // fixed height for recognition input
export const PPOCR_RECOGNIZER_MAX_WIDTH = 320; // max width (padded with zeros if shorter)
export const PPOCR_RECOGNIZER_MAX_BATCH_SIZE = 8; // bounds the largest logits allocation
export const PPOCR_RECOGNIZER_MIN_CONFIDENCE = 0.3; // discard results below this confidence
export const PPOCR_RECOGNIZER_BLANK_TOKEN = 0; // CTC blank token index

// Normalization: PP-OCRv6 rec uses (pixel/255 - 0.5) / 0.5 → [-1, 1] range.
// This is DIFFERENT from the detection model which uses ImageNet mean/std.
// Confirmed by PaddleOCR's resize_norm_img(), nihui's ncnn impl, and HoVDuc's ONNX impl.
const MEAN = [0.5, 0.5, 0.5];
const STD = [0.5, 0.5, 0.5];

let ort: typeof import('onnxruntime-web/wasm') | null = null;
let session: import('onnxruntime-web/wasm').InferenceSession | null = null;
let loading: Promise<void> | null = null;
let dictionary: string[] | null = null;

export type PPOcrRecognizerBackend = 'auto' | 'native' | 'wasm';

export interface PPOcrRecognizerRunOptions {
	backend?: PPOcrRecognizerBackend;
	nativeConfig?: NativePPOcrConfig;
	/** Cancels only this native callback; WASM observes it between batches. */
	signal?: AbortSignal;
}

function throwIfRecognizerCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('PP-OCR recognition cancelled');
}

// A failed automatic native configuration stays quarantined for this lifecycle.
// Explicit `backend: 'native'` bypasses it; release clears it for an intentional retry.
const nativeFailureQuarantine = new Set<string>();

function nativeConfigKey(config: NativePPOcrConfig): string {
	return `${config.provider}:${config.threads}`;
}

function logNativeRecognizerMetrics(result: NativePPOcrRecognition): void {
	const metrics = { backend: 'native-android', ...result.metrics };
	console.warn(`[ppocr-rec] metrics ${JSON.stringify(metrics)}`);
	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__fumeto_last_ppocr_recognizer_metrics = metrics;
	}
}

export interface RecognitionResult {
	boxId: number;
	text: string;
	confidence: number;
}

/**
 * Load the character dictionary from the text file.
 * Dictionary is 1-indexed in CTC decode (index 0 = blank token).
 */
async function loadDictionary(): Promise<string[]> {
	if (dictionary) return dictionary;

	const response = await fetch(PPOCR_RECOGNIZER_DICTIONARY_PATH);
	if (!response.ok) throw new Error(`Failed to load dictionary: ${response.status}`);
	const text = await response.text();
	// Each line is one character; filter empty lines
	dictionary = text.split('\n').filter((line) => line.length > 0);
	return dictionary;
}

/**
 * Initialize ONNX Runtime and load the recognition model.
 * Model is loaded from the bundled static asset.
 */
export async function initRecognizerWasm(): Promise<void> {
	if (session) return;
	if (loading) return loading;

	loading = (async () => {
		// Load dictionary in parallel with model
		const [, ortModule] = await Promise.all([loadDictionary(), import('onnxruntime-web/wasm')]);

		ort = ortModule;
		ort.env.wasm.wasmPaths = ortWasmBaseUrl();
		ort.env.wasm.proxy = false;
		ort.env.wasm.numThreads = 1;

		// Android builds prune this model from the web bundle (native ORT owns
		// det/rec there); the loader falls back to the APK's native asset copy
		// so WASM remains a working rescue path on-device.
		const modelBuffer = await loadPPOcrWasmModelBuffer(PPOCR_RECOGNIZER_MODEL_PATH, 'recognizer');

		session = await ort.InferenceSession.create(modelBuffer, {
			executionProviders: ['wasm']
		});
	})();

	try {
		await loading;
	} catch (err) {
		loading = null;
		session = null;
		throw err;
	}
}

/** Initialize the selected recognizer, with one-shot native-to-WASM fallback in auto mode. */
export async function initRecognizer(options: PPOcrRecognizerRunOptions = {}): Promise<void> {
	const backend = options.backend ?? 'auto';
	const config = options.nativeConfig ?? DEFAULT_NATIVE_PPOCR_RECOGNIZER_CONFIG;
	const quarantineKey = nativeConfigKey(config);
	const shouldTryNative =
		backend !== 'wasm' &&
		isNativePPOcrRecognizerAvailable() &&
		(backend === 'native' || !nativeFailureQuarantine.has(quarantineKey));
	if (shouldTryNative) {
		try {
			await initializeNativePPOcrRecognizer(config, options.signal);
			nativeFailureQuarantine.delete(quarantineKey);
			return;
		} catch (error) {
			throwIfRecognizerCancelled(options.signal);
			if (backend === 'native') throw error;
			nativeFailureQuarantine.add(quarantineKey);
			console.warn('[ppocr-rec] Native initialization failed; using WASM', error);
		}
	} else if (backend === 'native') {
		throw new Error('Native PP-OCR recognizer is unavailable');
	}
	throwIfRecognizerCancelled(options.signal);
	await initRecognizerWasm();
	throwIfRecognizerCancelled(options.signal);
}

/**
 * Crop a single region from the source image and prepare for recognition.
 * Returns the cropped ImageData resized to height=48 with preserved aspect ratio.
 */
function cropAndResize(
	sourceCanvas: OffscreenCanvas,
	sourceCtx: OffscreenCanvasRenderingContext2D,
	region: DetectedTextRegion
): { imageData: ImageData; width: number } {
	// Clamp region to image bounds
	// DB boxes hug the outermost glyph pixels. A fixed two-pixel source-space
	// margin preserves dakuten, punctuation, and thin end strokes without
	// pulling neighboring lines into the crop. This was especially important
	// for small horizontal Japanese text in the live manga corpus.
	const cropMargin = 2;
	const sx = Math.max(0, region.x - cropMargin);
	const sy = Math.max(0, region.y - cropMargin);
	const right = Math.min(sourceCanvas.width, region.x + region.width + cropMargin);
	const bottom = Math.min(sourceCanvas.height, region.y + region.height + cropMargin);
	const sw = right - sx;
	const sh = bottom - sy;

	if (sw <= 0 || sh <= 0) {
		// Degenerate region — return minimal empty data
		const canvas = new OffscreenCanvas(1, PPOCR_RECOGNIZER_IMAGE_HEIGHT);
		const ctx = canvas.getContext('2d')!;
		return {
			imageData: ctx.getImageData(0, 0, 1, PPOCR_RECOGNIZER_IMAGE_HEIGHT),
			width: 1
		};
	}

	// For vertical text (height > width * 1.5), rotate 90° CCW before recognition.
	// PaddleOCR's rec model reads horizontally — vertical manga text (top→bottom)
	// must be rotated so characters flow left→right.
	const isVertical = sh > sw * 1.5;
	const effectiveW = isVertical ? sh : sw;
	const effectiveH = isVertical ? sw : sh;

	// Calculate target dimensions: height=48, width preserves aspect ratio
	const aspectRatio = effectiveW / effectiveH;
	let targetW = Math.round(PPOCR_RECOGNIZER_IMAGE_HEIGHT * aspectRatio);
	targetW = Math.max(1, Math.min(targetW, PPOCR_RECOGNIZER_MAX_WIDTH));

	const cropCanvas = new OffscreenCanvas(targetW, PPOCR_RECOGNIZER_IMAGE_HEIGHT);
	const cropCtx = cropCanvas.getContext('2d')!;

	if (isVertical) {
		// Rotate 90° CCW: top→left, so vertical text becomes horizontal LTR
		cropCtx.save();
		cropCtx.translate(0, PPOCR_RECOGNIZER_IMAGE_HEIGHT);
		cropCtx.rotate(-Math.PI / 2);
		// In rotated coordinates, draw scaled to (height=targetW, width=fixed input height)
		cropCtx.drawImage(
			sourceCanvas,
			sx,
			sy,
			sw,
			sh,
			0,
			0,
			PPOCR_RECOGNIZER_IMAGE_HEIGHT,
			targetW
		);
		cropCtx.restore();
	} else {
		cropCtx.drawImage(
			sourceCanvas,
			sx,
			sy,
			sw,
			sh,
			0,
			0,
			targetW,
			PPOCR_RECOGNIZER_IMAGE_HEIGHT
		);
	}

	return {
		imageData: cropCtx.getImageData(0, 0, targetW, PPOCR_RECOGNIZER_IMAGE_HEIGHT),
		width: targetW
	};
}

/**
 * Convert cropped image data to a normalized CHW float32 tensor.
 * Pads width to padWidth with zeros.
 *
 * PaddleOCR models expect BGR channel order. Canvas imageData is RGBA,
 * so we swap R↔B when building the tensor: channel 0=B, channel 1=G, channel 2=R.
 */
function imageDataToTensor(imageData: ImageData, padWidth: number): Float32Array {
	const h = imageData.height;
	const w = imageData.width;
	const pixels = imageData.data;
	const chw = new Float32Array(3 * h * padWidth);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const srcIdx = (y * w + x) * 4;
			const dstIdx = y * padWidth + x;
			// BGR order: channel 0 = Blue (srcIdx+2), channel 1 = Green (srcIdx+1), channel 2 = Red (srcIdx)
			chw[dstIdx] = (pixels[srcIdx + 2] / 255.0 - MEAN[0]) / STD[0]; // B
			chw[h * padWidth + dstIdx] = (pixels[srcIdx + 1] / 255.0 - MEAN[1]) / STD[1]; // G
			chw[2 * h * padWidth + dstIdx] = (pixels[srcIdx] / 255.0 - MEAN[2]) / STD[2]; // R
		}
		// Padding region (x >= w) stays as 0.0 (zero-padded)
	}

	return chw;
}

/**
 * CTC greedy decode: argmax per timestep → collapse consecutive duplicates → remove blanks.
 *
 * @param logits Float32Array of shape [seq_len, vocab_size]
 * @param seqLen Number of timesteps
 * @param vocabSize Size of vocabulary (including blank at index 0)
 * @returns Decoded text and average confidence
 */
export function ctcDecode(
	logits: Float32Array,
	seqLen: number,
	vocabSize: number
): { text: string; confidence: number } {
	if (!dictionary || dictionary.length === 0) {
		return { text: '', confidence: 0 };
	}

	const indices: number[] = [];
	const confidences: number[] = [];
	let prevIdx = -1;

	for (let t = 0; t < seqLen; t++) {
		// Find argmax for this timestep
		let maxIdx = 0;
		let maxVal = logits[t * vocabSize];
		for (let v = 1; v < vocabSize; v++) {
			const val = logits[t * vocabSize + v];
			if (val > maxVal) {
				maxVal = val;
				maxIdx = v;
			}
		}

		// Collapse consecutive duplicates and skip blanks
		if (maxIdx !== prevIdx && maxIdx !== PPOCR_RECOGNIZER_BLANK_TOKEN) {
			indices.push(maxIdx);
			// The rec model's ONNX graph ends with softmax, so this output value
			// IS the argmax probability (verified live 2026-07-20: re-normalizing
			// collapsed every line below MIN_CONFIDENCE). The mean of these per
			// selected timestep is the line confidence that feeds the gate and
			// the coverage-demotion path downstream.
			confidences.push(maxVal);
		}
		prevIdx = maxIdx;
	}

	// Map indices to characters (dictionary is 1-indexed: index 1 → dict[0])
	const chars = indices.map((idx) => {
		const dictIdx = idx - 1;
		if (dictIdx >= 0 && dictIdx < dictionary!.length) {
			return dictionary![dictIdx];
		}
		return '';
	});

	const text = chars.join('');
	const avgConfidence =
		confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

	return { text, confidence: avgConfidence };
}

/**
 * Recognize text in detected regions from a page image.
 *
 * Crops each region, resizes to h=48, normalizes, runs ONNX inference,
 * and CTC-decodes the output to get text strings.
 *
 * @param imageBlob - Full page image as Blob
 * @param regions - Detected text regions from PP-OCR detector
 * @returns Recognition results (filtered: no empty text, no confidence < 0.3)
 */
export async function recognizeTextRegionsWasm(
	imageBlob: Blob,
	regions: DetectedTextRegion[],
	signal?: AbortSignal
): Promise<RecognitionResult[]> {
	throwIfRecognizerCancelled(signal);
	if (!session || !ort) {
		await initRecognizerWasm();
	}
	throwIfRecognizerCancelled(signal);
	if (!session || !ort) throw new Error('Recognizer not initialized');
	if (!dictionary) throw new Error('Dictionary not loaded');
	if (regions.length === 0) return [];

	// Draw source image onto a canvas for cropping
	const bitmap = await createImageBitmap(imageBlob);
	if (signal?.aborted) {
		bitmap.close();
		throwIfRecognizerCancelled(signal);
	}
	const sourceCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const sourceCtx = sourceCanvas.getContext('2d')!;
	sourceCtx.drawImage(bitmap, 0, 0);
	bitmap.close();

	const preprocessingStarted = performance.now();
	const prepared = regions
		.map((region, originalIndex) => ({
			region,
			originalIndex,
			...cropAndResize(sourceCanvas, sourceCtx, region)
		}))
		// Similar widths share a batch so narrow lines do not pay for padding to
		// the widest line on the page. The original result order is restored below.
		.sort((a, b) => a.width - b.width);
	const preprocessingMs = performance.now() - preprocessingStarted;
	let inferenceMs = 0;
	let decodeMs = 0;
	let batchAttempts = 0;
	let fallbackBatches = 0;
	const indexedResults: Array<{ originalIndex: number; result: RecognitionResult }> = [];

	const runBatch = async (batch: typeof prepared): Promise<void> => {
		throwIfRecognizerCancelled(signal);
		batchAttempts += 1;
		const padWidth = Math.max(1, ...batch.map((item) => item.width));
		const valuesPerInput = 3 * PPOCR_RECOGNIZER_IMAGE_HEIGHT * padWidth;
		const batchedChw = new Float32Array(batch.length * valuesPerInput);
		for (let i = 0; i < batch.length; i++) {
			batchedChw.set(imageDataToTensor(batch[i].imageData, padWidth), i * valuesPerInput);
		}

		const inputTensor = new ort!.Tensor(
			'float32',
			batchedChw,
			[batch.length, 3, PPOCR_RECOGNIZER_IMAGE_HEIGHT, padWidth]
		);
		let outputTensors: import('onnxruntime-web/wasm').Tensor[] = [];
		try {
			const inputName = session!.inputNames?.[0] ?? 'x';
			const inferenceStarted = performance.now();
			const output = await session!.run({ [inputName]: inputTensor });
			throwIfRecognizerCancelled(signal);
			inferenceMs += performance.now() - inferenceStarted;
			outputTensors = Object.values(output);

			const outputKeys = Object.keys(output);
			if (outputKeys.length === 0) {
				throw new Error('PP-OCR recognizer returned no output tensors');
			}

			const outputTensor = output[outputKeys[0]];
			if (!outputTensor?.data) {
				throw new Error('PP-OCR recognizer output tensor is empty');
			}

			const logits = outputTensor.data as Float32Array;
			const dims = outputTensor.dims;
			const outputBatch = dims[0] as number;
			const seqLen = dims[1] as number;
			const vocabSize = dims[2] as number;
			if (outputBatch !== batch.length || !seqLen || !vocabSize) {
				throw new Error(`Unexpected PP-OCR recognizer output shape [${dims.join(',')}]`);
			}

			const logitsPerInput = seqLen * vocabSize;
			const decodeStarted = performance.now();
			for (let i = 0; i < batch.length; i++) {
				const item = batch[i];
				const itemLogits = logits.subarray(i * logitsPerInput, (i + 1) * logitsPerInput);
				const { text, confidence } = ctcDecode(itemLogits, seqLen, vocabSize);
				if (text.trim().length > 0 && confidence >= PPOCR_RECOGNIZER_MIN_CONFIDENCE) {
					indexedResults.push({
						originalIndex: item.originalIndex,
						result: {
							boxId: item.region.boxId,
							text: text.trim(),
							confidence
						}
					});
				}
			}
			decodeMs += performance.now() - decodeStarted;
		} finally {
			inputTensor.dispose();
			for (const tensor of new Set(outputTensors)) tensor.dispose();
		}
	};

	for (let start = 0; start < prepared.length; start += PPOCR_RECOGNIZER_MAX_BATCH_SIZE) {
		throwIfRecognizerCancelled(signal);
		const batch = prepared.slice(start, start + PPOCR_RECOGNIZER_MAX_BATCH_SIZE);
		const resultsBeforeBatch = indexedResults.length;
		try {
			await runBatch(batch);
		} catch (error) {
			throwIfRecognizerCancelled(signal);
			if (batch.length === 1) throw error;
			// Dynamic batching is supported by the official model, but retain a
			// correctness fallback for vendor/WebView runtime regressions.
			indexedResults.length = resultsBeforeBatch;
			fallbackBatches += 1;
			console.warn(`[ppocr-rec] batch-of-${batch.length} failed; retrying individually`);
			for (const item of batch) {
				throwIfRecognizerCancelled(signal);
				await runBatch([item]);
			}
		}
	}

	indexedResults.sort((a, b) => a.originalIndex - b.originalIndex);
	const results = indexedResults.map((item) => item.result);
	const metrics = {
		regions: regions.length,
		plannedBatches: Math.ceil(regions.length / PPOCR_RECOGNIZER_MAX_BATCH_SIZE),
		batchAttempts,
		fallbackBatches,
		preprocessingMs: Math.round(preprocessingMs * 100) / 100,
		inferenceMs: Math.round(inferenceMs * 100) / 100,
		decodeMs: Math.round(decodeMs * 100) / 100
	};
	console.warn(`[ppocr-rec] metrics ${JSON.stringify(metrics)}`);
	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__fumeto_last_ppocr_recognizer_metrics = metrics;
	}
	perfMark('ocr.recognize', preprocessingMs + inferenceMs + decodeMs, {
		regions: regions.length,
		batches: batchAttempts,
		inference: inferenceMs,
		decode: decodeMs
	});
	return results;
}

/** Recognize with an explicit backend selector and a single direct WASM fallback. */
export async function recognizeTextRegions(
	imageBlob: Blob,
	regions: DetectedTextRegion[],
	options: PPOcrRecognizerRunOptions = {}
): Promise<RecognitionResult[]> {
	const backend = options.backend ?? 'auto';
	const config = options.nativeConfig ?? DEFAULT_NATIVE_PPOCR_RECOGNIZER_CONFIG;
	const quarantineKey = nativeConfigKey(config);
	const shouldTryNative =
		backend !== 'wasm' &&
		isNativePPOcrRecognizerAvailable() &&
		(backend === 'native' || !nativeFailureQuarantine.has(quarantineKey));
	if (shouldTryNative) {
		try {
			const result = await recognizeTextRegionsNative(imageBlob, regions, {
				config,
				signal: options.signal
			});
			nativeFailureQuarantine.delete(quarantineKey);
			logNativeRecognizerMetrics(result);
			return result.results;
		} catch (error) {
			throwIfRecognizerCancelled(options.signal);
			if (backend === 'native') throw error;
			nativeFailureQuarantine.add(quarantineKey);
			console.warn('[ppocr-rec] Native recognition failed; using WASM', error);
		}
	} else if (backend === 'native') {
		throw new Error('Native PP-OCR recognizer is unavailable');
	}
	return recognizeTextRegionsWasm(imageBlob, regions, options.signal);
}

/**
 * Check if the recognizer model is loaded.
 */
export function isRecognizerReady(): boolean {
	return session !== null || getNativePPOcrRuntimeInfo().recognizer?.sessionLoaded === true;
}

/**
 * Release the recognizer model and its WASM heap allocation.
 * Call after batch recognition to minimize memory footprint.
 */
export async function releaseRecognizerWasm(): Promise<void> {
	if (session) {
		await session.release();
		session = null;
	}
	loading = null;
}

/** Release both independent recognizer backends and reset automatic-failure quarantine. */
export async function releaseRecognizer(): Promise<void> {
	await releaseRecognizerWasm();
	if (isNativePPOcrRecognizerAvailable()) {
		try {
			await releaseNativePPOcrRecognizer();
		} catch (error) {
			console.warn('[ppocr-rec] Native recognizer release failed', error);
		}
	}
	nativeFailureQuarantine.clear();
}

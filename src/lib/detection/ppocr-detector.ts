/**
 * PP-OCRv6 medium det — text region detection via Android ORT or ORT Web.
 *
 * Detects text regions on manga/comic pages and returns bounding boxes
 * in image-space pixel coordinates. Uses the official PP-OCRv6 medium det
 * ONNX model (~62 MB). Android prefers the native ONNX Runtime bridge; other
 * platforms and quarantined native configurations use the in-browser WASM path.
 *
 * The model is bundled in static/models/. ONNX Runtime Web assets used by the
 * fallback path are served from static/wasm/.
 *
 * The model uses DB (Differentiable Binarization) and outputs a probability
 * map which we threshold and extract contours from to get text region polygons.
 */

import type { DetectedTextComponent, DetectedTextRegion } from '$lib/types/index.js';
import {
	DEFAULT_NATIVE_PPOCR_DETECTOR_CONFIG,
	detectTextRegionsNative,
	getNativePPOcrRuntimeInfo,
	initializeNativePPOcr,
	isNativePPOcrAvailable,
	releaseNativePPOcr,
	type NativePPOcrConfig,
	type NativePPOcrDetection
} from './native-ppocr-detector.js';
import { ortWasmBaseUrl } from './ort-wasm-paths.js';
import { groupRawTextComponents } from './ppocr-grouping.js';
import { loadPPOcrWasmModelBuffer } from './ppocr-wasm-model-loader.js';

// Model path — bundled in static/models/
export const PPOCR_DETECTOR_MODEL_PATH = '/models/ppocr-det-v6-medium.onnx';

// DB post-processing parameters
// PP-OCRv6's published DB post-processing defaults. The lower map threshold
// lets adjacent strokes form a complete component; BOX_THRESHOLD still rejects
// weak components using their average probability.
const DETECTION_THRESHOLD = 0.2;
const BOX_THRESHOLD = 0.45;
const MIN_BOX_SIZE = 5; // minimum width/height in pixels
const MAX_CANDIDATES = 3000; // official PP-OCRv6 candidate cap
const DB_UNCLIP_RATIO = 1.4; // official PP-OCRv6 DB unclip setting

// A low-confidence component is never admitted alone. These deliberately
// narrow gates rescue only two mutually supporting pieces of one horizontal
// line, based on reviewed development annotations. Global DB thresholds remain
// authoritative for every other component.
const RESCUE_MIN_COMPONENT_MEAN = 0.34;
const RESCUE_MIN_COMPONENT_MAX = 0.55;
const RESCUE_MIN_FOREGROUND_PIXELS = 30;
const RESCUE_MIN_Y_OVERLAP = 0.72;
const RESCUE_MAX_X_GAP_IN_HEIGHTS = 2.1;
const RESCUE_MAX_HEIGHT_RATIO = 1.5;
const RESCUE_MIN_UNION_ASPECT = 4.5;
const RESCUE_MIN_WEIGHTED_MEAN = 0.38;
const RESCUE_MIN_PAIR_MAX = 0.65;

// Input image parameters.
// 960 is the floor, not a fixed size: full manga pages (commonly 2600-3000px
// tall) downscaled to a 960 longest edge fuse adjacent text columns into one
// DB component — the probability map itself merges, so no postprocessing
// threshold can split it and recognition of the fused block returns nothing
// (verified on a 1773x2880 page whose five columns fused at 576x960 input and
// separated cleanly at every input from 640x1024 up). Aim for the detector to
// see the page at >= ADAPTIVE_SCALE of native resolution, keeping small pages
// on the historical 960 and capping compute for very large scans; the fusion
// retry in fusion-guard.ts covers pages beyond the cap.
export const PPOCR_DETECTOR_TARGET_SIZE = 960; // minimum longest edge; multiple of 32
export const PPOCR_DETECTOR_MAX_TARGET_SIZE = 1536;
export const PPOCR_DETECTOR_ADAPTIVE_SCALE = 0.45;

/**
 * Longest-edge target for the detector input. Mirrored exactly by
 * PPOcrDetectorGeometry.targetSizeFor in the native Kotlin path — any change
 * here must change both, with the shared parity fixtures updated.
 */
export function ppocrDetectorTargetSize(longestEdge: number): number {
	return Math.min(
		PPOCR_DETECTOR_MAX_TARGET_SIZE,
		Math.max(
			PPOCR_DETECTOR_TARGET_SIZE,
			Math.ceil((longestEdge * PPOCR_DETECTOR_ADAPTIVE_SCALE) / 32) * 32
		)
	);
}

/**
 * Retry target when detection at the adaptive size still fused distinct text
 * blocks: native page resolution, bounded by the same compute cap. Never below
 * the adaptive target it escalates from.
 */
export function ppocrDetectorEscalatedTargetSize(longestEdge: number): number {
	return Math.min(
		PPOCR_DETECTOR_MAX_TARGET_SIZE,
		Math.max(ppocrDetectorTargetSize(longestEdge), Math.ceil(longestEdge / 32) * 32)
	);
}

export type PPOcrDetectorBackend = 'auto' | 'native' | 'wasm';

export interface PPOcrDetectorRunOptions {
	backend?: PPOcrDetectorBackend;
	nativeConfig?: NativePPOcrConfig;
	/** Caller will perform the one authoritative bubble/locale-aware grouping pass. */
	deferGrouping?: boolean;
	locale?: string;
	/** Cancels only this native callback; WASM observes it between async phases. */
	signal?: AbortSignal;
	/**
	 * Longest-edge detector input override, used by the fusion retry. Omitted:
	 * both backends derive the adaptive target from the page dimensions.
	 */
	targetLongestEdge?: number;
}

export type PPOcrComponentDisposition =
	| 'accepted'
	| 'rescued-horizontal-sequence'
	| 'too-small'
	| 'below-box-threshold'
	| 'candidate-cap';

export interface PPOcrRawComponentDiagnostic {
	componentId: number;
	disposition: PPOcrComponentDisposition;
	mapBounds: { x: number; y: number; width: number; height: number };
	imageBounds: { x: number; y: number; width: number; height: number };
	foregroundPixelCount: number;
	meanConfidence: number;
	maxConfidence: number;
}

export interface PPOcrComponentExtractionDiagnostics {
	mapThreshold: number;
	boxThreshold: number;
	minimumBoxSize: number;
	maximumCandidates: number;
	totalComponents: number;
	acceptedComponents: number;
	rescuedHorizontalSequenceComponents: number;
	rejectedTooSmall: number;
	rejectedBelowBoxThreshold: number;
	rejectedByCandidateCap: number;
	components: PPOcrRawComponentDiagnostic[];
}

export interface PPOcrBoxExtractionResult {
	regions: DetectedTextRegion[];
	diagnostics: PPOcrComponentExtractionDiagnostics;
}

interface ExtractedProbabilityComponent {
	componentId: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	pixelCount: number;
	scoreSum: number;
	maxScore: number;
	sumX: number;
	sumY: number;
	sumXX: number;
	sumYY: number;
	sumXY: number;
	componentPixels: number[];
}

interface HorizontalRescueCandidate {
	component: ExtractedProbabilityComponent;
	diagnosticIndex: number;
}

function throwIfDetectorCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('PP-OCR detection cancelled');
}

let ort: typeof import('onnxruntime-web/wasm') | null = null;
let session: import('onnxruntime-web/wasm').InferenceSession | null = null;
let loading: Promise<void> | null = null;
const nativeFailureQuarantine = new Set<string>();

/** Canonical backend-neutral grouping boundary for accepted detector components. */
export function groupDetectedComponents(
	rawRegions: DetectedTextRegion[],
	imageWidth: number,
	imageHeight: number,
	signal?: AbortSignal,
	locale?: string
): DetectedTextRegion[] {
	return groupRawTextComponents(rawRegions, [], imageWidth, imageHeight, { signal, locale }).groups;
}

function nativeConfigFor(options: PPOcrDetectorRunOptions): NativePPOcrConfig {
	return options.nativeConfig ?? DEFAULT_NATIVE_PPOCR_DETECTOR_CONFIG;
}

function nativeConfigKey(config: NativePPOcrConfig): string {
	return `${config.provider}:${config.threads}`;
}

function shouldTryNativeDetector(
	backend: PPOcrDetectorBackend,
	config: NativePPOcrConfig
): boolean {
	return (
		backend !== 'wasm' &&
		isNativePPOcrAvailable() &&
		(backend === 'native' || !nativeFailureQuarantine.has(nativeConfigKey(config)))
	);
}

function roundedMs(durationMs: number): number {
	return Math.round(durationMs * 100) / 100;
}

function logDetectorMetrics(metrics: {
	mode: 'merged' | 'raw-and-merged';
	inputWidth: number;
	inputHeight: number;
	rawRegions: number;
	mergedRegions: number;
	initializationMs: number;
	preprocessingMs: number;
	inferenceMs: number;
	postprocessingMs: number;
	totalMs: number;
}): void {
	// Keep diagnostics safe for production logs: dimensions, counts, and timings
	// only. Never include the image source, probability values, or recognized text.
	const sanitized = {
		...metrics,
		initializationMs: roundedMs(metrics.initializationMs),
		preprocessingMs: roundedMs(metrics.preprocessingMs),
		inferenceMs: roundedMs(metrics.inferenceMs),
		postprocessingMs: roundedMs(metrics.postprocessingMs),
		totalMs: roundedMs(metrics.totalMs)
	};
	console.warn(`[ppocr-det] metrics ${JSON.stringify(sanitized)}`);
	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__fumeto_last_ppocr_detector_metrics = sanitized;
	}
}

function logNativeDetectorMetrics(
	result: NativePPOcrDetection,
	mode: 'merged' | 'raw-and-merged'
): void {
	const metrics = {
		mode,
		backend: 'native-android',
		provider: result.metrics.provider,
		requestedProvider: result.metrics.requestedProvider,
		providerFallback: result.metrics.providerFallback,
		providerFallbackReason: result.metrics.providerFallbackReason,
		threads: result.metrics.threads,
		ortIntraOpThreads: result.metrics.ortIntraOpThreads,
		xnnpackIntraOpThreads: result.metrics.xnnpackIntraOpThreads,
		cpuFallbackEnabled: result.metrics.cpuFallbackEnabled,
		modelAsset: result.metrics.modelAsset,
		modelSha256: result.metrics.modelSha256,
		modelBytes: result.metrics.modelBytes,
		packagedModelBytes: result.metrics.packagedModelBytes,
		ortVersion: result.metrics.ortVersion,
		inputWidth: result.metrics.inputWidth,
		inputHeight: result.metrics.inputHeight,
		rawRegions: result.rawRegions.length,
		mergedRegions: result.mergedRegions.length,
		initializationMs:
			result.metrics.modelPreparationMs + result.metrics.sessionInitializationMs,
		preprocessingMs: result.metrics.decodeMs + result.metrics.preprocessingMs,
		inferenceMs: result.metrics.inferenceMs,
		postprocessingMs: result.metrics.postprocessingMs,
		totalMs: result.metrics.totalMs,
		nativeHeapDeltaBytes: result.metrics.nativeHeapDeltaBytes,
		javaHeapDeltaBytes: result.metrics.javaHeapDeltaBytes
	};
	console.warn(`[ppocr-det] metrics ${JSON.stringify(metrics)}`);
	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__fumeto_last_ppocr_detector_metrics = metrics;
	}
}

/** Convert canvas RGBA pixels to the detector's normalized BGR CHW tensor. */
export function imageDataToDetectorTensor(imageData: ImageData): Float32Array {
	const { width, height, data: pixels } = imageData;
	const mean = [0.485, 0.456, 0.406];
	const std = [0.229, 0.224, 0.225];
	const planeSize = width * height;
	const chw = new Float32Array(3 * planeSize);
	for (let i = 0; i < planeSize; i++) {
		// PP-OCRv6 detector inference.yml specifies DecodeImage.img_mode=BGR.
		chw[i] = (pixels[i * 4 + 2] / 255.0 - mean[0]) / std[0]; // B
		chw[planeSize + i] = (pixels[i * 4 + 1] / 255.0 - mean[1]) / std[1]; // G
		chw[2 * planeSize + i] = (pixels[i * 4] / 255.0 - mean[2]) / std[2]; // R
	}
	return chw;
}

/**
 * Initialize ONNX Runtime and load the detection model.
 * Model is loaded from the bundled static asset.
 */
export async function initDetectorWasm(): Promise<void> {
	if (session) return;
	if (loading) return loading;

	loading = (async () => {
		ort = await import('onnxruntime-web/wasm');
		ort.env.wasm.wasmPaths = ortWasmBaseUrl();
		ort.env.wasm.proxy = false;
		ort.env.wasm.numThreads = 1;

		// Android builds prune this model from the web bundle (native ORT owns
		// det/rec there); the loader falls back to the APK's native asset copy
		// so WASM remains a working rescue path on-device.
		const modelBuffer = await loadPPOcrWasmModelBuffer(PPOCR_DETECTOR_MODEL_PATH, 'detector');

		session = await ort.InferenceSession.create(modelBuffer, {
			executionProviders: ['wasm']
		});
	})();

	try {
		await loading;
	} catch (err) {
		// A transient asset/runtime failure must not permanently poison future calls.
		loading = null;
		session = null;
		throw err;
	}
}

/** Initialize the selected detector, falling back to authoritative WASM once in auto mode. */
export async function initDetector(options: PPOcrDetectorRunOptions = {}): Promise<void> {
	const backend = options.backend ?? 'auto';
	const config = nativeConfigFor(options);
	if (shouldTryNativeDetector(backend, config)) {
		try {
			await initializeNativePPOcr(config, options.signal);
			nativeFailureQuarantine.delete(nativeConfigKey(config));
			return;
		} catch (error) {
			throwIfDetectorCancelled(options.signal);
			if (backend === 'native') throw error;
			nativeFailureQuarantine.add(nativeConfigKey(config));
			console.warn('[ppocr-det] Native initialization failed; using WASM', error);
		}
	} else if (backend === 'native') {
		throw new Error('Native PP-OCR detector is unavailable');
	}
	throwIfDetectorCancelled(options.signal);
	await initDetectorWasm();
	throwIfDetectorCancelled(options.signal);
}

/**
 * Detect text regions in an image.
 *
 * @param imageBlob - Page image as Blob
 * @returns Array of detected text regions with bounding boxes
 */
export async function detectTextRegionsWasm(
	imageBlob: Blob,
	signal?: AbortSignal,
	locale?: string,
	targetLongestEdge?: number
): Promise<DetectedTextRegion[]> {
	throwIfDetectorCancelled(signal);
	const totalStarted = performance.now();
	const initializationStarted = totalStarted;
	if (!session || !ort) {
		await initDetectorWasm();
	}
	throwIfDetectorCancelled(signal);
	if (!session || !ort) throw new Error('Detector not initialized');
	const initializationMs = performance.now() - initializationStarted;

	const preprocessingStarted = performance.now();
	const bitmap = await createImageBitmap(imageBlob);
	if (signal?.aborted) {
		bitmap.close();
		throwIfDetectorCancelled(signal);
	}
	const origW = bitmap.width;
	const origH = bitmap.height;

	// Resize to the adaptive longest-edge target, keeping aspect ratio, round to multiple of 32
	const scale = (targetLongestEdge ?? ppocrDetectorTargetSize(Math.max(origW, origH))) / Math.max(origW, origH);
	const resizedW = Math.round((origW * scale) / 32) * 32 || 32;
	const resizedH = Math.round((origH * scale) / 32) * 32 || 32;

	// Draw resized image
	const canvas = new OffscreenCanvas(resizedW, resizedH);
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(bitmap, 0, 0, resizedW, resizedH);
	bitmap.close();

	const imageData = ctx.getImageData(0, 0, resizedW, resizedH);

	// Normalize to CHW float32 tensor: (1, 3, H, W)
	// PaddleOCR normalization: (pixel / 255.0 - mean) / std
	const chw = imageDataToDetectorTensor(imageData);

	const inputTensor = new ort.Tensor('float32', chw, [1, 3, resizedH, resizedW]);
	const preprocessingMs = performance.now() - preprocessingStarted;
	let outputTensors: import('onnxruntime-web/wasm').Tensor[] = [];
	try {
		// Run inference (use dynamic input name for model compatibility)
		const inputName = session.inputNames?.[0] ?? 'x';
		const inferenceStarted = performance.now();
		const results = await session.run({ [inputName]: inputTensor });
		throwIfDetectorCancelled(signal);
		const inferenceMs = performance.now() - inferenceStarted;
		outputTensors = Object.values(results);

		const postprocessingStarted = performance.now();
		// The output is a probability map: shape (1, 1, H, W)
		const outputKeys = Object.keys(results);
		if (outputKeys.length === 0) throw new Error('PP-OCR model returned no outputs');
		const outputTensor = results[outputKeys[0]];
		if (!outputTensor || !outputTensor.data) throw new Error('PP-OCR output tensor is empty');
		const probMap = outputTensor.data as Float32Array;
		if (probMap.length !== resizedW * resizedH) {
			throw new Error(
				`PP-OCR output size mismatch: expected ${resizedW * resizedH}, got ${probMap.length}`
			);
		}

		const scaleX = origW / resizedW;
		const scaleY = origH / resizedH;
		const rawRegions = extractBoxesFromProbMap(probMap, resizedW, resizedH, scaleX, scaleY);
		const mergedRegions = groupDetectedComponents(rawRegions, origW, origH, signal, locale);
		const postprocessingMs = performance.now() - postprocessingStarted;
		logDetectorMetrics({
			mode: 'merged',
			inputWidth: resizedW,
			inputHeight: resizedH,
			rawRegions: rawRegions.length,
			mergedRegions: mergedRegions.length,
			initializationMs,
			preprocessingMs,
			inferenceMs,
			postprocessingMs,
			totalMs: performance.now() - totalStarted
		});
		return mergedRegions;
	} finally {
		inputTensor.dispose();
		for (const tensor of new Set(outputTensors)) tensor.dispose();
	}
}

/** Detect merged regions with an explicit backend selector and one-shot auto fallback. */
export async function detectTextRegions(
	imageBlob: Blob,
	options: PPOcrDetectorRunOptions = {}
): Promise<DetectedTextRegion[]> {
	const backend = options.backend ?? 'auto';
	const config = nativeConfigFor(options);
	if (shouldTryNativeDetector(backend, config)) {
		try {
			const result = await detectTextRegionsNative(imageBlob, {
				config,
				signal: options.signal,
				targetLongestEdge: options.targetLongestEdge
			});
			nativeFailureQuarantine.delete(nativeConfigKey(config));
			const grouped = groupDetectedComponents(
				result.rawRegions,
				result.imageWidth,
				result.imageHeight,
				options.signal,
				options.locale
			);
			logNativeDetectorMetrics({ ...result, mergedRegions: grouped }, 'merged');
			return grouped;
		} catch (error) {
			throwIfDetectorCancelled(options.signal);
			if (backend === 'native') throw error;
			nativeFailureQuarantine.add(nativeConfigKey(config));
			console.warn('[ppocr-det] Native detection failed; using WASM', error);
		}
	} else if (backend === 'native') {
		throw new Error('Native PP-OCR detector is unavailable');
	}
	return detectTextRegionsWasm(imageBlob, options.signal, options.locale, options.targetLongestEdge);
}

/**
 * Extract bounding boxes from the DB probability map.
 *
 * 1. Threshold the probability map to binary
 * 2. Find eight-connected components (simple flood fill)
 * 3. Compute oriented component polygons using second moments
 * 4. Filter by size and average score
 */
function componentWidth(component: ExtractedProbabilityComponent): number {
	return component.maxX - component.minX + 1;
}

function componentHeight(component: ExtractedProbabilityComponent): number {
	return component.maxY - component.minY + 1;
}

function buildDetectedComponent(
	component: ExtractedProbabilityComponent,
	width: number,
	height: number,
	scaleX: number,
	scaleY: number
): DetectedTextComponent {
	const meanX = component.sumX / component.pixelCount;
	const meanY = component.sumY / component.pixelCount;
	const covarianceXX = component.sumXX / component.pixelCount - meanX * meanX;
	const covarianceYY = component.sumYY / component.pixelCount - meanY * meanY;
	const covarianceXY = component.sumXY / component.pixelCount - meanX * meanY;
	const angle = Math.abs(covarianceXX - covarianceYY) < 1e-6 && Math.abs(covarianceXY) < 1e-6
		? 0
		: 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY);
	const axisX = Math.cos(angle);
	const axisY = Math.sin(angle);
	const normalX = -axisY;
	const normalY = axisX;
	let minimumAxis = Infinity;
	let maximumAxis = -Infinity;
	let minimumNormal = Infinity;
	let maximumNormal = -Infinity;
	for (const pixel of component.componentPixels) {
		const px = pixel % width;
		const py = Math.floor(pixel / width);
		const along = px * axisX + py * axisY;
		const across = px * normalX + py * normalY;
		minimumAxis = Math.min(minimumAxis, along);
		maximumAxis = Math.max(maximumAxis, along);
		minimumNormal = Math.min(minimumNormal, across);
		maximumNormal = Math.max(maximumNormal, across);
	}

	const mapWidth = componentWidth(component);
	const mapHeight = componentHeight(component);
	const unclipDistance = (mapWidth * mapHeight * DB_UNCLIP_RATIO) / (2 * (mapWidth + mapHeight));
	minimumAxis -= unclipDistance;
	maximumAxis += unclipDistance + 1;
	minimumNormal -= unclipDistance;
	maximumNormal += unclipDistance + 1;
	const mapCorners = [
		[minimumAxis, minimumNormal],
		[maximumAxis, minimumNormal],
		[maximumAxis, maximumNormal],
		[minimumAxis, maximumNormal]
	] as const;
	const polygon = mapCorners.map(([along, across]) => [
		Math.round(Math.max(0, Math.min(width, along * axisX + across * normalX)) * scaleX),
		Math.round(Math.max(0, Math.min(height, along * axisY + across * normalY)) * scaleY)
	] as [number, number]);
	const polygonXs = polygon.map(([px]) => px);
	const polygonYs = polygon.map(([, py]) => py);
	const outputMinX = Math.max(0, Math.min(...polygonXs));
	const outputMinY = Math.max(0, Math.min(...polygonYs));
	const outputMaxX = Math.min(Math.round(width * scaleX), Math.max(...polygonXs));
	const outputMaxY = Math.min(Math.round(height * scaleY), Math.max(...polygonYs));
	const firstEdgeX = polygon[1][0] - polygon[0][0];
	const firstEdgeY = polygon[1][1] - polygon[0][1];
	let orientationDegrees = Math.atan2(firstEdgeY, firstEdgeX) * 180 / Math.PI;
	while (orientationDegrees >= 90) orientationDegrees -= 180;
	while (orientationDegrees < -90) orientationDegrees += 180;
	// Android's wire contract stores this value as a Kotlin Float. Quantize at
	// the shared detector boundary so a rotated component has the same durable
	// source geometry (and therefore the same V2 source/entry/item IDs) whether
	// detection ran through native ORT or the browser/WASM fallback.
	orientationDegrees = Math.fround(orientationDegrees);
	const confidence = Math.fround(component.scoreSum / component.pixelCount);
	return {
		componentId: component.componentId,
		x: outputMinX,
		y: outputMinY,
		width: Math.max(1, outputMaxX - outputMinX),
		height: Math.max(1, outputMaxY - outputMinY),
		confidence,
		polygon,
		orientationDegrees,
		foregroundPixelCount: component.pixelCount,
		meanConfidence: confidence,
		maxConfidence: component.maxScore
	};
}

/**
 * Keep one recognizer crop while retaining the exact geometry of every raw
 * component that contributed to it. This matters for the deliberately narrow
 * two-component rescue: durable V2 sources own component polygons, not the
 * larger union crop used by the recognizer.
 */
function buildDetectedRegion(
	cropComponent: ExtractedProbabilityComponent,
	sourceComponents: ExtractedProbabilityComponent[],
	width: number,
	height: number,
	scaleX: number,
	scaleY: number
): DetectedTextRegion {
	const crop = buildDetectedComponent(cropComponent, width, height, scaleX, scaleY);
	const sources = [...sourceComponents]
		.sort((left, right) => left.componentId - right.componentId)
		.map((component) => buildDetectedComponent(component, width, height, scaleX, scaleY));
	if (!sources.length || new Set(sources.map((component) => component.componentId)).size !== sources.length) {
		throw new TypeError('Detected PP-OCR crop must contain unique source components');
	}
	return {
		boxId: sources[0].componentId,
		x: crop.x,
		y: crop.y,
		width: crop.width,
		height: crop.height,
		confidence: crop.confidence,
		polygon: crop.polygon,
		orientationDegrees: crop.orientationDegrees,
		sourceComponents: sources,
		sourceComponentIds: sources.map((component) => component.componentId),
		foregroundPixelCount: crop.foregroundPixelCount,
		meanConfidence: crop.meanConfidence,
		maxConfidence: crop.maxConfidence
	};
}

function qualifiesHorizontalRescuePair(
	leftValue: ExtractedProbabilityComponent,
	rightInput: ExtractedProbabilityComponent
): boolean {
	const [left, rightValue] = leftValue.minX < rightInput.minX
		|| leftValue.minX === rightInput.minX && leftValue.componentId < rightInput.componentId
		? [leftValue, rightInput]
		: [rightInput, leftValue];
	if (rightValue.minX <= left.minX) return false;
	const leftHeight = componentHeight(left);
	const rightHeight = componentHeight(rightValue);
	const yOverlap = Math.max(0, Math.min(left.maxY, rightValue.maxY) - Math.max(left.minY, rightValue.minY) + 1);
	const yOverlapRatio = yOverlap / Math.max(1, Math.min(leftHeight, rightHeight));
	const xGap = Math.max(0, rightValue.minX - left.maxX - 1);
	const heightRatio = Math.max(leftHeight, rightHeight) / Math.max(1, Math.min(leftHeight, rightHeight));
	const unionWidth = Math.max(left.maxX, rightValue.maxX) - Math.min(left.minX, rightValue.minX) + 1;
	const unionHeight = Math.max(left.maxY, rightValue.maxY) - Math.min(left.minY, rightValue.minY) + 1;
	const weightedMean = (left.scoreSum + rightValue.scoreSum) / (left.pixelCount + rightValue.pixelCount);
	return yOverlapRatio >= RESCUE_MIN_Y_OVERLAP
		&& xGap <= Math.max(leftHeight, rightHeight) * RESCUE_MAX_X_GAP_IN_HEIGHTS
		&& heightRatio <= RESCUE_MAX_HEIGHT_RATIO
		&& unionWidth / Math.max(1, unionHeight) >= RESCUE_MIN_UNION_ASPECT
		&& weightedMean >= RESCUE_MIN_WEIGHTED_MEAN
		&& Math.max(left.maxScore, rightValue.maxScore) >= RESCUE_MIN_PAIR_MAX;
}

function combineProbabilityComponents(
	left: ExtractedProbabilityComponent,
	rightValue: ExtractedProbabilityComponent
): ExtractedProbabilityComponent {
	return {
		componentId: Math.min(left.componentId, rightValue.componentId),
		minX: Math.min(left.minX, rightValue.minX),
		maxX: Math.max(left.maxX, rightValue.maxX),
		minY: Math.min(left.minY, rightValue.minY),
		maxY: Math.max(left.maxY, rightValue.maxY),
		pixelCount: left.pixelCount + rightValue.pixelCount,
		scoreSum: left.scoreSum + rightValue.scoreSum,
		maxScore: Math.max(left.maxScore, rightValue.maxScore),
		sumX: left.sumX + rightValue.sumX,
		sumY: left.sumY + rightValue.sumY,
		sumXX: left.sumXX + rightValue.sumXX,
		sumYY: left.sumYY + rightValue.sumYY,
		sumXY: left.sumXY + rightValue.sumXY,
		componentPixels: [...left.componentPixels, ...rightValue.componentPixels]
	};
}

export function extractBoxesWithDiagnosticsFromProbMap(
	probMap: Float32Array,
	width: number,
	height: number,
	scaleX: number,
	scaleY: number
): PPOcrBoxExtractionResult {
	// Step 1: Binarize
	const binary = new Uint8Array(width * height);
	for (let i = 0; i < probMap.length; i++) {
		binary[i] = probMap[i] > DETECTION_THRESHOLD ? 1 : 0;
	}

	// Step 2: Find connected components via flood fill
	const visited = new Uint8Array(width * height);
	const regions: DetectedTextRegion[] = [];
	const componentDiagnostics: PPOcrRawComponentDiagnostic[] = [];
	const horizontalRescueCandidates: HorizontalRescueCandidate[] = [];
	let componentId = 0;
	let acceptedCount = 0;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			if (binary[idx] === 0 || visited[idx]) continue;
			componentId += 1;

			// Flood fill preserves enough evidence to derive PCA orientation and
			// an oriented quadrilateral. IDs are scan-order component IDs and are
			// assigned before filtering, so accepted lineage remains stable.
			let minX = x,
				maxX = x,
				minY = y,
				maxY = y;
			let scoreSum = 0;
			let maxScore = 0;
			let count = 0;
			let sumX = 0;
			let sumY = 0;
			let sumXX = 0;
			let sumYY = 0;
			let sumXY = 0;
			const componentPixels: number[] = [];
			const stack = [idx];
			visited[idx] = 1;

			while (stack.length > 0) {
				const ci = stack.pop()!;
				const cx = ci % width;
				const cy = Math.floor(ci / width);
				scoreSum += probMap[ci];
				maxScore = Math.max(maxScore, probMap[ci]);
				count++;
				sumX += cx;
				sumY += cy;
				sumXX += cx * cx;
				sumYY += cy * cy;
				sumXY += cx * cy;
				componentPixels.push(ci);

				if (cx < minX) minX = cx;
				if (cx > maxX) maxX = cx;
				if (cy < minY) minY = cy;
				if (cy > maxY) maxY = cy;

				// Eight-connected components retain diagonally joined strokes.
				for (let dy = -1; dy <= 1; dy += 1) {
					for (let dx = -1; dx <= 1; dx += 1) {
						if (dx === 0 && dy === 0) continue;
						const nx = cx + dx;
						const ny = cy + dy;
						if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
						const neighbor = ny * width + nx;
						if (visited[neighbor] || binary[neighbor] === 0) continue;
						visited[neighbor] = 1;
						stack.push(neighbor);
					}
				}
			}

			if (count === 0) continue;

			const bw = maxX - minX + 1;
			const bh = maxY - minY + 1;
			const averageScoreForThreshold = scoreSum / count;
			// Native transports Float32 confidence values. Quantize the accepted
			// evidence identically so native and WASM documents hash the same while
			// retaining the unrounded average for the DB box-threshold decision.
			const avgScore = Math.fround(averageScoreForThreshold);
			const imageBounds = {
				x: Math.round(minX * scaleX),
				y: Math.round(minY * scaleY),
				width: Math.max(1, Math.round(bw * scaleX)),
				height: Math.max(1, Math.round(bh * scaleY))
			};
			const diagnosticBase = {
				componentId,
				mapBounds: { x: minX, y: minY, width: bw, height: bh },
				imageBounds,
				foregroundPixelCount: count,
				meanConfidence: avgScore,
				maxConfidence: maxScore
			};
			const extractedComponent: ExtractedProbabilityComponent = {
				componentId,
				minX,
				maxX,
				minY,
				maxY,
				pixelCount: count,
				scoreSum,
				maxScore,
				sumX,
				sumY,
				sumXX,
				sumYY,
				sumXY,
				componentPixels
			};

			// Filter: too small or low confidence
			if (bw < MIN_BOX_SIZE || bh < MIN_BOX_SIZE) {
				componentDiagnostics.push({ ...diagnosticBase, disposition: 'too-small' });
				continue;
			}
			if (averageScoreForThreshold < BOX_THRESHOLD) {
				const diagnosticIndex = componentDiagnostics.length;
				componentDiagnostics.push({ ...diagnosticBase, disposition: 'below-box-threshold' });
				if (averageScoreForThreshold >= RESCUE_MIN_COMPONENT_MEAN
					&& maxScore >= RESCUE_MIN_COMPONENT_MAX
					&& count >= RESCUE_MIN_FOREGROUND_PIXELS
				) {
					horizontalRescueCandidates.push({ component: extractedComponent, diagnosticIndex });
				}
				continue;
			}
			if (acceptedCount >= MAX_CANDIDATES) {
				componentDiagnostics.push({ ...diagnosticBase, disposition: 'candidate-cap' });
				continue;
			}

			acceptedCount += 1;
			componentDiagnostics.push({ ...diagnosticBase, disposition: 'accepted' });
			regions.push(buildDetectedRegion(
				extractedComponent,
				[extractedComponent],
				width,
				height,
				scaleX,
				scaleY
			));
		}
	}

	// Candidate IDs are scan-order stable. Greedy lexicographic matching makes
	// the selected pairs byte-deterministic and prevents one weak component from
	// being admitted through multiple neighbours.
	const usedRescueIds = new Set<number>();
	for (let leftIndex = 0; leftIndex < horizontalRescueCandidates.length; leftIndex += 1) {
		const left = horizontalRescueCandidates[leftIndex];
		if (usedRescueIds.has(left.component.componentId)) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < horizontalRescueCandidates.length; rightIndex += 1) {
			const rightValue = horizontalRescueCandidates[rightIndex];
			if (usedRescueIds.has(rightValue.component.componentId)
				|| !qualifiesHorizontalRescuePair(left.component, rightValue.component)
			) continue;
			usedRescueIds.add(left.component.componentId);
			usedRescueIds.add(rightValue.component.componentId);
			if (acceptedCount + 2 > MAX_CANDIDATES) {
				componentDiagnostics[left.diagnosticIndex].disposition = 'candidate-cap';
				componentDiagnostics[rightValue.diagnosticIndex].disposition = 'candidate-cap';
				break;
			}
			const combined = combineProbabilityComponents(left.component, rightValue.component);
			componentDiagnostics[left.diagnosticIndex].disposition = 'rescued-horizontal-sequence';
			componentDiagnostics[rightValue.diagnosticIndex].disposition = 'rescued-horizontal-sequence';
			regions.push(buildDetectedRegion(
				combined,
				[left.component, rightValue.component],
				width,
				height,
				scaleX,
				scaleY
			));
			acceptedCount += 2;
			break;
		}
	}

	// Sort by confidence descending
	regions.sort((a, b) => b.confidence - a.confidence);

	return {
		regions,
		diagnostics: {
			mapThreshold: DETECTION_THRESHOLD,
			boxThreshold: BOX_THRESHOLD,
			minimumBoxSize: MIN_BOX_SIZE,
			maximumCandidates: MAX_CANDIDATES,
			totalComponents: componentDiagnostics.length,
			acceptedComponents: componentDiagnostics.filter((item) =>
				item.disposition === 'accepted' || item.disposition === 'rescued-horizontal-sequence'
			).length,
			rescuedHorizontalSequenceComponents: componentDiagnostics.filter((item) =>
				item.disposition === 'rescued-horizontal-sequence'
			).length,
			rejectedTooSmall: componentDiagnostics.filter((item) => item.disposition === 'too-small').length,
			rejectedBelowBoxThreshold: componentDiagnostics.filter((item) =>
				item.disposition === 'below-box-threshold'
			).length,
			rejectedByCandidateCap: componentDiagnostics.filter((item) => item.disposition === 'candidate-cap').length,
			components: componentDiagnostics
		}
	};
}

/** Backward-compatible accepted-region view used by production detector callers. */
export function extractBoxesFromProbMap(
	probMap: Float32Array,
	width: number,
	height: number,
	scaleX: number,
	scaleY: number
): DetectedTextRegion[] {
	return extractBoxesWithDiagnosticsFromProbMap(probMap, width, height, scaleX, scaleY).regions;
}

/**
 * Merge nearby detected regions into logical text blocks.
 *
 * PP-OCR detects individual text lines — for vertical Japanese manga text,
 * a speech bubble with 3 columns produces 3+ narrow boxes. This function
 * merges overlapping or nearby boxes into larger unified regions, then
 * adds padding so the overlay comfortably covers the original text.
 *
 * Guards against over-merging:
 * - Small gap threshold (1.5% of image size) limits merge distance
 * - Max merged area cap (12% of image) prevents runaway snowball merges
 * - Fill ratio check ensures the union box isn't mostly empty space
 */
export function mergeNearbyRegions(
	regions: DetectedTextRegion[],
	imageWidth: number,
	imageHeight: number,
	gapFraction?: number
): DetectedTextRegion[] {
	if (regions.length <= 1) return regions;

	// Gap threshold: merge boxes within this pixel distance of each other.
	// Default 1.0% of image size. Callers can override via gapFraction
	// (e.g., larger for within-bubble, smaller for loose SFX).
	const gap = Math.max(imageWidth, imageHeight) * (gapFraction ?? 0.01);

	// Maximum area a merged box can occupy (12% of image area).
	// Prevents snowball merges that swallow entire panels.
	const maxMergedArea = imageWidth * imageHeight * 0.12;

	// Minimum fill ratio: combined area of the two boxes must be at least
	// this fraction of the union bounding box area. Prevents merging two
	// small boxes that are far apart (union would be mostly empty).
	const minFillRatio = 0.25;

	// Work with x1/y1/x2/y2 for easier overlap math
	let boxes = regions.map((r) => ({
		x1: r.x,
		y1: r.y,
		x2: r.x + r.width,
		y2: r.y + r.height,
		confidence: r.confidence
	}));

	// Iterative pairwise merge: keep merging until stable
	let merged = true;
	while (merged) {
		merged = false;
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				// Two boxes are "nearby" if the gap between them is ≤ threshold
				if (
					boxes[i].x1 - gap <= boxes[j].x2 &&
					boxes[j].x1 - gap <= boxes[i].x2 &&
					boxes[i].y1 - gap <= boxes[j].y2 &&
					boxes[j].y1 - gap <= boxes[i].y2
				) {
					// Compute candidate union box
					const ux1 = Math.min(boxes[i].x1, boxes[j].x1);
					const uy1 = Math.min(boxes[i].y1, boxes[j].y1);
					const ux2 = Math.max(boxes[i].x2, boxes[j].x2);
					const uy2 = Math.max(boxes[i].y2, boxes[j].y2);
					const unionArea = (ux2 - ux1) * (uy2 - uy1);

					// Guard: don't merge if result is too large
					if (unionArea > maxMergedArea) continue;

					// Guard: don't merge if the two boxes are small relative
					// to the union (indicates a large gap between them)
					const areaI = (boxes[i].x2 - boxes[i].x1) * (boxes[i].y2 - boxes[i].y1);
					const areaJ = (boxes[j].x2 - boxes[j].x1) * (boxes[j].y2 - boxes[j].y1);
					if ((areaI + areaJ) / unionArea < minFillRatio) continue;

					// Merge into union bounding box
					boxes[i] = {
						x1: ux1,
						y1: uy1,
						x2: ux2,
						y2: uy2,
						confidence: Math.max(boxes[i].confidence, boxes[j].confidence)
					};
					boxes.splice(j, 1);
					merged = true;
					break;
				}
			}
			if (merged) break;
		}
	}

	// Sort by manga reading order: top-to-bottom first, then right-to-left
	// within each horizontal band. This ensures narration boxes at the top
	// of the page are read before speech bubbles lower down, regardless of
	// horizontal position.
	//
	// Step 1: Sort by vertical center
	const vertSorted = [...boxes].sort((a, b) => (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2);

	// Step 2: Group into horizontal rows — boxes within 20% of image height
	// of the running row average are considered the same row
	const rowThreshold = imageHeight * 0.2;
	const rows: (typeof boxes)[] = [];
	for (const box of vertSorted) {
		const cy = (box.y1 + box.y2) / 2;
		const lastRow = rows[rows.length - 1];
		if (lastRow) {
			const rowAvgY = lastRow.reduce((s, b) => s + (b.y1 + b.y2) / 2, 0) / lastRow.length;
			if (Math.abs(cy - rowAvgY) < rowThreshold) {
				lastRow.push(box);
				continue;
			}
		}
		rows.push([box]);
	}

	// Step 3: Within each row, sort right-to-left (manga reading order)
	for (const row of rows) {
		row.sort((a, b) => (b.x1 + b.x2) / 2 - (a.x1 + a.x2) / 2);
	}

	// Step 4: Flatten back (rows already in top-to-bottom order)
	boxes.length = 0;
	for (const row of rows) boxes.push(...row);

	// Convert back to DetectedTextRegion with light padding and dimension caps.
	// Caps are generous — merge guards (max area, fill ratio) already prevent
	// runaway merges, so these are just a safety net.
	const maxW = imageWidth * 0.4;
	const maxH = imageHeight * 0.45;

	return boxes.map((b, i) => {
		let w = b.x2 - b.x1;
		let h = b.y2 - b.y1;
		const padX = w * 0.04;
		const padY = h * 0.03;
		w = Math.min(w + padX * 2, maxW);
		h = Math.min(h + padY * 2, maxH);
		const cx = (b.x1 + b.x2) / 2;
		const cy = (b.y1 + b.y2) / 2;
		const x = Math.max(0, Math.round(cx - w / 2));
		const y = Math.max(0, Math.round(cy - h / 2));
		return {
			boxId: i + 1,
			x,
			y,
			width: Math.max(1, Math.min(imageWidth - x, Math.round(w))),
			height: Math.max(1, Math.min(imageHeight - y, Math.round(h))),
			confidence: b.confidence
		};
	});
}

/**
 * Detect text regions and return both raw text lines and merged overlay regions.
 *
 * Raw regions are individual text lines — ideal for per-line OCR recognition.
 * Merged regions combine nearby lines into speech-bubble-sized blocks — ideal for overlay display.
 *
 * @param imageBlob - Page image as Blob
 * @returns Raw text lines (for OCR) and merged regions (for overlay)
 */
export interface PPOcrDetectionWithRawResult {
	rawRegions: DetectedTextRegion[];
	mergedRegions: DetectedTextRegion[];
	imageWidth: number;
	imageHeight: number;
	/** Raw DB probability map (float32, one value per pixel at reduced resolution). Usable as a text segmentation mask for inpainting. */
	probMap: Float32Array;
	probMapWidth: number;
	probMapHeight: number;
	/** Stage attribution for every threshold-map component, including rejected ones. */
	componentDiagnostics: PPOcrComponentExtractionDiagnostics;
}

/** Authoritative force-WASM path used for fallback and backend equivalence. */
export async function detectTextRegionsWithRawWasm(
	imageBlob: Blob,
	signal?: AbortSignal,
	deferGrouping = false,
	locale?: string,
	targetLongestEdge?: number
): Promise<PPOcrDetectionWithRawResult> {
	throwIfDetectorCancelled(signal);
	const totalStarted = performance.now();
	const initializationStarted = totalStarted;
	if (!session || !ort) {
		await initDetectorWasm();
	}
	throwIfDetectorCancelled(signal);
	if (!session || !ort) throw new Error('Detector not initialized');
	const initializationMs = performance.now() - initializationStarted;

	const preprocessingStarted = performance.now();
	const bitmap = await createImageBitmap(imageBlob);
	if (signal?.aborted) {
		bitmap.close();
		throwIfDetectorCancelled(signal);
	}
	const origW = bitmap.width;
	const origH = bitmap.height;

	const scale = (targetLongestEdge ?? ppocrDetectorTargetSize(Math.max(origW, origH))) / Math.max(origW, origH);
	const resizedW = Math.round((origW * scale) / 32) * 32 || 32;
	const resizedH = Math.round((origH * scale) / 32) * 32 || 32;

	const canvas = new OffscreenCanvas(resizedW, resizedH);
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(bitmap, 0, 0, resizedW, resizedH);
	bitmap.close();

	const imageData = ctx.getImageData(0, 0, resizedW, resizedH);

	const chw = imageDataToDetectorTensor(imageData);

	const inputTensor = new ort.Tensor('float32', chw, [1, 3, resizedH, resizedW]);
	const preprocessingMs = performance.now() - preprocessingStarted;
	let outputTensors: import('onnxruntime-web/wasm').Tensor[] = [];
	try {
		const inputName = session.inputNames?.[0] ?? 'x';
		const inferenceStarted = performance.now();
		const results = await session.run({ [inputName]: inputTensor });
		throwIfDetectorCancelled(signal);
		const inferenceMs = performance.now() - inferenceStarted;
		outputTensors = Object.values(results);

		const postprocessingStarted = performance.now();
		const outputKeys = Object.keys(results);
		if (outputKeys.length === 0) throw new Error('PP-OCR model returned no outputs');
		const outputTensor = results[outputKeys[0]];
		if (!outputTensor || !outputTensor.data) throw new Error('PP-OCR output tensor is empty');
		const probMap = outputTensor.data as Float32Array;
		if (probMap.length !== resizedW * resizedH) {
			throw new Error(
				`PP-OCR output size mismatch: expected ${resizedW * resizedH}, got ${probMap.length}`
			);
		}

		const scaleX = origW / resizedW;
		const scaleY = origH / resizedH;
		const extracted = extractBoxesWithDiagnosticsFromProbMap(
			probMap,
			resizedW,
			resizedH,
			scaleX,
			scaleY
		);
		const rawRegions = extracted.regions;
		const probMapCopy = new Float32Array(probMap);
			const mergedRegions = deferGrouping
				? []
				: groupDetectedComponents(rawRegions, origW, origH, signal, locale);
		const postprocessingMs = performance.now() - postprocessingStarted;
		logDetectorMetrics({
			mode: 'raw-and-merged',
			inputWidth: resizedW,
			inputHeight: resizedH,
			rawRegions: rawRegions.length,
			mergedRegions: mergedRegions.length,
			initializationMs,
			preprocessingMs,
			inferenceMs,
			postprocessingMs,
			totalMs: performance.now() - totalStarted
		});

		return {
			rawRegions,
			mergedRegions,
			imageWidth: origW,
			imageHeight: origH,
			probMap: probMapCopy,
			probMapWidth: resizedW,
			probMapHeight: resizedH,
			componentDiagnostics: extracted.diagnostics
		};
	} finally {
		inputTensor.dispose();
		for (const tensor of new Set(outputTensors)) tensor.dispose();
	}
}

/**
 * Detect raw/merged regions plus the lossless DB map. Native map transfer uses
 * Float32 little-endian Base64, never a giant JSON numeric array.
 */
export async function detectTextRegionsWithRaw(
	imageBlob: Blob,
	options: PPOcrDetectorRunOptions = {}
): Promise<PPOcrDetectionWithRawResult> {
	const backend = options.backend ?? 'auto';
	const config = nativeConfigFor(options);
	if (shouldTryNativeDetector(backend, config)) {
		try {
			const result = await detectTextRegionsNative(imageBlob, {
				config,
				includeProbabilityMap: true,
				signal: options.signal
			});
			if (!result.probMap || !result.probMapWidth || !result.probMapHeight) {
				throw new Error('Native detector omitted the requested probability map');
			}
			nativeFailureQuarantine.delete(nativeConfigKey(config));
				const grouped = options.deferGrouping
					? []
					: groupDetectedComponents(
						result.rawRegions,
						result.imageWidth,
						result.imageHeight,
						options.signal,
						options.locale
					);
			const componentDiagnostics = extractBoxesWithDiagnosticsFromProbMap(
				result.probMap,
				result.probMapWidth,
				result.probMapHeight,
				result.imageWidth / result.probMapWidth,
				result.imageHeight / result.probMapHeight
			).diagnostics;
			logNativeDetectorMetrics({ ...result, mergedRegions: grouped }, 'raw-and-merged');
			return {
				rawRegions: result.rawRegions,
				mergedRegions: grouped,
				imageWidth: result.imageWidth,
				imageHeight: result.imageHeight,
				probMap: result.probMap,
				probMapWidth: result.probMapWidth,
				probMapHeight: result.probMapHeight,
				componentDiagnostics
			};
		} catch (error) {
			throwIfDetectorCancelled(options.signal);
			if (backend === 'native') throw error;
			nativeFailureQuarantine.add(nativeConfigKey(config));
			console.warn('[ppocr-det] Native map detection failed; using WASM', error);
		}
	} else if (backend === 'native') {
		throw new Error('Native PP-OCR detector is unavailable');
	}
	// Forward the caller's escalated size. Dropping it here meant a caller that
	// asked for a larger detection input silently got the adaptive default.
	// The native branch above cannot honour it: `detectImageWithProbabilityMap`
	// takes no target-size parameter, so an escalated with-map request there
	// still runs at the adaptive size until the Kotlin bridge grows one.
	return detectTextRegionsWithRawWasm(
		imageBlob,
		options.signal,
		options.deferGrouping,
		options.locale,
		options.targetLongestEdge
	);
}

export type PPOcrRecognitionDetection = Omit<
	PPOcrDetectionWithRawResult,
	'probMap' | 'probMapWidth' | 'probMapHeight' | 'componentDiagnostics'
>;

/** Boxes-only fast path for OCR recognition; no multi-megabyte map transfer. */
export async function detectTextRegionsForRecognition(
	imageBlob: Blob,
	options: PPOcrDetectorRunOptions = {}
): Promise<PPOcrRecognitionDetection> {
	const backend = options.backend ?? 'auto';
	const config = nativeConfigFor(options);
	if (shouldTryNativeDetector(backend, config)) {
		try {
			const result = await detectTextRegionsNative(imageBlob, {
				config,
				signal: options.signal,
				targetLongestEdge: options.targetLongestEdge
			});
			nativeFailureQuarantine.delete(nativeConfigKey(config));
				const grouped = options.deferGrouping
					? []
					: groupDetectedComponents(
						result.rawRegions,
						result.imageWidth,
						result.imageHeight,
						options.signal,
						options.locale
					);
			logNativeDetectorMetrics({ ...result, mergedRegions: grouped }, 'raw-and-merged');
			return {
				rawRegions: result.rawRegions,
				mergedRegions: grouped,
				imageWidth: result.imageWidth,
				imageHeight: result.imageHeight
			};
		} catch (error) {
			throwIfDetectorCancelled(options.signal);
			if (backend === 'native') throw error;
			nativeFailureQuarantine.add(nativeConfigKey(config));
			console.warn('[ppocr-det] Native OCR detection failed; using WASM', error);
		}
	} else if (backend === 'native') {
		throw new Error('Native PP-OCR detector is unavailable');
	}
	const wasm = await detectTextRegionsWithRawWasm(
		imageBlob,
		options.signal,
		options.deferGrouping,
		options.locale,
		options.targetLongestEdge
	);
	return {
		rawRegions: wasm.rawRegions,
		mergedRegions: wasm.mergedRegions,
		imageWidth: wasm.imageWidth,
		imageHeight: wasm.imageHeight
	};
}

/**
 * Check if the detector model is loaded.
 */
export function isDetectorReady(): boolean {
	return session !== null || getNativePPOcrRuntimeInfo().sessionLoaded === true;
}

/**
 * Release the detector model and free memory.
 */
export async function releaseDetectorWasm(): Promise<void> {
	if (session) {
		await session.release();
		session = null;
	}
	loading = null;
}

/** Release both possible singleton backends; each remains reusable afterward. */
export async function releaseDetector(): Promise<void> {
	await releaseDetectorWasm();
	if (isNativePPOcrAvailable()) {
		try {
			await releaseNativePPOcr();
		} catch (error) {
			console.warn('[ppocr-det] Native detector release failed', error);
		}
	}
	nativeFailureQuarantine.clear();
}

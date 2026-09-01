/**
 * Opt-in PP-OCRv6 medium detector experiment using ONNX Runtime Web's WebGPU EP.
 *
 * This module is intentionally separate from ppocr-detector.ts. Importing it does
 * not change the production WASM detector, and WebGPU is only requested when one
 * of the exported spike functions is called. The experiment shares the production
 * model, tensor conversion, DB extraction, and region merge contracts.
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import {
	detectTextRegionsWithRawWasm,
	extractBoxesFromProbMap,
	groupDetectedComponents,
	imageDataToDetectorTensor,
	PPOCR_DETECTOR_MODEL_PATH,
	PPOCR_DETECTOR_TARGET_SIZE
} from './ppocr-detector.js';

const WASM_ASSET_PATH = '/wasm/';
/** Version fingerprint verified against every bundled static/wasm runtime asset. */
export const PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION = '1.27.0';

type WebGpuRuntime = typeof import('onnxruntime-web/webgpu');
type WebGpuSession = import('onnxruntime-web/webgpu').InferenceSession;
type WebGpuTensor = import('onnxruntime-web/webgpu').Tensor;

type GpuAdapterLike = {
	features?: { size?: number };
	info?: {
		vendor?: string;
		architecture?: string;
		device?: string;
		description?: string;
	};
};

type GpuNavigatorLike = {
	requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GpuAdapterLike | null>;
};

export type PPOCRWebGPUFallbackStage = 'capability' | 'session' | 'run' | null;

export interface PPOCRWebGPUCapability {
	/** Convenience alias used by provider-neutral benchmark capability tables. */
	available: boolean;
	supported: boolean;
	apiAvailable: boolean;
	adapterAvailable: boolean;
	reason: 'available' | 'navigator-gpu-unavailable' | 'adapter-unavailable' | 'adapter-request-failed';
	probeMs: number;
	adapter: {
		vendor?: string;
		architecture?: string;
		device?: string;
		description?: string;
		featureCount?: number;
	} | null;
}

export interface PPOCRWebGPUSessionMetrics {
	status: 'ready' | 'failed';
	capability: PPOCRWebGPUCapability;
	runtimeVersion: string | null;
	bundledRuntimeVersion: typeof PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION;
	runtimeAssetVersionMatch: boolean | null;
	runtimeImportMs: number;
	executionProvider: 'webgpu';
	preferredLayout: 'NCHW';
	preferredOutputLocation: 'cpu';
	graphCaptureEnabled: false;
	modelPath: typeof PPOCR_DETECTOR_MODEL_PATH;
	modelBytes: number;
	modelFetchMs: number;
	sessionCreationMs: number;
	totalMs: number;
	failureStage: Exclude<PPOCRWebGPUFallbackStage, 'run' | null> | null;
	failureReason: string | null;
}

export interface PPOCRWebGPURunMetrics {
	requestedBackend: 'webgpu';
	backendUsed: 'webgpu' | 'wasm';
	fallbackStage: PPOCRWebGPUFallbackStage;
	fallbackReason: string | null;
	inputWidth: number;
	inputHeight: number;
	rawRegions: number;
	mergedRegions: number;
	sessionReused: boolean;
	sessionInitializationMs: number;
	/** @deprecated Use sessionInitializationMs. */
	initializationMs: number;
	preprocessingMs: number;
	inferenceMs: number;
	postprocessingMs: number;
	fallbackMs: number;
	totalMs: number;
	session: PPOCRWebGPUSessionMetrics | null;
}

export interface PPOCRDetectorSpikeOutput {
	rawRegions: DetectedTextRegion[];
	mergedRegions: DetectedTextRegion[];
	imageWidth: number;
	imageHeight: number;
	probMap: Float32Array;
	probMapWidth: number;
	probMapHeight: number;
	metrics: PPOCRWebGPURunMetrics;
}

export interface PPOCRDetectorComparableOutput {
	rawRegions: readonly DetectedTextRegion[];
	mergedRegions: readonly DetectedTextRegion[];
	probMap: Float32Array;
	probMapWidth: number;
	probMapHeight: number;
}

export interface PPOCRDetectorComparisonOptions {
	/** Maximum allowed absolute difference for each probability-map value. */
	probabilityAbsoluteTolerance?: number;
	/** Maximum allowed absolute difference for region x/y/width/height values. */
	coordinateTolerancePx?: number;
	/** Maximum allowed absolute confidence difference for paired regions. */
	confidenceAbsoluteTolerance?: number;
}

export interface PPOCRDetectorRegionComparison {
	countMatch: boolean;
	referenceCount: number;
	candidateCount: number;
	maxCoordinateDeltaPx: number;
	maxConfidenceDelta: number;
	mismatchedRegions: number;
}

export interface PPOCRDetectorOutputComparison {
	equivalent: boolean;
	dimensionsMatch: boolean;
	elementCountMatch: boolean;
	comparedProbabilityValues: number;
	maxProbabilityAbsoluteError: number;
	meanProbabilityAbsoluteError: number;
	probabilityRmse: number;
	probabilityValuesOutsideTolerance: number;
	rawRegions: PPOCRDetectorRegionComparison;
	mergedRegions: PPOCRDetectorRegionComparison;
	tolerances: Required<PPOCRDetectorComparisonOptions>;
}

export interface PPOCRWebGPUSpikeOptions {
	/** Fall back to the unchanged production WASM detector. Defaults to true. */
	fallbackToWasm?: boolean;
}

class WebGPUDetectorSpikeError extends Error {
	constructor(
		readonly stage: Exclude<PPOCRWebGPUFallbackStage, null>,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'WebGPUDetectorSpikeError';
	}
}

let runtime: WebGpuRuntime | null = null;
let session: WebGpuSession | null = null;
let sessionLoading: Promise<PPOCRWebGPUSessionMetrics> | null = null;
let lastSessionMetrics: PPOCRWebGPUSessionMetrics | null = null;
let lastRunMetrics: PPOCRWebGPURunMetrics | null = null;

function now(): number {
	return performance.now();
}

function roundedMs(value: number): number {
	return Math.round(value * 100) / 100;
}

function safeFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) || 'Unknown WebGPU error';
}

function gpuNavigator(): GpuNavigatorLike | null {
	if (typeof navigator === 'undefined') return null;
	const candidate = (navigator as Navigator & { gpu?: GpuNavigatorLike }).gpu;
	return candidate && typeof candidate.requestAdapter === 'function' ? candidate : null;
}

function adapterSummary(adapter: GpuAdapterLike): PPOCRWebGPUCapability['adapter'] {
	const info = adapter.info;
	return {
		...(info?.vendor ? { vendor: info.vendor } : {}),
		...(info?.architecture ? { architecture: info.architecture } : {}),
		...(info?.device ? { device: info.device } : {}),
		...(info?.description ? { description: info.description } : {}),
		...(typeof adapter.features?.size === 'number' ? { featureCount: adapter.features.size } : {})
	};
}

/** Feature-test navigator.gpu and confirm that the WebView can return an adapter. */
export async function probePPOCRDetectorWebGPU(): Promise<PPOCRWebGPUCapability> {
	const started = now();
	const gpu = gpuNavigator();
	if (!gpu) {
		return {
			available: false,
			supported: false,
			apiAvailable: false,
			adapterAvailable: false,
			reason: 'navigator-gpu-unavailable',
			probeMs: roundedMs(now() - started),
			adapter: null
		};
	}

	try {
		const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) {
			return {
				available: false,
				supported: false,
				apiAvailable: true,
				adapterAvailable: false,
				reason: 'adapter-unavailable',
				probeMs: roundedMs(now() - started),
				adapter: null
			};
		}
		return {
			available: true,
			supported: true,
			apiAvailable: true,
			adapterAvailable: true,
			reason: 'available',
			probeMs: roundedMs(now() - started),
			adapter: adapterSummary(adapter)
		};
	} catch {
		return {
			available: false,
			supported: false,
			apiAvailable: true,
			adapterAvailable: false,
			reason: 'adapter-request-failed',
			probeMs: roundedMs(now() - started),
			adapter: null
		};
	}
}

/**
 * Create the opt-in WebGPU session. The probability-map output stays on CPU
 * because the existing DB postprocessor consumes it there. Graph capture is
 * intentionally disabled: PP-OCR accepts dynamic page aspect ratios.
 */
export async function initPPOCRDetectorWebGPU(): Promise<PPOCRWebGPUSessionMetrics> {
	if (session && lastSessionMetrics) return lastSessionMetrics;
	if (sessionLoading) return sessionLoading;

	sessionLoading = (async () => {
		const totalStarted = now();
		const capability = await probePPOCRDetectorWebGPU();
		if (!capability.supported) {
			const metrics: PPOCRWebGPUSessionMetrics = {
				status: 'failed',
				capability,
				runtimeVersion: null,
				bundledRuntimeVersion: PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION,
				runtimeAssetVersionMatch: null,
				runtimeImportMs: 0,
				executionProvider: 'webgpu',
				preferredLayout: 'NCHW',
				preferredOutputLocation: 'cpu',
				graphCaptureEnabled: false,
				modelPath: PPOCR_DETECTOR_MODEL_PATH,
				modelBytes: 0,
				modelFetchMs: 0,
				sessionCreationMs: 0,
				totalMs: roundedMs(now() - totalStarted),
				failureStage: 'capability',
				failureReason: capability.reason
			};
			lastSessionMetrics = metrics;
			throw new WebGPUDetectorSpikeError('capability', capability.reason);
		}

		let modelBytes = 0;
		let runtimeImportMs = 0;
		let modelFetchMs = 0;
		let sessionCreationMs = 0;
		try {
			const runtimeImportStarted = now();
			try {
				runtime = await import('onnxruntime-web/webgpu');
			} finally {
				runtimeImportMs = now() - runtimeImportStarted;
			}
			const origin = typeof window !== 'undefined' ? window.location.origin : '';
			runtime.env.wasm.wasmPaths = `${origin}${WASM_ASSET_PATH}`;
			runtime.env.wasm.proxy = false;
			runtime.env.wasm.numThreads = 1;
			const runtimeVersion = runtime.env.versions.web;
			if (runtimeVersion && runtimeVersion !== PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION) {
				throw new Error(
					`ONNX Runtime Web ${runtimeVersion} does not match bundled WASM ${PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION}`
				);
			}

			const fetchStarted = now();
			let modelBuffer: ArrayBuffer;
			try {
				const response = await fetch(PPOCR_DETECTOR_MODEL_PATH);
				if (!response.ok) throw new Error(`Failed to load WebGPU detector model: ${response.status}`);
				modelBuffer = await response.arrayBuffer();
			} finally {
				modelFetchMs = now() - fetchStarted;
			}
			modelBytes = modelBuffer.byteLength;

			const sessionStarted = now();
			try {
				session = await runtime.InferenceSession.create(modelBuffer, {
					executionProviders: [{ name: 'webgpu', preferredLayout: 'NCHW' }],
					preferredOutputLocation: 'cpu',
					enableGraphCapture: false
				});
			} finally {
				sessionCreationMs = now() - sessionStarted;
			}
			const metrics: PPOCRWebGPUSessionMetrics = {
				status: 'ready',
				capability,
				runtimeVersion: runtimeVersion ?? null,
				bundledRuntimeVersion: PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION,
				runtimeAssetVersionMatch: runtimeVersion
					? runtimeVersion === PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION
					: null,
				runtimeImportMs: roundedMs(runtimeImportMs),
				executionProvider: 'webgpu',
				preferredLayout: 'NCHW',
				preferredOutputLocation: 'cpu',
				graphCaptureEnabled: false,
				modelPath: PPOCR_DETECTOR_MODEL_PATH,
				modelBytes,
				modelFetchMs: roundedMs(modelFetchMs),
				sessionCreationMs: roundedMs(sessionCreationMs),
				totalMs: roundedMs(now() - totalStarted),
				failureStage: null,
				failureReason: null
			};
			lastSessionMetrics = metrics;
			return metrics;
		} catch (error) {
			const reason = safeFailureReason(error);
			const metrics: PPOCRWebGPUSessionMetrics = {
				status: 'failed',
				capability,
				runtimeVersion: runtime?.env.versions.web ?? null,
				bundledRuntimeVersion: PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION,
				runtimeAssetVersionMatch: runtime?.env.versions.web
					? runtime.env.versions.web === PPOCR_WEBGPU_BUNDLED_RUNTIME_VERSION
					: null,
				runtimeImportMs: roundedMs(runtimeImportMs),
				executionProvider: 'webgpu',
				preferredLayout: 'NCHW',
				preferredOutputLocation: 'cpu',
				graphCaptureEnabled: false,
				modelPath: PPOCR_DETECTOR_MODEL_PATH,
				modelBytes,
				modelFetchMs: roundedMs(modelFetchMs),
				sessionCreationMs: roundedMs(sessionCreationMs),
				totalMs: roundedMs(now() - totalStarted),
				failureStage: 'session',
				failureReason: reason
			};
			lastSessionMetrics = metrics;
			session = null;
			runtime = null;
			throw new WebGPUDetectorSpikeError('session', reason, { cause: error });
		}
	})();

	try {
		return await sessionLoading;
	} finally {
		sessionLoading = null;
	}
}

function publishRunMetrics(metrics: PPOCRWebGPURunMetrics): void {
	lastRunMetrics = metrics;
	console.warn(`[ppocr-det-webgpu-spike] metrics ${JSON.stringify(metrics)}`);
	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__fumeto_last_ppocr_detector_webgpu_spike_metrics = metrics;
	}
}

async function discardFailedWebGPUSession(): Promise<void> {
	const failedSession = session;
	session = null;
	runtime = null;
	sessionLoading = null;
	if (failedSession) {
		try {
			await failedSession.release();
		} catch {
			// Preserve the original inference failure and continue to the safe fallback.
		}
	}
}

async function fallbackToProductionWasm(
	imageBlob: Blob,
	totalStarted: number,
	initializationMs: number,
	sessionReused: boolean,
	stage: Exclude<PPOCRWebGPUFallbackStage, null>,
	reason: string,
	attempted: { preprocessingMs?: number; inferenceMs?: number } = {}
): Promise<PPOCRDetectorSpikeOutput> {
	const fallbackStarted = now();
	const fallback = await detectTextRegionsWithRawWasm(imageBlob);
	const fallbackMs = now() - fallbackStarted;
	const metrics: PPOCRWebGPURunMetrics = {
		requestedBackend: 'webgpu',
		backendUsed: 'wasm',
		fallbackStage: stage,
		fallbackReason: reason,
		inputWidth: fallback.probMapWidth,
		inputHeight: fallback.probMapHeight,
		rawRegions: fallback.rawRegions.length,
		mergedRegions: fallback.mergedRegions.length,
		sessionReused,
		sessionInitializationMs: roundedMs(initializationMs),
		initializationMs: roundedMs(initializationMs),
		preprocessingMs: roundedMs(attempted.preprocessingMs ?? 0),
		inferenceMs: roundedMs(attempted.inferenceMs ?? 0),
		postprocessingMs: 0,
		fallbackMs: roundedMs(fallbackMs),
		totalMs: roundedMs(now() - totalStarted),
		session: lastSessionMetrics
	};
	publishRunMetrics(metrics);
	return { ...fallback, metrics };
}

/**
 * Run the WebGPU detector experiment. Any capability, session, or inference
 * failure falls back to the unchanged production WASM path by default.
 */
export async function runPPOCRDetectorWebGPUSpike(
	imageBlob: Blob,
	options: PPOCRWebGPUSpikeOptions = {}
): Promise<PPOCRDetectorSpikeOutput> {
	const fallbackEnabled = options.fallbackToWasm !== false;
	const totalStarted = now();
	const initializationStarted = totalStarted;
	const sessionReused = session !== null;
	let initializationMs = 0;
	try {
		await initPPOCRDetectorWebGPU();
		initializationMs = now() - initializationStarted;
	} catch (error) {
		initializationMs = now() - initializationStarted;
		const stage = error instanceof WebGPUDetectorSpikeError ? error.stage : 'session';
		const reason = safeFailureReason(error);
		if (!fallbackEnabled) throw error;
		return fallbackToProductionWasm(
			imageBlob,
			totalStarted,
			initializationMs,
			sessionReused,
			stage,
			reason
		);
	}
	if (!session || !runtime) {
		const error = new WebGPUDetectorSpikeError('session', 'WebGPU detector session was not initialized');
		if (!fallbackEnabled) throw error;
		return fallbackToProductionWasm(
			imageBlob,
			totalStarted,
			initializationMs,
			sessionReused,
			'session',
			error.message
		);
	}

	const preprocessingStarted = now();
	const bitmap = await createImageBitmap(imageBlob);
	const imageWidth = bitmap.width;
	const imageHeight = bitmap.height;
	const scale = PPOCR_DETECTOR_TARGET_SIZE / Math.max(imageWidth, imageHeight);
	const inputWidth = Math.round((imageWidth * scale) / 32) * 32 || 32;
	const inputHeight = Math.round((imageHeight * scale) / 32) * 32 || 32;
	const canvas = new OffscreenCanvas(inputWidth, inputHeight);
	const context = canvas.getContext('2d');
	if (!context) {
		bitmap.close();
		throw new Error('Unable to create detector preprocessing canvas');
	}
	context.drawImage(bitmap, 0, 0, inputWidth, inputHeight);
	bitmap.close();
	const imageData = context.getImageData(0, 0, inputWidth, inputHeight);
	const chw = imageDataToDetectorTensor(imageData);
	const inputTensor = new runtime.Tensor('float32', chw, [1, 3, inputHeight, inputWidth]);
	const preprocessingMs = now() - preprocessingStarted;

	let inferenceMs = 0;
	let outputTensors: WebGpuTensor[] = [];
	let runTensorsDisposed = false;
	const disposeRunTensors = () => {
		if (runTensorsDisposed) return;
		runTensorsDisposed = true;
		inputTensor.dispose();
		for (const tensor of new Set(outputTensors)) tensor.dispose();
	};
	let probMap: Float32Array;
	try {
		const inferenceStarted = now();
		const inputName = session.inputNames?.[0] ?? 'x';
		let results: import('onnxruntime-web/webgpu').InferenceSession.ReturnType;
		try {
			results = await session.run({ [inputName]: inputTensor });
		} finally {
			inferenceMs = now() - inferenceStarted;
		}
		outputTensors = Object.values(results).filter(
			(value): value is WebGpuTensor => typeof (value as WebGpuTensor | undefined)?.dispose === 'function'
		);
		const outputName = Object.keys(results)[0];
		if (!outputName) throw new Error('PP-OCR WebGPU model returned no outputs');
		const outputTensor = results[outputName] as WebGpuTensor | undefined;
		if (!outputTensor) throw new Error('PP-OCR WebGPU output tensor is missing');
		const outputData = outputTensor.data;
		if (!(outputData instanceof Float32Array)) {
			throw new Error(`PP-OCR WebGPU output type mismatch: expected float32, got ${outputTensor.type}`);
		}
		if (outputData.length !== inputWidth * inputHeight) {
			throw new Error(
				`PP-OCR WebGPU output size mismatch: expected ${inputWidth * inputHeight}, got ${outputData.length}`
			);
		}
		probMap = new Float32Array(outputData);
	} catch (error) {
		const wrapped = error instanceof WebGPUDetectorSpikeError
			? error
			: new WebGPUDetectorSpikeError('run', safeFailureReason(error), { cause: error });
		disposeRunTensors();
		await discardFailedWebGPUSession();
		if (!fallbackEnabled) throw wrapped;
		return await fallbackToProductionWasm(
			imageBlob,
			totalStarted,
			initializationMs,
			sessionReused,
			'run',
			wrapped.message,
			{ preprocessingMs, inferenceMs }
		);
	} finally {
		disposeRunTensors();
	}

	const postprocessingStarted = now();
	const scaleX = imageWidth / inputWidth;
	const scaleY = imageHeight / inputHeight;
	const rawRegions = extractBoxesFromProbMap(probMap, inputWidth, inputHeight, scaleX, scaleY);
	const mergedRegions = groupDetectedComponents(rawRegions, imageWidth, imageHeight);
	const postprocessingMs = now() - postprocessingStarted;
	const metrics: PPOCRWebGPURunMetrics = {
		requestedBackend: 'webgpu',
		backendUsed: 'webgpu',
		fallbackStage: null,
		fallbackReason: null,
		inputWidth,
		inputHeight,
		rawRegions: rawRegions.length,
		mergedRegions: mergedRegions.length,
		sessionReused,
		sessionInitializationMs: roundedMs(initializationMs),
		initializationMs: roundedMs(initializationMs),
		preprocessingMs: roundedMs(preprocessingMs),
		inferenceMs: roundedMs(inferenceMs),
		postprocessingMs: roundedMs(postprocessingMs),
		fallbackMs: 0,
		totalMs: roundedMs(now() - totalStarted),
		session: lastSessionMetrics
	};
	publishRunMetrics(metrics);
	return {
		rawRegions,
		mergedRegions,
		imageWidth,
		imageHeight,
		probMap,
		probMapWidth: inputWidth,
		probMapHeight: inputHeight,
		metrics
	};
}

function compareRegions(
	reference: readonly DetectedTextRegion[],
	candidate: readonly DetectedTextRegion[],
	coordinateTolerancePx: number,
	confidenceAbsoluteTolerance: number
): PPOCRDetectorRegionComparison {
	const canonicalize = (regions: readonly DetectedTextRegion[]) => [...regions].sort(
		(a, b) => a.boxId - b.boxId || a.y - b.y || a.x - b.x || a.height - b.height || a.width - b.width
	);
	const expectedRegions = canonicalize(reference);
	const actualRegions = canonicalize(candidate);
	const compared = Math.min(expectedRegions.length, actualRegions.length);
	let maxCoordinateDeltaPx = 0;
	let maxConfidenceDelta = 0;
	let mismatchedRegions = Math.abs(reference.length - candidate.length);
	for (let index = 0; index < compared; index++) {
		const expected = expectedRegions[index];
		const actual = actualRegions[index];
		const rawCoordinateDelta = Math.max(
			Math.abs(expected.x - actual.x),
			Math.abs(expected.y - actual.y),
			Math.abs(expected.width - actual.width),
			Math.abs(expected.height - actual.height)
		);
		const rawConfidenceDelta = Math.abs(expected.confidence - actual.confidence);
		const coordinateDelta = Number.isFinite(rawCoordinateDelta) ? rawCoordinateDelta : Infinity;
		const confidenceDelta = Number.isFinite(rawConfidenceDelta) ? rawConfidenceDelta : Infinity;
		maxCoordinateDeltaPx = Math.max(maxCoordinateDeltaPx, coordinateDelta);
		maxConfidenceDelta = Math.max(maxConfidenceDelta, confidenceDelta);
		if (
			expected.boxId !== actual.boxId ||
			coordinateDelta > coordinateTolerancePx ||
			confidenceDelta > confidenceAbsoluteTolerance
		) mismatchedRegions++;
	}
	return {
		countMatch: reference.length === candidate.length,
		referenceCount: reference.length,
		candidateCount: candidate.length,
		maxCoordinateDeltaPx,
		maxConfidenceDelta,
		mismatchedRegions
	};
}

/** Deterministically compare WASM/reference and WebGPU detector outputs. */
export function comparePPOCRDetectorSpikeOutputs(
	reference: PPOCRDetectorComparableOutput,
	candidate: PPOCRDetectorComparableOutput,
	options: PPOCRDetectorComparisonOptions = {}
): PPOCRDetectorOutputComparison {
	const tolerances: Required<PPOCRDetectorComparisonOptions> = {
		probabilityAbsoluteTolerance: options.probabilityAbsoluteTolerance ?? 1e-3,
		coordinateTolerancePx: options.coordinateTolerancePx ?? 1,
		confidenceAbsoluteTolerance: options.confidenceAbsoluteTolerance ?? 1e-3
	};
	for (const [name, value] of Object.entries(tolerances)) {
		if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
	}

	const dimensionsMatch = reference.probMapWidth === candidate.probMapWidth
		&& reference.probMapHeight === candidate.probMapHeight;
	const elementCountMatch = reference.probMap.length === candidate.probMap.length;
	const comparedProbabilityValues = Math.min(reference.probMap.length, candidate.probMap.length);
	let maxProbabilityAbsoluteError = 0;
	let probabilityErrorSum = 0;
	let probabilitySquaredErrorSum = 0;
	let probabilityValuesOutsideTolerance = Math.abs(
		reference.probMap.length - candidate.probMap.length
	);
	for (let index = 0; index < comparedProbabilityValues; index++) {
		const rawError = Math.abs(reference.probMap[index] - candidate.probMap[index]);
		const error = Number.isFinite(rawError) ? rawError : Infinity;
		maxProbabilityAbsoluteError = Math.max(maxProbabilityAbsoluteError, error);
		probabilityErrorSum += error;
		probabilitySquaredErrorSum += error * error;
		if (error > tolerances.probabilityAbsoluteTolerance) {
			probabilityValuesOutsideTolerance++;
		}
	}
	const meanProbabilityAbsoluteError = comparedProbabilityValues > 0
		? probabilityErrorSum / comparedProbabilityValues
		: 0;
	const probabilityRmse = comparedProbabilityValues > 0
		? Math.sqrt(probabilitySquaredErrorSum / comparedProbabilityValues)
		: 0;
	const rawRegions = compareRegions(
		reference.rawRegions,
		candidate.rawRegions,
		tolerances.coordinateTolerancePx,
		tolerances.confidenceAbsoluteTolerance
	);
	const mergedRegions = compareRegions(
		reference.mergedRegions,
		candidate.mergedRegions,
		tolerances.coordinateTolerancePx,
		tolerances.confidenceAbsoluteTolerance
	);
	return {
		equivalent: dimensionsMatch
			&& elementCountMatch
			&& probabilityValuesOutsideTolerance === 0
			&& rawRegions.mismatchedRegions === 0
			&& mergedRegions.mismatchedRegions === 0,
		dimensionsMatch,
		elementCountMatch,
		comparedProbabilityValues,
		maxProbabilityAbsoluteError,
		meanProbabilityAbsoluteError,
		probabilityRmse,
		probabilityValuesOutsideTolerance,
		rawRegions,
		mergedRegions,
		tolerances
	};
}

export function getLastPPOCRDetectorWebGPUSessionMetrics(): PPOCRWebGPUSessionMetrics | null {
	return lastSessionMetrics;
}

export function getLastPPOCRDetectorWebGPURunMetrics(): PPOCRWebGPURunMetrics | null {
	return lastRunMetrics;
}

/** Release only the opt-in WebGPU session; the production WASM detector is untouched. */
export async function releasePPOCRDetectorWebGPUSpike(): Promise<void> {
	const loading = sessionLoading;
	if (loading) {
		try {
			await loading;
		} catch {
			// A failed initialization has no live session to release.
		}
	}
	const activeSession = session;
	session = null;
	runtime = null;
	sessionLoading = null;
	lastSessionMetrics = null;
	if (activeSession) await activeSession.release();
}

/** Backward-compatible short alias for callers that already imported the spike. */
export const releasePPOCRDetectorWebGPU = releasePPOCRDetectorWebGPUSpike;

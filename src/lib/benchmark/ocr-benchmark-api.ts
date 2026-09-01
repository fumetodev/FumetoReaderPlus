/**
 * Debug-build OCR benchmark orchestration.
 *
 * This module deliberately sits outside the production OCR selection path. It
 * gives the Appium benchmark one provider-neutral API while leaving the reader's
 * detector/recognizer behavior untouched. PageViewer only loads it from the
 * existing benchmark-build hook.
 */

import {
	detectTextRegionsWithRawWasm,
	initDetectorWasm,
	releaseDetectorWasm
} from '$lib/detection/ppocr-detector.js';
import {
	acquireNativePPOcrExclusiveAccess,
	compareNativePPOcrProbabilityMap,
	detectTextRegionsNative,
	getNativePPOcrRuntimeInfo,
	isNativePPOcrAvailable,
	isNativePPOcrRecognizerAvailable,
	profileNativePPOcrProviderAssignment,
	profileNativePPOcrProviderAssignments,
	poisonNativePPOcrExclusiveAccess,
	recognizeTextRegionsNative,
	releaseNativePPOcrExclusiveAccess,
	releaseNativePPOcr,
	releaseNativePPOcrRecognizer,
	type NativePPOcrConfig,
	type NativePPOcrProviderAssignmentProfile
} from '$lib/detection/native-ppocr-detector.js';
import {
	initRecognizerWasm,
	recognizeTextRegionsWasm,
	releaseRecognizerWasm,
	type RecognitionResult
} from '$lib/detection/ppocr-recognizer.js';
import { sortRawRegionsInReadingOrder } from '$lib/translation/ppocr-text-extractor.js';
import { suppressRubyLines } from '$lib/translation/furigana-filter.js';
import type { RecognizedBlock } from '$lib/translation/recognized-block.js';
import type { DetectedTextRegion } from '$lib/types/index.js';

export type OcrBenchmarkProvider = 'wasm' | 'native-cpu' | 'native-xnnpack' | 'webgpu';
export type OcrBenchmarkPhase = 'detector' | 'recognizer' | 'pipeline';

export interface OcrBenchmarkBackend {
	provider: OcrBenchmarkProvider;
	threads: number;
}

export interface OcrBenchmarkRequest {
	phase: OcrBenchmarkPhase;
	detector: OcrBenchmarkBackend;
	recognizer?: OcrBenchmarkBackend;
	cold?: boolean;
	/** Required for a recognition-only run. The authoritative WASM detector regions are used. */
	recognitionRegions?: DetectedTextRegion[];
	/** Full detector probability-map absolute tolerance. Defaults to 1e-3. */
	probabilityMapAbsoluteTolerance?: number;
	/** Region x/y/width/height tolerance used by the WebGPU paired comparison. */
	coordinateTolerancePx?: number;
	/** Region confidence tolerance used by the WebGPU paired comparison. */
	confidenceAbsoluteTolerance?: number;
	/** Run the expensive full-map equivalence pass. Timed production-path samples leave this false. */
	verifyProbabilityMap?: boolean;
	/** Select the retained probability-map oracle used by a verification run. */
	probabilityMapReference?: 'wasm' | 'native-cpu';
	/** Capture a fresh native-CPU probability-map oracle without timing or comparing it. */
	captureNativeCpuProbabilityMapReference?: boolean;
	/** Exact fixture/page identity used to reject a stale retained probability reference. */
	referenceIdentity?: string;
}

export interface OcrBenchmarkCapability {
	provider: OcrBenchmarkProvider;
	available: boolean;
	threadCounts: number[];
	detector: boolean;
	recognizer: boolean;
	pipeline: boolean;
	pipelineLabel: string;
	reason?: string;
	runtimeInfo?: Record<string, unknown>;
}

export interface OcrBenchmarkCapabilities {
	schemaVersion: 1;
	providers: OcrBenchmarkCapability[];
}

export interface OcrLegacyProviderProfileRequest {
	backend: OcrBenchmarkBackend;
	/** Optional authoritative regions; empty uses boxes from the profiled detector run. */
	recognitionRegions?: DetectedTextRegion[];
}

export interface OcrPairedProviderProfileRequest {
	detector: OcrBenchmarkBackend;
	recognizer: OcrBenchmarkBackend;
	/** Optional authoritative regions; empty uses boxes from the profiled detector run. */
	recognitionRegions?: DetectedTextRegion[];
}

export type OcrProviderProfileRequest =
	| OcrLegacyProviderProfileRequest
	| OcrPairedProviderProfileRequest;

export type OcrProviderProfileResult = NativePPOcrProviderAssignmentProfile;

export interface OcrDetectorBenchmarkResult {
	requestedProvider: OcrBenchmarkProvider;
	providerUsed: string;
	threads: number;
	rawRegions: DetectedTextRegion[];
	mergedRegions: DetectedTextRegion[];
	imageWidth: number;
	imageHeight: number;
	metrics: Record<string, unknown>;
}

export interface OcrRecognizerBenchmarkResult {
	requestedProvider: OcrBenchmarkProvider;
	providerUsed: string;
	threads: number;
	inputRegions: number;
	results: RecognitionResult[];
	metrics: Record<string, unknown>;
}

export interface OcrBenchmarkRunResult {
	schemaVersion: 2;
	phase: OcrBenchmarkPhase;
	cold: boolean;
	/** Session reset time is reported separately and is never included in totalMs. */
	resetMs: number;
	totalMs: number;
	/** Android SystemClock.elapsedRealtimeNanos(), converted losslessly to milliseconds. */
	inferenceStartedElapsedRealtimeMs: number;
	inferenceEndedElapsedRealtimeMs: number;
	detector?: OcrDetectorBenchmarkResult;
	recognizer?: OcrRecognizerBenchmarkResult;
	blocks?: RecognizedBlock[];
	mappingMs?: number;
}

let wasmDetectorReference: {
	identity: string;
	rawRegions: DetectedTextRegion[];
	mergedRegions: DetectedTextRegion[];
	probMap: Float32Array;
	probMapWidth: number;
	probMapHeight: number;
} | null = null;
let nativeCpuDetectorReference: {
	identity: string;
	probMap: Float32Array;
	probMapWidth: number;
	probMapHeight: number;
	sha256: string;
} | null = null;
let benchmarkOperationInFlight = false;
let benchmarkAbortController: AbortController | null = null;

function beginBenchmarkOperation(): AbortController {
	if (benchmarkOperationInFlight || benchmarkAbortController) {
		throw new Error('Another OCR benchmark operation is already running');
	}
	const controller = new AbortController();
	acquireNativePPOcrExclusiveAccess(controller.signal);
	benchmarkOperationInFlight = true;
	benchmarkAbortController = controller;
	return controller;
}

function finishBenchmarkOperation(controller: AbortController): void {
	if (controller.signal.aborted) {
		poisonNativePPOcrExclusiveAccess(controller.signal);
	} else {
		releaseNativePPOcrExclusiveAccess(controller.signal);
	}
	if (benchmarkAbortController === controller) benchmarkAbortController = null;
	benchmarkOperationInFlight = false;
}

function now(): number {
	return performance.now();
}

function roundedMs(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Correlates WebView work with the sampler's `/proc/uptime` CLOCK_BOOTTIME clock. */
export function androidElapsedRealtimeMs(): number {
	const bridge = typeof window === 'undefined'
		? undefined
		: (window as unknown as Record<string, unknown>).__fumeto_llama as {
			getElapsedRealtimeNanos?: () => string;
		} | undefined;
	const raw = bridge?.getElapsedRealtimeNanos?.();
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
		throw new Error('Android benchmark monotonic clock is unavailable or invalid');
	}
	const nanos = BigInt(raw);
	const milliseconds = Number(nanos / 1_000_000n) + Number(nanos % 1_000_000n) / 1_000_000;
	if (!Number.isFinite(milliseconds) || milliseconds < 0) {
		throw new Error('Android benchmark monotonic clock could not be represented in milliseconds');
	}
	return milliseconds;
}

function nativeConfig(backend: OcrBenchmarkBackend): NativePPOcrConfig {
	const provider = backend.provider === 'native-cpu'
		? 'cpu'
		: backend.provider === 'native-xnnpack'
			? 'xnnpack'
			: null;
	if (!provider) throw new Error(`${backend.provider} is not a native ORT provider`);
	return { provider, threads: backend.threads };
}

function isNativeProvider(provider: OcrBenchmarkProvider): boolean {
	return provider === 'native-cpu' || provider === 'native-xnnpack';
}

function validateNativeIdentity(
	metrics: unknown,
	expected: NativePPOcrConfig,
	component: 'detector' | 'recognizer'
): { provider: NativePPOcrConfig['provider']; threads: number } {
	if (!metrics || typeof metrics !== 'object') {
		throw new Error(`Native PP-OCR ${component} metrics are missing or invalid`);
	}
	const identity = metrics as Record<string, unknown>;
	const requestedProvider = identity.requestedProvider;
	const provider = identity.provider;
	const threads = identity.threads;
	const providerFallback = identity.providerFallback;
	if (
		(requestedProvider !== 'cpu' && requestedProvider !== 'xnnpack') ||
		(provider !== 'cpu' && provider !== 'xnnpack') ||
		!Number.isInteger(threads) ||
		Number(threads) < 1 ||
		typeof providerFallback !== 'boolean'
	) {
		throw new Error(`Native PP-OCR ${component} metrics have invalid provider/thread identity`);
	}
	if (requestedProvider !== expected.provider) {
		throw new Error(
			`Native PP-OCR ${component} metrics requested ${requestedProvider}, expected ${expected.provider}`
		);
	}
	if (provider !== expected.provider || providerFallback) {
		throw new Error(
			`Native PP-OCR ${component} metrics used ${provider}${providerFallback ? ' via fallback' : ''}, ` +
			`expected ${expected.provider}`
		);
	}
	if (threads !== expected.threads) {
		throw new Error(
			`Native PP-OCR ${component} metrics reported ${threads} threads, expected ${expected.threads}`
		);
	}
	return { provider, threads: Number(threads) };
}

function validateNativeDetectorIdentity(
	metrics: unknown,
	expected: NativePPOcrConfig
): { provider: NativePPOcrConfig['provider']; threads: number } {
	return validateNativeIdentity(metrics, expected, 'detector');
}

function validateNativeRecognizerIdentity(
	metrics: unknown,
	expected: NativePPOcrConfig
): { provider: NativePPOcrConfig['provider']; threads: number } {
	return validateNativeIdentity(metrics, expected, 'recognizer');
}

function probabilityMapSummary(
	values: Float32Array,
	width: number,
	height: number,
	sha256?: string
): Record<string, unknown> {
	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	for (const value of values) {
		min = Math.min(min, value);
		max = Math.max(max, value);
		sum += value;
	}
	return {
		width,
		height,
		values: values.length,
		min: values.length ? min : 0,
		max: values.length ? max : 0,
		mean: values.length ? sum / values.length : 0,
		...(sha256 === undefined ? {} : { sha256 })
	};
}

async function probabilityMapSha256(values: Float32Array): Promise<string> {
	// The Android comparison bridge hashes Float32 values serialized in little-endian
	// order. Serialize explicitly instead of relying on the WebView CPU's endianness so
	// this capture digest remains stable and can be matched to baselineSha256.
	const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < values.length; index++) {
		view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, values[index], true);
	}
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateCapturedNativeRegions(
	regions: unknown,
	label: string,
	imageWidth: number,
	imageHeight: number
): void {
	if (!Array.isArray(regions)) {
		throw new Error(`Native CPU probability-map capture ${label} regions are invalid`);
	}
	const seenIds = new Set<number>();
	for (let index = 0; index < regions.length; index++) {
		const region = regions[index] as Record<string, unknown> | null;
		if (!region || typeof region !== 'object'
			|| !Number.isSafeInteger(region.boxId)
			|| Number(region.boxId) < 0
			|| !Number.isFinite(region.x)
			|| Number(region.x) < 0
			|| !Number.isFinite(region.y)
			|| Number(region.y) < 0
			|| !Number.isFinite(region.width)
			|| !Number.isFinite(region.height)
			|| !Number.isFinite(region.confidence)
			|| Number(region.width) <= 0
			|| Number(region.height) <= 0
			|| Number(region.confidence) < 0
			|| Number(region.confidence) > 1
			|| Number(region.x) + Number(region.width) > imageWidth
			|| Number(region.y) + Number(region.height) > imageHeight
			|| seenIds.has(Number(region.boxId))) {
			throw new Error(
				`Native CPU probability-map capture ${label} region ${index} is invalid or non-finite`
			);
		}
		seenIds.add(Number(region.boxId));
	}
}

async function validateCapturedNativeProbabilityMap(
	output: Awaited<ReturnType<typeof detectTextRegionsNative>>
): Promise<{
	probMap: Float32Array;
	probMapWidth: number;
	probMapHeight: number;
	sha256: string;
}> {
	if (!Number.isSafeInteger(output.imageWidth) || output.imageWidth <= 0
		|| !Number.isSafeInteger(output.imageHeight) || output.imageHeight <= 0) {
		throw new Error('Native CPU probability-map capture image dimensions are invalid');
	}
	validateCapturedNativeRegions(output.rawRegions, 'raw', output.imageWidth, output.imageHeight);
	validateCapturedNativeRegions(output.mergedRegions, 'merged', output.imageWidth, output.imageHeight);

	const probMap = output.probMap;
	const width = output.probMapWidth;
	const height = output.probMapHeight;
	if (!(probMap instanceof Float32Array)
		|| !Number.isSafeInteger(width) || Number(width) <= 0
		|| !Number.isSafeInteger(height) || Number(height) <= 0
		|| Number(width) > Number.MAX_SAFE_INTEGER / Number(height)
		|| Number(width) * Number(height) !== probMap.length) {
		throw new Error('Native CPU probability-map reference capture shape is invalid');
	}
	const metrics = output.metrics as unknown as Record<string, unknown>;
	if (metrics.inputWidth !== width || metrics.inputHeight !== height) {
		throw new Error(
			'Native CPU probability-map reference dimensions do not match the detector input dimensions'
		);
	}
	for (let index = 0; index < probMap.length; index++) {
		if (!Number.isFinite(probMap[index])) {
			throw new Error(`Native CPU probability-map reference value ${index} is non-finite`);
		}
	}
	const copiedMap = probMap.slice();
	return {
		probMap: copiedMap,
		probMapWidth: Number(width),
		probMapHeight: Number(height),
		sha256: await probabilityMapSha256(copiedMap)
	};
}

function sanitizeRegions(regions: DetectedTextRegion[]): DetectedTextRegion[] {
	return regions.map((region) => ({
		boxId: Number(region.boxId),
		x: Number(region.x),
		y: Number(region.y),
		width: Number(region.width),
		height: Number(region.height),
		confidence: Number(region.confidence),
		...(region.inBubble === undefined ? {} : { inBubble: Boolean(region.inBubble) })
	}));
}

async function releaseNative(signal?: AbortSignal): Promise<void> {
	if (isNativePPOcrAvailable()) await releaseNativePPOcr(signal);
}

async function releaseNativeRecognizer(signal?: AbortSignal): Promise<void> {
	if (isNativePPOcrRecognizerAvailable()) await releaseNativePPOcrRecognizer(signal);
}

async function resetDetector(provider: OcrBenchmarkProvider, signal?: AbortSignal): Promise<void> {
	if (provider === 'wasm') {
		await releaseDetectorWasm();
		return;
	}
	if (isNativeProvider(provider)) {
		await releaseNative(signal);
		return;
	}
	if (provider === 'webgpu') {
		const spike = await import('$lib/detection/ppocr-detector-webgpu-spike.js');
		await spike.releasePPOCRDetectorWebGPUSpike?.();
	}
}

async function resetRecognizer(provider: OcrBenchmarkProvider, signal?: AbortSignal): Promise<void> {
	if (provider === 'wasm' || provider === 'webgpu') {
		await releaseRecognizerWasm();
		return;
	}
	if (isNativeProvider(provider)) await releaseNativeRecognizer(signal);
}

async function runWasmDetector(
	image: Blob,
	backend: OcrBenchmarkBackend,
	referenceIdentity: string
): Promise<OcrDetectorBenchmarkResult> {
	if (backend.threads !== 1) throw new Error('The authoritative WASM baseline is fixed to one thread');
	const initializationStarted = now();
	await initDetectorWasm();
	const initializationMs = now() - initializationStarted;
	const detectionStarted = now();
	const output = await detectTextRegionsWithRawWasm(image);
	const detectionMs = now() - detectionStarted;
	wasmDetectorReference = {
		identity: referenceIdentity,
		rawRegions: sanitizeRegions(output.rawRegions),
		mergedRegions: sanitizeRegions(output.mergedRegions),
		probMap: output.probMap,
		probMapWidth: output.probMapWidth,
		probMapHeight: output.probMapHeight
	};
	const detailed = (window as unknown as Record<string, unknown>).__fumeto_last_ppocr_detector_metrics;
	return {
		requestedProvider: backend.provider,
		providerUsed: 'wasm',
		threads: 1,
		rawRegions: sanitizeRegions(output.rawRegions),
		mergedRegions: sanitizeRegions(output.mergedRegions),
		imageWidth: output.imageWidth,
		imageHeight: output.imageHeight,
		metrics: {
			initializationMs: roundedMs(initializationMs),
			detectionMs: roundedMs(detectionMs),
			totalMs: roundedMs(initializationMs + detectionMs),
			detail: detailed ?? null,
			probabilityMapReference: probabilityMapSummary(
				output.probMap,
				output.probMapWidth,
				output.probMapHeight
			)
		}
	};
}

async function runNativeDetector(
	image: Blob,
	backend: OcrBenchmarkBackend,
	probabilityMapAbsoluteTolerance: number,
	verifyProbabilityMap: boolean,
	requestedProbabilityMapReference: 'wasm' | 'native-cpu' | undefined,
	captureNativeCpuProbabilityMapReference: boolean,
	referenceIdentity: string,
	signal: AbortSignal
): Promise<OcrDetectorBenchmarkResult> {
	if (!isNativePPOcrAvailable()) {
		throw new Error('Native PP-OCR detector bridge is unavailable');
	}
	if (captureNativeCpuProbabilityMapReference && verifyProbabilityMap) {
		throw new Error('Native CPU probability-map capture and verification are mutually exclusive');
	}
	if (captureNativeCpuProbabilityMapReference && backend.provider !== 'native-cpu') {
		throw new Error('Only native-cpu may capture the native probability-map reference');
	}
	if (captureNativeCpuProbabilityMapReference && requestedProbabilityMapReference === 'wasm') {
		throw new Error('A native CPU probability-map capture cannot use the wasm reference kind');
	}
	const probabilityMapReference = requestedProbabilityMapReference
		?? (captureNativeCpuProbabilityMapReference ? 'native-cpu' : 'wasm');
	const retainedReference = probabilityMapReference === 'native-cpu'
		? nativeCpuDetectorReference
		: wasmDetectorReference;
	if (verifyProbabilityMap && !retainedReference) {
		throw new Error(`Run the ${probabilityMapReference} detector reference before a native candidate`);
	}
	if (verifyProbabilityMap && retainedReference?.identity !== referenceIdentity) {
		throw new Error(
			`Native candidate fixture does not match the retained ${probabilityMapReference} probability reference`
		);
	}
	const expectedConfig = nativeConfig(backend);
	// Fail closed: a failed refresh must not leave a same-fixture native oracle
	// available for a later verification run.
	if (captureNativeCpuProbabilityMapReference) nativeCpuDetectorReference = null;
	const bridgeStarted = now();
	const output = captureNativeCpuProbabilityMapReference
		? await detectTextRegionsNative(image, {
			config: expectedConfig,
			includeProbabilityMap: true,
			signal
		})
		: verifyProbabilityMap
		? await compareNativePPOcrProbabilityMap(
			image,
			retainedReference!.probMap,
			retainedReference!.probMapWidth,
			retainedReference!.probMapHeight,
			probabilityMapAbsoluteTolerance,
			expectedConfig,
			signal
		)
		: await detectTextRegionsNative(image, {
			config: expectedConfig,
			includeProbabilityMap: false,
				signal
			});
	const bridgeMs = now() - bridgeStarted;
	// Provider/thread identity is part of the oracle. Validate it before any
	// probability bytes from this result can become retained benchmark state.
	const identity = validateNativeDetectorIdentity(output.metrics, expectedConfig);
	if (captureNativeCpuProbabilityMapReference) {
		const validated = await validateCapturedNativeProbabilityMap(output);
		nativeCpuDetectorReference = {
			identity: referenceIdentity,
			...validated
		};
	}
	const referenceEvidence = captureNativeCpuProbabilityMapReference
		? nativeCpuDetectorReference
		: verifyProbabilityMap ? retainedReference : null;
	return {
		requestedProvider: backend.provider,
		providerUsed: identity.provider,
		threads: identity.threads,
		rawRegions: sanitizeRegions(output.rawRegions ?? []),
		mergedRegions: sanitizeRegions(output.mergedRegions ?? []),
		imageWidth: Number(output.imageWidth),
		imageHeight: Number(output.imageHeight),
		metrics: {
			...output.metrics,
			probabilityMapComparison: 'comparison' in output ? output.comparison : null,
			...(referenceEvidence ? {
				probabilityMapReference: probabilityMapSummary(
					referenceEvidence.probMap,
					referenceEvidence.probMapWidth,
					referenceEvidence.probMapHeight,
					'sha256' in referenceEvidence ? referenceEvidence.sha256 : undefined
				),
				probabilityMapReferenceIdentity: referenceEvidence.identity
			} : {}),
			probabilityMapReferenceKind: referenceEvidence ? probabilityMapReference : null,
			probabilityMapVerification: captureNativeCpuProbabilityMapReference
				? 'reference-capture'
				: verifyProbabilityMap ? 'full-map' : 'not-requested',
			bridgeRoundTripMs: roundedMs(bridgeMs),
			endToEndMs: roundedMs(bridgeMs)
		}
	};
}

async function runWebGpuDetector(
	image: Blob,
	backend: OcrBenchmarkBackend,
	referenceIdentity: string,
	tolerances: Pick<
		OcrBenchmarkRequest,
		'probabilityMapAbsoluteTolerance' | 'coordinateTolerancePx' | 'confidenceAbsoluteTolerance'
		| 'verifyProbabilityMap' | 'probabilityMapReference' | 'captureNativeCpuProbabilityMapReference'
	>,
	signal: AbortSignal
): Promise<OcrDetectorBenchmarkResult> {
	if (backend.threads !== 1) throw new Error('WebGPU does not accept a CPU thread-count setting');
	if (tolerances.verifyProbabilityMap && !wasmDetectorReference) {
		throw new Error('Run the authoritative WASM detector before a WebGPU candidate');
	}
	if (tolerances.verifyProbabilityMap && wasmDetectorReference?.identity !== referenceIdentity) {
		throw new Error('WebGPU candidate fixture does not match the retained WASM probability reference');
	}
	const spike = await import('$lib/detection/ppocr-detector-webgpu-spike.js');
	const output = await spike.runPPOCRDetectorWebGPUSpike(image, { fallbackToWasm: false });
	const comparison = tolerances.verifyProbabilityMap
		? spike.comparePPOCRDetectorSpikeOutputs(wasmDetectorReference!, output, {
			probabilityAbsoluteTolerance: tolerances.probabilityMapAbsoluteTolerance,
			coordinateTolerancePx: tolerances.coordinateTolerancePx,
			confidenceAbsoluteTolerance: tolerances.confidenceAbsoluteTolerance
		})
		: null;
	return {
		requestedProvider: backend.provider,
		providerUsed: output.metrics.backendUsed,
		threads: 1,
		rawRegions: sanitizeRegions(output.rawRegions),
		mergedRegions: sanitizeRegions(output.mergedRegions),
		imageWidth: output.imageWidth,
		imageHeight: output.imageHeight,
		metrics: {
			...(output.metrics as unknown as Record<string, unknown>),
			probabilityMapComparison: comparison,
			probabilityMapVerification: tolerances.verifyProbabilityMap ? 'full-map' : 'not-requested'
		}
	};
}

async function runDetector(
	image: Blob,
	backend: OcrBenchmarkBackend,
	referenceIdentity: string,
	tolerances: Pick<
		OcrBenchmarkRequest,
		'probabilityMapAbsoluteTolerance' | 'coordinateTolerancePx' | 'confidenceAbsoluteTolerance'
		| 'verifyProbabilityMap' | 'probabilityMapReference' | 'captureNativeCpuProbabilityMapReference'
	>,
	signal: AbortSignal
): Promise<OcrDetectorBenchmarkResult> {
	if (tolerances.captureNativeCpuProbabilityMapReference
		&& backend.provider !== 'native-cpu') {
		throw new Error('Only native-cpu may capture the native probability-map reference');
	}
	if (backend.provider === 'wasm') return runWasmDetector(image, backend, referenceIdentity);
	if (isNativeProvider(backend.provider)) {
		return runNativeDetector(
			image,
			backend,
			tolerances.probabilityMapAbsoluteTolerance ?? 1e-3,
			tolerances.verifyProbabilityMap === true,
			tolerances.probabilityMapReference,
			tolerances.captureNativeCpuProbabilityMapReference === true,
			referenceIdentity,
			signal
		);
	}
	return runWebGpuDetector(image, backend, referenceIdentity, tolerances, signal);
}

async function runWasmRecognizer(
	image: Blob,
	regions: DetectedTextRegion[],
	backend: OcrBenchmarkBackend
): Promise<OcrRecognizerBenchmarkResult> {
	if (backend.threads !== 1) throw new Error('The WASM recognizer is fixed to one thread');
	const initializationStarted = now();
	await initRecognizerWasm();
	const initializationMs = now() - initializationStarted;
	const recognitionStarted = now();
	const results = await recognizeTextRegionsWasm(image, regions);
	const recognitionMs = now() - recognitionStarted;
	const detailed = (window as unknown as Record<string, unknown>).__fumeto_last_ppocr_recognizer_metrics;
	return {
		requestedProvider: backend.provider,
		providerUsed: 'wasm',
		threads: 1,
		inputRegions: regions.length,
		results,
		metrics: {
			initializationMs: roundedMs(initializationMs),
			recognitionMs: roundedMs(recognitionMs),
			totalMs: roundedMs(initializationMs + recognitionMs),
			detail: detailed ?? null
		}
	};
}

async function runRecognizer(
	image: Blob,
	regions: DetectedTextRegion[],
	backend: OcrBenchmarkBackend,
	signal: AbortSignal
): Promise<OcrRecognizerBenchmarkResult> {
	// WebGPU currently covers detection only, so a WebGPU pipeline deliberately
	// pairs it with the authoritative WASM recognizer.
	if (backend.provider === 'wasm' || backend.provider === 'webgpu') {
		return runWasmRecognizer(image, regions, { provider: 'wasm', threads: 1 });
	}
	if (!isNativePPOcrRecognizerAvailable()) {
		throw new Error('Native PP-OCR recognizer bridge is unavailable');
	}
	const expectedConfig = nativeConfig(backend);
	const started = now();
	const output = await recognizeTextRegionsNative(image, regions, { config: expectedConfig, signal });
	const identity = validateNativeRecognizerIdentity(output.metrics, expectedConfig);
	return {
		requestedProvider: backend.provider,
		providerUsed: identity.provider,
		threads: identity.threads,
		inputRegions: regions.length,
		results: output.results,
		metrics: {
			...output.metrics,
			bridgeRoundTripMs: roundedMs(now() - started)
		}
	};
}

function mapRecognizedBlocks(
	rawRegions: DetectedTextRegion[],
	mergedRegions: DetectedTextRegion[],
	results: RecognitionResult[]
): RecognizedBlock[] {
	const rawText = new Map(results.map((result) => [result.boxId, result.text]));
	const blocks: RecognizedBlock[] = [];
	for (let index = 0; index < mergedRegions.length; index++) {
		const merged = mergedRegions[index];
		const contained = rawRegions.filter((raw) => {
			const centerX = raw.x + raw.width / 2;
			const centerY = raw.y + raw.height / 2;
			return centerX >= merged.x
				&& centerX <= merged.x + merged.width
				&& centerY >= merged.y
				&& centerY <= merged.y + merged.height;
		});
		// Mirror the production extractor so the two assemble text the same way. Note
		// this path does not run bubble segmentation, so its groups are usually single
		// lines and the filter rarely has anything to act on — it fires only if grouping
		// merged, which is the case production always hits and this one usually does not.
		const text = suppressRubyLines(sortRawRegionsInReadingOrder(contained), rawText)
			.map((region) => rawText.get(region.boxId) ?? '')
			.filter(Boolean)
			.join('');
		if (!text) continue;
		blocks.push({
			text,
			x: merged.x,
			y: merged.y,
			width: merged.width,
			height: merged.height,
			blockIndex: index
		});
	}
	return blocks;
}

export async function getOcrBenchmarkCapabilities(): Promise<OcrBenchmarkCapabilities> {
	const crossOriginIsolationAvailable = globalThis.crossOriginIsolated === true;
	const sharedArrayBufferAvailable = typeof globalThis.SharedArrayBuffer === 'function';
	const wasmThreadingRuntimeEligible = crossOriginIsolationAvailable && sharedArrayBufferAvailable;
	const providers: OcrBenchmarkCapability[] = [{
		provider: 'wasm',
		available: true,
		threadCounts: [1],
		detector: true,
		recognizer: true,
		pipeline: true,
		pipelineLabel: 'wasm-detector+wasm-recognizer',
		runtimeInfo: {
			crossOriginIsolated: crossOriginIsolationAvailable,
			sharedArrayBufferAvailable,
			wasmThreadingRuntimeEligible,
			threadedBenchmarkLaneImplemented: false,
			benchmarkThreadCount: 1,
			threadingMode: 'authoritative-single-thread-baseline',
		}
	}];

	const nativeAvailable = isNativePPOcrAvailable();
	const nativeRecognizer = nativeAvailable && isNativePPOcrRecognizerAvailable();
	const runtimeInfo = getNativePPOcrRuntimeInfo() as unknown as Record<string, unknown>;
	for (const provider of ['native-cpu', 'native-xnnpack'] as const) {
		providers.push({
			provider,
			available: nativeAvailable,
			threadCounts: [2, 4, 6, 8],
			detector: nativeAvailable,
			recognizer: nativeRecognizer,
			pipeline: nativeAvailable,
			pipelineLabel: nativeRecognizer
				? `${provider}-detector+${provider}-recognizer`
				: `${provider}-detector+wasm-recognizer`,
			...(nativeAvailable ? {} : { reason: 'Native PP-OCR detector bridge is unavailable' }),
			runtimeInfo
		});
	}

	try {
		const spike = await import('$lib/detection/ppocr-detector-webgpu-spike.js');
		const probe = await spike.probePPOCRDetectorWebGPU();
		providers.push({
			provider: 'webgpu',
			available: probe.available,
			threadCounts: [1],
			detector: probe.available,
				recognizer: false,
				pipeline: probe.available,
				pipelineLabel: 'webgpu-detector+wasm-recognizer',
			...(probe.reason ? { reason: probe.reason } : {}),
			runtimeInfo: probe as unknown as Record<string, unknown>
		});
	} catch (error) {
		providers.push({
			provider: 'webgpu',
			available: false,
			threadCounts: [1],
			detector: false,
				recognizer: false,
				pipeline: false,
				pipelineLabel: 'webgpu-detector+wasm-recognizer',
			reason: error instanceof Error ? error.message : String(error)
		});
	}

	return { schemaVersion: 1, providers };
}

async function runOcrBenchmarkInternal(
	image: File,
	request: OcrBenchmarkRequest,
	signal: AbortSignal
): Promise<OcrBenchmarkRunResult> {
	const cold = request.cold === true;
	const referenceIdentity = request.referenceIdentity
		?? `${image.name}:${image.size}:${image.lastModified}:${image.type}`;
	const recognizerBackend = request.recognizer ?? { provider: 'wasm', threads: 1 };
	const recognitionRegions = request.phase === 'recognizer' ? request.recognitionRegions : undefined;
	if (request.phase === 'recognizer' && !recognitionRegions) {
		throw new Error('recognitionRegions are required for a recognition-only benchmark');
	}

	let resetMs = 0;
	if (cold) {
		const resetStarted = now();
		if (request.phase === 'detector') {
			await resetDetector(request.detector.provider, signal);
		} else if (request.phase === 'recognizer') {
			await resetRecognizer(recognizerBackend.provider, signal);
		} else {
			await resetDetector(request.detector.provider, signal);
			await resetRecognizer(recognizerBackend.provider, signal);
		}
		resetMs = roundedMs(now() - resetStarted);
	}
	const inferenceStartedElapsedRealtimeMs = androidElapsedRealtimeMs();
	const started = now();

	if (request.phase === 'detector') {
		const detector = await runDetector(image, request.detector, referenceIdentity, request, signal);
		const totalMs = roundedMs(now() - started);
		const inferenceEndedElapsedRealtimeMs = androidElapsedRealtimeMs();
		return {
			schemaVersion: 2,
			phase: request.phase,
			cold,
			resetMs,
			totalMs,
			inferenceStartedElapsedRealtimeMs,
			inferenceEndedElapsedRealtimeMs,
			detector
		};
	}

	if (request.phase === 'recognizer') {
		const recognizer = await runRecognizer(
			image,
			sanitizeRegions(recognitionRegions!),
			recognizerBackend,
			signal
		);
		const totalMs = roundedMs(now() - started);
		const inferenceEndedElapsedRealtimeMs = androidElapsedRealtimeMs();
		return {
			schemaVersion: 2,
			phase: request.phase,
			cold,
			resetMs,
			totalMs,
			inferenceStartedElapsedRealtimeMs,
			inferenceEndedElapsedRealtimeMs,
			recognizer
		};
	}

	const detector = await runDetector(image, request.detector, referenceIdentity, request, signal);
	const recognizer = await runRecognizer(image, detector.rawRegions, recognizerBackend, signal);
	const mappingStarted = now();
	const blocks = mapRecognizedBlocks(detector.rawRegions, detector.mergedRegions, recognizer.results);
	const mappingMs = now() - mappingStarted;
	const totalMs = roundedMs(now() - started);
	const inferenceEndedElapsedRealtimeMs = androidElapsedRealtimeMs();
	return {
		schemaVersion: 2,
		phase: request.phase,
		cold,
		resetMs,
		totalMs,
		inferenceStartedElapsedRealtimeMs,
		inferenceEndedElapsedRealtimeMs,
		detector,
		recognizer,
		blocks,
		mappingMs: roundedMs(mappingMs)
	};
}

/** A module-wide mutex covers both the catalog fixture host and PageViewer hook. */
export async function runOcrBenchmark(
	image: File,
	request: OcrBenchmarkRequest
): Promise<OcrBenchmarkRunResult> {
	const controller = beginBenchmarkOperation();
	try {
		return await runOcrBenchmarkInternal(image, request, controller.signal);
	} finally {
		finishBenchmarkOperation(controller);
	}
}

/** Debug-only one-shot ORT node/provider evidence; never reuses timed sessions. */
export async function profileOcrNativeProviderAssignment(
	image: File,
	request: OcrProviderProfileRequest
): Promise<OcrProviderProfileResult> {
	const detectorBackend = 'backend' in request ? request.backend : request.detector;
	const recognizerBackend = 'backend' in request ? request.backend : request.recognizer;
	if (!isNativeProvider(detectorBackend.provider) || !isNativeProvider(recognizerBackend.provider)) {
		throw new Error('ORT provider profiling requires native-cpu or native-xnnpack');
	}
	if (!isNativePPOcrAvailable() || !isNativePPOcrRecognizerAvailable()) {
		throw new Error('Native detector and recognizer bridges are required for provider profiling');
	}
	const controller = beginBenchmarkOperation();
	try {
		const regions = sanitizeRegions(request.recognitionRegions ?? []);
		if ('backend' in request) {
			return await profileNativePPOcrProviderAssignment(
				image,
				regions,
				nativeConfig(request.backend),
				controller.signal
			);
		}
		return await profileNativePPOcrProviderAssignments(image, regions, {
			detector: nativeConfig(request.detector),
			recognizer: nativeConfig(request.recognizer)
		}, controller.signal);
	} finally {
		finishBenchmarkOperation(controller);
	}
}

/** Cancel only callbacks carrying the active benchmark operation's AbortSignal. */
export function cancelOcrBenchmarkOperation(reason: string): boolean {
	const controller = benchmarkAbortController;
	if (!controller || controller.signal.aborted) return false;
	controller.abort(reason.trim() || 'OCR benchmark operation was cancelled');
	return true;
}

/** Free WASM model memory without discarding the retained fixture probability reference. */
export async function releaseOcrBenchmarkWasmSessions(): Promise<void> {
	if (benchmarkOperationInFlight) throw new Error('Cannot release WASM sessions during OCR inference');
	await Promise.all([releaseDetectorWasm(), releaseRecognizerWasm()]);
}

async function withExclusiveNativeMaintenance(
	operation: (signal: AbortSignal) => Promise<void>
): Promise<void> {
	const controller = new AbortController();
	acquireNativePPOcrExclusiveAccess(controller.signal);
	let completed = false;
	try {
		await operation(controller.signal);
		completed = true;
	} catch (error) {
		poisonNativePPOcrExclusiveAccess(controller.signal);
		throw error;
	} finally {
		if (completed) releaseNativePPOcrExclusiveAccess(controller.signal);
	}
}

/** Release all candidate sessions while retaining the copied WASM probability reference. */
export async function releaseOcrBenchmarkCandidateSessions(): Promise<void> {
	if (benchmarkOperationInFlight) throw new Error('Cannot release candidate sessions during OCR inference');
	await withExclusiveNativeMaintenance(async (signal) => {
		await Promise.all([releaseDetectorWasm(), releaseRecognizerWasm()]);
		await releaseNative(signal);
		await releaseNativeRecognizer(signal);
		try {
			const spike = await import('$lib/detection/ppocr-detector-webgpu-spike.js');
			await spike.releasePPOCRDetectorWebGPUSpike?.();
		} catch {
			// WebGPU was unavailable or never initialized.
		}
	});
}

/** Release every benchmark-owned session after an evidence run. */
export async function releaseOcrBenchmarkBackends(): Promise<void> {
	if (benchmarkOperationInFlight) throw new Error('Cannot release OCR backends during inference');
	await withExclusiveNativeMaintenance(async (signal) => {
		await Promise.all([releaseDetectorWasm(), releaseRecognizerWasm()]);
		await releaseNative(signal);
		await releaseNativeRecognizer(signal);
		try {
			const spike = await import('$lib/detection/ppocr-detector-webgpu-spike.js');
			await spike.releasePPOCRDetectorWebGPUSpike?.();
		} catch {
			// A build without the time-boxed WebGPU spike has nothing to release.
		}
	});
	wasmDetectorReference = null;
	nativeCpuDetectorReference = null;
}

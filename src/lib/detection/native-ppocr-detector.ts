/**
 * Android native ONNX Runtime bridge for PP-OCRv6 detection.
 *
 * Encoded image bytes cross into Kotlin once; decoded pixels, normalized CHW
 * tensors, ORT outputs, and DB post-processing stay native. The normal OCR
 * path receives only compact regions and metrics. A separate map mode returns
 * lossless Float32/LE Base64 only for inpainting and equivalence tests.
 */

import type { DetectedTextRegion } from '$lib/types/index.js';
import { parseBridgeRejection } from '$lib/i18n/errors.js';

export type NativePPOcrProvider = 'cpu' | 'xnnpack';

export interface NativePPOcrConfig {
	provider: NativePPOcrProvider;
	threads: number;
}

/** Metrics returned by detector session initialization, before any image run. */
export interface NativePPOcrSessionMetrics {
	requestedProvider: NativePPOcrProvider;
	provider: NativePPOcrProvider;
	providerFallback: boolean;
	providerFallbackReason: string | null;
	threads: number;
	ortIntraOpThreads: number;
	xnnpackIntraOpThreads: number;
	cpuFallbackEnabled: boolean;
	sessionReused: boolean;
	modelCacheHit: boolean;
	modelPreparationMs: number;
	sessionInitializationMs: number;
	modelAsset: string;
	modelSha256: string;
	modelBytes: number;
	packagedModelBytes: number;
	cacheModelBytes: number;
	ortVersion: string;
	availableProviders: string[];
}

export interface NativePPOcrMetrics extends NativePPOcrSessionMetrics {
	inputWidth: number;
	inputHeight: number;
	rawRegions: number;
	mergedRegions: number;
	encodedImageBytes: number;
	decodeMs: number;
	preprocessingMs: number;
	inferenceMs: number;
	postprocessingMs: number;
	totalMs: number;
	nativeHeapBytesBefore: number;
	nativeHeapBytesAfter: number;
	nativeHeapDeltaBytes: number;
	javaHeapBytesBefore: number;
	javaHeapBytesAfter: number;
	javaHeapDeltaBytes: number;
}

export interface NativePPOcrDetection {
	rawRegions: DetectedTextRegion[];
	mergedRegions: DetectedTextRegion[];
	imageWidth: number;
	imageHeight: number;
	metrics: NativePPOcrMetrics;
	probMap?: Float32Array;
	probMapWidth?: number;
	probMapHeight?: number;
}

export interface NativePPOcrRuntimeInfo {
	available: boolean;
	/** False until Android has actually loaded ORT and queried its providers. */
	probed?: boolean;
	ortVersion?: string;
	availableProviders?: string[];
	modelAsset?: string;
	modelSha256?: string;
	modelBytes?: number;
	packagedModelBytes?: number;
	cacheModelBytes?: number;
	sessionLoaded?: boolean;
	requestedProvider?: NativePPOcrProvider | 'none';
	provider?: NativePPOcrProvider | 'none';
	threads?: number;
	cpuFallbackEnabled?: boolean;
	error?: string;
	detector?: NativePPOcrRuntimeInfo;
	recognizer?: NativePPOcrRecognizerRuntimeInfo;
	packagedDictionaryBytes?: number;
}

export interface NativePPOcrRecognizerRuntimeInfo {
	available: boolean;
	/** False until Android has actually loaded ORT and queried its providers. */
	probed?: boolean;
	ortVersion?: string;
	availableProviders?: string[];
	modelAsset?: string;
	modelSha256?: string;
	modelBytes?: number;
	packagedModelBytes?: number;
	cacheModelBytes?: number;
	dictionaryAsset?: string;
	dictionarySha256?: string;
	dictionaryBytes?: number;
	packagedDictionaryBytes?: number;
	dictionaryEntries?: number;
	sessionLoaded?: boolean;
	requestedProvider?: NativePPOcrProvider | 'none';
	provider?: NativePPOcrProvider | 'none';
	threads?: number;
	cpuFallbackEnabled?: boolean;
	error?: string;
}

/** Metrics returned by recognizer session initialization, before any crop run. */
export interface NativePPOcrRecognizerSessionMetrics extends NativePPOcrSessionMetrics {
	dictionaryPreparationMs: number;
	dictionaryAsset: string;
	dictionarySha256: string;
	dictionaryBytes: number;
	packagedDictionaryBytes: number;
	dictionaryEntries: number;
}

export interface NativePPOcrRecognitionMetrics extends NativePPOcrRecognizerSessionMetrics {
	regions: number;
	results: number;
	plannedBatches: number;
	batchAttempts: number;
	fallbackBatches: number;
	maximumBatchWidth: number;
	encodedImageBytes: number;
	decodeImageMs: number;
	preprocessingMs: number;
	/** Direct-buffer allocation, zero-fill, CHW packing, and tensor wrapping. */
	inputPreparationMs: number;
	inferenceMs: number;
	decodeMs: number;
	totalMs: number;
	nativeHeapBytesBefore: number;
	nativeHeapBytesAfter: number;
	nativeHeapDeltaBytes: number;
	javaHeapBytesBefore: number;
	javaHeapBytesAfter: number;
	javaHeapDeltaBytes: number;
}

export interface NativePPOcrRecognitionResult {
	boxId: number;
	text: string;
	confidence: number;
}

export interface NativePPOcrRecognition {
	results: NativePPOcrRecognitionResult[];
	metrics: NativePPOcrRecognitionMetrics;
}

export interface NativePPOcrProbabilityComparison {
	values: number;
	maxAbsError: number;
	meanAbsError: number;
	rmse: number;
	overTolerance: number;
	nativeSha256: string;
	baselineSha256: string;
}

export interface NativePPOcrComparisonResult extends Omit<NativePPOcrDetection, 'probMap'> {
	comparison: NativePPOcrProbabilityComparison;
}

export interface NativePPOcrProviderProfileEvidence {
	component: 'detector' | 'recognizer';
	requestedProvider: NativePPOcrProvider;
	provider: NativePPOcrProvider;
	threads: number;
	inputCount: number;
	outputCount: number;
	isolatedOneShotSession: boolean;
	requestedProviderAssigned: boolean;
	xnnpackAssigned: boolean;
	cpuFallbackObserved: boolean;
	xnnpackNodeEvents: number;
	cpuNodeEvents: number;
	profileDeleted: boolean;
	profileBytes: number;
	traceEvents: number;
	nodeEvents: number;
	assignedNodeEvents: number;
	unassignedNodeEvents: number;
	providerNodeEvents: Record<string, number>;
	providerUniqueNodes: Record<string, number>;
	providerDurationMicros: Record<string, number>;
	providerOpCounts: Record<string, Record<string, number>>;
}

export interface NativePPOcrProviderAssignmentProfileV1 {
	schemaVersion: 1;
	requestedProvider: NativePPOcrProvider;
	threads: number;
	detector: NativePPOcrProviderProfileEvidence & {
		rawRegions: number;
		mergedRegions: number;
		imageWidth: number;
		imageHeight: number;
	};
	recognizer: NativePPOcrProviderProfileEvidence & {
		regions: number;
		results: number;
		regionsSource: 'supplied' | 'profiled-detector';
	};
}

export interface NativePPOcrProviderAssignmentProfileV2 {
	schemaVersion: 2;
	requested: {
		detector: NativePPOcrConfig;
		recognizer: NativePPOcrConfig;
	};
	detector: NativePPOcrProviderProfileEvidence & {
		rawRegions: number;
		mergedRegions: number;
		imageWidth: number;
		imageHeight: number;
	};
	recognizer: NativePPOcrProviderProfileEvidence & {
		regions: number;
		results: number;
		regionsSource: 'supplied' | 'profiled-detector';
	};
}

export type NativePPOcrProviderAssignmentProfile =
	| NativePPOcrProviderAssignmentProfileV1
	| NativePPOcrProviderAssignmentProfileV2;

export interface NativePPOcrProviderProfileConfigs {
	detector: NativePPOcrConfig;
	recognizer: NativePPOcrConfig;
}

type NativeBridge = {
	isAvailable?: () => boolean;
	isRecognizerAvailable?: () => boolean;
	getRuntimeInfo?: () => string;
	initialize?: (provider: string, threads: number, callbackId: string) => void;
	detectImage?: (
		imageBase64: string,
		provider: string,
		threads: number,
		targetLongestEdge: number,
		callbackId: string
	) => void;
	materializeWasmModelAsset?: (component: string, callbackId: string) => void;
	detectImageWithProbabilityMap?: (
		imageBase64: string,
		provider: string,
		threads: number,
		callbackId: string
	) => void;
	compareProbabilityMap?: (
		imageBase64: string,
		baselineFloat32Base64: string,
		baselineWidth: number,
		baselineHeight: number,
		absoluteTolerance: number,
		provider: string,
		threads: number,
		callbackId: string
	) => void;
	profileProviderAssignment?: (
		imageBase64: string,
		regionsJson: string,
		provider: string,
		threads: number,
		callbackId: string
	) => void;
	profileProviderAssignments?: (
		imageBase64: string,
		regionsJson: string,
		detectorProvider: string,
		detectorThreads: number,
		recognizerProvider: string,
		recognizerThreads: number,
		callbackId: string
	) => void;
	release?: (callbackId: string) => void;
	initializeRecognizer?: (provider: string, threads: number, callbackId: string) => void;
	recognizeImage?: (
		imageBase64: string,
		regionsJson: string,
		provider: string,
		threads: number,
		callbackId: string
	) => void;
	releaseRecognizer?: (callbackId: string) => void;
	cancel?: (callbackId: string) => boolean;
};

type PendingCallback = {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	bridge: NativeBridge;
	signal?: AbortSignal;
	abortListener?: () => void;
};

const pendingCallbacks = new Map<string, PendingCallback>();
let exclusiveOperationSignal: AbortSignal | null = null;
let exclusiveAccessPoisoned = false;
let callbackCounter = 0;
const INITIALIZATION_TIMEOUT_MS = 180_000;
const DETECTION_TIMEOUT_MS = 180_000;
const RECOGNITION_TIMEOUT_MS = 180_000;
const PROVIDER_PROFILE_TIMEOUT_MS = 300_000;
const RELEASE_TIMEOUT_MS = 30_000;

export const DEFAULT_NATIVE_PPOCR_DETECTOR_CONFIG: Readonly<NativePPOcrConfig> = {
	provider: 'cpu',
	threads: 6
};

export const DEFAULT_NATIVE_PPOCR_RECOGNIZER_CONFIG: Readonly<NativePPOcrConfig> = {
	provider: 'cpu',
	threads: 2
};

function settleCallback(
	callbackId: string,
	settle: (callback: Pick<PendingCallback, 'resolve' | 'reject'>) => void
): void {
	const callback = pendingCallbacks.get(callbackId);
	if (!callback) return;
	pendingCallbacks.delete(callbackId);
	clearTimeout(callback.timer);
	if (callback.signal && callback.abortListener) {
		callback.signal.removeEventListener('abort', callback.abortListener);
	}
	settle(callback);
}

if (typeof window !== 'undefined') {
	const nativeWindow = window as unknown as Record<string, unknown>;
	nativeWindow.__ppocr_native_resolve = (callbackId: string, resultJson: string) => {
		settleCallback(callbackId, (callback) => callback.resolve(resultJson));
	};
	nativeWindow.__ppocr_native_reject = (callbackId: string, errorMessage: string) => {
		settleCallback(callbackId, (callback) => callback.reject(parseBridgeRejection(errorMessage)));
	};
}

function getBridge(): NativeBridge | null {
	if (typeof window === 'undefined') return null;
	return (
		((window as unknown as Record<string, unknown>).__fumeto_ppocr_native as NativeBridge | undefined) ??
		null
	);
}

/**
 * Reserves the shared Android detector/recognizer singleton for a controlled
 * benchmark operation. Existing reader OCR is never cancelled to acquire it.
 */
export function acquireNativePPOcrExclusiveAccess(signal: AbortSignal): void {
	if (signal.aborted) throw new Error('Cannot acquire native PP-OCR exclusive access with an aborted signal');
	if (exclusiveOperationSignal) throw new Error('Native PP-OCR exclusive access is already held');
	if (pendingCallbacks.size > 0) {
		throw new Error(
			`Native PP-OCR exclusive access refused because ${pendingCallbacks.size} external operation(s) are active`
		);
	}
	exclusiveOperationSignal = signal;
	exclusiveAccessPoisoned = false;
}

export function releaseNativePPOcrExclusiveAccess(signal: AbortSignal): boolean {
	if (exclusiveOperationSignal !== signal || exclusiveAccessPoisoned || signal.aborted) return false;
	exclusiveOperationSignal = null;
	return true;
}

export function poisonNativePPOcrExclusiveAccess(signal: AbortSignal): boolean {
	if (exclusiveOperationSignal !== signal) return false;
	exclusiveAccessPoisoned = true;
	return true;
}

function invokeCallback(
	timeoutMs: number,
	operation: string,
	invoke: (bridge: NativeBridge, callbackId: string) => void,
	signal?: AbortSignal
): Promise<string> {
	if (exclusiveOperationSignal && signal !== exclusiveOperationSignal) {
		return Promise.reject(new Error('Native PP-OCR is reserved for an exclusive benchmark operation'));
	}
	const bridge = getBridge();
	if (!bridge) return Promise.reject(new Error('Native PP-OCR detector bridge is unavailable'));
	const callbackId = `ppocr_native_${++callbackCounter}_${Date.now()}`;
	const promise = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (signal && exclusiveOperationSignal === signal) exclusiveAccessPoisoned = true;
			try {
				bridge.cancel?.(callbackId);
			} catch {
				// The timeout remains authoritative even if native cancellation fails.
			}
			settleCallback(callbackId, (callback) => {
				callback.reject(
					new Error(`${operation} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)
				);
			});
		}, timeoutMs);
		const abortListener = signal
			? () => {
				if (exclusiveOperationSignal === signal) exclusiveAccessPoisoned = true;
				try {
					bridge.cancel?.(callbackId);
				} catch {
					// The callback owner still rejects even if native cancellation fails.
				}
				settleCallback(callbackId, (callback) => {
					callback.reject(new Error(`${operation} cancelled`));
				});
			}
			: undefined;
		pendingCallbacks.set(callbackId, { resolve, reject, timer, bridge, signal, abortListener });
		if (signal && abortListener) {
			signal.addEventListener('abort', abortListener, { once: true });
			if (signal.aborted) abortListener();
		}
	});
	// An already-aborted signal settles the callback before native work starts.
	if (!pendingCallbacks.has(callbackId)) return promise;
	try {
		invoke(bridge, callbackId);
	} catch (error) {
		settleCallback(callbackId, (callback) => {
			callback.reject(error instanceof Error ? error : new Error(String(error)));
		});
	}
	return promise;
}

function validateConfig(config: NativePPOcrConfig): NativePPOcrConfig {
	if (config.provider !== 'cpu' && config.provider !== 'xnnpack') {
		throw new Error(`Unsupported native PP-OCR provider: ${String(config.provider)}`);
	}
	if (!Number.isInteger(config.threads) || config.threads < 1 || config.threads > 16) {
		throw new Error('Native PP-OCR threads must be an integer between 1 and 16');
	}
	return config;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeCountRecord(value: unknown): value is Record<string, number> {
	return isPlainRecord(value) && Object.entries(value).every(
		([name, count]) => name.length > 0 && isNonnegativeSafeInteger(count)
	);
}

function isNonnegativeFiniteNumberRecord(value: unknown): value is Record<string, number> {
	return isPlainRecord(value) && Object.entries(value).every(
		([name, amount]) => name.length > 0
			&& typeof amount === 'number'
			&& Number.isFinite(amount)
			&& amount >= 0
	);
}

function isProviderOpCountRecord(value: unknown): value is Record<string, Record<string, number>> {
	return isPlainRecord(value) && Object.entries(value).every(
		([provider, counts]) => provider.length > 0 && isNonnegativeCountRecord(counts)
	);
}

function hasValidProviderProfileComponent(
	value: unknown,
	component: 'detector' | 'recognizer',
	config: NativePPOcrConfig
): value is NativePPOcrProviderProfileEvidence {
	if (!isPlainRecord(value)) return false;
	const countFields = [
		'inputCount',
		'outputCount',
		'xnnpackNodeEvents',
		'cpuNodeEvents',
		'profileBytes',
		'traceEvents',
		'nodeEvents',
		'assignedNodeEvents',
		'unassignedNodeEvents'
	] as const;
	const booleanFields = [
		'isolatedOneShotSession',
		'requestedProviderAssigned',
		'xnnpackAssigned',
		'cpuFallbackObserved',
		'profileDeleted'
	] as const;
	return value.component === component
		&& value.requestedProvider === config.provider
		&& value.provider === config.provider
		&& value.threads === config.threads
		&& countFields.every((field) => isNonnegativeSafeInteger(value[field]))
		&& booleanFields.every((field) => typeof value[field] === 'boolean')
		&& isNonnegativeCountRecord(value.providerNodeEvents)
		&& isNonnegativeCountRecord(value.providerUniqueNodes)
		&& isNonnegativeFiniteNumberRecord(value.providerDurationMicros)
		&& isProviderOpCountRecord(value.providerOpCounts);
}

function hasValidDetectorProfileDetails(value: unknown): boolean {
	return isPlainRecord(value)
		&& isNonnegativeSafeInteger(value.rawRegions)
		&& isNonnegativeSafeInteger(value.mergedRegions)
		&& isNonnegativeSafeInteger(value.imageWidth)
		&& isNonnegativeSafeInteger(value.imageHeight);
}

function hasValidRecognizerProfileDetails(value: unknown): boolean {
	return isPlainRecord(value)
		&& isNonnegativeSafeInteger(value.regions)
		&& isNonnegativeSafeInteger(value.results)
		&& (value.regionsSource === 'supplied' || value.regionsSource === 'profiled-detector');
}

function hasValidProviderAssignmentComponents(
	value: unknown,
	detectorConfig: NativePPOcrConfig,
	recognizerConfig: NativePPOcrConfig
): boolean {
	if (!isPlainRecord(value)) return false;
	return hasValidProviderProfileComponent(value.detector, 'detector', detectorConfig)
		&& hasValidDetectorProfileDetails(value.detector)
		&& hasValidProviderProfileComponent(value.recognizer, 'recognizer', recognizerConfig)
		&& hasValidRecognizerProfileDetails(value.recognizer);
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error('Unable to encode detector image'));
		reader.onload = () => {
			if (typeof reader.result !== 'string') {
				reject(new Error('Detector image did not encode as a data URL'));
				return;
			}
			resolve(reader.result);
		};
		reader.readAsDataURL(blob);
	});
}

function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function float32ToLittleEndianBase64(values: Float32Array): string {
	const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < values.length; index++) {
		view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, values[index], true);
	}
	return bytesToBase64(bytes);
}

export function decodeLittleEndianFloat32Base64(encoded: string): Float32Array {
	const binary = atob(encoded);
	if (binary.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
		throw new Error(`Native probability-map byte length is invalid: ${binary.length}`);
	}
	const values = new Float32Array(binary.length / Float32Array.BYTES_PER_ELEMENT);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < values.length; index++) {
		values[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
	}
	return values;
}

function parseDetectionResult(resultJson: string, includeProbabilityMap: boolean): NativePPOcrDetection {
	const parsed = JSON.parse(resultJson) as NativePPOcrDetection & {
		probabilityMapFloat32Base64?: string;
		probabilityMapWidth?: number;
		probabilityMapHeight?: number;
		probabilityMapValues?: number;
	};
	if (!Array.isArray(parsed.rawRegions) || !Array.isArray(parsed.mergedRegions)) {
		throw new Error('Native PP-OCR result did not contain region arrays');
	}
	if (includeProbabilityMap) {
		if (typeof parsed.probabilityMapFloat32Base64 !== 'string') {
			throw new Error('Native PP-OCR result did not contain a probability map');
		}
		const probMap = decodeLittleEndianFloat32Base64(parsed.probabilityMapFloat32Base64);
		const width = parsed.probabilityMapWidth;
		const height = parsed.probabilityMapHeight;
		if (!Number.isInteger(width) || !Number.isInteger(height) || width! * height! !== probMap.length) {
			throw new Error('Native PP-OCR probability-map shape is invalid');
		}
		parsed.probMap = probMap;
		parsed.probMapWidth = width;
		parsed.probMapHeight = height;
		delete parsed.probabilityMapFloat32Base64;
	}
	return parsed;
}

export function isNativePPOcrAvailable(): boolean {
	const bridge = getBridge();
	if (!bridge?.isAvailable) return false;
	try {
		return bridge.isAvailable() === true;
	} catch {
		return false;
	}
}

export function isNativePPOcrRecognizerAvailable(): boolean {
	const bridge = getBridge();
	if (!bridge?.isRecognizerAvailable) return false;
	try {
		return bridge.isRecognizerAvailable() === true;
	} catch {
		return false;
	}
}

export function getNativePPOcrRuntimeInfo(): NativePPOcrRuntimeInfo {
	const bridge = getBridge();
	if (!bridge?.getRuntimeInfo) return { available: false };
	try {
		return JSON.parse(bridge.getRuntimeInfo()) as NativePPOcrRuntimeInfo;
	} catch (error) {
		return { available: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function initializeNativePPOcr(
	config: NativePPOcrConfig = DEFAULT_NATIVE_PPOCR_DETECTOR_CONFIG,
	signal?: AbortSignal
): Promise<NativePPOcrSessionMetrics> {
	const validated = validateConfig(config);
	const result = await invokeCallback(
		INITIALIZATION_TIMEOUT_MS,
		'Native PP-OCR initialization',
		(bridge, callbackId) => {
			if (!bridge.initialize) throw new Error('Native PP-OCR initialize method is unavailable');
			bridge.initialize(validated.provider, validated.threads, callbackId);
		},
		signal
	);
	return (JSON.parse(result) as { metrics: NativePPOcrSessionMetrics }).metrics;
}

export async function initializeNativePPOcrRecognizer(
	config: NativePPOcrConfig = DEFAULT_NATIVE_PPOCR_RECOGNIZER_CONFIG,
	signal?: AbortSignal
): Promise<NativePPOcrRecognizerSessionMetrics> {
	const validated = validateConfig(config);
	const result = await invokeCallback(
		INITIALIZATION_TIMEOUT_MS,
		'Native PP-OCR recognizer initialization',
		(bridge, callbackId) => {
			if (!bridge.initializeRecognizer) {
				throw new Error('Native PP-OCR recognizer initialize method is unavailable');
			}
			bridge.initializeRecognizer(validated.provider, validated.threads, callbackId);
		},
		signal
	);
	return (JSON.parse(result) as { metrics: NativePPOcrRecognizerSessionMetrics }).metrics;
}

export async function recognizeTextRegionsNative(
	imageBlob: Blob,
	regions: DetectedTextRegion[],
	options: { config?: NativePPOcrConfig; signal?: AbortSignal } = {}
): Promise<NativePPOcrRecognition> {
	const config = validateConfig(options.config ?? DEFAULT_NATIVE_PPOCR_RECOGNIZER_CONFIG);
	if (options.signal?.aborted) throw new Error('Native PP-OCR recognition cancelled');
	const encodedImage = await blobToDataUrl(imageBlob);
	if (options.signal?.aborted) throw new Error('Native PP-OCR recognition cancelled');
	const compactRegions = regions.map(({ boxId, x, y, width, height, confidence }) => ({
		boxId,
		x,
		y,
		width,
		height,
		confidence
	}));
	const result = await invokeCallback(
		RECOGNITION_TIMEOUT_MS,
		'Native PP-OCR recognition',
		(bridge, callbackId) => {
			if (!bridge.recognizeImage) {
				throw new Error('Native PP-OCR recognize method is unavailable');
			}
			bridge.recognizeImage(
				encodedImage,
				JSON.stringify(compactRegions),
				config.provider,
				config.threads,
				callbackId
			);
		},
		options.signal
	);
	const parsed = JSON.parse(result) as NativePPOcrRecognition;
	if (!Array.isArray(parsed.results) || !parsed.metrics) {
		throw new Error('Native PP-OCR recognizer result is invalid');
	}
	return parsed;
}

export async function detectTextRegionsNative(
	imageBlob: Blob,
	options: {
		config?: NativePPOcrConfig;
		includeProbabilityMap?: boolean;
		signal?: AbortSignal;
		/** Longest-edge input override (fusion retry); 0/omitted = adaptive. */
		targetLongestEdge?: number;
	} = {}
): Promise<NativePPOcrDetection> {
	const config = validateConfig(options.config ?? DEFAULT_NATIVE_PPOCR_DETECTOR_CONFIG);
	const includeProbabilityMap = options.includeProbabilityMap === true;
	const targetLongestEdge = validateTargetLongestEdge(options.targetLongestEdge);
	if (options.signal?.aborted) throw new Error('Native PP-OCR detection cancelled');
	const encodedImage = await blobToDataUrl(imageBlob);
	if (options.signal?.aborted) throw new Error('Native PP-OCR detection cancelled');
	const result = await invokeCallback(DETECTION_TIMEOUT_MS, 'Native PP-OCR detection', (bridge, id) => {
		if (includeProbabilityMap) {
			if (!bridge.detectImageWithProbabilityMap) {
				throw new Error('Native PP-OCR probability-map method is unavailable');
			}
			bridge.detectImageWithProbabilityMap(encodedImage, config.provider, config.threads, id);
		} else {
			if (!bridge.detectImage) throw new Error('Native PP-OCR detect method is unavailable');
			bridge.detectImage(encodedImage, config.provider, config.threads, targetLongestEdge, id);
		}
	}, options.signal);
	return parseDetectionResult(result, includeProbabilityMap);
}

export interface MaterializedWasmModel {
	path: string;
	bytes: number;
}

/**
 * Copy a pruned-from-the-embed PP-OCR model out of the APK's native assets
 * into the app data directory so the WASM fallback can read it via plugin-fs.
 * Android-only; throws where the native bridge is unavailable.
 */
export async function materializeNativeWasmModel(
	component: 'detector' | 'recognizer',
	signal?: AbortSignal
): Promise<MaterializedWasmModel> {
	// WASM session init inside an exclusive benchmark lease triggers this call;
	// join the active lease instead of being rejected by the exclusivity gate.
	const effectiveSignal = exclusiveOperationSignal ?? signal;
	const result = await invokeCallback(
		DETECTION_TIMEOUT_MS,
		'Native PP-OCR WASM model materialization',
		(bridge, callbackId) => {
			if (!bridge.materializeWasmModelAsset) {
				throw new Error('Native PP-OCR WASM model materialization is unavailable');
			}
			bridge.materializeWasmModelAsset(component, callbackId);
		},
		effectiveSignal
	);
	const parsed = JSON.parse(result) as MaterializedWasmModel & { success?: boolean };
	if (!parsed.path || !Number.isFinite(parsed.bytes) || parsed.bytes <= 0) {
		throw new Error('Native PP-OCR WASM model materialization returned invalid metadata');
	}
	return { path: parsed.path, bytes: parsed.bytes };
}

function validateTargetLongestEdge(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isInteger(value) || value < 32 || value > 8192) {
		throw new Error(`Invalid PP-OCR detector target longest edge: ${value}`);
	}
	return value;
}

export async function compareNativePPOcrProbabilityMap(
	imageBlob: Blob,
	baseline: Float32Array,
	baselineWidth: number,
	baselineHeight: number,
	absoluteTolerance: number,
	config: NativePPOcrConfig,
	signal?: AbortSignal
): Promise<NativePPOcrComparisonResult> {
	const validated = validateConfig(config);
	if (baselineWidth * baselineHeight !== baseline.length) {
		throw new Error('Baseline PP-OCR probability-map shape is invalid');
	}
	if (!Number.isFinite(absoluteTolerance) || absoluteTolerance < 0) {
		throw new Error('Probability-map tolerance must be finite and non-negative');
	}
	const [encodedImage, encodedBaseline] = await Promise.all([
		blobToDataUrl(imageBlob),
		Promise.resolve(float32ToLittleEndianBase64(baseline))
	]);
	const result = await invokeCallback(
		DETECTION_TIMEOUT_MS,
		'Native PP-OCR probability-map comparison',
		(bridge, callbackId) => {
			if (!bridge.compareProbabilityMap) {
				throw new Error('Native PP-OCR comparison method is unavailable');
			}
			bridge.compareProbabilityMap(
				encodedImage,
				encodedBaseline,
				baselineWidth,
				baselineHeight,
				absoluteTolerance,
				validated.provider,
				validated.threads,
				callbackId
			);
		},
		signal
	);
	return JSON.parse(result) as NativePPOcrComparisonResult;
}

/**
 * Debug benchmark evidence from isolated native ORT sessions. The returned
 * counts come from real ORT node trace events, not provider registration.
 */
export async function profileNativePPOcrProviderAssignment(
	imageBlob: Blob,
	regions: DetectedTextRegion[],
	config: NativePPOcrConfig,
	signal?: AbortSignal
): Promise<NativePPOcrProviderAssignmentProfileV1> {
	const validated = validateConfig(config);
	const encodedImage = await blobToDataUrl(imageBlob);
	const compactRegions = compactProviderProfileRegions(regions);
	const result = await invokeCallback(
		PROVIDER_PROFILE_TIMEOUT_MS,
		'Native PP-OCR provider profiling',
		(bridge, callbackId) => {
			if (!bridge.profileProviderAssignment) {
				throw new Error('Native PP-OCR provider profiling is unavailable in this build');
			}
			bridge.profileProviderAssignment(
				encodedImage,
				JSON.stringify(compactRegions),
				validated.provider,
				validated.threads,
				callbackId
			);
		},
		signal
	);
	const parsed = JSON.parse(result) as NativePPOcrProviderAssignmentProfileV1;
	if (
		parsed.schemaVersion !== 1 ||
		parsed.requestedProvider !== validated.provider ||
		parsed.threads !== validated.threads ||
		!hasValidProviderAssignmentComponents(parsed, validated, validated)
	) {
		throw new Error('Native PP-OCR provider profile result is invalid');
	}
	return parsed;
}

function compactProviderProfileRegions(regions: DetectedTextRegion[]): Array<{
	boxId: number;
	x: number;
	y: number;
	width: number;
	height: number;
	confidence: number;
}> {
	return regions.map(({ boxId, x, y, width, height, confidence }) => ({
		boxId,
		x,
		y,
		width,
		height,
		confidence
	}));
}

function sameNativeConfig(left: NativePPOcrConfig, right: NativePPOcrConfig): boolean {
	return left.provider === right.provider && left.threads === right.threads;
}

/**
 * Profiles detector and recognizer with independently selected ORT settings.
 * Older benchmark APKs may service an identical pair through the schema-v1
 * bridge. A genuinely mixed request never silently collapses to that legacy API.
 */
export async function profileNativePPOcrProviderAssignments(
	imageBlob: Blob,
	regions: DetectedTextRegion[],
	configs: NativePPOcrProviderProfileConfigs,
	signal?: AbortSignal
): Promise<NativePPOcrProviderAssignmentProfile> {
	const detector = validateConfig(configs.detector);
	const recognizer = validateConfig(configs.recognizer);
	const bridge = getBridge();
	if (!bridge?.profileProviderAssignments) {
		if (sameNativeConfig(detector, recognizer) && bridge?.profileProviderAssignment) {
			return profileNativePPOcrProviderAssignment(imageBlob, regions, detector, signal);
		}
		throw new Error(
			'Mixed native PP-OCR provider profiling is unavailable in this build; ' +
			'the detector and recognizer configuration was not profiled'
		);
	}

	const encodedImage = await blobToDataUrl(imageBlob);
	const compactRegions = compactProviderProfileRegions(regions);
	const result = await invokeCallback(
		PROVIDER_PROFILE_TIMEOUT_MS,
		'Native mixed PP-OCR provider profiling',
		(activeBridge, callbackId) => {
			if (!activeBridge.profileProviderAssignments) {
				throw new Error('Mixed native PP-OCR provider profiling became unavailable');
			}
			activeBridge.profileProviderAssignments(
				encodedImage,
				JSON.stringify(compactRegions),
				detector.provider,
				detector.threads,
				recognizer.provider,
				recognizer.threads,
				callbackId
			);
		},
		signal
	);
	const parsed = JSON.parse(result) as NativePPOcrProviderAssignmentProfileV2;
	if (
		parsed.schemaVersion !== 2 ||
		!parsed.requested ||
		parsed.requested.detector?.provider !== detector.provider ||
		parsed.requested.detector?.threads !== detector.threads ||
		parsed.requested.recognizer?.provider !== recognizer.provider ||
		parsed.requested.recognizer?.threads !== recognizer.threads ||
		!hasValidProviderAssignmentComponents(parsed, detector, recognizer)
	) {
		throw new Error('Native mixed PP-OCR provider profile result is invalid');
	}
	return parsed;
}


export async function releaseNativePPOcr(signal?: AbortSignal): Promise<boolean> {
	const result = await invokeCallback(RELEASE_TIMEOUT_MS, 'Native PP-OCR release', (bridge, id) => {
		if (!bridge.release) throw new Error('Native PP-OCR release method is unavailable');
		bridge.release(id);
	}, signal);
	return (JSON.parse(result) as { released: boolean }).released;
}

export async function releaseNativePPOcrRecognizer(signal?: AbortSignal): Promise<boolean> {
	const result = await invokeCallback(
		RELEASE_TIMEOUT_MS,
		'Native PP-OCR recognizer release',
		(bridge, callbackId) => {
			if (!bridge.releaseRecognizer) {
				throw new Error('Native PP-OCR recognizer release method is unavailable');
			}
			bridge.releaseRecognizer(callbackId);
		},
		signal
	);
	return (JSON.parse(result) as { released: boolean }).released;
}

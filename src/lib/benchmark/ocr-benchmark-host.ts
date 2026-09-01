/** Debug-only, in-memory fixture host for device OCR benchmarks. */

import type {
	OcrBenchmarkCapabilities,
	OcrBenchmarkRequest,
	OcrBenchmarkRunResult,
	OcrProviderProfileRequest,
	OcrProviderProfileResult
} from './ocr-benchmark-api.js';
import { OCR_BENCHMARK_CANCEL_SETTLE_TIMEOUT_MS } from './ocr-benchmark-timeouts.js';

export { OCR_BENCHMARK_CANCEL_SETTLE_TIMEOUT_MS } from './ocr-benchmark-timeouts.js';

export interface OcrBenchmarkFixtureDescriptor {
	id: string;
	base64: string;
	mimeType: string;
	sha256: string;
}

export interface LoadedOcrBenchmarkFixture {
	id: string;
	mimeType: string;
	sha256: string;
	bytes: number;
}

export interface OcrBenchmarkFixtureRunResult extends OcrBenchmarkRunResult {
	fixture: LoadedOcrBenchmarkFixture;
}

export type OcrProviderProfileFixtureResult = OcrProviderProfileResult & {
	fixture: LoadedOcrBenchmarkFixture;
};

export interface OcrBenchmarkHostApi {
	loadFixture(descriptor: OcrBenchmarkFixtureDescriptor): Promise<LoadedOcrBenchmarkFixture>;
	inspectFixture(): LoadedOcrBenchmarkFixture | null;
	getCapabilities(): Promise<OcrBenchmarkCapabilities>;
	runFixture(request: OcrBenchmarkRequest): Promise<OcrBenchmarkFixtureRunResult>;
	profileNativeProviderAssignment(
		request: OcrProviderProfileRequest
	): Promise<OcrProviderProfileFixtureResult>;
	cancelActiveOperation(reason: string): Promise<boolean>;
	releaseWasmSessions(): Promise<void>;
	releaseCandidateSessions(): Promise<void>;
	release(): Promise<void>;
	clearFixture(): Promise<void>;
}

const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;

async function awaitCancellationSettlement(completion: Promise<void>, reason: string): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | null = null;
	try {
		await Promise.race([
			completion,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(
					`OCR benchmark cancellation did not settle within ${OCR_BENCHMARK_CANCEL_SETTLE_TIMEOUT_MS} ms: ${reason}`
				)), OCR_BENCHMARK_CANCEL_SETTLE_TIMEOUT_MS);
			})
		]);
	} finally {
		if (timeout !== null) clearTimeout(timeout);
	}
}

function hex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	if (binary.length > MAX_FIXTURE_BYTES) {
		throw new Error(`OCR benchmark fixture exceeds ${MAX_FIXTURE_BYTES} bytes`);
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * Installs an in-memory fixture API only when MainActivity reports a benchmark
 * (debug) build. No setting, IndexedDB row, library, overlay, or page state is
 * read or written by this host.
 */
export function installOcrBenchmarkHost(): (() => void) | null {
	if (typeof window === 'undefined') return null;
	const benchmarkWindow = window as unknown as Record<string, unknown>;
	const buildBridge = benchmarkWindow.__fumeto_llama as { isBenchmarkBuild?: () => boolean } | undefined;
	if (buildBridge?.isBenchmarkBuild?.() !== true) return null;

	let fixture: { descriptor: LoadedOcrBenchmarkFixture; file: File } | null = null;
	let inFlight = false;
	let activeOperation: { work: Promise<unknown>; completion: Promise<void> } | null = null;

	const api: OcrBenchmarkHostApi = {
		loadFixture: async (descriptor) => {
			if (inFlight) throw new Error('Cannot replace the OCR fixture during a benchmark');
			if (!descriptor.id.trim()) throw new Error('OCR fixture id is required');
			if (!/^[a-f0-9]{64}$/i.test(descriptor.sha256)) throw new Error('OCR fixture SHA-256 is invalid');
			if (!descriptor.mimeType.startsWith('image/')) throw new Error('OCR fixture must be an image');
			const { releaseOcrBenchmarkBackends } = await import('./ocr-benchmark-api.js');
			await releaseOcrBenchmarkBackends();
			const decoded = decodeBase64(descriptor.base64);
			const bytes = new ArrayBuffer(decoded.byteLength);
			new Uint8Array(bytes).set(decoded);
			const actualSha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
			if (actualSha256.toLowerCase() !== descriptor.sha256.toLowerCase()) {
				throw new Error(`OCR fixture digest mismatch: expected ${descriptor.sha256}, got ${actualSha256}`);
			}
			const loaded: LoadedOcrBenchmarkFixture = {
				id: descriptor.id,
				mimeType: descriptor.mimeType,
				sha256: actualSha256,
				bytes: bytes.byteLength
			};
			fixture = {
				descriptor: loaded,
				file: new File([bytes], `${descriptor.id}.fixture`, { type: descriptor.mimeType })
			};
			return loaded;
		},
		inspectFixture: () => fixture?.descriptor ?? null,
		getCapabilities: async () => {
			const { getOcrBenchmarkCapabilities } = await import('./ocr-benchmark-api.js');
			return getOcrBenchmarkCapabilities();
		},
		runFixture: async (request) => {
			if (!fixture) throw new Error('Load an exact OCR benchmark fixture before inference');
			const loadedFixture = fixture;
			if (inFlight) throw new Error('An OCR fixture benchmark is already running');
			inFlight = true;
			let resolveCompletion!: () => void;
			const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
			const operation = (async () => {
				const { runOcrBenchmark } = await import('./ocr-benchmark-api.js');
				return {
					...(await runOcrBenchmark(loadedFixture.file, {
						...request,
						referenceIdentity: loadedFixture.descriptor.sha256
					})),
					fixture: loadedFixture.descriptor
				};
			})();
			activeOperation = { work: operation, completion };
			try {
				return await operation;
			} finally {
				inFlight = false;
				resolveCompletion();
				if (activeOperation?.work === operation) activeOperation = null;
			}
		},
		profileNativeProviderAssignment: async (request) => {
			if (!fixture) throw new Error('Load an exact OCR benchmark fixture before profiling');
			const loadedFixture = fixture;
			if (inFlight) throw new Error('An OCR fixture benchmark is already running');
			inFlight = true;
			let resolveCompletion!: () => void;
			const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
			const operation = (async () => {
				const { profileOcrNativeProviderAssignment } = await import('./ocr-benchmark-api.js');
				return {
					...(await profileOcrNativeProviderAssignment(loadedFixture.file, request)),
					fixture: loadedFixture.descriptor
				};
			})();
			activeOperation = { work: operation, completion };
			try {
				return await operation;
			} finally {
				inFlight = false;
				resolveCompletion();
				if (activeOperation?.work === operation) activeOperation = null;
			}
		},
		cancelActiveOperation: async (reason) => {
			const operation = activeOperation;
			if (!operation) return false;
			const { cancelOcrBenchmarkOperation } = await import('./ocr-benchmark-api.js');
			const cancelled = cancelOcrBenchmarkOperation(reason);
			// Native cancellation rejects the active promise synchronously. Await the
			// host wrapper's finally block so its inFlight guard is also released.
			// Fail closed if native termination claims success but never settles.
			if (cancelled) await awaitCancellationSettlement(operation.completion, reason);
			return cancelled;
		},
		releaseWasmSessions: async () => {
			if (inFlight) throw new Error('Cannot release WASM sessions during a benchmark');
			const { releaseOcrBenchmarkWasmSessions } = await import('./ocr-benchmark-api.js');
			await releaseOcrBenchmarkWasmSessions();
		},
		releaseCandidateSessions: async () => {
			if (inFlight) throw new Error('Cannot release candidate sessions during a benchmark');
			const { releaseOcrBenchmarkCandidateSessions } = await import('./ocr-benchmark-api.js');
			await releaseOcrBenchmarkCandidateSessions();
		},
		release: async () => {
			if (inFlight) throw new Error('Cannot release OCR backends during a benchmark');
			const { releaseOcrBenchmarkBackends } = await import('./ocr-benchmark-api.js');
			await releaseOcrBenchmarkBackends();
		},
		clearFixture: async () => {
			if (inFlight) throw new Error('Cannot clear the OCR fixture during a benchmark');
			await api.release();
			fixture = null;
		}
	};

	benchmarkWindow.__fumeto_ocr_benchmark = api;
	return () => {
		if (benchmarkWindow.__fumeto_ocr_benchmark === api) {
			delete benchmarkWindow.__fumeto_ocr_benchmark;
		}
		fixture = null;
		void api.release().catch(() => {});
	};
}

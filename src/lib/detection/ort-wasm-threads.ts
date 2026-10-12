/**
 * ONNX Runtime's WebAssembly thread count, decided in one place.
 *
 * ORT reads `env.wasm.numThreads` once per page, when the first session
 * starts its runtime, so whichever caller gets there first — PP-OCR
 * detection, PP-OCR recognition, or the layout/candidate models — decides for
 * all of them. They have to agree.
 *
 * Threads need SharedArrayBuffer, and so a cross-origin-isolated page.
 * Android and the browser keep the counts they always had: PP-OCR
 * single-threaded (on Android it runs natively; WebAssembly is its rescue
 * path), the candidate models threaded wherever the page is isolated. The Mac
 * app is the one place WebAssembly is the production engine for every vision
 * model, and WebKit ignores the `credentialless` embedder policy the other
 * platforms use, so `tauri.macos.conf.json` asks for `require-corp` instead.
 * When that isolates the page, every caller gets the same threaded runtime:
 * half the logical cores, at most four — the performance cores, or fewer, on
 * Apple Silicon.
 */

import { isMacOS, isTauriDesktop } from '$lib/util/platform.js';

export type OrtWasmCaller = 'ppocr' | 'candidate';

export interface OrtWasmEnvironment {
	/** The macOS app, as opposed to a browser on a Mac. */
	macApp: boolean;
	crossOriginIsolated: boolean;
	sharedArrayBuffer: boolean;
	hardwareConcurrency: number;
}

const MAX_THREADS = 4;

export function ortWasmThreads(caller: OrtWasmCaller, env: OrtWasmEnvironment): number {
	const cores =
		Number.isFinite(env.hardwareConcurrency) && env.hardwareConcurrency > 0
			? Math.floor(env.hardwareConcurrency)
			: 1;
	if (env.macApp && env.crossOriginIsolated) {
		return Math.min(MAX_THREADS, Math.max(1, Math.floor(cores / 2)));
	}
	if (caller === 'ppocr') return 1;
	// ORT falls back to one thread silently without SharedArrayBuffer, so this
	// is a free upside wherever the WebView grants isolation.
	return env.sharedArrayBuffer ? Math.min(MAX_THREADS, cores) : 1;
}

function currentEnvironment(): OrtWasmEnvironment {
	return {
		macApp: isMacOS && isTauriDesktop(),
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
		hardwareConcurrency: typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency
	};
}

let reported = false;

/**
 * Set `numThreads` on ORT's wasm environment for `caller`. The first call of
 * the page logs the count, which is the one ORT will actually use.
 */
export function applyOrtWasmThreads(
	wasm: { numThreads?: number },
	caller: OrtWasmCaller,
	env: OrtWasmEnvironment = currentEnvironment()
): number {
	const threads = ortWasmThreads(caller, env);
	wasm.numThreads = threads;
	if (!reported) {
		reported = true;
		console.log(`[ort] wasm threads: ${threads} (isolated: ${env.crossOriginIsolated ? 'yes' : 'no'})`);
	}
	return threads;
}

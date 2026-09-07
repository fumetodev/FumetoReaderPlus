/**
 * llama.cpp Bridge — platform-agnostic bridge for the local Tencent Hy-MT2
 * 1.8B 1.25-bit on-device translation backend.
 *
 * On Android: communicates via WebView JavascriptInterface (`window.__fumeto_llama`).
 * On Desktop (macOS/Windows/Linux): communicates via Tauri invoke commands.
 *
 * The bridge auto-detects the platform and dispatches to the appropriate backend.
 *
 * Deprecated TranslateGemma-named aliases remain available for settings and
 * extension migration, but new call sites use the Hy-MT2 names below.
 */

import { get, writable } from 'svelte/store';
import { parseBridgeRejection } from '$lib/i18n/errors.js';
import { desktopSystemInfo } from '$lib/device/desktop-system-info.js';
import { perfMark } from '$lib/util/perf.js';
import { isAndroid, isDesktop } from '$lib/util/platform.js';
import { settings, ON_DEVICE_TEMPERATURE_DEFAULT } from '$lib/settings/settings.js';
import type { GgufDownloadState } from './gguf-model-manager.js';

// Pending async callbacks from Kotlin — shared across llama operations
// and the model downloads that ride the same bridge.
const pendingCallbacks = new Map<
	string,
	{
		resolve: (value: string) => void;
		reject: (error: Error) => void;
		timer?: ReturnType<typeof setTimeout>;
	}
>();
let callbackCounter = 0;

const MODEL_LOAD_TIMEOUT_MS = 5 * 60_000;
const INFERENCE_TIMEOUT_MS = 5 * 60_000;
const MODEL_UNLOAD_TIMEOUT_MS = 2 * 60_000;

/**
 * Kotlin serializes the process-global llama context. Mirror that ordering in
 * JavaScript so cancelling a queued page cannot accidentally cancel a
 * different page that currently owns native inference.
 */
let inferenceQueueTail: Promise<void> = Promise.resolve();
const modelLoads = new Map<string, Promise<void>>();

function translationCancelledError(): Error {
	return new Error('Translation cancelled');
}

function raceWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(new DOMException('Translation cancelled', 'AbortError'));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new DOMException('Translation cancelled', 'AbortError'));
		signal.addEventListener('abort', abort, { once: true });
		work.then(
			(value) => { signal.removeEventListener('abort', abort); resolve(value); },
			(error) => { signal.removeEventListener('abort', abort); reject(error); }
		);
	});
}

async function acquireInferenceTurn(signal?: AbortSignal): Promise<() => void> {
	const previous = inferenceQueueTail.catch(() => {});
	let release!: () => void;
	let released = false;
	inferenceQueueTail = new Promise<void>((resolve) => {
		release = () => {
			if (released) return;
			released = true;
			resolve();
		};
	});

	if (!signal) {
		await previous;
		return release;
	}
	if (signal.aborted) {
		void previous.then(release);
		throw translationCancelledError();
	}

	let removeAbortListener = () => {};
	const aborted = new Promise<false>((resolve) => {
		const onAbort = () => resolve(false);
		signal.addEventListener('abort', onAbort, { once: true });
		removeAbortListener = () => signal.removeEventListener('abort', onAbort);
	});
	const acquired = await Promise.race([previous.then(() => true as const), aborted]);
	removeAbortListener();
	if (!acquired || signal.aborted) {
		// Preserve queue order even though this cancelled caller can return now.
		void previous.then(release);
		throw translationCancelledError();
	}
	return release;
}

export interface NativeCallbackOptions {
	/** null disables the deadline for explicitly cancellable multi-GB downloads. */
	timeoutMs?: number | null;
	operation?: string;
}

function settleCallback(
	callbackId: string,
	settle: (callback: { resolve: (value: string) => void; reject: (error: Error) => void }) => void
): boolean {
	const callback = pendingCallbacks.get(callbackId);
	if (!callback) return false;
	pendingCallbacks.delete(callbackId);
	if (callback.timer !== undefined) clearTimeout(callback.timer);
	settle(callback);
	return true;
}

// Per-download progress handlers keyed by callbackId.
// When set, __llama_progress dispatches to the registered handler instead
// of the default ggufDownloadProgress store.
const progressHandlers = new Map<string, (downloadedBytes: number, totalBytes: number) => void>();

/**
 * Register a pending callback that will be resolved/rejected by the Kotlin bridge.
 */
export function registerCallback(
	callbackId: string,
	options: NativeCallbackOptions = {}
): Promise<string> {
	const timeoutMs = options.timeoutMs === undefined ? INFERENCE_TIMEOUT_MS : options.timeoutMs;
	const operation = options.operation ?? 'Native llama operation';
	return new Promise<string>((resolve, reject) => {
		const timer = timeoutMs === null ? undefined : setTimeout(() => {
			settleCallback(callbackId, (callback) => {
				callback.reject(new Error(`${operation} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
			});
		}, timeoutMs);
		pendingCallbacks.set(callbackId, { resolve, reject, timer });
	});
}

/** Reject and remove a callback when a synchronous invocation or cancellation wins. */
export function rejectRegisteredCallback(callbackId: string, error: Error): boolean {
	return settleCallback(callbackId, (callback) => callback.reject(error));
}

/**
 * Register a progress handler for a specific download callbackId.
 * When the Kotlin bridge reports progress for this ID, the handler
 * is called instead of updating the default GGUF store.
 */
export function registerProgressHandler(
	callbackId: string,
	handler: (downloadedBytes: number, totalBytes: number) => void
): void {
	progressHandlers.set(callbackId, handler);
}

/** Remove a per-download progress handler. */
export function unregisterProgressHandler(callbackId: string): void {
	progressHandlers.delete(callbackId);
}

// Re-export the download state store so progress handler can update it
export const ggufDownloadProgress = writable<GgufDownloadState>({
	status: 'idle',
	error: undefined,
	progress: undefined
});

// Register global callback handlers that Kotlin will invoke
if (typeof window !== 'undefined') {
	(window as unknown as Record<string, unknown>).__llama_resolve = (
		callbackId: string,
		resultJson: string
	) => {
		settleCallback(callbackId, (callback) => callback.resolve(resultJson));
	};

	(window as unknown as Record<string, unknown>).__llama_reject = (
		callbackId: string,
		errorMessage: string
	) => {
		settleCallback(callbackId, (callback) => callback.reject(parseBridgeRejection(errorMessage)));
	};

	(window as unknown as Record<string, unknown>).__llama_progress = (
		callbackId: string,
		downloadedBytes: number,
		totalBytes: number
	) => {
		// Route to per-download handler if registered, else default GGUF store
		const handler = progressHandlers.get(callbackId);
		if (handler) {
			handler(downloadedBytes, totalBytes);
		} else {
			ggufDownloadProgress.set({
				status: 'downloading',
				error: undefined,
				progress: { downloadedBytes, totalBytes }
			});
		}
	};

	// Invoked by InferenceForegroundService (notification Stop action / idle
	// auto-unload) so the model unloads through the normal JS path and every
	// JS-side consumer observes a consistent unloaded state.
	(window as unknown as Record<string, unknown>).__fumeto_unload_llama = () => {
		void unloadModel().catch(() => {
			// The Kotlin side force-stops the service if this doesn't land.
		});
	};
}

/**
 * Create a unique callback ID and a promise that resolves when Kotlin calls back.
 */
function createCallback(
	timeoutMs: number | null,
	operation: string
): { callbackId: string; promise: Promise<string> } {
	const callbackId = `llama_${++callbackCounter}_${Date.now()}`;
	const promise = registerCallback(callbackId, { timeoutMs, operation });
	return { callbackId, promise };
}

function invokeCallback(
	timeoutMs: number | null,
	operation: string,
	invoke: (callbackId: string) => void
): { callbackId: string; promise: Promise<string> } {
	const callback = createCallback(timeoutMs, operation);
	try {
		invoke(callback.callbackId);
	} catch (error) {
		rejectRegisteredCallback(
			callback.callbackId,
			error instanceof Error ? error : new Error(String(error))
		);
	}
	return callback;
}

/**
 * Access the native llama.cpp bridge interface.
 */
function getBridge(): Record<string, (...args: unknown[]) => unknown> | null {
	if (typeof window === 'undefined') return null;
	return (
		((window as unknown as Record<string, unknown>).__fumeto_llama as Record<
			string,
			(...args: unknown[]) => unknown
		> | null) ?? null
	);
}

// ============================================================
// Availability & Status
// ============================================================

/**
 * Check if the llama.cpp bridge is available.
 * On Android: checks the native WebView bridge.
 * On Desktop: always available (Tauri commands are compiled in).
 */
export function isLlamaBridgeAvailable(): boolean {
	if (isDesktop) return true;
	const bridge = getBridge();
	if (!bridge?.isAvailable) return false;
	try {
		return bridge.isAvailable() as boolean;
	} catch {
		return false;
	}
}

/**
 * Check if a GGUF model is currently loaded in memory.
 */
export async function isModelLoaded(): Promise<boolean> {
	if (isDesktop) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			return await invoke<boolean>('llama_is_loaded');
		} catch {
			return false;
		}
	}
	const bridge = getBridge();
	if (!bridge?.isModelLoaded) return false;
	try {
		return bridge.isModelLoaded() as boolean;
	} catch {
		return false;
	}
}

/**
 * Get the storage path for model files.
 * Android: external app storage via Kotlin bridge.
 * Desktop: Tauri app data directory.
 * Returns empty string if unavailable.
 */
export async function getExternalModelDir(): Promise<string> {
	if (isDesktop) {
		try {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
			const dataDir = await appDataDir();
			const modelsDir = await join(dataDir, 'models');
			if (!(await exists(modelsDir))) {
				await mkdir(modelsDir, { recursive: true });
			}
			return modelsDir;
		} catch {
			return '';
		}
	}
	const bridge = getBridge();
	if (!bridge?.getExternalModelDir) return '';
	try {
		return bridge.getExternalModelDir() as string;
	} catch {
		return '';
	}
}

/**
 * Get the active inference backend.
 * Android: "opencl:QUALCOMM Adreno(TM) 830" or "cpu"
 * macOS: "metal:Apple M1" or "cpu"
 */
export async function getBackend(): Promise<string> {
	if (isDesktop) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const info = await invoke<{ backend: string; description: string }>('llama_get_backend');
			return info.backend;
		} catch {
			return 'unknown';
		}
	}
	const bridge = getBridge();
	if (!bridge?.getBackend) return 'unknown';
	try {
		return bridge.getBackend() as string;
	} catch {
		return 'unknown';
	}
}

/**
 * The active backend together with the shell's description of it. On
 * desktop the backend can be "unsupported" — the CPU lacks an instruction
 * set the build assumes — and the description then says which; Android
 * reports the backend name alone.
 */
export async function getBackendInfo(): Promise<{ backend: string; description: string }> {
	if (isDesktop) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const info = await invoke<{ backend: string; description?: string }>('llama_get_backend');
			return { backend: info.backend, description: info.description ?? '' };
		} catch {
			return { backend: 'unknown', description: '' };
		}
	}
	return { backend: await getBackend(), description: '' };
}

/**
 * Check if the device has GPU acceleration available.
 * Android: OpenCL driver. macOS: Metal (always available on Apple Silicon).
 */
export async function hasGPU(): Promise<boolean> {
	if (isDesktop) {
		try {
			const backend = await getBackend();
			return backend.startsWith('metal:');
		} catch {
			return false;
		}
	}
	const bridge = getBridge();
	if (!bridge?.hasOpenCL) return false;
	try {
		return bridge.hasOpenCL() as boolean;
	} catch {
		return false;
	}
}

/** @deprecated Use hasGPU() instead. Kept for backward compatibility. */
export function hasOpenCL(): boolean {
	if (isDesktop) return false; // macOS uses Metal, not OpenCL
	const bridge = getBridge();
	if (!bridge?.hasOpenCL) return false;
	try {
		return bridge.hasOpenCL() as boolean;
	} catch {
		return false;
	}
}

/**
 * Get available device RAM in GB.
 * Desktop: the shell's system-info snapshot (WebKitGTK offers a page no
 * memory API at all); 0 before it is primed or where the command is absent.
 */
export function getAvailableMemoryGB(): number {
	if (isDesktop) {
		const info = desktopSystemInfo();
		const bytes = info?.availableMemoryBytes ?? info?.totalMemoryBytes ?? 0;
		return bytes > 0 ? bytes / 1024 ** 3 : 0;
	}
	const bridge = getBridge();
	if (!bridge?.getAvailableMemoryGB) return 0;
	try {
		return bridge.getAvailableMemoryGB() as number;
	} catch {
		return 0;
	}
}

// ============================================================
// Model Loading
// ============================================================

/**
 * A user-supplied prompt wrapping, for an imported model whose chat template
 * llama.cpp does not recognise. Never supplied for the bundled variants, which
 * resolve their template from the GGUF itself.
 */
export interface ManualPromptFormat {
	prefix: string;
	suffix: string;
	stops: string[];
}

export interface ModelLoadOptions {
	promptFormat?: ManualPromptFormat;
	/**
	 * True only for the v3 fine-tune, the one checkpoint trained with a
	 * per-target terminology block. Every other model keeps the English-only
	 * guidance it shipped with — handing v2 a Korean glossary preamble it never
	 * saw would be an unmeasured change to a model people already use.
	 */
	multilingualGuidance?: boolean;
}

/**
 * Load the Hy-MT2 local-translation GGUF model from the given path.
 */
async function performHyMT2ModelLoad(
	modelPath: string,
	options?: ModelLoadOptions
): Promise<void> {
	if (isDesktop) {
		const { invoke } = await import('@tauri-apps/api/core');
		const started = performance.now();
		try {
			await invoke('llama_load', {
				modelPath,
				// The same two values the Android bridge sends, so both shells
				// gate the per-target guidance block on one rule.
				guidanceScope: options?.multilingualGuidance ? 'all-targets' : 'english-only'
			});
			perfMark('llama.load', performance.now() - started, { model: fileBasename(modelPath) });
		} catch (error) {
			// A Tauri command rejects with its bare error string. Wrap it so the
			// text (for instance a CPU-preflight verdict) reaches the same
			// `err.message` readers the Android path feeds.
			throw error instanceof Error ? error : new Error(String(error));
		}
		return;
	}

	const bridge = getBridge();
	if (!bridge?.loadModel) {
		throw new Error('llama.cpp bridge not available');
	}

	const { promise } = invokeCallback(MODEL_LOAD_TIMEOUT_MS, 'llama model load', (callbackId) => {
		// Stops travel newline-separated: the bridge takes three plain strings
		// so the native side needs no JSON parser.
		bridge.loadModel(
			modelPath,
			callbackId,
			options?.promptFormat?.prefix ?? '',
			options?.promptFormat?.suffix ?? '',
			(options?.promptFormat?.stops ?? []).join('\n'),
			options?.multilingualGuidance ? 'all-targets' : 'english-only'
		);
	});

	const result = await promise;
	const parsed = JSON.parse(result);
	if (parsed.error) {
		throw new Error(parsed.error);
	}
}

/**
 * Load the model once per path while letting each page stop waiting promptly.
 * The native mmap cannot be interrupted safely, so abort detaches only this
 * page consumer; the shared load remains observed and can serve a later page.
 */
export function loadHyMT2Model(
	modelPath: string,
	signal?: AbortSignal,
	options?: ModelLoadOptions
): Promise<void> {
	// Detaching from an ALREADY IN-FLIGHT shared load is the point of this
	// function; starting a brand-new one for a caller who has already given up
	// is not. Without this check an aborted request still kicked off a 462 MB to
	// 1.13 GB native load for nobody — an unwanted resident allocation on a
	// memory-constrained device, and, because the abort race returns without
	// attaching handlers to `work`, a failing abandoned load became an
	// unhandled rejection that surfaced in the user's diagnostic report.
	if (signal?.aborted && !modelLoads.has(modelPath)) {
		return Promise.reject(new DOMException('Translation cancelled', 'AbortError'));
	}
	let work = modelLoads.get(modelPath);
	if (!work) {
		// Keyed by path alone. There is a single custom-model slot at a fixed
		// path, so a given path always implies one prompt format; two
		// concurrent loads of the same path with different formats cannot
		// arise.
		work = performHyMT2ModelLoad(modelPath, options).finally(() =>
			modelLoads.delete(modelPath)
		);
		modelLoads.set(modelPath, work);
	}
	return raceWithAbort(work, signal);
}

// ============================================================
// Translation
// ============================================================

/**
 * Strip Hy-MT2 chat-template tokens and generic translator noise from raw
 * model output. Tencent's tokenizer uses full-width vertical bars in tokens
 * such as `<｜hy_Assistant｜>` and `<｜hy_EOT｜>`. ASCII-bar variants are
 * accepted too because some GGUF tooling normalizes the delimiters.
 */
export function postProcessHyMT2Output(raw: string): string {
	let text = raw;

	// If the native layer returns an echoed chat transcript, keep only the
	// final assistant segment.
	const assistantTokenRe = /<[|｜]hy_Assistant[|｜]>\s*/gi;
	const assistantMatches = [...text.matchAll(assistantTokenRe)];
	if (assistantMatches.length > 0) {
		const last = assistantMatches[assistantMatches.length - 1];
		text = text.slice((last.index ?? 0) + last[0].length);
	}

	// Stop at the first Hy-MT2 turn terminator that leaked through decoding.
	// `place▁holder▁no▁2` is the official tokenizer's EOS token.
	const hyTerminatorRe = /<[|｜]hy_(?:EOT|end▁of▁sentence|place▁holder▁no▁2|User)[|｜]>/i;
	const terminator = hyTerminatorRe.exec(text);
	if (terminator?.index !== undefined) {
		text = text.slice(0, terminator.index);
	}

	// Remove any other Hy-MT2 control token while preserving translated text.
	text = text.replace(/<[|｜]hy_[^>]*[|｜]>/gi, '');

	// Generic defenses for runtimes that expose a reasoning wrapper or
	// normalize chat tokens to common instruct formats.
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
	text = text.replace(/<\/?(?:s|assistant|user|system)>/gi, '');
	text = text.replace(/<\|(?:im_start|im_end|assistant|user|system|eot_id|end_of_text)\|>/gi, '');
	text = text.replace(/^(?:\/no_?think|\/think)\s*/i, '');

	// ── Common instruction-model preambles ──
	// Only strip if they appear at the very start (after trim). Case-insensitive.
	// Keep this list conservative — adding too many patterns risks over-stripping
	// legitimate translations that happen to start with similar phrasing.
	text = text.trim();
	const preambleRe = /^(?:here(?:'s| is)?\s+(?:the\s+)?translation\s*[:\-–—]?\s*|translation\s*[:\-–—]\s*|sure,?\s+here(?:'s| is)?\s*[:\-–—]?\s*|the\s+translation\s+is\s*[:\-–—]?\s*)/i;
	text = text.replace(preambleRe, '');

	// ── Wrapping quotes ──
	// Strip one matched pair of wrapping quotes.
	text = text.trim();
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		const pairs: Array<[string, string]> = [
			['"', '"'],
			['“', '”'],
			['‘', '’'],
			["'", "'"]
		];
		for (const [open, close] of pairs) {
			if (first === open && last === close) {
				text = text.slice(1, -1);
				break;
			}
		}
	}

	// ── Translator notes ──
	text = text.replace(/\(TN:\s*[^)]*\)/gi, '');
	text = text.replace(/\[Note:\s*[^\]]*\]/gi, '');
	text = text.replace(/\(Translator['']?s?\s*note:\s*[^)]*\)/gi, '');

	// Final whitespace trim
	text = text.trim();

	return text;
}

/**
 * The configured on-device sampler temperature, or the default if the store is
 * unreadable for any reason.
 *
 * Read per request rather than captured at load: the native side rebuilds only
 * the sampler chain when the value changes, so moving the slider takes effect
 * on the next bubble without reloading 1.13 GB of weights.
 */
function resolveOnDeviceTemperature(): number {
	try {
		const configured = get(settings).onDeviceTemperature;
		return typeof configured === 'number' && Number.isFinite(configured)
			? configured
			: ON_DEVICE_TEMPERATURE_DEFAULT;
	} catch {
		return ON_DEVICE_TEMPERATURE_DEFAULT;
	}
}

/**
 * Translate text using the local Hy-MT2 1.8B model via llama.cpp.
 * Prompt construction is handled by the platform's native bridge.
 *
 * @param text - Source text to translate
 * @param sourceLang - ISO 639-1 source language code (e.g. 'ja')
 * @param targetLang - ISO 639-1 target language code (e.g. 'en')
 * @param signal - Cancels the request; the native decode loop polls it
 * @param temperature - Overrides the configured sampler temperature. Left
 *   unset by every product call site, which is deliberate: reading the setting
 *   here means the model-import self-test exercises the same sampler a real
 *   translation will use, instead of validating a configuration nobody runs.
 */
export async function translateWithHyMT2(
	text: string,
	sourceLang: string = 'ja',
	targetLang: string = 'en',
	signal?: AbortSignal,
	temperature?: number
): Promise<string> {
	const samplerTemperature = temperature ?? resolveOnDeviceTemperature();
	const releaseTurn = await acquireInferenceTurn(signal);
	let settled = false;
	const cancellationRetryTimers: Array<ReturnType<typeof setTimeout>> = [];
	const requestActiveCancellation = (): void => {
		void cancelInference();
		// The Android JS interface queues work onto a coroutine. Repeat briefly so
		// an abort that lands between enqueue and beginInference cannot be missed.
		for (const delay of [25, 100]) {
			cancellationRetryTimers.push(setTimeout(() => {
				if (!settled && signal?.aborted) void cancelInference();
			}, delay));
		}
	};
	const onAbort = () => requestActiveCancellation();
	if (signal) {
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) requestActiveCancellation();
	}

	try {
		if (signal?.aborted) throw translationCancelledError();
		if (isDesktop) {
			const { invoke } = await import('@tauri-apps/api/core');
			const result = await invoke<string>('llama_translate', {
				text,
				sourceLang,
				targetLang,
				temperature: samplerTemperature,
			});
			if (signal?.aborted) throw translationCancelledError();
			return postProcessHyMT2Output(result);
		}

		const bridge = getBridge();
		if (!bridge?.translate) {
			throw new Error('llama.cpp bridge not available');
		}

		const { promise } = invokeCallback(INFERENCE_TIMEOUT_MS, 'llama inference', (callbackId) => {
			bridge.translate(text, sourceLang, targetLang, samplerTemperature, callbackId);
		});

		let result: string;
		try {
			result = await promise;
		} catch (error) {
			if (error instanceof Error && error.message.includes('timed out')) {
				// A callback timeout is not native completion. Release the process-wide
				// llama lifecycle by signalling the decode loop before another request.
				void cancelInference();
			}
			throw error;
		}
		if (signal?.aborted) throw translationCancelledError();
		const parsed = JSON.parse(result);
		if (parsed.error) {
			throw new Error(parsed.error);
		}

		return postProcessHyMT2Output(parsed.translation as string);
	} finally {
		settled = true;
		for (const timer of cancellationRetryTimers) clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
		releaseTurn();
	}
}

/** @deprecated Use loadHyMT2Model(). Retained for extension compatibility. */
export const loadTranslateGemmaModel = loadHyMT2Model;

/** @deprecated Use translateWithHyMT2(). Retained for extension compatibility. */
export const translateWithGemma = translateWithHyMT2;

// ============================================================
// Model Management
// ============================================================

/**
 * Unload the currently loaded Hy-MT2 model and release its weights, KV cache,
 * and activation scratch memory.
 */
export async function unloadModel(): Promise<void> {
	if (isDesktop) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('llama_unload');
		} catch {
			// Best effort
		}
		return;
	}

	const bridge = getBridge();
	if (!bridge?.unloadModel) return;

	const { promise } = invokeCallback(MODEL_UNLOAD_TIMEOUT_MS, 'llama model unload', (callbackId) => {
		bridge.unloadModel(callbackId);
	});
	await promise;
}

/**
 * Cancel the currently running inference (if any).
 * Signals the native decode loop to break early.
 */
export async function cancelInference(): Promise<void> {
	if (isDesktop) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const started = performance.now();
			await invoke('llama_cancel');
			perfMark('llama.cancel', performance.now() - started);
		} catch {
			// Best effort
		}
		return;
	}

	const bridge = getBridge();
	if (!bridge?.cancelInference) return;
	try {
		bridge.cancelInference();
	} catch {
		// Best effort
	}
}

// ============================================================
// Download (delegates to Kotlin OkHttp)
// ============================================================

/** The last path segment, for perf lines that name a model without its directory. */
function fileBasename(path: string): string {
	return path.split(/[\\/]/).pop() || path;
}

// Desktop download cancellation flag
let desktopDownloadAbort: AbortController | null = null;
const activeAndroidDownloadCallbackIds = new Set<string>();
/** Set by cancelDownload() so the rejected download reports idle, not an error. */
let downloadCancelRequested = false;

/**
 * Download a model file.
 * Android: via Kotlin OkHttp bridge with __llama_progress callback.
 * Desktop: via fetch with streaming progress.
 *
 * `onProgress` diverts reporting to the caller and leaves
 * `ggufDownloadProgress` untouched. Without it, a second downloader (the OCR
 * models) would drive the GGUF store, and the settings UI would animate a
 * progress bar on whichever Hy-MT2 row was last selected.
 */
export async function downloadModelFile(
	url: string,
	destPath: string,
	options: { onProgress?: (downloadedBytes: number, totalBytes: number) => void } = {}
): Promise<void> {
	const { onProgress } = options;
	const publish = (state: GgufDownloadState) => {
		if (!onProgress) ggufDownloadProgress.set(state);
	};
	// A fresh download is not cancelled; clearing here keeps a later genuine
	// failure from being reported as a cancellation.
	downloadCancelRequested = false;
	onProgress?.(0, 0);
	publish({
		status: 'downloading',
		error: undefined,
		progress: { downloadedBytes: 0, totalBytes: 0 }
	});

	if (isDesktop) {
		try {
			// Streams straight to disk: the page never holds more than one chunk
			// of a model that can be over a gigabyte.
			const { downloadToFileDesktop } = await import('$lib/util/desktop-stream-download.js');
			desktopDownloadAbort = new AbortController();
			const { bytes, ms } = await downloadToFileDesktop(url, destPath, {
				signal: desktopDownloadAbort.signal,
				onProgress: (downloadedBytes, totalBytes) => {
					onProgress?.(downloadedBytes, totalBytes);
					publish({
						status: 'downloading',
						error: undefined,
						progress: { downloadedBytes, totalBytes }
					});
				}
			});
			perfMark(`download.${fileBasename(destPath)}`, ms, { bytes });

			publish({
				status: 'completed',
				error: undefined,
				progress: undefined
			});
			desktopDownloadAbort = null;
		} catch (err) {
			desktopDownloadAbort = null;
			const msg = err instanceof Error ? err.message : 'Download failed';
			if (msg.toLowerCase().includes('abort')) {
				publish({ status: 'idle', error: undefined, progress: undefined });
				// Cancellation is not transport success. Propagate it so callers
				// cannot validate or delete a previous model after an aborted copy.
				throw err;
			} else {
				publish({ status: 'error', error: msg, progress: undefined });
				throw err;
			}
		}
		return;
	}

	// Android: use Kotlin OkHttp bridge
	const bridge = getBridge();
	if (!bridge?.downloadModel) {
		throw new Error('llama.cpp bridge not available for download');
	}

	// Multi-GB GGUF downloads intentionally have no wall-clock deadline. They
	// remain explicitly cancellable through cancelDownload().
	const { callbackId, promise } = invokeCallback(null, 'Model download', (id) => {
		activeAndroidDownloadCallbackIds.add(id);
		// Registered before the transfer starts so the first tick cannot land on
		// the default GGUF store when a caller supplied its own reporter.
		if (onProgress) registerProgressHandler(id, onProgress);
		bridge.downloadModel(url, destPath, id);
	});

	try {
		const result = await promise;
		const parsed = JSON.parse(result);
		if (parsed.error) {
			throw new Error(parsed.error);
		}
		publish({
			status: 'completed',
			error: undefined,
			progress: undefined
		});
	} catch (err) {
		// A user cancel is not an error. cancelDownload() sets `idle`
		// synchronously, but this rejection lands a microtask later and used to
		// overwrite it with a red "Download cancelled" under the variant picker
		// — for an action the user themselves took.
		publish(
			downloadCancelRequested
				? { status: 'idle', error: undefined, progress: undefined }
				: {
					status: 'error',
					error: err instanceof Error ? err.message : 'Download failed',
					progress: undefined
				}
		);
		throw err;
	} finally {
		activeAndroidDownloadCallbackIds.delete(callbackId);
		unregisterProgressHandler(callbackId);
	}
}

/**
 * Copy a user-picked GGUF from device storage into the app's model directory.
 *
 * Android only. The picker returns a `content://` URI whose read grant does not
 * outlive the Activity result, and llama.cpp loads by absolute path, so the
 * file must be copied. The copy runs in Kotlin rather than through plugin-fs
 * `readFile`/`writeFile`, which would materialise a multi-gigabyte model in the
 * JS heap.
 *
 * Shares the download progress store and cancellation path, so `cancelDownload`
 * stops an import too.
 */
export async function importModelFile(contentUri: string, destPath: string): Promise<void> {
	const bridge = getBridge();
	if (!bridge?.importModelFromUri) {
		throw new Error('Importing your own model needs the Android app');
	}

	downloadCancelRequested = false;
	ggufDownloadProgress.set({
		status: 'downloading',
		error: undefined,
		progress: { downloadedBytes: 0, totalBytes: 0 }
	});

	// No wall-clock deadline, for the same reason downloads have none: the file
	// can be several gigabytes. Cancellation is the escape hatch.
	const { callbackId, promise } = invokeCallback(null, 'GGUF model import', (id) => {
		activeAndroidDownloadCallbackIds.add(id);
		bridge.importModelFromUri(contentUri, destPath, id);
	});

	try {
		const parsed = JSON.parse(await promise);
		if (parsed.error) throw new Error(parsed.error);
		ggufDownloadProgress.set({ status: 'completed', error: undefined, progress: undefined });
	} catch (err) {
		ggufDownloadProgress.set(
			downloadCancelRequested
				? { status: 'idle', error: undefined, progress: undefined }
				: {
					status: 'error',
					error: err instanceof Error ? err.message : 'Import failed',
					progress: undefined
				}
		);
		throw err;
	} finally {
		activeAndroidDownloadCallbackIds.delete(callbackId);
	}
}

/**
 * Cancel an in-progress model download.
 */
export function cancelDownload(): void {
	// Desktop: abort fetch
	if (isDesktop && desktopDownloadAbort) {
		desktopDownloadAbort.abort();
		desktopDownloadAbort = null;
		ggufDownloadProgress.set({ status: 'idle', error: undefined, progress: undefined });
		return;
	}

	// Android: use Kotlin bridge
	const bridge = getBridge();
	if (bridge?.cancelDownload) {
		try {
			bridge.cancelDownload('');
		} catch {
			// The JS-side cancellation below still releases every waiter.
		}
	}
	for (const callbackId of activeAndroidDownloadCallbackIds) {
		rejectRegisteredCallback(callbackId, new Error('Download cancelled'));
	}
	activeAndroidDownloadCallbackIds.clear();
	ggufDownloadProgress.set({
		status: 'idle',
		error: undefined,
		progress: undefined
	});
}

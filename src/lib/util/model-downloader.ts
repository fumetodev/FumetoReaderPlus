/**
 * Platform-aware file download utility for ONNX model files.
 *
 * Desktop: downloads via Tauri HTTP plugin (streaming with progress).
 * Android: downloads via the Kotlin LlamaBridge OkHttp client, which
 *          streams to disk without buffering the entire file in the
 *          WebView's JS heap.
 *
 * On Android, the Kotlin bridge calls back via window.__llama_resolve,
 * __llama_reject, and __llama_progress — the shared callback registry
 * in llamacpp-bridge.ts routes these to the correct handler by callbackId.
 *
 * Used by saliency-model-manager, lama-model-manager, and head-model-manager.
 */

import { isAndroid } from '$lib/util/platform.js';
import {
	registerCallback,
	registerProgressHandler,
	rejectRegisteredCallback,
	unregisterProgressHandler
} from '$lib/translation/llamacpp-bridge.js';

export type ProgressCallback = (downloadedBytes: number, totalBytes: number) => void;

let callbackCounter = 0;

function getLlamaBridge(): Record<string, (...args: unknown[]) => unknown> | null {
	if (typeof window === 'undefined') return null;
	return (
		((window as unknown as Record<string, unknown>).__fumeto_llama as Record<
			string,
			(...args: unknown[]) => unknown
		> | null) ?? null
	);
}

// ============================================================
// Desktop download
// ============================================================

async function downloadDesktop(
	url: string,
	destPath: string,
	onProgress: ProgressCallback,
	signal?: AbortSignal
): Promise<void> {
	const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
	const { writeFile, mkdir } = await import('@tauri-apps/plugin-fs');

	// Ensure parent directory exists
	const lastSlash = destPath.lastIndexOf('/');
	if (lastSlash > 0) {
		const parentDir = destPath.substring(0, lastSlash);
		try { await mkdir(parentDir, { recursive: true }); } catch { /* may exist */ }
	}

	const response = await tauriFetch(url, {
		method: 'GET',
		signal,
		maxRedirections: 5
	});

	if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
	const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);

	const reader = response.body?.getReader();
	if (!reader) throw new Error('Response body is not readable');

	const chunks: Uint8Array[] = [];
	let downloadedBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		downloadedBytes += value.byteLength;
		onProgress(downloadedBytes, totalBytes);
	}

	const fullBuffer = new Uint8Array(downloadedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		fullBuffer.set(chunk, offset);
		offset += chunk.byteLength;
	}

	await writeFile(destPath, fullBuffer);
}

// ============================================================
// Android download
// ============================================================

async function downloadAndroid(
	url: string,
	destPath: string,
	onProgress: ProgressCallback,
	signal?: AbortSignal
): Promise<void> {
	const bridge = getLlamaBridge();
	if (!bridge?.downloadModel) {
		throw new Error('Download bridge not available');
	}

	const callbackId = `dl_${++callbackCounter}_${Date.now()}`;
	// ONNX/GGUF assets can be multi-GB on slow connections, so this callback
	// has no short inference deadline. AbortSignal remains the explicit escape.
	const promise = registerCallback(callbackId, {
		timeoutMs: null,
		operation: 'Native model download'
	});
	registerProgressHandler(callbackId, onProgress);
	const abortDownload = () => {
		try {
			bridge.cancelDownload(callbackId);
		} finally {
			rejectRegisteredCallback(callbackId, new Error('Download cancelled'));
		}
	};

	try {
		if (signal?.aborted) {
			rejectRegisteredCallback(callbackId, new Error('Download cancelled'));
			await promise;
			return;
		}
		signal?.addEventListener('abort', abortDownload, { once: true });
		bridge.downloadModel(url, destPath, callbackId);
		const result = await promise;
		const parsed = JSON.parse(result);
		if (parsed.error) {
			throw new Error(parsed.error);
		}
	} finally {
		signal?.removeEventListener('abort', abortDownload);
		unregisterProgressHandler(callbackId);
	}
}

// ============================================================
// Public API
// ============================================================

/**
 * Download a file to the given destination path with progress reporting.
 * Automatically selects the best backend for the current platform.
 *
 * @param url - URL to download from
 * @param destPath - Absolute filesystem path for the downloaded file
 * @param onProgress - Called with (downloadedBytes, totalBytes) during download
 * @param signal - Optional AbortSignal for cancellation (desktop only; Android uses cancelDownload)
 */
export async function downloadFile(
	url: string,
	destPath: string,
	onProgress: ProgressCallback,
	signal?: AbortSignal
): Promise<void> {
	if (isAndroid) {
		await downloadAndroid(url, destPath, onProgress, signal);
	} else {
		await downloadDesktop(url, destPath, onProgress, signal);
	}
}

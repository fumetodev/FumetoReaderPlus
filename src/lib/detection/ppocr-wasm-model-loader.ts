/**
 * Model-byte loader for the PP-OCR WASM sessions.
 *
 * Resolution order, first hit wins:
 *   1. A downloaded model in the app-data `models/` directory (see
 *      ocr-model-manager.ts). This is the production path on every Tauri
 *      host: the desktop shell always runs the WASM tier, and an Android
 *      device lands here when native ORT is unavailable.
 *   2. The frontend bundle's `/models/` URL, which a plain browser
 *      (`npm run dev`) serves from `static/models`. The bytes are sniffed
 *      before use: a bundle that was pruned of its models answers those URLs
 *      with index.html at HTTP 200 (the SPA fallback), so a status check never
 *      fires and ort-web would die with "protobuf parsing failed".
 *   3. Android only: a packaged asset copy materialised through the PP-OCR
 *      bridge and read back via plugin-fs, which keeps the WASM fallback
 *      working without re-embedding 83 MB of weights in the web bundle.
 */

import {
	isNativePPOcrAvailable,
	materializeNativeWasmModel
} from './native-ppocr-detector.js';
import { ocrModelPath } from './ocr-model-manager.js';

/** A downloaded model outranks both the bundle and the packaged asset. */
async function readDownloadedModel(modelPath: string): Promise<Uint8Array | null> {
	if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
	try {
		const filename = modelPath.split('/').pop();
		if (!filename) return null;
		const path = await ocrModelPath(filename);
		const { exists, readFile } = await import('@tauri-apps/plugin-fs');
		if (!(await exists(path))) return null;
		return await readFile(path);
	} catch {
		return null;
	}
}

/** Reject HTML masquerading as a model (SPA fallback) and empty payloads. */
export function looksLikeOnnxModel(buffer: ArrayBuffer, contentType: string | null): boolean {
	if (contentType && /text\/html/i.test(contentType)) return false;
	if (buffer.byteLength === 0) return false;
	// ONNX files begin with a protobuf varint field, never '<'.
	return new Uint8Array(buffer, 0, 1)[0] !== 0x3c;
}

export async function loadPPOcrWasmModelBuffer(
	modelPath: string,
	component: 'detector' | 'recognizer'
): Promise<Uint8Array> {
	const downloaded = await readDownloadedModel(modelPath);
	if (downloaded) return downloaded;

	let fetchProblem = 'unreachable';
	try {
		const response = await fetch(modelPath);
		if (response.ok) {
			const buffer = await response.arrayBuffer();
			const contentType = response.headers?.get?.('content-type') ?? null;
			if (looksLikeOnnxModel(buffer, contentType)) return new Uint8Array(buffer);
			fetchProblem = `served ${contentType ?? 'unknown content'} instead of a model`;
		} else {
			fetchProblem = `HTTP ${response.status}`;
		}
	} catch (error) {
		fetchProblem = error instanceof Error ? error.message : String(error);
	}
	if (isNativePPOcrAvailable()) {
		const { path } = await materializeNativeWasmModel(component);
		const { readFile } = await import('@tauri-apps/plugin-fs');
		return await readFile(path);
	}
	throw new Error(
		`PP-OCR ${component} model unavailable in this build (${modelPath} ${fetchProblem}, and no native asset bridge is present). Reinstalling the app may help.`
	);
}

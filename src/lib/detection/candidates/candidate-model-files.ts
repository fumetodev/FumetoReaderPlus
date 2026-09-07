/**
 * Candidate-model file registry for the model-candidate evaluation suite
 * (internal testing).
 *
 * Files live in the same `appDataDir()/models/` directory the production
 * download managers use. The e2e suite pushes them via adb + run-as, so no
 * in-app download is required; `CANDIDATE_SOURCES` records the upstream URLs
 * for anyone provisioning manually.
 *
 * The evaluation lab is the exception: it runs in a plain browser with no Tauri
 * bridge, so `appDataDir()` does not exist there. In that realm the same files
 * are read over HTTP from the lab dev server, which serves the gitignored
 * artifacts cache under the `/candidate-models/` prefix below. Populate it with
 * `npm run candidates:fetch`.
 */

import { exists as fsExists, readFile } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { ortWasmBaseUrl } from '../ort-wasm-paths.js';

export type CandidateModelId =
	| 'manga-ocr'
	| 'comic-layout'
	| 'rtdetr'
	| 'yolov8-bubble'
	| 'rtmdet-manga'
	| 'rtmdet-native';

export const CANDIDATE_FILES: Record<CandidateModelId, readonly string[]> = {
	'manga-ocr': [
		'manga-ocr-encoder-int8.onnx',
		'manga-ocr-decoder-int8.onnx',
		'manga-ocr-vocab.txt'
	],
	'comic-layout': ['comic-layout-yolo26s.onnx'],
	rtdetr: ['rtdetrv4-manga109.onnx'],
	'yolov8-bubble': ['yolov8-bubble-seg.onnx'],
	'rtmdet-manga': ['rtmdet-manga-layout.onnx'],
	'rtmdet-native': ['rtmdet-manga-layout-1024.onnx']
};

export const CANDIDATE_SOURCES: Record<string, string> = {
	'manga-ocr-encoder-int8.onnx':
		'https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model_int8.onnx',
	'manga-ocr-decoder-int8.onnx':
		'https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/decoder_model_int8.onnx',
	'manga-ocr-vocab.txt': 'https://huggingface.co/kha-white/manga-ocr-base/resolve/main/vocab.txt',
	'rtdetrv4-manga109.onnx':
		'https://huggingface.co/aoiandroid/rtdetrv4-x-manga109s_v2/resolve/main/model.onnx',
	'yolov8-bubble-seg.onnx':
		'https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble/resolve/main/model_dynamic.onnx',
	// comic-layout-yolo26s.onnx is produced by scripts/export-comic-layout-onnx.py
	// Our bespoke fine-tune (Apache-2.0), published on Hugging Face. Note the
	// device filename of the 960 WASM model differs from its hosted name.
	'rtmdet-manga-layout.onnx':
		'https://huggingface.co/fumetodev/rtmdet-manga-layout-onnx/resolve/main/rtmdet-manga-layout-960.onnx',
	'rtmdet-manga-layout-1024.onnx':
		'https://huggingface.co/fumetodev/rtmdet-manga-layout-onnx/resolve/main/rtmdet-manga-layout-1024.onnx'
};

export async function candidateModelPath(fileName: string): Promise<string> {
	return join(await appDataDir(), 'models', fileName);
}

/** Where the evaluation lab's dev server exposes the candidate-model cache. */
const LAB_MODEL_PREFIX = '/candidate-models/';

/** True inside the app (desktop shell or Android WebView), false in the lab. */
function hasTauriFs(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function candidateFileExists(fileName: string): Promise<boolean> {
	if (hasTauriFs()) return fsExists(await candidateModelPath(fileName));
	const response = await fetch(`${LAB_MODEL_PREFIX}${fileName}`, { method: 'HEAD' });
	return response.ok;
}

async function readCandidateBytes(fileName: string): Promise<Uint8Array> {
	if (hasTauriFs()) return readFile(await candidateModelPath(fileName));
	const response = await fetch(`${LAB_MODEL_PREFIX}${fileName}`);
	if (!response.ok) {
		throw new Error(
			`candidate model "${fileName}" is not available at ${LAB_MODEL_PREFIX} ` +
			`(run \`npm run candidates:fetch\` to populate artifacts/model-candidates/models)`
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

export async function isCandidateAvailable(id: CandidateModelId): Promise<boolean> {
	try {
		for (const fileName of CANDIDATE_FILES[id]) {
			if (!(await candidateFileExists(fileName))) return false;
		}
		return true;
	} catch {
		return false;
	}
}

export async function candidateAvailability(): Promise<Record<CandidateModelId, boolean>> {
	const ids = Object.keys(CANDIDATE_FILES) as CandidateModelId[];
	const entries = await Promise.all(ids.map(async (id) => [id, await isCandidateAvailable(id)]));
	return Object.fromEntries(entries) as Record<CandidateModelId, boolean>;
}

export async function readCandidateText(fileName: string): Promise<string> {
	const bytes = await readCandidateBytes(fileName);
	return new TextDecoder('utf-8').decode(bytes);
}

// ── ORT session cache ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrtSession = any;

let ortModule: OrtModule | null = null;
const sessions = new Map<string, OrtSession>();

async function ort(): Promise<OrtModule> {
	if (ortModule) return ortModule;
	ortModule = await import('onnxruntime-web/wasm');
	ortModule.env.wasm.wasmPaths = ortWasmBaseUrl();
	ortModule.env.wasm.proxy = false;
	// Threads need SharedArrayBuffer (cross-origin isolation); ort falls back
	// to 1 silently when unavailable, so this is a free upside on devices
	// where the WebView grants isolation.
	ortModule.env.wasm.numThreads =
		typeof SharedArrayBuffer !== 'undefined'
			? Math.min(4, navigator.hardwareConcurrency || 1)
			: 1;
	return ortModule;
}

/** Load (and cache) an ORT-WASM session for a candidate model file. */
export async function createCandidateSession(fileName: string): Promise<OrtSession> {
	const cached = sessions.get(fileName);
	if (cached) return cached;
	const module = await ort();
	const bytes = await readCandidateBytes(fileName);
	// Slice to a clean ArrayBuffer (readFile may return a view on a larger buffer).
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const session = await module.InferenceSession.create(buffer, {
		executionProviders: ['wasm']
	});
	sessions.set(fileName, session);
	return session;
}

export function ortTensor(): Promise<OrtModule> {
	return ort();
}

/** Release every cached candidate session (frees WASM heap between runs). */
export async function releaseCandidateModelSessions(): Promise<void> {
	for (const [, session] of sessions) {
		try {
			await session.release?.();
		} catch {
			// Best effort.
		}
	}
	sessions.clear();
}

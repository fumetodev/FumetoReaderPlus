/**
 * Download manager for the on-device vision models.
 *
 * The PP-OCR detector and recogniser and the rtmdet layout model used to ride
 * inside the APK as packaged assets, which cost 124 MB of install for every
 * user — including the ones who only ever read comics. They are fetched on
 * demand instead, into the one directory both sides of the bridge already
 * agree on: Tauri's `appDataDir()` is `/data/user/0/<pkg>/` on Android, so
 * `appDataDir()/models/` is Kotlin's `context.dataDir/models/`. The native
 * engines look there first and fall back to a packaged asset, so a build that
 * still bundles one keeps working.
 *
 * Integrity is checked twice on purpose. This module compares the exact byte
 * count, which catches a truncated transfer or a captive-portal error page;
 * the Kotlin engines then verify sha256 before handing the file to ONNX
 * Runtime, which is what catches a file that is the right size and still
 * wrong.
 */

import { writable } from 'svelte/store';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists as fsExists, mkdir as fsMkdir, remove as fsRemove, stat as fsStat } from '@tauri-apps/plugin-fs';
import { downloadModelFile, cancelDownload as cancelBridgeDownload } from '$lib/translation/llamacpp-bridge.js';

export type OcrModelId = 'ppocr-det' | 'ppocr-rec' | 'rtmdet-layout';

export interface OcrModelSpec {
	id: OcrModelId;
	/** Filename under `appDataDir()/models/`; the native engines resolve the same name. */
	filename: string;
	/**
	 * Pinned to a commit rather than `main`: the Kotlin engines hard-code the
	 * sha256 they will accept, so a repository that moved on would fail
	 * verification after a 62 MB download rather than before it.
	 */
	url: string;
	sizeBytes: number;
}

const HF = 'https://huggingface.co';

export const OCR_MODELS: readonly OcrModelSpec[] = [
	{
		id: 'ppocr-det',
		filename: 'ppocr-det-v6-medium.onnx',
		url: `${HF}/fumetodev/PP-OCRv6_medium_det_ONNX/resolve/40d3657242b2f173558c3b8b7a506619cbdf97c7/ppocr-det-v6-medium.onnx`,
		sizeBytes: 62_032_837
	},
	{
		id: 'ppocr-rec',
		filename: 'ppocr-rec-v6-small.onnx',
		url: `${HF}/fumetodev/PP-OCRv6_small_rec_manga_ONNX/resolve/1ef01f78c59f6f66389c9722fd2d0ab761680ea9/ppocr-rec-v6-small-manga.onnx`,
		sizeBytes: 21_143_614
	},
	{
		id: 'rtmdet-layout',
		filename: 'rtmdet-manga-layout-1024.onnx',
		url: `${HF}/fumetodev/rtmdet-manga-layout-onnx/resolve/10b9004ebfc773896dec5ceab9df6a8d259caad9/rtmdet-manga-layout-1024.onnx`,
		sizeBytes: 43_227_772
	}
] as const;

export const OCR_MODELS_TOTAL_BYTES = OCR_MODELS.reduce((total, spec) => total + spec.sizeBytes, 0);

export interface OcrModelDownloadState {
	status: 'idle' | 'downloading' | 'completed' | 'error' | 'deleting';
	error?: string;
	progress?: { downloadedBytes: number; totalBytes: number };
}

export const ocrModelDownloadState = writable<OcrModelDownloadState>({
	status: 'idle',
	error: undefined,
	progress: undefined
});

let downloadInProgress = false;
let cancelRequested = false;

/**
 * A plain browser (`npm run dev`) has no Tauri filesystem and serves the models
 * from the frontend bundle, so every readiness question answers "yes" there.
 */
function hasTauriFs(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Absolute path of a model file, downloaded or not. */
export async function ocrModelPath(filename: string): Promise<string> {
	return await join(await appDataDir(), 'models', filename);
}

/** The models that still need downloading, in download order. */
export async function missingOcrModels(): Promise<OcrModelSpec[]> {
	if (!hasTauriFs()) return [];
	const missing: OcrModelSpec[] = [];
	for (const spec of OCR_MODELS) {
		try {
			const path = await ocrModelPath(spec.filename);
			const present = (await fsExists(path)) && (await fsStat(path)).size === spec.sizeBytes;
			if (!present) missing.push(spec);
		} catch {
			missing.push(spec);
		}
	}
	return missing;
}

export async function areOcrModelsReady(): Promise<boolean> {
	return (await missingOcrModels()).length === 0;
}

/** Bytes already on disk, for the storage line in Settings. */
export async function installedOcrModelBytes(): Promise<number> {
	if (!hasTauriFs()) return 0;
	let total = 0;
	for (const spec of OCR_MODELS) {
		try {
			const path = await ocrModelPath(spec.filename);
			if (await fsExists(path)) total += (await fsStat(path)).size;
		} catch {
			// A file we cannot stat contributes nothing to the total.
		}
	}
	return total;
}

/**
 * Download every missing model, one at a time, reporting a single aggregate
 * progress figure across the whole set. A file that arrives at the wrong size
 * is deleted rather than left behind: a half-written model that survives to
 * the next launch would be reported as present and fail deep inside ONNX
 * Runtime instead of here.
 */
export async function downloadOcrModels(): Promise<void> {
	if (downloadInProgress) return;
	downloadInProgress = true;
	cancelRequested = false;

	try {
		const missing = await missingOcrModels();
		if (missing.length === 0) {
			ocrModelDownloadState.set({ status: 'completed', error: undefined, progress: undefined });
			return;
		}

		const totalBytes = missing.reduce((total, spec) => total + spec.sizeBytes, 0);
		let completedBytes = 0;
		ocrModelDownloadState.set({
			status: 'downloading',
			error: undefined,
			progress: { downloadedBytes: 0, totalBytes }
		});

		const modelsDir = await join(await appDataDir(), 'models');
		if (!(await fsExists(modelsDir))) await fsMkdir(modelsDir, { recursive: true });

		for (const spec of missing) {
			const destPath = await ocrModelPath(spec.filename);
			const base = completedBytes;
			await downloadModelFile(spec.url, destPath, {
				onProgress: (downloadedBytes) => {
					ocrModelDownloadState.set({
						status: 'downloading',
						error: undefined,
						progress: { downloadedBytes: base + downloadedBytes, totalBytes }
					});
				}
			});

			const written = await fsStat(destPath);
			if (written.size !== spec.sizeBytes) {
				await fsRemove(destPath).catch(() => undefined);
				throw new Error(
					`${spec.filename} downloaded with an unexpected size (${written.size} bytes; expected ${spec.sizeBytes})`
				);
			}
			completedBytes += spec.sizeBytes;
			ocrModelDownloadState.set({
				status: 'downloading',
				error: undefined,
				progress: { downloadedBytes: completedBytes, totalBytes }
			});
		}

		ocrModelDownloadState.set({ status: 'completed', error: undefined, progress: undefined });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Download failed';
		// A cancel is the user's own action, not a failure to report back to them.
		ocrModelDownloadState.set(
			cancelRequested || /cancel/i.test(message)
				? { status: 'idle', error: undefined, progress: undefined }
				: { status: 'error', error: message, progress: undefined }
		);
		throw error;
	} finally {
		downloadInProgress = false;
	}
}

export function cancelOcrModelDownload(): void {
	cancelRequested = true;
	cancelBridgeDownload();
	downloadInProgress = false;
	ocrModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
}

/** Remove every downloaded vision model. */
export async function deleteOcrModels(): Promise<void> {
	ocrModelDownloadState.set({ status: 'deleting', error: undefined, progress: undefined });
	try {
		for (const spec of OCR_MODELS) {
			const path = await ocrModelPath(spec.filename);
			if (await fsExists(path)) await fsRemove(path);
		}
		ocrModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
	} catch (error) {
		ocrModelDownloadState.set({
			status: 'error',
			error: error instanceof Error ? error.message : 'Delete failed',
			progress: undefined
		});
		throw error;
	}
}

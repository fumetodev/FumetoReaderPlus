/**
 * Download manager for the sound-effect filter model.
 *
 * The model is not part of any build. Every Tauri build (Android and desktop)
 * fetches it on demand from its pinned Hugging Face file into
 * `appDataDir()/models/`, once the user turns the filter on and asks for it.
 * A plain browser (`npm run dev`) has no app data directory and reads a
 * developer's local, untracked `static/models/sfx-filter.onnx` instead.
 *
 * The filter is optional. Nothing here gates translation: without the model,
 * unenclosed groups stay unscored and the layout rules decide, as before.
 *
 * Integrity is checked twice, like the vision models: the exact byte count
 * after the transfer (a truncated file or a captive-portal page), and sha256
 * when the file is loaded (a file of the right size that is still wrong) —
 * by `SfxFilterEngine` when Android runs it natively, here before the WASM
 * fallback opens it. Either way a file that fails is deleted.
 */

import { writable } from 'svelte/store';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists as fsExists, mkdir as fsMkdir, readDir as fsReadDir, readFile as fsReadFile, remove as fsRemove, stat as fsStat } from '@tauri-apps/plugin-fs';
import { downloadFile } from '$lib/util/model-downloader.js';
import * as m from '$lib/paraglide/messages.js';
import { resetSfxFilter, SFX_FILTER_CALIBRATION } from './sfx-filter.js';

export interface SfxModelSpec {
	/**
	 * Filename under `appDataDir()/models/`. Named after the calibration's model
	 * label, so the file on disk and the thresholds applied to its scores
	 * cannot belong to different models.
	 */
	filename: string;
	/** Pinned to a commit: the hash below is the only file this build accepts. */
	url: string;
	sizeBytes: number;
	sha256: string;
}

export const SFX_MODEL: SfxModelSpec = {
	filename: `${SFX_FILTER_CALIBRATION.model}.onnx`,
	url: 'https://huggingface.co/fumetodev/manga-sfx-filter-onnx/resolve/460edd438572117a37e86a52c68df7a44f89107a/sfx-filter-v0.3.onnx',
	sizeBytes: 17521333,
	sha256: 'ee75be46e3ead0e294ac680b87fbb848c62a0bca37e8a849213dcfc75bf8d3a4'
};

export interface SfxModelDownloadState {
	status: 'idle' | 'downloading' | 'completed' | 'error' | 'deleting';
	error?: string;
	progress?: { downloadedBytes: number; totalBytes: number };
}

export const sfxModelDownloadState = writable<SfxModelDownloadState>({
	status: 'idle',
	error: undefined,
	progress: undefined
});

let downloadAbort: AbortController | null = null;

/** Every Tauri build downloads the model; only a plain browser has nowhere to put it. */
export function sfxModelIsManagedHere(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function sfxModelPath(): Promise<string> {
	return await join(await appDataDir(), 'models', SFX_MODEL.filename);
}

/** Whether the model is on disk at the expected size (always true in a plain browser). */
export async function isSfxModelReady(): Promise<boolean> {
	if (!sfxModelIsManagedHere()) return true;
	try {
		const path = await sfxModelPath();
		return (await fsExists(path)) && (await fsStat(path)).size === SFX_MODEL.sizeBytes;
	} catch {
		return false;
	}
}

/** Bytes on disk, for the storage line in Settings. */
export async function installedSfxModelBytes(): Promise<number> {
	if (!sfxModelIsManagedHere()) return 0;
	try {
		const path = await sfxModelPath();
		return (await fsExists(path)) ? (await fsStat(path)).size : 0;
	} catch {
		return 0;
	}
}

/** Files an earlier model version downloaded: this build can never load them, so they only take space. */
const SUPERSEDED_MODEL_FILE = /^sfx-filter-v[A-Za-z0-9._-]*\.onnx$/;

async function removeSupersededSfxModels(): Promise<void> {
	try {
		const modelsDir = await join(await appDataDir(), 'models');
		if (!(await fsExists(modelsDir))) return;
		for (const entry of await fsReadDir(modelsDir)) {
			if (!entry.isFile || entry.name === SFX_MODEL.filename || !SUPERSEDED_MODEL_FILE.test(entry.name)) continue;
			await fsRemove(await join(modelsDir, entry.name)).catch(() => undefined);
		}
	} catch {
		// Housekeeping only: a leftover file costs space, never correctness.
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The downloaded model's bytes, or `null` when it is not downloaded. A file
 * that fails the hash is deleted, so Settings offers the download again
 * instead of reporting a model that can never load.
 */
export async function readDownloadedSfxModel(): Promise<Uint8Array | null> {
	if (!sfxModelIsManagedHere() || !(await isSfxModelReady())) return null;
	const path = await sfxModelPath();
	const bytes = await fsReadFile(path);
	if ((await sha256Hex(bytes)) !== SFX_MODEL.sha256) {
		console.warn('[sfx-model] Downloaded model failed its integrity check; removing it.');
		await fsRemove(path).catch(() => undefined);
		sfxModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
		return null;
	}
	return bytes;
}

/**
 * Download the model. A file that arrives at the wrong size is deleted rather
 * than left behind to be reported as present.
 */
export async function downloadSfxModel(): Promise<void> {
	if (downloadAbort) return;
	if (await isSfxModelReady()) {
		sfxModelDownloadState.set({ status: 'completed', error: undefined, progress: undefined });
		return;
	}
	const abort = new AbortController();
	downloadAbort = abort;
	const totalBytes = SFX_MODEL.sizeBytes;
	sfxModelDownloadState.set({ status: 'downloading', error: undefined, progress: { downloadedBytes: 0, totalBytes } });
	try {
		const modelsDir = await join(await appDataDir(), 'models');
		if (!(await fsExists(modelsDir))) await fsMkdir(modelsDir, { recursive: true });
		const destPath = await sfxModelPath();
		// Per-download cancellation: cancelling this transfer must not stop a
		// vision or translation model downloading at the same time.
		await downloadFile(
			SFX_MODEL.url,
			destPath,
			(downloadedBytes) => {
				if (abort.signal.aborted) return;
				sfxModelDownloadState.set({ status: 'downloading', error: undefined, progress: { downloadedBytes, totalBytes } });
			},
			abort.signal
		);
		const written = await fsStat(destPath);
		if (written.size !== SFX_MODEL.sizeBytes) {
			await fsRemove(destPath).catch(() => undefined);
			throw new Error(
				`${SFX_MODEL.filename} downloaded with an unexpected size (${written.size} bytes; expected ${SFX_MODEL.sizeBytes})`
			);
		}
		await removeSupersededSfxModels();
		// A session that gave up while the model was missing loads it on the next page.
		resetSfxFilter();
		sfxModelDownloadState.set({ status: 'completed', error: undefined, progress: undefined });
	} catch (error) {
		const message = error instanceof Error ? error.message : m.settings_models_download_failed();
		// A cancel is the user's own action, not a failure to report back to them.
		sfxModelDownloadState.set(
			abort.signal.aborted || /cancel/i.test(message)
				? { status: 'idle', error: undefined, progress: undefined }
				: { status: 'error', error: message, progress: undefined }
		);
		throw error;
	} finally {
		if (downloadAbort === abort) downloadAbort = null;
	}
}

export function cancelSfxModelDownload(): void {
	downloadAbort?.abort();
	downloadAbort = null;
	sfxModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
}

export async function deleteSfxModel(): Promise<void> {
	sfxModelDownloadState.set({ status: 'deleting', error: undefined, progress: undefined });
	try {
		const path = await sfxModelPath();
		if (await fsExists(path)) await fsRemove(path);
		await removeSupersededSfxModels();
		resetSfxFilter();
		sfxModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
	} catch (error) {
		sfxModelDownloadState.set({
			status: 'error',
			error: error instanceof Error ? error.message : 'Delete failed',
			progress: undefined
		});
		throw error;
	}
}

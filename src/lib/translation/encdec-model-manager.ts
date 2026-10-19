/**
 * Download manager for the on-device Japanese-to-English encoder-decoder translator.
 *
 * Five files, pinned to one Hugging Face revision, into `appDataDir()/models/<dir>/` (`appDataDir()` is the Kotlin
 * `context.dataDir` the native engine reads). Android only, like the engine that runs them.
 *
 * Integrity is checked twice, like the sound-effect model: the exact byte count after each transfer (a truncated file
 * or a captive-portal page), and sha256 when the native engine opens the files (a file of the right size that is still
 * wrong). Either way a file that fails is deleted. A finished download is proven by translating a probe line, the way
 * a GGUF download is, before Settings calls it Ready.
 */

import { writable } from 'svelte/store';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists as fsExists, mkdir as fsMkdir, readDir as fsReadDir, remove as fsRemove, stat as fsStat } from '@tauri-apps/plugin-fs';
import { downloadFile } from '$lib/util/model-downloader.js';
import * as m from '$lib/paraglide/messages.js';

export interface EncDecModelFile {
	name: string;
	sizeBytes: number;
	sha256: string;
}

export interface EncDecModelSpec {
	/** Folder under `appDataDir()/models/`, named after the version, so a future model never shares it. */
	dir: string;
	/** Hugging Face commit every file is pinned to: the hashes below are the only files this build accepts. */
	revision: string;
	/** The version's folder in the repository. */
	repoFolder: string;
	files: EncDecModelFile[];
}

const REPO = 'https://huggingface.co/fumetodev/manga-ja-en-translator-onnx/resolve';

export const ENCDEC_MODEL: EncDecModelSpec = {
	dir: 'manga-ja-en-v1',
	revision: '3fb250a9e078f9f988d6a4326f7fa1af4584c2a7',
	repoFolder: 'v1',
	files: [
		{ name: 'encoder.int8.onnx', sizeBytes: 358_353_978, sha256: '0f7104134a05fb852186836948dc225f1f4c080b414ba9003b0984bf0ead659c' },
		{ name: 'decoder.int8.onnx', sizeBytes: 84_639_888, sha256: 'c34cd737fa97582228d9ddd43128161280a15866b07e72a8cd350c699b232eb0' },
		{ name: 'enc-vocab.json', sizeBytes: 3_676_471, sha256: '20dee436709c3019526688882be31d0be209d70ad93180eff0e71f043711141e' },
		{ name: 'dec-vocab.json', sizeBytes: 183_290, sha256: 'ab7b8c4a1a939c937c9f46dcd13ff651af54d6bd32f678e3f2439001fb9416f0' },
		{ name: 'meta.json', sizeBytes: 325, sha256: 'dbd866b9684d46452bc7076fbe803439e6b1745188d751f0cb18abcfb335f347' }
	]
};

export const ENCDEC_MODEL_TOTAL_BYTES = ENCDEC_MODEL.files.reduce((sum, f) => sum + f.sizeBytes, 0);

function fileUrl(name: string): string {
	return `${REPO}/${ENCDEC_MODEL.revision}/${ENCDEC_MODEL.repoFolder}/${name}`;
}

export interface EncDecModelDownloadState {
	status: 'idle' | 'downloading' | 'completed' | 'error' | 'deleting';
	error?: string;
	progress?: { downloadedBytes: number; totalBytes: number };
}

export const encdecModelDownloadState = writable<EncDecModelDownloadState>({
	status: 'idle',
	error: undefined,
	progress: undefined
});

let downloadAbort: AbortController | null = null;

async function modelDir(): Promise<string> {
	return await join(await appDataDir(), 'models', ENCDEC_MODEL.dir);
}

/** Whether every file is on disk at its expected size. */
export async function isEncDecModelReady(): Promise<boolean> {
	try {
		const dir = await modelDir();
		for (const file of ENCDEC_MODEL.files) {
			const path = await join(dir, file.name);
			if (!(await fsExists(path)) || (await fsStat(path)).size !== file.sizeBytes) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Bytes on disk, for the storage card in Settings. */
export async function installedEncDecModelBytes(): Promise<number> {
	try {
		const dir = await modelDir();
		let total = 0;
		for (const file of ENCDEC_MODEL.files) {
			const path = await join(dir, file.name);
			if (await fsExists(path)) total += (await fsStat(path)).size;
		}
		return total;
	} catch {
		return 0;
	}
}

/** Folders an earlier version of this model downloaded: this build can never load them, so they only take space. */
const SUPERSEDED_DIR = /^manga-ja-en-v[0-9]+$/;

async function removeSupersededVersions(): Promise<void> {
	try {
		const modelsDir = await join(await appDataDir(), 'models');
		if (!(await fsExists(modelsDir))) return;
		for (const entry of await fsReadDir(modelsDir)) {
			if (!entry.isDirectory || entry.name === ENCDEC_MODEL.dir || !SUPERSEDED_DIR.test(entry.name)) continue;
			await fsRemove(await join(modelsDir, entry.name), { recursive: true }).catch(() => undefined);
		}
	} catch {
		// Housekeeping only: a leftover folder costs space, never correctness.
	}
}

/**
 * Download every file not already on disk at its expected size, then prove the model translates. A file that arrives
 * at the wrong size is deleted rather than left behind to be reported as present.
 */
export async function downloadEncDecModel(): Promise<void> {
	if (downloadAbort) return;
	const abort = new AbortController();
	downloadAbort = abort;
	const totalBytes = ENCDEC_MODEL_TOTAL_BYTES;
	encdecModelDownloadState.set({ status: 'downloading', error: undefined, progress: { downloadedBytes: 0, totalBytes } });
	try {
		const dir = await modelDir();
		if (!(await fsExists(dir))) await fsMkdir(dir, { recursive: true });
		let done = 0;
		for (const file of ENCDEC_MODEL.files) {
			const path = await join(dir, file.name);
			if ((await fsExists(path)) && (await fsStat(path)).size === file.sizeBytes) {
				done += file.sizeBytes;
				continue;
			}
			// Per-download cancellation: cancelling this transfer must not stop another model downloading.
			await downloadFile(
				fileUrl(file.name),
				path,
				(downloadedBytes) => {
					if (abort.signal.aborted) return;
					encdecModelDownloadState.set({ status: 'downloading', error: undefined, progress: { downloadedBytes: done + downloadedBytes, totalBytes } });
				},
				abort.signal
			);
			const written = await fsStat(path);
			if (written.size !== file.sizeBytes) {
				await fsRemove(path).catch(() => undefined);
				throw new Error(`${file.name} downloaded with an unexpected size (${written.size} bytes; expected ${file.sizeBytes})`);
			}
			done += file.sizeBytes;
		}
		await validateDownloadedModel();
		await removeSupersededVersions();
		encdecModelDownloadState.set({ status: 'completed', error: undefined, progress: undefined });
	} catch (error) {
		const message = error instanceof Error ? error.message : m.settings_models_download_failed();
		// A cancel is the user's own action, not a failure to report back to them.
		encdecModelDownloadState.set(
			abort.signal.aborted || /cancel/i.test(message)
				? { status: 'idle', error: undefined, progress: undefined }
				: { status: 'error', error: message, progress: undefined }
		);
		throw error;
	} finally {
		if (downloadAbort === abort) downloadAbort = null;
	}
}

/**
 * The first translation hashes every file against its pin and opens both sessions; a probe line proves the model
 * answers in English. A model that fails is deleted, so Settings does not report a model that can never translate.
 */
async function validateDownloadedModel(): Promise<void> {
	const { encdecAvailable, translateWithEncDec } = await import('./encdec-translator.js');
	if (!encdecAvailable()) return;
	let probe = '';
	try {
		probe = (await translateWithEncDec('行くぞ！')).trim();
	} catch (error) {
		await removeModelFiles();
		throw error;
	}
	if (!probe || !/[A-Za-z]/.test(probe)) {
		await removeModelFiles();
		throw new Error('The translation model downloaded but failed its Japanese-to-English check.');
	}
}

async function removeModelFiles(): Promise<void> {
	const dir = await modelDir();
	if (await fsExists(dir)) await fsRemove(dir, { recursive: true });
}

export function cancelEncDecModelDownload(): void {
	downloadAbort?.abort();
	downloadAbort = null;
	encdecModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
}

export async function deleteEncDecModel(): Promise<void> {
	encdecModelDownloadState.set({ status: 'deleting', error: undefined, progress: undefined });
	try {
		const { releaseEncDec } = await import('./encdec-translator.js');
		await releaseEncDec();
		await removeModelFiles();
		await removeSupersededVersions();
		encdecModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
	} catch (error) {
		encdecModelDownloadState.set({
			status: 'error',
			error: error instanceof Error ? error.message : 'Delete failed',
			progress: undefined
		});
		throw error;
	}
}

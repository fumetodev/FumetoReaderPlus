/**
 * Download manager for the on-device Japanese-to-English encoder-decoder translators.
 *
 * Each model is five files, pinned to one Hugging Face revision, in its own folder under `appDataDir()/models/`
 * (`appDataDir()` is the Kotlin `context.dataDir` the native engine reads). Android only, like the engine that runs
 * them. FumetoTranslate replaced the first model (`manga-ja-en-v1`): that one is no longer offered for download, and
 * its folder is removed by the handoff once FumetoTranslate is ready (encdec-handoff.ts), never by a download here.
 *
 * Integrity is checked twice, like the sound-effect model: the exact byte count after each transfer (a truncated file
 * or a captive-portal page), and sha256 when the native engine opens the files (a file of the right size that is still
 * wrong). Either way a file that fails is deleted. A finished download is proven by translating a probe line, the way
 * a GGUF download is, before Settings calls it Ready.
 */

import { get, writable, type Writable } from 'svelte/store';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists as fsExists, mkdir as fsMkdir, remove as fsRemove, stat as fsStat } from '@tauri-apps/plugin-fs';
import { downloadFile } from '$lib/util/model-downloader.js';
import * as m from '$lib/paraglide/messages.js';

export type EncDecModelId = 'manga-ja-en-v1' | 'fumetotranslate';

export interface EncDecModelFile {
	name: string;
	sizeBytes: number;
	sha256: string;
}

export interface EncDecModelSpec {
	/** `owner/name` on Hugging Face. */
	repo: string;
	/** Folder under `appDataDir()/models/`, one per model, so two models never share it. */
	dir: string;
	/** Hugging Face commit every file is pinned to: the hashes below are the only files this build accepts. */
	revision: string;
	/** The files' folder in the repository. */
	repoFolder: string;
	/** Reads a whole page at once (page and line modes); the first model reads one line at a time. */
	pageModel: boolean;
	files: EncDecModelFile[];
}

/** The tokenizers' vocabularies are the same files in both models. */
const VOCABULARIES: EncDecModelFile[] = [
	{ name: 'enc-vocab.json', sizeBytes: 3_676_471, sha256: '20dee436709c3019526688882be31d0be209d70ad93180eff0e71f043711141e' },
	{ name: 'dec-vocab.json', sizeBytes: 183_290, sha256: 'ab7b8c4a1a939c937c9f46dcd13ff651af54d6bd32f678e3f2439001fb9416f0' }
];

export const ENCDEC_MODELS: Record<EncDecModelId, EncDecModelSpec> = {
	'manga-ja-en-v1': {
		repo: 'fumetodev/manga-ja-en-translator-onnx',
		dir: 'manga-ja-en-v1',
		revision: '3fb250a9e078f9f988d6a4326f7fa1af4584c2a7',
		repoFolder: 'v1',
		pageModel: false,
		files: [
			{ name: 'encoder.int8.onnx', sizeBytes: 358_353_978, sha256: '0f7104134a05fb852186836948dc225f1f4c080b414ba9003b0984bf0ead659c' },
			{ name: 'decoder.int8.onnx', sizeBytes: 84_639_888, sha256: 'c34cd737fa97582228d9ddd43128161280a15866b07e72a8cd350c699b232eb0' },
			...VOCABULARIES,
			{ name: 'meta.json', sizeBytes: 325, sha256: 'dbd866b9684d46452bc7076fbe803439e6b1745188d751f0cb18abcfb335f347' }
		]
	},
	fumetotranslate: {
		repo: 'fumetodev/fumetotranslate-manga-ja-translator',
		dir: 'fumetotranslate',
		revision: 'bd412776250570467cfeb261c94a7918da936091',
		repoFolder: 'int8',
		pageModel: true,
		files: [
			{ name: 'encoder.int8.onnx', sizeBytes: 358_353_978, sha256: '55f914d801a3b5259b5ce556017dc2ba8a8d692fb8d6d6005d7dbed6c1387c0e' },
			{ name: 'decoder.int8.onnx', sizeBytes: 90_095_234, sha256: 'f49ca242e7bf58d32a8603c834c7763653df74b9c2babc51f30112ea23034bbf' },
			...VOCABULARIES,
			{ name: 'meta.json', sizeBytes: 482, sha256: '16e8e085fe97606259e980134015142113dc0e89b459ac81c93ea0ce40ce642e' }
		]
	}
};

export function encdecModelTotalBytes(id: EncDecModelId): number {
	return ENCDEC_MODELS[id].files.reduce((sum, f) => sum + f.sizeBytes, 0);
}

/** `{ "<file>": { size, sha256 } }`, the form the native engine checks the files against. */
export function encdecManifest(id: EncDecModelId): Record<string, { size: number; sha256: string }> {
	return Object.fromEntries(ENCDEC_MODELS[id].files.map((f) => [f.name, { size: f.sizeBytes, sha256: f.sha256 }]));
}

function fileUrl(id: EncDecModelId, name: string): string {
	const spec = ENCDEC_MODELS[id];
	return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${spec.repoFolder}/${name}`;
}

export interface EncDecModelDownloadState {
	status: 'idle' | 'downloading' | 'completed' | 'error' | 'deleting';
	error?: string;
	progress?: { downloadedBytes: number; totalBytes: number };
}

const idleState = (): EncDecModelDownloadState => ({ status: 'idle', error: undefined, progress: undefined });

/** One store per model: one model downloading must not show as progress on the other's card. */
export const encdecModelDownloadStates: Record<EncDecModelId, Writable<EncDecModelDownloadState>> = {
	'manga-ja-en-v1': writable(idleState()),
	fumetotranslate: writable(idleState())
};

const downloadAborts = new Map<EncDecModelId, AbortController>();

async function modelDir(id: EncDecModelId): Promise<string> {
	return await join(await appDataDir(), 'models', ENCDEC_MODELS[id].dir);
}

/** Whether every file is on disk at its expected size. */
export async function isEncDecModelReady(id: EncDecModelId): Promise<boolean> {
	try {
		const dir = await modelDir(id);
		for (const file of ENCDEC_MODELS[id].files) {
			const path = await join(dir, file.name);
			if (!(await fsExists(path)) || (await fsStat(path)).size !== file.sizeBytes) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Whether anything of the model is on disk, complete or not. */
export async function encdecModelFolderExists(id: EncDecModelId): Promise<boolean> {
	try {
		return await fsExists(await modelDir(id));
	} catch {
		return false;
	}
}

/** Bytes on disk, for the storage card in Settings. */
export async function installedEncDecModelBytes(id: EncDecModelId): Promise<number> {
	try {
		const dir = await modelDir(id);
		let total = 0;
		for (const file of ENCDEC_MODELS[id].files) {
			const path = await join(dir, file.name);
			if (await fsExists(path)) total += (await fsStat(path)).size;
		}
		return total;
	} catch {
		return 0;
	}
}

/** Listeners told when a model's download has finished and passed its probe (the handoff listens). */
const readyListeners = new Set<(id: EncDecModelId) => void>();

export function onEncDecModelReady(listener: (id: EncDecModelId) => void): () => void {
	readyListeners.add(listener);
	return () => readyListeners.delete(listener);
}

/**
 * Download every file not already on disk at its expected size, then prove the model translates. A file that arrives
 * at the wrong size is deleted rather than left behind to be reported as present.
 */
export async function downloadEncDecModel(id: EncDecModelId): Promise<void> {
	if (downloadAborts.has(id)) return;
	const state = encdecModelDownloadStates[id];
	const abort = new AbortController();
	downloadAborts.set(id, abort);
	const totalBytes = encdecModelTotalBytes(id);
	state.set({ status: 'downloading', error: undefined, progress: { downloadedBytes: 0, totalBytes } });
	try {
		const dir = await modelDir(id);
		if (!(await fsExists(dir))) await fsMkdir(dir, { recursive: true });
		let done = 0;
		for (const file of ENCDEC_MODELS[id].files) {
			const path = await join(dir, file.name);
			if ((await fsExists(path)) && (await fsStat(path)).size === file.sizeBytes) {
				done += file.sizeBytes;
				continue;
			}
			// Per-download cancellation: cancelling this transfer must not stop another model downloading.
			await downloadFile(
				fileUrl(id, file.name),
				path,
				(downloadedBytes) => {
					if (abort.signal.aborted) return;
					state.set({ status: 'downloading', error: undefined, progress: { downloadedBytes: done + downloadedBytes, totalBytes } });
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
		await validateDownloadedModel(id);
		state.set({ status: 'completed', error: undefined, progress: undefined });
		for (const listener of readyListeners) listener(id);
	} catch (error) {
		const message = error instanceof Error ? error.message : m.settings_models_download_failed();
		// A cancel is the user's own action, not a failure to report back to them.
		state.set(
			abort.signal.aborted || /cancel/i.test(message)
				? idleState()
				: { status: 'error', error: message, progress: undefined }
		);
		throw error;
	} finally {
		if (downloadAborts.get(id) === abort) downloadAborts.delete(id);
	}
}

/** Whether a model's download is running now. */
export function isEncDecModelDownloading(id: EncDecModelId): boolean {
	return downloadAborts.has(id) || get(encdecModelDownloadStates[id]).status === 'downloading';
}

/**
 * The first translation hashes every file against its pin and opens both sessions; a probe line proves the model
 * answers in English. A model that fails is deleted, so Settings does not report a model that can never translate.
 */
async function validateDownloadedModel(id: EncDecModelId): Promise<void> {
	const { encdecAvailable, translateWithEncDec } = await import('./encdec-translator.js');
	if (!encdecAvailable()) return;
	let probe = '';
	try {
		probe = (await translateWithEncDec(id, '行くぞ！')).trim();
	} catch (error) {
		await removeEncDecModelFiles(id);
		throw error;
	}
	if (!probe || !/[A-Za-z]/.test(probe)) {
		await removeEncDecModelFiles(id);
		throw new Error('The translation model downloaded but failed its Japanese-to-English check.');
	}
}

/** Removes the model's folder. Callers release the native engine first if it may hold the model. */
export async function removeEncDecModelFiles(id: EncDecModelId): Promise<void> {
	const dir = await modelDir(id);
	if (await fsExists(dir)) await fsRemove(dir, { recursive: true });
}

export function cancelEncDecModelDownload(id: EncDecModelId): void {
	downloadAborts.get(id)?.abort();
	downloadAborts.delete(id);
	encdecModelDownloadStates[id].set(idleState());
}

export async function deleteEncDecModel(id: EncDecModelId): Promise<void> {
	const state = encdecModelDownloadStates[id];
	state.set({ status: 'deleting', error: undefined, progress: undefined });
	try {
		const { releaseEncDec } = await import('./encdec-translator.js');
		await releaseEncDec();
		await removeEncDecModelFiles(id);
		state.set(idleState());
	} catch (error) {
		state.set({
			status: 'error',
			error: error instanceof Error ? error.message : 'Delete failed',
			progress: undefined
		});
		throw error;
	}
}

/**
 * The on-device Japanese-to-English encoder-decoder translator, run natively through `__fumeto_encdec_native`
 * (tokenizers, both ONNX graphs and beam search in Kotlin). Android only: a plain browser and the desktop build have no
 * such bridge, so Settings does not offer the model there and `encdecAvailable()` is false.
 *
 * The WebView pins the files (`ENCDEC_MODEL` in encdec-model-manager.ts) and sends their sizes and sha256 with every
 * call; the engine checks them once per set of files on disk and deletes a file that fails, so a corrupt download turns
 * into the Download button again rather than a model that can never load.
 */
import { ENCDEC_MODEL, encdecModelDownloadState } from './encdec-model-manager.js';

interface EncDecNativeBridge {
	isAvailable(): boolean;
	translate(modelDir: string, manifestJson: string, textsJson: string, beam: number, maxLen: number, threads: number, callbackId: string): void;
	release(callbackId: string): void;
}

declare global {
	interface Window {
		__fumeto_encdec_native?: EncDecNativeBridge;
		__encdec_native_resolve?: (callbackId: string, json: string) => void;
		__encdec_native_reject?: (callbackId: string, message: string) => void;
	}
}

/** Beam 4 is the setting the model was evaluated and published with; greedy decoding loses clearly in blind review. */
const BEAM = 4;
const MAX_LEN = 128;
/** Measured on a Snapdragon 8 Gen 2: four intra-op threads, about 140 ms a bubble. */
const THREADS = 4;
/** The first call also hashes about 450 MB and opens both sessions. */
const CALL_TIMEOUT_MS = 120_000;

const pending = new Map<string, { resolve: (json: string) => void; reject: (error: Error) => void }>();
let counter = 0;

function installHandlers(): void {
	if (window.__encdec_native_resolve) return;
	window.__encdec_native_resolve = (id, json) => {
		pending.get(id)?.resolve(json);
		pending.delete(id);
	};
	window.__encdec_native_reject = (id, message) => {
		pending.get(id)?.reject(new Error(message));
		pending.delete(id);
	};
}

function bridge(): EncDecNativeBridge | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.__fumeto_encdec_native?.isAvailable() ? window.__fumeto_encdec_native : null;
	} catch {
		return null;
	}
}

/** Whether this build can run the translator at all (Android with the native bridge). */
export function encdecAvailable(): boolean {
	return bridge() !== null;
}

function call(send: (b: EncDecNativeBridge, id: string) => void): Promise<string> {
	const b = bridge();
	if (!b) return Promise.reject(new Error('The fast translation model runs on Android only.'));
	installHandlers();
	const id = `encdec-${++counter}-${Date.now()}`;
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error('The translation model did not answer in time.'));
		}, CALL_TIMEOUT_MS);
		pending.set(id, {
			resolve: (json) => { clearTimeout(timer); resolve(json); },
			reject: (error) => { clearTimeout(timer); reject(error); }
		});
		try {
			send(b, id);
		} catch (error) {
			clearTimeout(timer);
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

/**
 * Translate one Japanese text to English. Cancellation is checked before the call; a bubble takes a fraction of a
 * second, so a cancel lands at the next block.
 */
export async function translateWithEncDec(text: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
	const manifest = Object.fromEntries(ENCDEC_MODEL.files.map((f) => [f.name, { size: f.sizeBytes, sha256: f.sha256 }]));
	let json: string;
	try {
		json = await call((b, id) => b.translate(ENCDEC_MODEL.dir, JSON.stringify(manifest), JSON.stringify([text]), BEAM, MAX_LEN, THREADS, id));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('integrity:')) {
			// The engine deleted the failing file: Settings must offer the download again.
			encdecModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
			throw new Error('The translation model failed its integrity check and was removed. Download it again in Settings → Translation → On-Device.');
		}
		throw error;
	}
	const result = JSON.parse(json) as { texts: string[]; ms: number };
	return result.texts[0] ?? '';
}

/** Frees the model's memory (about 450 MB) when another model is chosen or this one is deleted. */
export async function releaseEncDec(): Promise<void> {
	if (!bridge()) return;
	await call((b, id) => b.release(id)).catch(() => undefined);
}

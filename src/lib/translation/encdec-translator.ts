/**
 * The on-device Japanese-to-English encoder-decoder translators, run natively through `__fumeto_encdec_native`
 * (tokenizers, both ONNX graphs and beam search in Kotlin). Android only: a plain browser and the desktop build have no
 * such bridge, so Settings does not offer the models there and `encdecAvailable()` is false.
 *
 * The WebView pins the files (`ENCDEC_MODELS` in encdec-model-manager.ts) and sends their sizes and sha256 with every
 * call; the engine checks them once per set of files on disk and deletes a file that fails, so a corrupt download turns
 * into the Download button again rather than a model that can never load.
 *
 * A page model (FumetoTranslate) translates a page in one call: every line is read with the rest of the page in view,
 * and all of them are decoded together. One line on its own is a page of one line.
 */
import { ENCDEC_MODELS, encdecManifest, encdecModelDownloadStates, type EncDecModelId } from './encdec-model-manager.js';

interface EncDecNativeBridge {
	isAvailable(): boolean;
	translate(modelDir: string, manifestJson: string, textsJson: string, beam: number, maxLen: number, threads: number, callbackId: string): void;
	translatePage(modelDir: string, manifestJson: string, requestJson: string, beam: number, maxLen: number, threads: number, callbackId: string): void;
	cancel(callbackId: string): void;
	release(callbackId: string): void;
}

declare global {
	interface Window {
		__fumeto_encdec_native?: EncDecNativeBridge;
		__encdec_native_resolve?: (callbackId: string, json: string) => void;
		__encdec_native_reject?: (callbackId: string, message: string) => void;
	}
}

/** Beam 4 is the setting the models were evaluated and published with; greedy decoding loses clearly in blind review. */
const BEAM = 4;
const MAX_LEN = 128;
/** Measured on a Snapdragon 8 Gen 2: four intra-op threads, about 140 ms a bubble for the line model. */
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

/** Whether this build can run the translators at all (Android with the native bridge). */
export function encdecAvailable(): boolean {
	return bridge() !== null;
}

function abortError(): DOMException {
	return new DOMException('Aborted', 'AbortError');
}

/** One native call. An abort cancels it natively (between decoder steps) and rejects it as an AbortError. */
function call(send: (b: EncDecNativeBridge, id: string) => void, signal?: AbortSignal): Promise<string> {
	const b = bridge();
	if (!b) return Promise.reject(new Error('The on-device Japanese-to-English translator runs on Android only.'));
	if (signal?.aborted) return Promise.reject(abortError());
	installHandlers();
	const id = `encdec-${++counter}-${Date.now()}`;
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => {
			try { b.cancel(id); } catch { /* the call ends on its own */ }
		};
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		const timer = setTimeout(() => {
			pending.delete(id);
			done();
			reject(new Error('The translation model did not answer in time.'));
		}, CALL_TIMEOUT_MS);
		signal?.addEventListener('abort', onAbort, { once: true });
		pending.set(id, {
			resolve: (json) => { done(); resolve(json); },
			reject: (error) => { done(); reject(signal?.aborted || error.message === 'cancelled' ? abortError() : error); }
		});
		try {
			send(b, id);
		} catch (error) {
			done();
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function integrityFailure(id: EncDecModelId, error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith('integrity:')) {
		// The engine deleted the failing file: Settings must offer the download again.
		encdecModelDownloadStates[id].set({ status: 'idle', error: undefined, progress: undefined });
		throw new Error('The translation model failed its integrity check and was removed. Download it again in Settings → Translation → On-Device.');
	}
	throw error;
}

/**
 * What a page model reads for one text block: one string, with the line breaks between a horizontal block's rows
 * removed (Japanese runs on without a space; a space is kept only where both sides are Latin letters or digits). The
 * line model keeps the text exactly as it always received it.
 */
export function encdecSourceText(id: EncDecModelId, text: string): string {
	if (!ENCDEC_MODELS[id].pageModel) return text;
	return text
		.replace(/([A-Za-z0-9])[ \t]*\r?\n[ \t]*(?=[A-Za-z0-9])/g, '$1 ')
		.replace(/[ \t]*\r?\n[ \t]*/g, '')
		.trim();
}

export interface EncDecPageResult {
	/** One translation per input line; "" for a blank line or one that was not asked for. */
	texts: string[];
	ms: number;
	/** Encoder passes the page took (more than one only for a page longer than the model's window). */
	windows: number;
}

/**
 * Translate one page, in reading order. `decode`: the indices to translate, the rest being context only (all of them
 * when absent). A line model translates the requested lines one by one, without context.
 */
export async function translatePageWithEncDec(
	id: EncDecModelId,
	lines: string[],
	options: { decode?: number[]; signal?: AbortSignal } = {}
): Promise<EncDecPageResult> {
	const spec = ENCDEC_MODELS[id];
	const request = JSON.stringify({ lines: lines.map((l) => encdecSourceText(id, l)), decode: options.decode ?? null });
	let json: string;
	try {
		json = await call((b, cb) => b.translatePage(spec.dir, JSON.stringify(encdecManifest(id)), request, BEAM, MAX_LEN, THREADS, cb), options.signal);
	} catch (error) {
		integrityFailure(id, error);
	}
	const result = JSON.parse(json) as EncDecPageResult;
	return { texts: lines.map((_, i) => result.texts[i] ?? ''), ms: result.ms, windows: result.windows };
}

/** Translate one Japanese text on its own (line mode, or the line model). */
export async function translateWithEncDec(id: EncDecModelId, text: string, signal?: AbortSignal): Promise<string> {
	return (await translatePageWithEncDec(id, [text], { signal })).texts[0];
}

/** Frees the model's memory (about 450 MB) when another model is chosen or this one is deleted. */
export async function releaseEncDec(): Promise<void> {
	if (!bridge()) return;
	await call((b, id) => b.release(id)).catch(() => undefined);
}

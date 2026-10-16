import type { FreeTextPixelBuffer } from './free-text-features.js';
import type { DetectedTextGroupKind } from '$lib/types/index.js';

/**
 * Learned sound-effect filter.
 *
 * A small image classifier scores every UNENCLOSED text group (balloon text is
 * never scored) from a crop of the page plus a few cheap features the
 * extractor already has. The score rides on the region as `sfxScore`; the
 * reader's filter strength is applied later, at layout and translation time,
 * so moving the strength acts on pages that are already translated.
 *
 * The model contract is fixed by the export (one ONNX file):
 *   image  float32 [B, 3, S, S]  RGB in 0..1, the group's box plus a 12% margin,
 *                                letterboxed onto white
 *   side   float32 [B, 21]       `sfxSideFeatures` below, in this exact order
 *   p_sfx  float32 [B]
 * Normalisation lives inside the graph, so this file never needs to know which
 * backbone was trained.
 */

/** A developer's local copy, read only in a plain browser; the app downloads the model (sfx-model-manager.ts). */
export const SFX_FILTER_MODEL_PATH = '/models/sfx-filter.onnx';
export const SFX_FILTER_INPUT_SIZE = 224;
export const SFX_FILTER_CROP_MARGIN = 0.12;
/** Layout kinds in the one-hot order the model was trained with. */
export const SFX_FILTER_KINDS: readonly DetectedTextGroupKind[] = ['unknown', 'narration', 'borderless', 'sfx', 'sign'];
export const SFX_FILTER_SIDE_FEATURES = 21;

// ---------------------------------------------------------------------------
// Strength → threshold
// ---------------------------------------------------------------------------

/**
 * Calibration of the shipped model: the score threshold that keeps the share
 * of unenclosed dialogue/narration it hides at or below a budget, measured on
 * held-out labelled pages. Strength 0 is off; between anchors the threshold is
 * interpolated in logit space, so the slider moves smoothly.
 *
 * Regenerated with the model — a new model with stale anchors would silently
 * change what every strength means.
 */
export const SFX_FILTER_CALIBRATION: {
	model: string;
	anchors: ReadonlyArray<{ strength: number; threshold: number; textLossBudget: number }>;
} = {
	model: 'sfx-filter-v0.3',
	anchors: [
		{ strength: 0.25, threshold: 0.9648, textLossBudget: 0.005 },
		{ strength: 0.5, threshold: 0.8672, textLossBudget: 0.02 },
		{ strength: 0.75, threshold: 0.5898, textLossBudget: 0.05 },
		{ strength: 1, threshold: 0.3086, textLossBudget: 0.1 }
	]
};

/** Filter strength for installs that never moved the slider: the 2% text-loss anchor. */
export const DEFAULT_SFX_FILTER_STRENGTH = 0.5;

/** Highest threshold the slider can reach just above "off". */
const THRESHOLD_CEILING = 0.995;

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Score a group must reach to be treated as a sound effect, or `undefined`
 * when the filter is off.
 */
export function sfxThresholdForStrength(
	strength: number | undefined,
	calibration = SFX_FILTER_CALIBRATION
): number | undefined {
	if (strength === undefined || !Number.isFinite(strength) || strength <= 0) return undefined;
	const s = Math.min(1, strength);
	const points = [{ strength: 0, threshold: THRESHOLD_CEILING }, ...calibration.anchors];
	for (let index = 1; index < points.length; index += 1) {
		const left = points[index - 1];
		const right = points[index];
		if (s <= right.strength) {
			const t = (s - left.strength) / Math.max(1e-9, right.strength - left.strength);
			const value = sigmoid(logit(left.threshold) + t * (logit(right.threshold) - logit(left.threshold)));
			// Quantized: the threshold enters the layout input hash.
			return Math.round(value * 1000) / 1000;
		}
	}
	return points[points.length - 1].threshold;
}

/** Whether a stored score counts as a sound effect at this threshold. */
export function isLearnedSfx(sfxScore: number | undefined, threshold: number | undefined): boolean {
	return threshold !== undefined && sfxScore !== undefined && Number.isFinite(sfxScore) && sfxScore >= threshold;
}

// ---------------------------------------------------------------------------
// Side features (must match the training-side reference exactly)
// ---------------------------------------------------------------------------

const KATAKANA = /[ァ-ヺー]/u;
const HIRAGANA = /[ぁ-ゖ]/u;
const KANJI = /[一-鿿々]/u;
const EMPHASIS = /[！!？?…・〜～ー♡♥❤っッ゛゜]/u;
const SMALL_TSU = /[っッ]/u;
const LETTER = /\p{L}/u;

function stripWhitespace(text: string): string[] {
	return Array.from(text.replace(/\s/gu, ''));
}

function textFeatures(text: string): number[] {
	const chars = stripWhitespace(text);
	const n = Math.max(1, chars.length);
	let kata = 0, hira = 0, kanji = 0, emphasis = 0, otherLetters = 0;
	for (const c of chars) {
		const isKata = KATAKANA.test(c), isHira = HIRAGANA.test(c), isKanji = KANJI.test(c);
		if (isKata) kata += 1;
		if (isHira) hira += 1;
		if (isKanji) kanji += 1;
		if (EMPHASIS.test(c)) emphasis += 1;
		if (LETTER.test(c) && !isKata && !isHira && !isKanji) otherLetters += 1;
	}
	return [
		Math.log1p(chars.length),
		kata / n,
		hira / n,
		kanji / n,
		emphasis / n,
		SMALL_TSU.test(chars.join('')) ? 1 : 0,
		text.includes('\n') ? 1 : 0,
		otherLetters / n
	];
}

/** Characters per box, as a glyph-size proxy: sqrt(area / visible characters). */
function glyphSize(width: number, height: number, text: string): number | undefined {
	const n = stripWhitespace(text).length;
	return n > 0 ? Math.sqrt(Math.max(1, width * height) / n) : undefined;
}

/** Median glyph size over every recognised block on the page (balloon text included). */
export function pageGlyphSize(blocks: ReadonlyArray<{ text: string; width: number; height: number }>): number {
	const sizes = blocks
		.map((block) => glyphSize(block.width, block.height, block.text))
		.filter((value): value is number => value !== undefined)
		.sort((a, b) => a - b);
	if (sizes.length === 0) return 30;
	const middle = sizes.length >> 1;
	return sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2;
}

export interface SfxFeatureInput {
	x: number;
	y: number;
	width: number;
	height: number;
	text: string;
	kind: DetectedTextGroupKind | undefined;
	recognitionConfidence?: number;
	classificationConfidence?: number;
}

export function sfxSideFeatures(
	group: SfxFeatureInput,
	pageWidth: number,
	pageHeight: number,
	pageGlyph: number
): Float32Array {
	const { x, y, width: w, height: h } = group;
	const n = Math.max(1, stripWhitespace(group.text).length);
	const glyph = Math.sqrt(Math.max(1, w * h) / n);
	const ratio = glyph / Math.max(1, pageGlyph);
	const out = new Float32Array(SFX_FILTER_SIDE_FEATURES);
	const values = [
		group.recognitionConfidence || 0,
		group.classificationConfidence || 0,
		Math.log(Math.max(w, 1) / Math.max(h, 1)),
		Math.log(Math.max(1, w * h) / (pageWidth * pageHeight)),
		ratio,
		Math.log(ratio),
		(x + w / 2) / pageWidth,
		(y + h / 2) / pageHeight,
		...SFX_FILTER_KINDS.map((kind) => (group.kind === kind ? 1 : 0)),
		...textFeatures(group.text)
	];
	out.set(values);
	return out;
}

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

/**
 * The group's box plus a margin, cut from a downscaled page buffer and
 * letterboxed onto a white square, as CHW floats in 0..1. Area-averaged when
 * shrinking, bilinear when enlarging.
 */
export function sfxCropTensor(
	pixels: FreeTextPixelBuffer,
	box: { x: number; y: number; width: number; height: number },
	sourceWidth: number,
	sourceHeight: number,
	size = SFX_FILTER_INPUT_SIZE,
	margin = SFX_FILTER_CROP_MARGIN,
	out: Float32Array<ArrayBufferLike> = new Float32Array(3 * size * size),
	offset = 0
): Float32Array<ArrayBufferLike> {
	const scale = pixels.width / sourceWidth;
	const m = margin * Math.max(box.width, box.height);
	const left = Math.max(0, box.x - m) * scale;
	const top = Math.max(0, box.y - m) * (pixels.height / sourceHeight);
	const right = Math.min(sourceWidth, box.x + box.width + m) * scale;
	const bottom = Math.min(sourceHeight, box.y + box.height + m) * (pixels.height / sourceHeight);
	const cropW = Math.max(1, right - left);
	const cropH = Math.max(1, bottom - top);
	const fit = size / Math.max(cropW, cropH);
	const outW = Math.max(1, Math.round(cropW * fit));
	const outH = Math.max(1, Math.round(cropH * fit));
	const padX = Math.floor((size - outW) / 2);
	const padY = Math.floor((size - outH) / 2);
	const plane = size * size;
	out.fill(1, offset, offset + 3 * plane);
	const { data, width: pw, height: ph } = pixels;
	const step = cropW / outW; // source pixels per output pixel
	for (let oy = 0; oy < outH; oy += 1) {
		const sy0 = top + oy * (cropH / outH);
		const sy1 = sy0 + cropH / outH;
		for (let ox = 0; ox < outW; ox += 1) {
			const sx0 = left + ox * step;
			const sx1 = sx0 + step;
			let r = 0, g = 0, b = 0;
			if (step > 1 || cropH / outH > 1) {
				// area average over the footprint
				const ix0 = Math.max(0, Math.floor(sx0)), ix1 = Math.min(pw, Math.max(ix0 + 1, Math.ceil(sx1)));
				const iy0 = Math.max(0, Math.floor(sy0)), iy1 = Math.min(ph, Math.max(iy0 + 1, Math.ceil(sy1)));
				let count = 0;
				for (let iy = iy0; iy < iy1; iy += 1) {
					for (let ix = ix0; ix < ix1; ix += 1) {
						const o = (iy * pw + ix) * 4;
						r += data[o]; g += data[o + 1]; b += data[o + 2]; count += 1;
					}
				}
				r /= count; g /= count; b /= count;
			} else {
				// bilinear at the footprint centre
				const fx = Math.min(pw - 1, Math.max(0, (sx0 + sx1) / 2 - 0.5));
				const fy = Math.min(ph - 1, Math.max(0, (sy0 + sy1) / 2 - 0.5));
				const x0 = Math.floor(fx), y0 = Math.floor(fy);
				const x1 = Math.min(pw - 1, x0 + 1), y1 = Math.min(ph - 1, y0 + 1);
				const ax = fx - x0, ay = fy - y0;
				const at = (xx: number, yy: number, c: number) => data[(yy * pw + xx) * 4 + c];
				const lerp = (c: number) => (at(x0, y0, c) * (1 - ax) + at(x1, y0, c) * ax) * (1 - ay)
					+ (at(x0, y1, c) * (1 - ax) + at(x1, y1, c) * ax) * ay;
				r = lerp(0); g = lerp(1); b = lerp(2);
			}
			const p = (padY + oy) * size + (padX + ox);
			out[offset + p] = r / 255;
			out[offset + plane + p] = g / 255;
			out[offset + 2 * plane + p] = b / 255;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

type OrtModule = typeof import('onnxruntime-web');
type OrtSession = import('onnxruntime-web').InferenceSession;

/**
 * Where the model runs. On Android the downloaded file is run by native ONNX
 * Runtime (`__fumeto_sfx_native`) — about 17 ms a crop on a Snapdragon 8 Elite against
 * about 100 ms in the WebView's single-threaded WASM, which stays the fallback
 * and the only engine everywhere else. The crops are cut here either way.
 */
type SfxBackend =
	| { kind: 'native'; fileName: string; sha256: string }
	| { kind: 'wasm'; session: OrtSession; ort: OrtModule };

interface SfxNativeBridge {
	isAvailable(): boolean;
	score(
		modelFileName: string,
		sha256: string,
		encodedPixels: string,
		encodedSide: string,
		count: number,
		threadCount: number,
		callbackId: string
	): void;
	release(callbackId: string): void;
}

declare global {
	interface Window {
		__fumeto_sfx_native?: SfxNativeBridge;
		__sfx_native_resolve?: (callbackId: string, resultJson: string) => void;
		__sfx_native_reject?: (callbackId: string, message: string) => void;
	}
}

const NATIVE_THREADS = 4;

let backend: SfxBackend | null = null;
let loading: Promise<boolean> | null = null;
let unavailable = false;
/** Set when native inference failed once; the session then runs on WASM. */
let nativeBroken = false;
/** Bumped by `resetSfxFilter`, so a load that was already running cannot install a stale backend. */
let generation = 0;
/** Batches in flight, and WASM sessions a reset retired while one was running. */
let running = 0;
const retired: OrtSession[] = [];

function nativeSfxBridge(): SfxNativeBridge | null {
	try {
		const bridge = typeof window === 'undefined' ? undefined : window.__fumeto_sfx_native;
		return bridge?.isAvailable() === true ? bridge : null;
	} catch {
		return null;
	}
}

/** A developer's local copy, for a plain browser; the SPA fallback answers a missing file with index.html at HTTP 200. */
async function fetchLocalCopy(): Promise<Uint8Array> {
	const response = await fetch(SFX_FILTER_MODEL_PATH);
	if (!response.ok) throw new Error(`model fetch ${response.status}`);
	const buffer = await response.arrayBuffer();
	if (/text\/html/i.test(response.headers.get('content-type') ?? '') || new Uint8Array(buffer, 0, 1)[0] === 0x3c) {
		throw new Error('no local model copy in this browser build');
	}
	return new Uint8Array(buffer);
}

async function openWasm(bytes: Uint8Array): Promise<SfxBackend> {
	const module = (await import('onnxruntime-web/wasm')) as unknown as OrtModule;
	module.env.wasm.wasmPaths = `${window.location.origin}/wasm/`;
	module.env.wasm.proxy = false;
	module.env.wasm.numThreads = 1;
	const session = await module.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
	return { kind: 'wasm', session, ort: module };
}

/**
 * `null` means "not downloaded yet", which a later download can change; a
 * local copy that is missing cannot appear at runtime and throws instead.
 */
async function openBackend(): Promise<SfxBackend | null> {
	const manager = await import('./sfx-model-manager.js');
	if (!manager.sfxModelIsManagedHere()) return await openWasm(await fetchLocalCopy());
	if (!(await manager.isSfxModelReady())) return null;
	// The native engine reads the file itself and checks its hash when it opens it.
	if (!nativeBroken && nativeSfxBridge()) {
		return { kind: 'native', fileName: manager.SFX_MODEL.filename, sha256: manager.SFX_MODEL.sha256 };
	}
	const bytes = await manager.readDownloadedSfxModel();
	return bytes ? await openWasm(bytes) : null;
}

/**
 * Load the model once. Resolves false when it is unavailable, so extraction
 * carries on unscored instead of failing a page over an optional filter. A
 * model that is merely not downloaded is asked about again on the next page;
 * a missing local copy or a runtime that fails to start stays off for the session.
 */
export function initSfxFilter(): Promise<boolean> {
	if (backend) return Promise.resolve(true);
	if (unavailable) return Promise.resolve(false);
	loading ??= (async () => {
		const started = generation;
		try {
			const opened = await openBackend();
			if (!opened) return false;
			if (started !== generation) {
				if (opened.kind === 'wasm') await opened.session.release().catch(() => undefined);
				return false;
			}
			backend = opened;
			return true;
		} catch (error) {
			if (started === generation) unavailable = true;
			console.warn('[sfx-filter] Model unavailable; sound effects are typed by rules only.', error);
			return false;
		} finally {
			if (started === generation) loading = null;
		}
	})();
	return loading;
}

/**
 * Forget the loaded model, after a download or a delete. The next page loads
 * whatever is on disk then.
 */
export function resetSfxFilter(): void {
	generation += 1;
	loading = null;
	unavailable = false;
	const released = backend;
	backend = null;
	if (released?.kind === 'native') {
		try {
			window.__fumeto_sfx_native?.release(`sfx-release-${Date.now()}`);
		} catch {
			// The engine reopens on the next file anyway: its session is keyed by the file.
		}
	} else if (released?.kind === 'wasm') {
		if (running > 0) retired.push(released.session);
		else void released.session.release().catch(() => undefined);
	}
}

/**
 * Whether the learned filter takes part at all: SFX overlays hidden and a
 * strength above off. While it does not, pages are not scored — the model is
 * neither loaded nor run — and the layout rules decide alone.
 */
export function sfxFilterEnabled(settings: { overlaySfx?: boolean; sfxFilterStrength?: number }): boolean {
	return !settings.overlaySfx
		&& sfxThresholdForStrength(settings.sfxFilterStrength ?? DEFAULT_SFX_FILTER_STRENGTH) !== undefined;
}

export interface SfxCandidate {
	box: { x: number; y: number; width: number; height: number };
	features: Float32Array;
}

/** Source-pixel rectangle the model sees for a box: the box plus a margin, clamped to the page. */
export function sfxCropRect(
	box: { x: number; y: number; width: number; height: number },
	sourceWidth: number,
	sourceHeight: number,
	margin = SFX_FILTER_CROP_MARGIN
): { x: number; y: number; width: number; height: number } {
	const m = margin * Math.max(box.width, box.height);
	const x = Math.max(0, Math.floor(box.x - m));
	const y = Math.max(0, Math.floor(box.y - m));
	const right = Math.min(sourceWidth, Math.ceil(box.x + box.width + m));
	const bottom = Math.min(sourceHeight, Math.ceil(box.y + box.height + m));
	return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Place an already-resized RGBA crop (both sides ≤ size) centred on a white square, as CHW floats. */
export function letterboxTensor(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	size = SFX_FILTER_INPUT_SIZE,
	out: Float32Array<ArrayBufferLike> = new Float32Array(3 * size * size),
	offset = 0
): Float32Array<ArrayBufferLike> {
	const plane = size * size;
	out.fill(1, offset, offset + 3 * plane);
	const padX = Math.floor((size - width) / 2);
	const padY = Math.floor((size - height) / 2);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const i = (y * width + x) * 4;
			const p = (padY + y) * size + (padX + x);
			out[offset + p] = rgba[i] / 255;
			out[offset + plane + p] = rgba[i + 1] / 255;
			out[offset + 2 * plane + p] = rgba[i + 2] / 255;
		}
	}
	return out;
}

/**
 * Crop straight from the full-resolution page with the browser's high-quality
 * resampler. The model was trained on full-resolution crops and reads the
 * crispness of drawn lettering, so a crop taken from the extractor's 1200 px
 * page buffer scores measurably differently on large pages — that buffer is
 * only the fallback.
 */
async function cropFromImage(
	image: ImageBitmap,
	box: SfxCandidate['box'],
	sourceWidth: number,
	sourceHeight: number,
	size: number,
	out: Float32Array,
	offset: number
): Promise<void> {
	const rect = sfxCropRect(box, sourceWidth, sourceHeight);
	const fit = size / Math.max(rect.width, rect.height);
	const width = Math.max(1, Math.min(size, Math.round(rect.width * fit)));
	const height = Math.max(1, Math.min(size, Math.round(rect.height * fit)));
	const bitmap = await createImageBitmap(image, rect.x, rect.y, rect.width, rect.height, {
		resizeWidth: width,
		resizeHeight: height,
		resizeQuality: 'high'
	});
	try {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('2d context unavailable');
		context.drawImage(bitmap, 0, 0);
		letterboxTensor(context.getImageData(0, 0, width, height).data, width, height, size, out, offset);
	} finally {
		bitmap.close();
	}
}

export interface SfxCropSources {
	/** The original page image; preferred. */
	image?: Blob;
	/** Downscaled page pixels, used when cropping the original fails. */
	pixels?: FreeTextPixelBuffer;
}

/** Score candidates in one batch; `null` when the filter is unavailable. */
export async function scoreSfxCandidates(
	sources: SfxCropSources,
	sourceWidth: number,
	sourceHeight: number,
	candidates: readonly SfxCandidate[]
): Promise<Float32Array | null> {
	if (candidates.length === 0) return new Float32Array(0);
	if (!(await initSfxFilter()) || !backend) return null;
	// Held for the whole call: a reset while the page is being cropped must
	// not swap or release the backend this batch runs on.
	const active = backend;
	running += 1;
	try {
		const tensors = await cropCandidates(sources, sourceWidth, sourceHeight, candidates);
		if (!tensors) return null;
		if (active.kind === 'wasm') return await runWasm(active, tensors, candidates.length);
		try {
			return await runNative(active, tensors, candidates.length);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith('integrity:')) {
				// The engine deleted the file; Settings offers the download again.
				console.warn('[sfx-filter] Downloaded model failed its integrity check; removed.');
				resetSfxFilter();
				const manager = await import('./sfx-model-manager.js');
				manager.sfxModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
				return null;
			}
			console.warn('[sfx-filter] Native inference failed; using WASM for the rest of the session.', error);
			nativeBroken = true;
			resetSfxFilter();
			if (!(await initSfxFilter()) || backend?.kind !== 'wasm') return null;
			return await runWasm(backend, tensors, candidates.length);
		}
	} finally {
		running -= 1;
		if (running === 0) for (const stale of retired.splice(0)) void stale.release().catch(() => undefined);
	}
}

interface SfxTensors {
	/** count × 3 × S × S, CHW, 0..1. */
	images: Float32Array;
	/** count × 21. */
	side: Float32Array;
}

async function cropCandidates(
	sources: SfxCropSources,
	sourceWidth: number,
	sourceHeight: number,
	candidates: readonly SfxCandidate[]
): Promise<SfxTensors | null> {
	const size = SFX_FILTER_INPUT_SIZE;
	const images = new Float32Array(candidates.length * 3 * size * size);
	const side = new Float32Array(candidates.length * SFX_FILTER_SIDE_FEATURES);
	// Decode the page once; every crop is then cut from the decoded bitmap.
	let page: ImageBitmap | null = null;
	if (sources.image && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
		try {
			page = await createImageBitmap(sources.image);
		} catch (error) {
			console.warn('[sfx-filter] Page decode failed; using the downscaled page.', error);
		}
	}
	try {
		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index];
			const offset = index * 3 * size * size;
			let cropped = false;
			if (page) {
				try {
					await cropFromImage(page, candidate.box, sourceWidth, sourceHeight, size, images, offset);
					cropped = true;
				} catch (error) {
					console.warn('[sfx-filter] Full-resolution crop failed; using the downscaled page.', error);
				}
			}
			if (!cropped) {
				if (!sources.pixels) return null;
				sfxCropTensor(sources.pixels, candidate.box, sourceWidth, sourceHeight, size, SFX_FILTER_CROP_MARGIN, images, offset);
			}
			side.set(candidate.features, index * SFX_FILTER_SIDE_FEATURES);
		}
	} finally {
		page?.close();
	}
	return { images, side };
}

async function runWasm(active: Extract<SfxBackend, { kind: 'wasm' }>, tensors: SfxTensors, count: number): Promise<Float32Array> {
	const size = SFX_FILTER_INPUT_SIZE;
	const output = await active.session.run({
		image: new active.ort.Tensor('float32', tensors.images, [count, 3, size, size]),
		side: new active.ort.Tensor('float32', tensors.side, [count, SFX_FILTER_SIDE_FEATURES])
	});
	return output.p_sfx.data as Float32Array;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

const nativePending = new Map<string, { resolve: (json: string) => void; reject: (error: Error) => void }>();
let nativeCallbackCounter = 0;

function installNativeHandlers(): void {
	if (window.__sfx_native_resolve) return;
	window.__sfx_native_resolve = (callbackId, resultJson) => {
		nativePending.get(callbackId)?.resolve(resultJson);
		nativePending.delete(callbackId);
	};
	window.__sfx_native_reject = (callbackId, message) => {
		nativePending.get(callbackId)?.reject(new Error(message));
		nativePending.delete(callbackId);
	};
}

/**
 * The crops cross as RGB bytes (HWC), not floats: every value the crop step
 * writes is a byte over 255, so the engine's own division restores it, at a
 * quarter of the payload.
 */
async function runNative(active: Extract<SfxBackend, { kind: 'native' }>, tensors: SfxTensors, count: number): Promise<Float32Array> {
	const bridge = window.__fumeto_sfx_native;
	if (!bridge) throw new Error('sfx native bridge unavailable');
	const size = SFX_FILTER_INPUT_SIZE;
	const plane = size * size;
	const pixels = new Uint8Array(count * plane * 3);
	for (let n = 0; n < count; n += 1) {
		const base = n * 3 * plane;
		for (let i = 0; i < plane; i += 1) {
			const out = (n * plane + i) * 3;
			pixels[out] = Math.round(tensors.images[base + i] * 255);
			pixels[out + 1] = Math.round(tensors.images[base + plane + i] * 255);
			pixels[out + 2] = Math.round(tensors.images[base + 2 * plane + i] * 255);
		}
	}
	const side = new Uint8Array(tensors.side.buffer, tensors.side.byteOffset, tensors.side.byteLength);
	installNativeHandlers();
	const callbackId = `sfx-${++nativeCallbackCounter}-${Date.now()}`;
	const json = await new Promise<string>((resolve, reject) => {
		nativePending.set(callbackId, { resolve, reject });
		try {
			bridge.score(active.fileName, active.sha256, bytesToBase64(pixels), bytesToBase64(side), count, NATIVE_THREADS, callbackId);
		} catch (error) {
			nativePending.delete(callbackId);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const result = JSON.parse(json) as { scores: number[] };
	const scores = result.scores;
	if (scores.length !== count) throw new Error(`native filter returned ${scores.length} scores for ${count} crops`);
	return Float32Array.from(scores);
}

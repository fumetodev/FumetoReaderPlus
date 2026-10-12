/**
 * The on-device vision model files, and which of them each kind of host
 * downloads.
 *
 * Kept apart from ocr-model-manager.ts, which touches the filesystem and
 * renders messages, so the lists and the choice between them can be checked
 * without either.
 *
 * Android downloads all three: `scripts/prune-embed.mjs android` strips the
 * PP-OCR models from its web bundle, and its native layout engine reads the
 * 1024 model. The desktop build keeps PP-OCR in the bundle and runs layout
 * through the WebAssembly tier, which reads the 960 model under a name of its
 * own — so the desktop downloads that one file and nothing else. A browser
 * (`npm run dev`) serves everything it can from `static/` and downloads
 * nothing.
 */

export type OcrModelId = 'ppocr-det' | 'ppocr-rec' | 'rtmdet-layout';

export interface OcrModelSpec {
	id: OcrModelId;
	/** Filename under `appDataDir()/models/`; the engine that reads it resolves the same name. */
	filename: string;
	/**
	 * Pinned to a commit rather than `main`: the Kotlin engines hard-code the
	 * sha256 they will accept, so a repository that moved on would fail
	 * verification after a 62 MB download rather than before it.
	 */
	url: string;
	sizeBytes: number;
	/**
	 * Lower-case hex sha256, checked after the download. Only set where no
	 * native engine checks the file itself: Android's Kotlin engines verify
	 * their own, the desktop's WebAssembly tier verifies nothing.
	 */
	sha256?: string;
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

export const DESKTOP_OCR_MODELS: readonly OcrModelSpec[] = [
	{
		id: 'rtmdet-layout',
		// The name the WebAssembly tier reads (`CANDIDATE_FILES['rtmdet-manga']`
		// in candidate-model-files.ts), not the hosted one.
		filename: 'rtmdet-manga-layout.onnx',
		url: `${HF}/fumetodev/rtmdet-manga-layout-onnx/resolve/10b9004ebfc773896dec5ceab9df6a8d259caad9/rtmdet-manga-layout-960.onnx`,
		sizeBytes: 43_206_748,
		sha256: '5b3135c6b038926d7291629e4dca6fbeeec68e4710537f2a65b20d695942d60e'
	}
] as const;

/** Who downloads the vision models: the Android app, the desktop app, or nobody. */
export type OcrModelHost = 'android' | 'desktop' | 'none';

/** The models `host` downloads and keeps, in download order. */
export function managedOcrModels(host: OcrModelHost): readonly OcrModelSpec[] {
	switch (host) {
		case 'android':
			return OCR_MODELS;
		case 'desktop':
			return DESKTOP_OCR_MODELS;
		case 'none':
			return [];
	}
}

/**
 * The download size to quote. A host that manages nothing still quotes the
 * full set, as it always has: there the figure only ever sits beside a "ready"
 * state.
 */
export function ocrModelsTotalBytes(host: OcrModelHost): number {
	const specs = host === 'none' ? OCR_MODELS : managedOcrModels(host);
	return specs.reduce((total, spec) => total + spec.sizeBytes, 0);
}

/** Lower-case hex sha256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

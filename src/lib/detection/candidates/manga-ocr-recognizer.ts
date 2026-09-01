/**
 * manga-ocr candidate recognizer (model-candidate eval suite).
 *
 * kha-white/manga-ocr int8 ONNX pair: ViT encoder (224², RGB, ±1 norm) +
 * character-level Japanese BERT decoder run autoregressively with greedy
 * argmax. The int8 export has no KV cache, so each step re-runs the decoder
 * over the whole prefix — slow but fine for evaluation, where quality is the
 * question and latency is merely recorded.
 */

import {
	createCandidateSession,
	ortTensor,
	readCandidateText,
	type OrtSession
} from './candidate-model-files.js';
import { MangaOcrTokenizer } from './manga-ocr-tokenizer.js';
import { cropRegion, imageDataToCHW, resizeImage } from './preprocess.js';

const ENCODER_FILE = 'manga-ocr-encoder-int8.onnx';
const DECODER_FILE = 'manga-ocr-decoder-int8.onnx';
const VOCAB_FILE = 'manga-ocr-vocab.txt';
const INPUT_SIZE = 224;
const DEFAULT_MAX_TOKENS = 64;

export interface MangaOcrCropResult {
	text: string;
	tokenCount: number;
	encoderMs: number;
	decodeMs: number;
}

interface MangaOcrRuntime {
	encoder: OrtSession;
	decoder: OrtSession;
	tokenizer: MangaOcrTokenizer;
}

let runtime: MangaOcrRuntime | null = null;

export async function initMangaOcr(): Promise<void> {
	if (runtime) return;
	const [encoder, decoder, vocabText] = await Promise.all([
		createCandidateSession(ENCODER_FILE),
		createCandidateSession(DECODER_FILE),
		readCandidateText(VOCAB_FILE)
	]);
	runtime = { encoder, decoder, tokenizer: MangaOcrTokenizer.fromVocabText(vocabText) };
}

export function isMangaOcrReady(): boolean {
	return runtime !== null;
}

export function releaseMangaOcrRuntime(): void {
	// Sessions themselves are released via releaseCandidateModelSessions().
	runtime = null;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error('manga-ocr recognition cancelled');
	error.name = 'AbortError';
	throw error;
}

/**
 * Recognize one text-region crop from the full-resolution page bitmap.
 * Regions are the pipeline's merged groups (manga-ocr's design target is a
 * whole balloon/text-block crop, not a single line).
 */
export async function recognizeCropWithMangaOcr(
	pageBitmap: ImageBitmap,
	region: { x: number; y: number; width: number; height: number },
	options: { signal?: AbortSignal; maxTokens?: number } = {}
): Promise<MangaOcrCropResult> {
	if (!runtime) throw new Error('manga-ocr runtime not initialized — call initMangaOcr()');
	const { encoder, decoder, tokenizer } = runtime;
	const ort = await ortTensor();
	throwIfAborted(options.signal);

	// Preprocess: crop → squash-resize 224², RGB, (x/255−0.5)/0.5.
	const crop = cropRegion(pageBitmap, region, 4);
	const cropBitmap = crop.transferToImageBitmap();
	const imageData = resizeImage(cropBitmap, INPUT_SIZE, INPUT_SIZE);
	cropBitmap.close();
	const pixels = imageDataToCHW(imageData, 'pm1');

	const encoderStarted = performance.now();
	const encoderOutput = await encoder.run({
		pixel_values: new ort.Tensor('float32', pixels, [1, 3, INPUT_SIZE, INPUT_SIZE])
	});
	const encoderMs = performance.now() - encoderStarted;
	const hiddenName = encoder.outputNames.includes('last_hidden_state')
		? 'last_hidden_state'
		: encoder.outputNames[0];
	const encoderHidden = encoderOutput[hiddenName];

	// Greedy autoregressive decode: [CLS] start, stop on [SEP].
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const generated: number[] = [tokenizer.clsId];
	const decodeStarted = performance.now();
	const wantsAttentionMask = decoder.inputNames.includes('encoder_attention_mask');
	const encoderSeqLen = Number(encoderHidden.dims[1]);
	for (let step = 0; step < maxTokens; step++) {
		throwIfAborted(options.signal);
		const inputIds = new ort.Tensor(
			'int64',
			BigInt64Array.from(generated.map((id) => BigInt(id))),
			[1, generated.length]
		);
		const feeds: Record<string, unknown> = {
			input_ids: inputIds,
			encoder_hidden_states: encoderHidden
		};
		if (wantsAttentionMask) {
			feeds.encoder_attention_mask = new ort.Tensor(
				'int64',
				BigInt64Array.from({ length: encoderSeqLen }, () => 1n),
				[1, encoderSeqLen]
			);
		}
		const output = await decoder.run(feeds);
		const logits = output[decoder.outputNames.includes('logits') ? 'logits' : decoder.outputNames[0]];
		const [, seqLen, vocabSize] = logits.dims as number[];
		const lastOffset = (seqLen - 1) * vocabSize;
		const data = logits.data as Float32Array;
		let best = -Infinity;
		let bestId = tokenizer.sepId;
		for (let v = 0; v < vocabSize; v++) {
			const value = data[lastOffset + v];
			if (value > best) {
				best = value;
				bestId = v;
			}
		}
		generated.push(bestId);
		if (bestId === tokenizer.sepId) break;
	}
	const decodeMs = performance.now() - decodeStarted;

	return {
		text: tokenizer.decode(generated),
		tokenCount: generated.length - 1,
		encoderMs,
		decodeMs
	};
}

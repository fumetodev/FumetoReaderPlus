/**
 * GGUF model download manager — UI state for local translation model download.
 *
 * Manages download status, progress, and error state as a Svelte store.
 * Android: download via Kotlin LlamaBridge (OkHttp streaming).
 * Desktop: download via Tauri HTTP plugin (fetch streaming).
 *
 * Model is stored on external app-specific storage (Android) or
 * app data directory (desktop).
 *
 * Current model: Tencent Hy-MT2 1.8B, compressed with AngelSlim's 1.25-bit
 * STQ quantization. The official GGUF is about 440 MiB and is designed for
 * low-latency local translation. It requires a llama.cpp build with Tencent's
 * STQ1_0 support; native runtime integration lives outside this manager.
 */

import * as m from '$lib/paraglide/messages.js';
import { writable, get } from 'svelte/store';
import { settings, type CustomModelRecord } from '$lib/settings/settings.js';
import {
	isLlamaBridgeAvailable,
	getExternalModelDir,
	downloadModelFile,
	importModelFile,
	loadHyMT2Model,
	unloadModel,
	translateWithHyMT2,
	cancelDownload as cancelBridgeDownload,
	ggufDownloadProgress,
	type ManualPromptFormat
} from './llamacpp-bridge.js';
import { exists as fsExists, remove as fsRemove, stat as fsStat } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';

export interface GgufDownloadState {
	variant?: HyMT2Variant;
	status: 'idle' | 'downloading' | 'completed' | 'error' | 'deleting';
	error?: string;
	progress?: { downloadedBytes: number; totalBytes: number };
}

/**
 * Selectable Hy-MT2 model variants. URLs are PINNED to revision hashes:
 * the app's vendored llama.cpp speaks STQ type 42, and upstream has already
 * moved the format to type 43 once (2026-07-20 rebase of PR #22836) — an
 * unpinned `main` URL could silently start serving files the kernel cannot
 * load. Pin bumps are deliberate, verified changes.
 */
export type BundledHyMT2Variant = 'stock' | 'manga-v2' | 'manga-v3' | 'manga-v5';
export type HyMT2Variant = BundledHyMT2Variant | 'custom';

export interface HyMT2VariantSpec {
	/**
	 * `bundled` variants are downloaded from a pinned URL and validated against
	 * an exact byte count. `custom` is a user-supplied file: it has no URL and
	 * no expected size, so `url`/`sizeBytes` are absent and the display fields
	 * are placeholders the settings UI overlays from the stored record.
	 */
	kind: 'bundled' | 'custom';
	filename: string;
	url?: string;
	sizeBytes?: number;
	/** Short technical label for logs and the Android model notification. */
	label: string;
	/** Card title in the Settings variant picker — a message getter, so it follows the UI language. */
	title: () => string;
	/** "Model:" line in the Settings variant picker. */
	modelName: string;
	/** "Size:" line in the Settings variant picker. */
	sizeLabel: string;
	/** "Quant:" line in the Settings variant picker. */
	quantLabel: string;
	/** Italic one-liner under the spec lines in the Settings variant picker — a message getter. */
	description: () => string;
}

export const HYMT2_VARIANTS: Record<HyMT2Variant, HyMT2VariantSpec> = {
	stock: {
		kind: 'bundled',
		filename: 'Hy-MT2-1.8B-1.25Bit.gguf',
		url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF/resolve/9df5c824a00a744fb0512a29c640466f4d97dfb0/Hy-MT2-1.8B-1.25Bit.gguf',
		sizeBytes: 461_860_800,
		label: 'Hy-MT2 1.8B (1.25-bit STQ)',
		title: () => m.model_variant_stock_title(),
		modelName: 'Hy-MT2-1.8B',
		sizeLabel: '462MB',
		quantLabel: '1.25-Bit',
		description: () => m.model_variant_stock_description()
	},
	'manga-v2': {
		kind: 'bundled',
		filename: 'Manga-v2-Q4_K_M.gguf',
		url: 'https://huggingface.co/fumetodev/Hy-MT2-1.8B-JP-Finetune-v2-GGUF/resolve/db23e9ee9dba8cafd3e6265a61e1767ee7331a2d/manga-v2-Q4_K_M.gguf',
		sizeBytes: 1_133_080_512,
		label: 'Hy-MT2 1.8B manga-tuned v2 (Q4_K_M)',
		title: () => m.model_variant_manga_v2_title(),
		modelName: 'Hy-MT2-1.8B-finetuned-v2',
		sizeLabel: '~1.13GB',
		quantLabel: 'Q4_K_M',
		description: () => m.model_variant_manga_v2_description()
	},
	'manga-v3': {
		kind: 'bundled',
		filename: 'Manga-v3a-Q4_K_M.gguf',
		url: 'https://huggingface.co/fumetodev/Hy-MT2-1.8B-JP-Finetune-v3-multilingual-GGUF/resolve/8ce5090ed061aade6374a436b5e8f459b78b6d2e/manga-v3a-Q4_K_M.gguf',
		// 96 bytes SMALLER than v2 — the two quants are near-identical in size and
		// this constant is the download's only integrity check. Do not copy v2's.
		sizeBytes: 1_133_080_416,
		label: 'Hy-MT2 1.8B manga-tuned v3 multilingual (Q4_K_M)',
		title: () => m.model_variant_manga_v3_title(),
		modelName: 'Hy-MT2-1.8B-finetuned-v3',
		sizeLabel: '~1.13GB',
		quantLabel: 'Q4_K_M',
		description: () => m.model_variant_manga_v3_description()
	},
	'manga-v5': {
		kind: 'bundled',
		filename: 'Manga-v5-Q4_K_M.gguf',
		// Internal tag v7.2. REPLACES v4 (internal v4.3) the way v2 replaced v1:
		// same architecture, quant and size, strictly preferred by the blind judge
		// (fewer hard errors than v2 on held-out archives) and it no longer reads
		// short katakana names as sound effects. English-only like v2 and v4;
		// trained on the re-OCR'd corpus with an image-grounded teacher.
		url: 'https://huggingface.co/fumetodev/Hy-MT2-1.8B-JP-Manga-Finetune-v5-GGUF/resolve/06835446f0d993f79c2aad22396e2cdd7b39efc7/manga-v5-Q4_K_M.gguf',
		// Byte-identical in SIZE to v2's and v4's quants (same architecture, same
		// quant type, same tensor shapes) — expected, not a copy-paste. The files
		// differ; the filename above keeps them apart on disk.
		sizeBytes: 1_133_080_512,
		label: 'Hy-MT2 1.8B manga-tuned v5 (Q4_K_M)',
		title: () => m.model_variant_manga_v5_title(),
		modelName: 'Hy-MT2-1.8B-finetuned-v5',
		sizeLabel: '~1.13GB',
		quantLabel: 'Q4_K_M',
		description: () => m.model_variant_manga_v5_description()
	},
	custom: {
		kind: 'custom',
		// Fixed on purpose. The picked file's display name is untrusted text and
		// must never reach a path concatenation; it is carried separately in
		// settings and used for display only.
		filename: 'Custom-Model.gguf',
		label: 'Custom GGUF model',
		title: () => m.model_variant_custom_title(),
		modelName: '—',
		sizeLabel: '—',
		quantLabel: '—',
		description: () => m.model_variant_custom_description()
	}
};

/** The bundled variants, in picker order. `custom` is deliberately excluded. */
export const BUNDLED_HYMT2_VARIANTS = ['stock', 'manga-v2', 'manga-v3', 'manga-v5'] as const;

export function isBundledVariant(variant: HyMT2Variant): variant is BundledHyMT2Variant {
	return HYMT2_VARIANTS[variant].kind === 'bundled';
}

/**
 * A bundled variant's spec, narrowed so `url`/`sizeBytes` are non-optional.
 * Every download-path caller goes through this rather than asserting.
 */
export function bundledSpec(
	variant: BundledHyMT2Variant
): HyMT2VariantSpec & { url: string; sizeBytes: number } {
	const spec = HYMT2_VARIANTS[variant];
	if (spec.kind !== 'bundled' || !spec.url || spec.sizeBytes === undefined) {
		throw new Error(`Variant ${variant} is not a bundled download`);
	}
	return spec as HyMT2VariantSpec & { url: string; sizeBytes: number };
}

/**
 * The variant selected in Settings (defaults to the stock model).
 *
 * `manga-v1` is accepted and mapped forward: v2 supersedes it at the same file
 * size and speed, so a profile written before the swap keeps its "upgraded
 * model" choice instead of silently falling back to stock. `manga-v4` maps to
 * `manga-v5` for the same reason (2026-09-03 swap).
 *
 * `custom` degrades to stock unless a custom model is actually registered.
 * Deleting a custom model would otherwise leave the picker with no row checked
 * and every translation failing on a path that no longer exists.
 */
export function activeHyMT2Variant(): HyMT2Variant {
	const stored = get(settings) as { hyMT2Variant?: string; customModel?: unknown };
	const value = stored.hyMT2Variant;
	if (value === 'manga-v5' || value === 'manga-v4') return 'manga-v5';
	if (value === 'manga-v3') return 'manga-v3';
	if (value === 'manga-v2' || value === 'manga-v1') return 'manga-v2';
	if (value === 'custom' && stored.customModel) return 'custom';
	return 'stock';
}

export const HYMT2_MODEL_FILENAME = HYMT2_VARIANTS.stock.filename;
export const HYMT2_MODEL_URL = bundledSpec('stock').url;
/** Exact byte length of Tencent's official immutable GGUF at the URL above. */
export const HYMT2_MODEL_SIZE_BYTES = bundledSpec('stock').sizeBytes;

// Old model filenames to clean up after a successful replacement download.
// Missing files are ignored.
// Add new entries here when swapping to a future model, newest-first.
export const LEGACY_MODEL_FILENAMES = [
	'Manga-v4-Q4_K_M.gguf', // superseded by manga-v5 at the same size; reclaims 1.13 GB
	'Manga-v1-Q4_K_M.gguf', // superseded by manga-v2 at the same size; reclaims 1.13 GB
	'gemma-4-E4B-it-Q4_0.gguf', // immediately previous model; remove only after Hy-MT2 succeeds
	'translategemma-4b-it.Q5_K_M.gguf', // pre-2026 Q5_K_M quant
	'translategemma-4b-it.Q4_0-pure-imatrix.gguf', // swapped out April 2026
	'gemma-4-E4B-it-Q4_K_M.gguf' // initial Gemma 4 swap, replaced with Q4_0 for faster Adreno kernels
];

export const ggufDownloadState = writable<GgufDownloadState>({
	status: 'idle',
	error: undefined,
	progress: undefined
});

// Forward progress from the bridge's progress store.
//
// MERGED, not replaced: the bridge store knows nothing about variants, so a
// bare `set` erased the `variant` that downloadHyMT2Model/importCustomModel had
// just stamped. Every consumer that decides which ROW a transfer belongs to
// reads that field, so the first progress tick — about 1 MB into a multi-GB
// transfer — moved the progress bar and Cancel button off the row doing the
// work.
ggufDownloadProgress.subscribe((state) => {
	if (state.status === 'downloading') {
		ggufDownloadState.update((current) => ({ ...current, ...state }));
	} else if (state.status === 'completed' && !downloadInProgress) {
		// downloadModelFile reports transport completion before this manager's
		// size/load/inference validation. Do not expose a false-ready state while
		// the replacement is still being proven.
		ggufDownloadState.set({ status: 'completed', error: undefined, progress: undefined });
	} else if (state.status === 'error') {
		ggufDownloadState.set({ status: 'error', error: state.error, progress: undefined });
	}
});

let downloadInProgress = false;

/**
 * Prove that the downloaded artifact is the expected model and that the
 * platform's native runtime can actually use it before deleting a known-good
 * legacy model. The exact byte count catches truncated/error-page downloads;
 * native load validates the GGUF/STQ/template contract; the fixed probe covers
 * tokenization, prefill, generation, and output decoding.
 */
async function validateDownloadedHyMT2Model(modelPath: string, expectedBytes: number): Promise<void> {
	const modelStat = await fsStat(modelPath);
	if (modelStat.size !== expectedBytes) {
		throw new Error(
			`Downloaded Hy-MT2 model has an unexpected size (${modelStat.size} bytes; expected ${expectedBytes})`
		);
	}

	await loadHyMT2Model(modelPath);
	const probe = (await translateWithHyMT2('行くぞ！', 'ja', 'en')).trim();
	if (!probe || probe === '行くぞ！' || !/[A-Za-z]/.test(probe) || /\[ERROR\]/i.test(probe)) {
		throw new Error('Hy-MT2 loaded but failed its Japanese-to-English inference validation');
	}
}

/**
 * Remove legacy model files after the replacement has downloaded successfully.
 * Each entry in
 * LEGACY_MODEL_FILENAMES is attempted in turn; missing files are ignored
 * so a clean install is a no-op.
 */
async function cleanupLegacyModelsAfterSuccessfulDownload(): Promise<void> {
	if (!isLlamaBridgeAvailable()) return;
	const externalDir = await getExternalModelDir();
	if (!externalDir) return;
	for (const legacyName of LEGACY_MODEL_FILENAMES) {
		const legacyPath = `${externalDir}/${legacyName}`;
		if (await fsExists(legacyPath)) {
			await fsRemove(legacyPath);
		}
	}
}

/**
 * Get the full path where the GGUF model should be stored.
 * Uses external storage on Android, app data dir on desktop.
 */
export async function getModelPath(variant: HyMT2Variant = activeHyMT2Variant()): Promise<string> {
	const filename = HYMT2_VARIANTS[variant].filename;
	if (isLlamaBridgeAvailable()) {
		const externalDir = await getExternalModelDir();
		if (externalDir) {
			return `${externalDir}/${filename}`;
		}
	}

	// Fallback to internal storage
	const dataDir = await appDataDir();
	return await join(dataDir, 'models', filename);
}

/**
 * Check if the Hy-MT2 1.8B 1.25-bit GGUF has been downloaded.
 */
export async function isModelDownloaded(variant: HyMT2Variant = activeHyMT2Variant()): Promise<boolean> {
	try {
		const path = await getModelPath(variant);
		return await fsExists(path);
	} catch {
		return false;
	}
}

/**
 * Start downloading the Hy-MT2 1.8B 1.25-bit GGUF.
 *
 * Legacy models are deliberately cleaned up only after the replacement
 * download succeeds. A failed or cancelled migration therefore leaves the
 * previously working model intact.
 */
export async function downloadHyMT2Model(variant: BundledHyMT2Variant): Promise<void> {
	if (downloadInProgress) return;
	downloadInProgress = true;
	let replacementWritten = false;
	const spec = bundledSpec(variant);

	ggufDownloadState.set({
		status: 'downloading',
		variant,
		error: undefined,
		progress: { downloadedBytes: 0, totalBytes: 0 }
	});

	try {
		const destPath = await getModelPath(variant);
		await downloadModelFile(spec.url, destPath);
		replacementWritten = true;
		await validateDownloadedHyMT2Model(destPath, spec.sizeBytes);
		await cleanupLegacyModelsAfterSuccessfulDownload();

		ggufDownloadState.set({
			status: 'completed',
			variant,
			error: undefined,
			progress: undefined
		});
	} catch (err) {
		// A transport-complete file that fails size/load/inference validation is
		// not a usable replacement. Remove only that failed new artifact; every
		// legacy model remains available for rollback.
		if (replacementWritten) {
			try {
				const destPath = await getModelPath(variant);
				if (await fsExists(destPath)) await fsRemove(destPath);
			} catch {
				// Best effort; preserve the original validation error below.
			}
		}
		if (get(ggufDownloadState).status !== 'idle') {
			ggufDownloadState.set({
				status: 'error',
				error: err instanceof Error ? err.message : 'Download failed',
				progress: undefined
			});
		}
	} finally {
		downloadInProgress = false;
	}
}

/**
 * Cancel an in-progress model download.
 */
export function cancelModelDownload(): void {
	cancelBridgeDownload();
	downloadInProgress = false;
	ggufDownloadState.set({
		status: 'idle',
		error: undefined,
		progress: undefined
	});
}

/**
 * Delete the downloaded local-translation GGUF model.
 */
export async function deleteHyMT2Model(variant: HyMT2Variant = activeHyMT2Variant()): Promise<void> {
	ggufDownloadState.set({
		status: 'deleting',
		variant,
		error: undefined,
		progress: undefined
	});

	try {
		const path = await getModelPath(variant);
		await fsRemove(path);

		ggufDownloadState.set({
			status: 'idle',
			error: undefined,
			progress: undefined
		});
	} catch (err) {
		ggufDownloadState.set({
			status: 'error',
			error: err instanceof Error ? err.message : 'Delete failed',
			progress: undefined
		});
	}
}

// ============================================================
// User-supplied models
// ============================================================

/** The prompt wrapping to load the custom model with, if it needs one. */
export function customPromptFormat(): ManualPromptFormat | undefined {
	const record = (get(settings) as { customModel?: CustomModelRecord }).customModel;
	if (!record || record.templateMode !== 'manual') return undefined;
	return {
		prefix: record.promptPrefix ?? '',
		suffix: record.promptSuffix ?? '',
		stops: record.stopStrings ?? []
	};
}

/**
 * Load whichever model is selected, with the prompt format it needs.
 *
 * Every translation path goes through this rather than calling
 * `loadHyMT2Model(await getModelPath())` directly: a custom model's prompt
 * format lives beside the path, and separating them is how one gets loaded
 * without the other.
 */
export async function loadActiveHyMT2Model(signal?: AbortSignal): Promise<void> {
	const variant = activeHyMT2Variant();
	const path = await getModelPath(variant);
	return loadHyMT2Model(path, signal, {
		promptFormat: variant === 'custom' ? customPromptFormat() : undefined,
		// v3 is the only checkpoint trained with per-target terminology blocks.
		// Stock, v2 and v4 keep the English-only guidance they shipped with.
		multilingualGuidance: variant === 'manga-v3'
	});
}

/**
 * Prove a model can be loaded and can actually translate.
 *
 * Shared by the import path and by re-validation after the user edits a prompt
 * format. Deliberately the same fixed probe the bundled downloads use.
 */
/**
 * The native layer tags a load failure it believes the user can fix. Anything
 * else — out of memory, a truncated file, an unsupported quant, the load
 * timeout — is not a prompt-format problem, and saying so would send the user
 * off to write a chat template that cannot possibly help.
 */
const NEEDS_FORMAT_MARKER = 'needs-prompt-format';

async function probeCustomModel(
	path: string,
	format: ManualPromptFormat | undefined
): Promise<{ status: CustomModelImportStatus; error?: string }> {
	try {
		await loadHyMT2Model(path, undefined, { promptFormat: format });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Load failed';
		return {
			status: message.includes(NEEDS_FORMAT_MARKER) ? 'needs-format' : 'load-failed',
			error: message
		};
	}
	try {
		const probe = (await translateWithHyMT2('行くぞ！', 'ja', 'en')).trim();
		const usable = Boolean(probe) && probe !== '行くぞ！' && /[A-Za-z]/.test(probe) && !/\[ERROR\]/i.test(probe);
		return { status: usable ? 'ready' : 'failed-self-test' };
	} catch {
		return { status: 'failed-self-test' };
	}
}

export type CustomModelImportStatus =
	| 'ready'
	/** llama.cpp does not recognise the model's chat format; the user can fix this. */
	| 'needs-format'
	/** Loads, but its translation self-test came back unusable. */
	| 'failed-self-test'
	/** Will not load at all, for a reason no prompt format can address. */
	| 'load-failed';

/**
 * Copy a user-picked GGUF into the model directory and work out how to run it.
 *
 * Unlike a bundled download, a failure here does not necessarily delete the
 * file. The user chose it deliberately and paid a multi-minute copy for it, so:
 *
 *   - the copy failing removes the partial file (nothing usable exists);
 *   - the model loading but failing its translation self-test keeps the file
 *     and flags the row, because "largely untested" is the whole premise;
 *   - the model failing to load keeps the file too and asks for a prompt
 *     format, since the most likely cause is a chat template llama.cpp does
 *     not recognise rather than a broken file.
 */
export async function importCustomModel(
	contentUri: string,
	displayName: string
): Promise<CustomModelImportStatus> {
	if (downloadInProgress) throw new Error('Another model transfer is already running');
	downloadInProgress = true;
	ggufDownloadState.set({
		status: 'downloading',
		variant: 'custom',
		error: undefined,
		progress: { downloadedBytes: 0, totalBytes: 0 }
	});

	const destPath = await getModelPath('custom');
	try {
		await importModelFile(contentUri, destPath);
	} catch (err) {
		try {
			if (await fsExists(destPath)) await fsRemove(destPath);
		} catch {
			// Best effort; the original error is the one worth reporting.
		}
		downloadInProgress = false;
		if (get(ggufDownloadState).status !== 'idle') {
			ggufDownloadState.set({
				status: 'error',
				error: err instanceof Error ? err.message : 'Import failed',
				progress: undefined
			});
		}
		throw err;
	}

	try {
		const sizeBytes = (await fsStat(destPath)).size;
		const { status, error } = await probeCustomModel(destPath, undefined);

		const record: CustomModelRecord = {
			displayName,
			sizeBytes,
			importedAt: Date.now(),
			// Only flip to 'manual' when a prompt format is actually the missing
			// piece. Marking a model manual because the device ran out of memory
			// would also change how it is templated on a later, successful load.
			templateMode: status === 'needs-format' ? 'manual' : 'auto',
			failedSelfTest: status === 'failed-self-test' || undefined,
			loadError: status === 'load-failed' ? error : undefined
		};
		settings.update((s) => ({ ...s, customModel: record }));

		ggufDownloadState.set({
			status: 'completed',
			variant: 'custom',
			error: undefined,
			progress: undefined
		});
		return status;
	} finally {
		downloadInProgress = false;
	}
}

/**
 * Re-validate the custom model after the user supplies or edits its prompt
 * format. Returns whether the model now loads and translates.
 */
export async function applyCustomPromptFormat(
	format: ManualPromptFormat
): Promise<CustomModelImportStatus> {
	const existing = (get(settings) as { customModel?: CustomModelRecord }).customModel;
	if (!existing) throw new Error('No custom model has been imported');

	const path = await getModelPath('custom');
	await unloadModel().catch(() => undefined);
	const { status, error } = await probeCustomModel(path, format);

	settings.update((s) => ({
		...s,
		customModel: {
			...existing,
			templateMode: 'manual',
			promptPrefix: format.prefix,
			promptSuffix: format.suffix,
			stopStrings: format.stops,
			failedSelfTest: status === 'failed-self-test' || undefined,
			loadError: status === 'load-failed' ? error : undefined
		}
	}));
	return status;
}

/**
 * Remove the imported model and forget it.
 *
 * Clearing the settings record matters as much as deleting the file:
 * `activeHyMT2Variant()` degrades a 'custom' selection to stock only while no
 * record exists, so a record left behind would point at a path that is gone.
 */
export async function deleteCustomModel(): Promise<void> {
	ggufDownloadState.set({
		status: 'deleting',
		variant: 'custom',
		error: undefined,
		progress: undefined
	});
	try {
		const path = await getModelPath('custom');
		if (await fsExists(path)) await fsRemove(path);
		settings.update((s) => ({
			...s,
			customModel: undefined,
			// Reset the SELECTION here, not at the call site. There are two
			// delete entry points (the variant picker and the On-Device Models
			// card) and only one of them used to do this, so deleting from the
			// storage card left 'custom' stored: the picker rendered a disabled
			// radio as checked with no other row selected, and a later import
			// silently re-activated custom without the user choosing it.
			hyMT2Variant: s.hyMT2Variant === 'custom' ? 'stock' : s.hyMT2Variant
		}));
		ggufDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
	} catch (err) {
		ggufDownloadState.set({
			status: 'error',
			error: err instanceof Error ? err.message : 'Delete failed',
			progress: undefined
		});
		throw err;
	}
}

/** @deprecated Use downloadHyMT2Model(). Retained for extension compatibility. */
export const downloadTranslateGemmaModel = downloadHyMT2Model;

/** @deprecated Use deleteHyMT2Model(). Retained for extension compatibility. */
export const deleteTranslateGemmaModel = deleteHyMT2Model;

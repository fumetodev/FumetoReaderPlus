/**
 * How each on-device model is loaded: the prompt wrapping a custom model
 * needs, which guidance blocks its prompts carry, and whether it may run on
 * the GPU.
 *
 * One place for the per-variant rules, so the loads that must agree — a
 * translation, a download's validation, a custom model's probe — cannot drift
 * apart. They did: a download's validation load passed nothing, and
 * translation keeps whatever model is loaded, so a freshly downloaded v3 ran
 * without its multilingual guidance until something reloaded it.
 */

import type { HyMT2Variant } from './gguf-model-manager.js';
import type { ManualPromptFormat, ModelLoadOptions } from './llamacpp-bridge.js';

/** Whether a load may use the GPU. */
export interface GpuChoice {
	/** The Settings switch; on unless the user turned it off. */
	useGpu: boolean;
	/** Whether this app can offload at all: only the Mac app, through Metal. */
	gpuCapable: boolean;
}

export function hyMT2LoadOptions(
	variant: HyMT2Variant,
	extra: { promptFormat?: ManualPromptFormat } & Partial<GpuChoice> = {}
): ModelLoadOptions {
	return {
		// Only a user-imported model can need one; the bundled variants resolve
		// their template from the GGUF itself.
		promptFormat: variant === 'custom' ? extra.promptFormat : undefined,
		// v3 is the only checkpoint trained with per-target terminology blocks.
		// Stock, v2 and v5 keep the English-only guidance they shipped with.
		multilingualGuidance: variant === 'manga-v3',
		// Metal has no kernel for the stock model's 1.25-bit STQ1_0 weights, so
		// it stays on the CPU path it was tuned for. The Q4_K_M fine-tunes and
		// an imported model may use the GPU; a load that fails there is retried
		// on the CPU.
		gpu: extra.gpuCapable === true && extra.useGpu !== false && variant !== 'stock'
	};
}

/**
 * What the Compute line in Settings shows: the loaded model's backend, or —
 * with nothing loaded — the one the selected model would load on.
 */
export function plannedBackend(
	info: { backend: string; gpuDevice: string | null; loaded: boolean },
	gpuWanted: boolean
): string {
	if (info.loaded) return info.backend;
	return gpuWanted && info.gpuDevice ? `metal:${info.gpuDevice}` : 'cpu';
}

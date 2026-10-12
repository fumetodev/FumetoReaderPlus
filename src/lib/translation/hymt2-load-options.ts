/**
 * How each on-device model is loaded: the prompt wrapping a custom model
 * needs, and which guidance blocks its prompts carry.
 *
 * One place for the per-variant rules, so the loads that must agree — a
 * translation, a download's validation, a custom model's probe — cannot drift
 * apart. They did: a download's validation load passed nothing, and
 * translation keeps whatever model is loaded, so a freshly downloaded v3 ran
 * without its multilingual guidance until something reloaded it.
 */

import type { HyMT2Variant } from './gguf-model-manager.js';
import type { ManualPromptFormat, ModelLoadOptions } from './llamacpp-bridge.js';

export function hyMT2LoadOptions(
	variant: HyMT2Variant,
	extra: { promptFormat?: ManualPromptFormat } = {}
): ModelLoadOptions {
	return {
		// Only a user-imported model can need one; the bundled variants resolve
		// their template from the GGUF itself.
		promptFormat: variant === 'custom' ? extra.promptFormat : undefined,
		// v3 is the only checkpoint trained with per-target terminology blocks.
		// Stock, v2 and v5 keep the English-only guidance they shipped with.
		multilingualGuidance: variant === 'manga-v3'
	};
}

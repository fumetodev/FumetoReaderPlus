/**
 * JSON schemas for structured output enforcement.
 *
 * These schemas match the JSON formats requested in prompt-builder.ts
 * and full-page-prompt.ts. When passed via `response_format` to
 * providers that support it (OpenRouter, OpenAI-compatible), the LLM
 * is grammar-constrained to produce valid JSON matching the schema.
 *
 * Providers that don't reliably support structured output (Claude and
 * local servers) omit the parameter — prompt-embedded format instructions
 * and fallback parsers remain as safety nets.
 */

import type { ProviderType } from './llm-types.js';

// ============================================================
// Translation entries schema
// ============================================================

/**
 * Schema for standard and full-page translation responses.
 *
 * Uses `json_object` mode (not strict json_schema) for broad compatibility.
 * The prompt still describes the exact format — this just ensures valid JSON output.
 */
export const TRANSLATION_JSON_MODE = {
	type: 'json_object' as const
};

// ============================================================
// Provider capability check
// ============================================================

/**
 * Whether a provider type supports OpenAI-compatible structured output
 * via the `response_format` request parameter.
 */
export function providerSupportsStructuredOutput(type: ProviderType): boolean {
	switch (type) {
		case 'openrouter':
		case 'openai-compatible':
			return true;
		default:
			// LM Studio and local servers: many models don't support
			// response_format, causing 400 errors. The prompt already
			// requests JSON output, so this is just an optimization
			// that isn't worth the compatibility risk.
			return false;
	}
}

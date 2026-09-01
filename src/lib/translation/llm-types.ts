/**
 * Provider-agnostic LLM types.
 *
 * These types replace the OpenRouter-specific types for all consumer code.
 * The shapes are intentionally identical to the OpenAI/OpenRouter message
 * format so the swap is a type rename with zero runtime change.
 */

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

import type { NormalizedFinishReason } from './finish-reason.js';

export type ProviderType =
	| 'openrouter'
	| 'openai-compatible'
	| 'ollama'
	| 'lmstudio'
	| 'local-compatible'
	| 'claude';

/**
 * Saved provider configuration.
 * API keys are stored separately in secure-storage, NOT here.
 */
export interface ProviderConfig {
	id: string;
	type: ProviderType;
	name: string;
	/** Base URL for the API. Not needed for OpenRouter or Claude; required for others. */
	baseUrl?: string;
	/** Default model ID for this provider. */
	defaultModel?: string;
	/** Whether this provider requires an API key. */
	requiresApiKey: boolean;
	/**
	 * When true, filter to vision-capable models and use image-based pipeline.
	 * When false, show all models and use text-only pipeline (PP-OCR → text LLM).
	 * Defaults vary by provider type (OpenRouter/Claude: true, others: false).
	 */
	visionOnly?: boolean;
	/**
	 * OpenRouter only: sent verbatim as the request's `reasoning` object.
	 * `{ enabled: false }` turns a thinking model's reasoning off — reasoning
	 * tokens are billed as output, and a model that thinks past `max_tokens`
	 * returns empty content. Absent means the provider's default; a model whose
	 * reasoning is mandatory rejects a disable. Other provider types ignore it.
	 */
	reasoning?: OpenRouterReasoning;
}

export interface OpenRouterReasoning {
	enabled?: boolean;
	effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	max_tokens?: number;
	exclude?: boolean;
}

// ---------------------------------------------------------------------------
// Chat messages (identical shape to OpenRouterMessage)
// ---------------------------------------------------------------------------

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content:
		| string
		| Array<
				| { type: 'text'; text: string }
				| { type: 'image_url'; image_url: { url: string } }
		  >;
}

// ---------------------------------------------------------------------------
// LLM response (normalized from all providers)
// ---------------------------------------------------------------------------

export interface LLMResponse {
	content: string;
	model: string;
	/**
	 * Why the model stopped, in the shared vocabulary — NOT the provider's own
	 * word for it. Adapters must run their raw value through
	 * `normalizeFinishReason`; the type is narrow so that forgetting is a
	 * compile error rather than a truncation guard that silently never fires.
	 */
	finish_reason?: NormalizedFinishReason;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
	};
}

// ---------------------------------------------------------------------------
// Model info (normalized from all providers)
// ---------------------------------------------------------------------------

export interface LLMModel {
	id: string;
	name: string;
	context_length?: number;
	/** Pricing info (OpenRouter only). Per-token string values. */
	pricing?: {
		prompt: string;
		completion: string;
	};
	/** Whether the model supports vision/image input (if known). */
	supportsVision?: boolean;
}

// ---------------------------------------------------------------------------
// Call options
// ---------------------------------------------------------------------------

export interface LLMCallOptions {
	temperature?: number;
	maxTokens?: number;
	/** Optional cancellation signal propagated to provider adapters. */
	signal?: AbortSignal;
	onRetry?: (attempt: number, delayMs: number, error: string) => void;
	/**
	 * Structured output hint (OpenAI-compatible providers only).
	 * `json_object` mode ensures valid JSON; `json_schema` mode constrains to a schema.
	 * Ignored by providers that don't support it.
	 */
	responseFormat?: {
		type: 'json_object';
	} | {
		type: 'json_schema';
		json_schema: {
			name: string;
			strict: boolean;
			schema: Record<string, unknown>;
		};
	};
}

// ---------------------------------------------------------------------------
// Provider error
// ---------------------------------------------------------------------------

export type BadRequestCategory =
	| 'context_length'
	| 'payload_too_large'
	| 'vision_unsupported'
	| 'invalid_request'
	| 'unknown';

/**
 * Classify common 400 Bad Request error messages into actionable categories.
 */
export function classifyBadRequestMessage(message: string): BadRequestCategory {
	const msg = message.toLowerCase();

	if (
		/context length|context window|maximum context|max context|prompt is too long|too many tokens|token limit/.test(
			msg
		)
	) {
		return 'context_length';
	}

	if (
		/payload too large|request too large|entity too large|image too large|content too large|max image size/.test(
			msg
		)
	) {
		return 'payload_too_large';
	}

	if (
		/does not support image|vision.*not supported|multimodal.*not supported|image input.*not supported|input modality/.test(
			msg
		)
	) {
		return 'vision_unsupported';
	}

	if (
		/invalid request|invalid .*parameter|bad request|unsupported parameter|invalid model|unknown model/.test(
			msg
		)
	) {
		return 'invalid_request';
	}

	return 'unknown';
}

/** Generic LLM provider error with status-based classification. */
export class LLMProviderError extends Error {
	/** Server-suggested retry delay in ms (from Retry-After header), if present. */
	public retryAfterMs?: number;
	/** Classified client-request category, if known (including HTTP 400/413). */
	public badRequestCategory?: BadRequestCategory;
	/** True when the provider returned 200 OK but with empty/filtered content (e.g., content moderation). */
	public isContentFiltered?: boolean;

	constructor(
		public status: number,
		message: string,
		public providerType: ProviderType
	) {
		super(`LLM API error ${status}: ${message}`);
		this.name = 'LLMProviderError';
	}

	get isAuthError(): boolean {
		return this.status === 401 || this.status === 403;
	}

	get isRateLimited(): boolean {
		return this.status === 429;
	}

	get isServerError(): boolean {
		return this.status >= 500;
	}
}

/**
 * Parse a Retry-After header value into milliseconds.
 *
 * Supports both formats per RFC 7231 §7.1.3:
 * - Seconds (e.g., "5", "30")
 * - HTTP-date (e.g., "Wed, 21 Oct 2025 07:28:00 GMT")
 *
 * Returns undefined if the header is absent or unparseable.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
	if (!headerValue) return undefined;

	// Try as integer seconds first (most common for APIs)
	const seconds = Number(headerValue);
	if (!isNaN(seconds) && seconds > 0) {
		return Math.ceil(seconds * 1000);
	}

	// Try as HTTP-date
	const date = new Date(headerValue);
	if (!isNaN(date.getTime())) {
		const delayMs = date.getTime() - Date.now();
		return delayMs > 0 ? delayMs : undefined;
	}

	return undefined;
}

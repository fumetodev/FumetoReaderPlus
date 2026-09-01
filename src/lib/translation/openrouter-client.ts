/**
 * OpenRouter API client.
 *
 * Thin fetch wrapper for the OpenRouter chat completions API.
 * Supports vision/image input via base64 data URIs.
 */

import { RequestCancelledError } from '$lib/i18n/errors.js';
import { rateLimitedUserMessage, withUserMessage } from '$lib/i18n/errors.js';
import {
	debugLogRequest,
	debugLogResponse,
	debugLogRetry,
	debugLogError,
	sanitizeSensitiveText
} from './debug-log.js';
import { parseRetryAfterMs } from './llm-types.js';
import type { LLMCallOptions, OpenRouterReasoning } from './llm-types.js';

export interface OpenRouterMessage {
	role: 'system' | 'user' | 'assistant';
	content:
		| string
		| Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

export interface OpenRouterResponse {
	id: string;
	/** Canonical model identifier reported by OpenRouter for the completed request. */
	model?: string;
	choices: Array<{
		message: {
			content: string;
		};
		finish_reason: string;
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface OpenRouterModel {
	id: string;
	name: string;
	pricing: {
		prompt: string;
		completion: string;
	};
	context_length: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
}

/** One centralized retry after the original request. Page orchestration does not retry again. */
export const MAX_RETRIES = 1;

/** Base delay for the single 429 retry. */
const RATE_LIMIT_BASE_MS = 5000;

/** Brief pause before retrying an ambiguous successful-but-empty completion. */
const EMPTY_RESPONSE_RETRY_DELAY_MS = 750;

/** Backoff multiplier per attempt */
const RATE_LIMIT_MULTIPLIER = 3;

/** Maximum backoff delay (cap) */
const MAX_BACKOFF_MS = 60_000;

/** If Retry-After exceeds this, abort immediately instead of waiting */
const RETRY_AFTER_ABORT_MS = 5 * 60 * 1000; // 5 minutes

/** Total request timeout (ms). Prevents indefinite hangs. */
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Connection timeout for the lightweight API-key validation request. */
const KEY_VALIDATION_TIMEOUT_MS = 15_000;

/** Model catalogs can be larger/slower than the key-validation response. */
const MODEL_LIST_TIMEOUT_MS = 30_000;

/** Only this narrow class of 400 response is safe to retry without response_format. */
function isUnsupportedResponseFormatError(status: number, message: string): boolean {
	if (status !== 400) return false;
	return /response[_ -]?format|structured output|json (?:object|mode)/i.test(message)
		&& /unsupported|not supported|does not support|unknown|unrecognized|invalid parameter/i.test(message);
}

function combineSignals(
	external?: AbortSignal,
	timeoutMs: number = REQUEST_TIMEOUT_MS
): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!external) return timeoutSignal;
	if (typeof AbortSignal.any === 'function') {
		return AbortSignal.any([external, timeoutSignal]);
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	external.addEventListener('abort', abort, { once: true });
	timeoutSignal.addEventListener('abort', abort, { once: true });
	return controller.signal;
}

async function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	if (signal.aborted) throw new RequestCancelledError();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new RequestCancelledError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Call the OpenRouter chat completions API with automatic retry.
 *
 * Retries once after the original request for transient errors (429, 500+, network failures,
 * and an ambiguous HTTP 200 completion with no usable assistant content).
 * Auth errors (401/403) and other client errors are not retried.
 *
 * 429 handling:
 * - Honors Retry-After header when present (+ small jitter)
 * - Falls back to exponential backoff: 5s × 3^attempt, capped at 60s
 * - Adds ±30% jitter to prevent thundering herd
 *
 * @param apiKey - OpenRouter API key
 * @param model - Model identifier (e.g., "google/gemini-3.1-flash-lite")
 * @param messages - Messages including optional image content
 * @param temperature - Sampling temperature
 * @param maxTokens - Maximum response tokens
 * @param onRetry - Optional callback when a retry is about to happen
 * @returns API response with completion and usage data
 */
export async function callOpenRouter(
	apiKey: string,
	model: string,
	messages: OpenRouterMessage[],
	temperature?: number,
	maxTokens: number = 2048,
	onRetry?: (attempt: number, delayMs: number, error: string) => void,
	signal?: AbortSignal,
	responseFormat?: LLMCallOptions['responseFormat'],
	reasoning?: OpenRouterReasoning
): Promise<OpenRouterResponse> {
	const body: Record<string, unknown> = {
		model,
		messages,
		max_tokens: maxTokens
	};
	if (temperature !== undefined) {
		body.temperature = temperature;
	}
	if (responseFormat !== undefined) {
		body.response_format = responseFormat;
	}
	if (reasoning !== undefined) {
		body.reasoning = reasoning;
	}

	const requestHeaders = {
		Authorization: `Bearer ${apiKey}`,
		'Content-Type': 'application/json',
		'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
		'X-Title': 'FumetoReaderPlus Manga Translator'
	};

	let requestBody = JSON.stringify(body);
	let responseFormatFallbackUsed = false;
	let lastError: Error | undefined;

	debugLogRequest('callOpenRouter', model, messages, temperature, maxTokens);
	const startTime = performance.now();

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: requestHeaders,
				body: requestBody,
				signal: combineSignals(signal)
			});

			if (!response.ok) {
				const errorBody = await response.json().catch(() => ({}));
				if (signal?.aborted) throw new RequestCancelledError();
				const message = sanitizeSensitiveText(
					(errorBody as { error?: { message?: string } })?.error?.message || response.statusText,
					[apiKey]
				);
				const openRouterError = new OpenRouterError(response.status, message);
				openRouterError.retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

				// Some OpenRouter routes/models reject the otherwise OpenAI-compatible
				// response_format field. Spend the one centralized retry on the exact
				// same request without that optional hint; prompt JSON instructions and
				// strict local parsing remain in force. Unrelated 400s are never retried.
				if (
					responseFormat !== undefined &&
					!responseFormatFallbackUsed &&
					attempt < MAX_RETRIES &&
					isUnsupportedResponseFormatError(response.status, message)
				) {
					responseFormatFallbackUsed = true;
					const fallbackBody = { ...body };
					delete fallbackBody.response_format;
					requestBody = JSON.stringify(fallbackBody);
					debugLogRetry('callOpenRouter', attempt + 1, 0, 'Provider rejected response_format');
					onRetry?.(attempt + 1, 0, 'Provider rejected response_format');
					continue;
				}

				// Don't retry auth or non-retryable client errors
				if (
					openRouterError.isAuthError ||
					(response.status >= 400 && response.status < 500 && response.status !== 429)
				) {
					throw openRouterError;
				}

				// If server requests a wait longer than 5 minutes, abort immediately
				if (openRouterError.retryAfterMs && openRouterError.retryAfterMs > RETRY_AFTER_ABORT_MS) {
					const waitMin = Math.ceil(openRouterError.retryAfterMs / 60_000);
					const abortError = withUserMessage(
						new OpenRouterError(429, `Rate limited: the server requested a wait of ${waitMin} min`),
						rateLimitedUserMessage(waitMin)
					);
					abortError.retryAfterMs = openRouterError.retryAfterMs;
					throw abortError;
				}

				// Retryable: 429, 500+
				lastError = openRouterError;
			} else {
				const result = (await response.json()) as OpenRouterResponse;
				if (signal?.aborted) throw new RequestCancelledError();

				// Detect empty/moderation responses: 200 OK but no usable content.
				// This can be a transient upstream routing failure or moderation. Spend
				// the existing single retry budget before surfacing the classified error.
				const assistantContent = result.choices?.[0]?.message?.content;
				if (
					!result.choices ||
					result.choices.length === 0 ||
					typeof assistantContent !== 'string' ||
					assistantContent.trim().length === 0
				) {
					const error = new OpenRouterError(
						200,
						'Empty response from provider — content may have been filtered by moderation.'
					);
					error.isContentFiltered = true;
					throw error;
				}

				debugLogResponse('callOpenRouter', result, performance.now() - startTime);
				return result;
			}
		} catch (err) {
			if (signal?.aborted) {
				throw new RequestCancelledError();
			}
			if (
				err instanceof OpenRouterError &&
				err.retryAfterMs &&
				err.retryAfterMs > RETRY_AFTER_ABORT_MS
			) {
				throw err;
			}
			// Re-throw non-retryable errors immediately
			if (
				err instanceof OpenRouterError &&
				(err.isAuthError || (err.status >= 400 && err.status < 500 && err.status !== 429))
			) {
				throw err;
			}
			lastError = err instanceof Error ? err : new Error(String(err));
		}

		// Wait before retrying — honor Retry-After header if present, capped at MAX_BACKOFF_MS
		if (attempt < MAX_RETRIES) {
			const rawServerDelay =
				lastError instanceof OpenRouterError ? lastError.retryAfterMs : undefined;
			const serverDelay = rawServerDelay ? Math.min(rawServerDelay, MAX_BACKOFF_MS) : undefined;
			const backoff = Math.min(
				RATE_LIMIT_BASE_MS * Math.pow(RATE_LIMIT_MULTIPLIER, attempt),
				MAX_BACKOFF_MS
			);
			const isEmptyResponse =
				lastError instanceof OpenRouterError && lastError.isContentFiltered === true;
			const baseDelay = isEmptyResponse
				? EMPTY_RESPONSE_RETRY_DELAY_MS
				: serverDelay ?? backoff;
			// Empty responses use one deterministic short pause. Rate limits and
			// transport failures retain jitter to prevent a thundering herd.
			const delay = isEmptyResponse
				? baseDelay
				: Math.round(baseDelay * (0.7 + Math.random() * 0.6));
			const errMsg = lastError?.message || 'Unknown error';
			debugLogRetry('callOpenRouter', attempt + 1, delay, errMsg);
			onRetry?.(attempt + 1, delay, errMsg);
			await delayWithSignal(delay, signal);
		}
	}

	const finalError = lastError || new Error('Request failed after retries');
	debugLogError('callOpenRouter', finalError, 'all retries exhausted');
	throw finalError;
}

/** Non-sensitive metadata returned by OpenRouter for the current API key. */
export interface OpenRouterKeyInfo {
	label?: string;
	limit?: number | null;
	limit_remaining?: number | null;
	limit_reset?: string | null;
	usage?: number;
	is_free_tier?: boolean;
	expires_at?: string | null;
}

/**
 * Validate an OpenRouter API key against the authenticated current-key endpoint.
 *
 * The model-list endpoint is intentionally public and therefore cannot prove
 * that a key is valid. Settings uses this authenticated probe before reporting
 * a successful provider connection.
 */
export async function validateOpenRouterApiKey(
	apiKey: string,
	signal?: AbortSignal
): Promise<OpenRouterKeyInfo> {
	if (!apiKey.trim()) {
		throw new OpenRouterError(401, 'API key is required.');
	}

	const response = await fetch('https://openrouter.ai/api/v1/key', {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		signal: combineSignals(signal, KEY_VALIDATION_TIMEOUT_MS)
	});

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({}));
		if (signal?.aborted) throw new RequestCancelledError();
		const message = sanitizeSensitiveText(
			(errorBody as { error?: { message?: string } })?.error?.message ||
				response.statusText ||
				'API key validation failed',
			[apiKey]
		);
		throw new OpenRouterError(response.status, message);
	}

	const result = (await response.json()) as { data?: OpenRouterKeyInfo };
	if (signal?.aborted) throw new RequestCancelledError();
	if (!result.data || typeof result.data !== 'object') {
		throw new OpenRouterError(502, 'OpenRouter returned an invalid API key response.');
	}
	return result.data;
}

/**
 * Fetch available models from OpenRouter that support vision/image input.
 */
export async function fetchVisionModels(
	apiKey: string,
	signal?: AbortSignal
): Promise<OpenRouterModel[]> {
	const response = await fetch('https://openrouter.ai/api/v1/models', {
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		signal: combineSignals(signal, MODEL_LIST_TIMEOUT_MS)
	});

	if (!response.ok) {
		throw new OpenRouterError(response.status, 'Failed to fetch models');
	}

	const data = (await response.json()) as { data: OpenRouterModel[] };
	if (signal?.aborted) throw new RequestCancelledError();
	// Filter for models that support image/vision input using input_modalities
	return data.data
		.filter((m) => m.architecture?.input_modalities?.includes('image'))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Fetch all available models from OpenRouter (no vision filter).
 */
export async function fetchAllModels(
	apiKey: string,
	signal?: AbortSignal
): Promise<OpenRouterModel[]> {
	const response = await fetch('https://openrouter.ai/api/v1/models', {
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		signal: combineSignals(signal, MODEL_LIST_TIMEOUT_MS)
	});

	if (!response.ok) {
		throw new OpenRouterError(response.status, 'Failed to fetch models');
	}

	const data = (await response.json()) as { data: OpenRouterModel[] };
	if (signal?.aborted) throw new RequestCancelledError();
	return data.data.sort((a, b) => a.id.localeCompare(b.id));
}

/** Custom error class for OpenRouter API errors */
export class OpenRouterError extends Error {
	/** Server-suggested retry delay in ms (from Retry-After header), if present. */
	public retryAfterMs?: number;
	/** True when a 200 response had empty/filtered content; retried once before being surfaced. */
	public isContentFiltered?: boolean;

	constructor(
		public status: number,
		message: string
	) {
		super(`OpenRouter API error ${status}: ${message}`);
		this.name = 'OpenRouterError';
	}

	get isRateLimited(): boolean {
		return this.status === 429;
	}

	get isAuthError(): boolean {
		return this.status === 401 || this.status === 403;
	}

	get isServerError(): boolean {
		return this.status >= 500;
	}
}

/**
 * OpenAI-compatible adapter.
 *
 * Works with any provider that exposes the OpenAI chat completions API:
 * OpenAI, Anthropic via proxy, Together AI, Fireworks, etc.
 *
 * Uses @tauri-apps/plugin-http (Tauri's Rust-side fetch) instead of the
 * browser's native fetch(). This routes requests through the Rust backend,
 * bypassing webview CSP and CORS restrictions — necessary for reaching
 * local/LAN servers (Ollama, LM Studio, etc.) that don't send CORS headers.
 *
 * No retry logic here — retry is handled centrally in llm-client.ts.
 */

import { RequestCancelledError } from '$lib/i18n/errors.js';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type {
	ChatMessage,
	LLMResponse,
	LLMModel,
	LLMCallOptions,
	ProviderConfig
} from '../llm-types.js';
import { LLMProviderError, parseRetryAfterMs, classifyBadRequestMessage } from '../llm-types.js';
import { badRequestGuidance } from './bad-request-guidance.js';
import { normalizeFinishReason } from '../finish-reason.js';

/** Connection establishment timeout (ms). Fails fast if server is unreachable. */
const CONNECT_TIMEOUT_MS = 10_000; // 10 seconds

/** Total request timeout (ms). Prevents infinite hangs from server crashes/OOM. */
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Model listing timeout (ms). Lightweight GET — 30s is generous. */
const MODELS_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Normalize a user-entered OpenAI-compatible URL to the API's `/v1` base.
 * Accepts server roots, roots with trailing slashes, `/v1`, and pasted
 * `/v1/models` or `/v1/chat/completions` endpoint URLs.
 */
export function normalizeOpenAIApiBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/, '');
	normalized = normalized.replace(/\/v1\/(?:models|chat\/completions)$/i, '/v1');
	if (/\/v1$/i.test(normalized)) return normalized;
	return `${normalized}/v1`;
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

/**
 * Call an OpenAI-compatible chat completions endpoint.
 */
export async function callProvider(
	config: ProviderConfig,
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	options?: LLMCallOptions
): Promise<LLMResponse> {
	const apiBaseUrl = normalizeOpenAIApiBaseUrl(config.baseUrl || '');
	const url = `${apiBaseUrl}/chat/completions`;

	const body: Record<string, unknown> = {
		model,
		messages,
		max_tokens: options?.maxTokens ?? 2048
	};
	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options?.responseFormat) {
		body.response_format = options.responseFormat;
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json'
	};
	if (apiKey) {
		headers['Authorization'] = `Bearer ${apiKey}`;
	}

	let response: Response;
	try {
		response = await tauriFetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			connectTimeout: CONNECT_TIMEOUT_MS,
			signal: combineSignals(options?.signal, REQUEST_TIMEOUT_MS)
		});
	} catch (err) {
		// Rewrite timeout errors to be user-friendly
		if (err instanceof Error) {
			if (err.name === 'TimeoutError' || err.message.includes('timed out')) {
				throw new Error(
					`Request to ${config.name || 'LLM server'} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. ` +
						'The server may be overloaded or the model may have crashed.'
				);
			}
			// Let abort errors (from volume cancellation) propagate unchanged
			if (err.name === 'AbortError' || err instanceof RequestCancelledError) {
				throw err;
			}
		}
		throw err;
	}

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({}));
		const message =
			(errorBody as { error?: { message?: string } })?.error?.message || response.statusText;
		let finalMessage = message;
		const err = new LLMProviderError(response.status, finalMessage, config.type);
		if (response.status === 400) {
			err.badRequestCategory = classifyBadRequestMessage(message);
			finalMessage = `${message} ${badRequestGuidance(err.badRequestCategory)}`.trim();
			err.message = `LLM API error ${response.status}: ${finalMessage}`;
		}
		err.retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
		throw err;
	}

	const result = await response.json();
	return {
		content: result.choices?.[0]?.message?.content || '',
		finish_reason: normalizeFinishReason(result.choices?.[0]?.finish_reason),
		model,
		usage: {
			prompt_tokens: result.usage?.prompt_tokens ?? 0,
			completion_tokens: result.usage?.completion_tokens ?? 0
		}
	};
}

/**
 * Fetch available models from an OpenAI-compatible `/v1/models` endpoint.
 */
export async function fetchModels(config: ProviderConfig, apiKey: string): Promise<LLMModel[]> {
	const apiBaseUrl = normalizeOpenAIApiBaseUrl(config.baseUrl || '');
	const url = `${apiBaseUrl}/models`;

	const headers: Record<string, string> = {};
	if (apiKey) {
		headers['Authorization'] = `Bearer ${apiKey}`;
	}

	const response = await tauriFetch(url, {
		headers,
		connectTimeout: CONNECT_TIMEOUT_MS,
		signal: combineSignals(undefined, MODELS_TIMEOUT_MS)
	});
	if (!response.ok) {
		throw new LLMProviderError(response.status, 'Failed to fetch models', config.type);
	}

	const data = await response.json();
	return (data.data || [])
		.map((m: Record<string, unknown>) => ({
			id: String(m.id ?? ''),
			name: String(m.id ?? ''),
			context_length: typeof m.context_length === 'number' ? m.context_length : undefined,
			supportsVision: undefined // cannot determine from generic endpoint
		}))
		.sort((a: LLMModel, b: LLMModel) => a.id.localeCompare(b.id));
}

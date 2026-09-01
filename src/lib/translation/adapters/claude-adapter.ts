/**
 * Anthropic Claude adapter.
 *
 * Handles the Anthropic Messages API directly. Converts the internal
 * ChatMessage format (OpenAI-shaped) to Claude's native format:
 * - System messages are extracted to a top-level `system` field
 * - Image content blocks are converted from OpenAI's image_url format
 *   to Claude's base64 source format
 *
 * Uses @tauri-apps/plugin-http (Tauri's Rust-side fetch) instead of the
 * browser's native fetch(). This routes requests through the Rust backend,
 * bypassing webview CSP and CORS restrictions.
 *
 * No retry logic here — retry is handled centrally in llm-client.ts.
 */

import { RequestCancelledError } from '$lib/i18n/errors.js';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ChatMessage, LLMResponse, LLMModel, LLMCallOptions, ProviderConfig } from '../llm-types.js';
import { LLMProviderError, parseRetryAfterMs, classifyBadRequestMessage } from '../llm-types.js';
import { badRequestGuidance } from './bad-request-guidance.js';
import { isContentFilteredFinish, normalizeFinishReason } from '../finish-reason.js';

/** Connection establishment timeout (ms). Fails fast if server is unreachable. */
const CONNECT_TIMEOUT_MS = 10_000; // 10 seconds

/** Total request timeout (ms). Prevents infinite hangs from server crashes/OOM. */
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Model listing timeout (ms). Lightweight GET — 30s is generous. */
const MODELS_TIMEOUT_MS = 30_000; // 30 seconds

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** Hardcoded fallback models if the /v1/models endpoint is unavailable. */
const FALLBACK_MODELS: LLMModel[] = [
	{ id: 'claude-haiku-4-20250414', name: 'Claude Haiku 4', supportsVision: true },
	{ id: 'claude-opus-4-20250514', name: 'Claude Opus 4', supportsVision: true },
	{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', supportsVision: true }
];


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

// ---------------------------------------------------------------------------
// Message format conversion (OpenAI → Claude)
// ---------------------------------------------------------------------------

type ClaudeContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface ClaudeMessage {
	role: 'user' | 'assistant';
	content: string | ClaudeContentBlock[];
}

/**
 * Parse a data URI into its media type and base64 payload.
 * e.g. "data:image/jpeg;base64,/9j/4AAQ..." → { media_type: 'image/jpeg', data: '/9j/4AAQ...' }
 */
function parseDataUri(dataUri: string): { media_type: string; data: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
	if (!match) return null;
	return { media_type: match[1], data: match[2] };
}

/**
 * Convert an OpenAI-shaped content block to Claude format.
 */
function convertContentBlock(block: { type: string; text?: string; image_url?: { url: string } }): ClaudeContentBlock | null {
	if (block.type === 'text' && block.text !== undefined) {
		return { type: 'text', text: block.text };
	}
	if (block.type === 'image_url' && block.image_url) {
		const parsed = parseDataUri(block.image_url.url);
		if (parsed) {
			return {
				type: 'image',
				source: { type: 'base64', media_type: parsed.media_type, data: parsed.data }
			};
		}
		// Non-data-URI image URLs are not supported by Claude's base64 source format.
		// Skip them silently rather than crashing.
		return null;
	}
	return null;
}

/**
 * Transform the internal ChatMessage[] into Claude's expected format.
 * Returns the system prompt (if any) separately from the message array.
 */
function transformMessages(messages: ChatMessage[]): { system: string | undefined; messages: ClaudeMessage[] } {
	let system: string | undefined;
	const claudeMessages: ClaudeMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			// Claude expects system as a top-level field, not in messages.
			// Concatenate multiple system messages if present.
			const text = typeof msg.content === 'string'
				? msg.content
				: msg.content
					.filter((b) => b.type === 'text')
					.map((b) => (b as { type: 'text'; text: string }).text)
					.join('\n');
			system = system ? `${system}\n\n${text}` : text;
			continue;
		}

		// User or assistant message
		const role = msg.role as 'user' | 'assistant';

		if (typeof msg.content === 'string') {
			claudeMessages.push({ role, content: msg.content });
		} else {
			// Array content — convert each block
			const blocks: ClaudeContentBlock[] = [];
			for (const block of msg.content) {
				const converted = convertContentBlock(block as Parameters<typeof convertContentBlock>[0]);
				if (converted) blocks.push(converted);
			}
			if (blocks.length === 1 && blocks[0].type === 'text') {
				// Single text block — simplify to string content
				claudeMessages.push({ role, content: blocks[0].text });
			} else if (blocks.length > 0) {
				claudeMessages.push({ role, content: blocks });
			}
		}
	}

	return { system, messages: claudeMessages };
}

// ---------------------------------------------------------------------------
// callProvider
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic Claude Messages API.
 */
export async function callProvider(
	config: ProviderConfig,
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	options?: LLMCallOptions
): Promise<LLMResponse> {
	const baseUrl = (config.baseUrl || ANTHROPIC_API_BASE).replace(/\/+$/, '');
	const url = `${baseUrl}/v1/messages`;

	const { system, messages: claudeMessages } = transformMessages(messages);

	const body: Record<string, unknown> = {
		model,
		max_tokens: options?.maxTokens ?? 2048,
		messages: claudeMessages
	};
	if (system) {
		body.system = system;
	}
	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	const headers: Record<string, string> = {
		'x-api-key': apiKey,
		'anthropic-version': ANTHROPIC_VERSION,
		'content-type': 'application/json'
	};

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
					`Request to ${config.name || 'Claude'} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. ` +
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
			(errorBody as { error?: { message?: string } })?.error?.message ||
			response.statusText;
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

	// Content-filtered detection: 200 OK but no text block.
	//
	// `stop_reason: 'refusal'` is Anthropic saying so outright. Gating only on
	// `end_turn` missed it, so a declined page surfaced as a generic empty
	// response: the client retried it once for nothing, `classifyFailure` read
	// it as `unknown` rather than `content_filter`, and the volume job counted
	// it toward its five-consecutive-failures abort — five declined pages ended
	// a whole volume, where the same pages on OpenRouter are skipped and the run
	// completes.
	const textBlock = (result.content || []).find(
		(b: { type: string }) => b.type === 'text'
	);
	const declined = isContentFilteredFinish(result.stop_reason);
	if (declined || (!textBlock && result.stop_reason === 'end_turn')) {
		const err = new LLMProviderError(200, 'Response was empty (content may have been filtered)', config.type);
		err.isContentFiltered = true;
		throw err;
	}

	return {
		content: textBlock?.text || '',
		model: result.model || model,
		// Anthropic says `max_tokens`; every truncation guard in this codebase
		// compares against OpenAI's `length`.
		finish_reason: normalizeFinishReason(result.stop_reason),
		usage: {
			prompt_tokens: result.usage?.input_tokens ?? 0,
			completion_tokens: result.usage?.output_tokens ?? 0
		}
	};
}

// ---------------------------------------------------------------------------
// fetchModels
// ---------------------------------------------------------------------------

/** Check whether a Claude model ID likely supports vision input. */
function modelSupportsVision(modelId: string): boolean {
	// Claude 3+ models support vision. Match claude-3, claude-4, or higher.
	return /claude-[3-9]|claude-\d{2,}/.test(modelId);
}

/**
 * Fetch available models from the Anthropic /v1/models endpoint.
 *
 * Falls back to a hardcoded list of known models if the endpoint is
 * unavailable (some API key tiers may not have access).
 */
export async function fetchModels(
	config: ProviderConfig,
	apiKey: string
): Promise<LLMModel[]> {
	const baseUrl = (config.baseUrl || ANTHROPIC_API_BASE).replace(/\/+$/, '');
	const url = `${baseUrl}/v1/models?limit=100`;

	try {
		const response = await tauriFetch(url, {
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION
			},
			connectTimeout: CONNECT_TIMEOUT_MS,
			signal: combineSignals(undefined, MODELS_TIMEOUT_MS)
		});

		if (!response.ok) {
			throw new LLMProviderError(response.status, 'Failed to fetch models', config.type);
		}

		const data = await response.json();
		let models: LLMModel[] = (data.data || []).map(
			(m: Record<string, unknown>) => ({
				id: String(m.id ?? ''),
				name: String(m.display_name ?? m.id ?? ''),
				supportsVision: modelSupportsVision(String(m.id ?? ''))
			})
		);

		if (config.visionOnly) {
			models = models.filter((m) => m.supportsVision);
		}

		return models.sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		// Models endpoint unavailable — return hardcoded fallback list
		let models = [...FALLBACK_MODELS];
		if (config.visionOnly) {
			models = models.filter((m) => m.supportsVision);
		}
		return models.sort((a, b) => a.id.localeCompare(b.id));
	}
}

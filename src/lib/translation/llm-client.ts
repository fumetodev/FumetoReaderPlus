/**
 * Unified LLM client.
 *
 * Single entry point that replaces all direct callOpenRouter imports.
 * Resolves the active provider from settings and dispatches to the
 * appropriate adapter. Handles retry logic centrally for non-OpenRouter
 * providers (OpenRouter's adapter delegates to its own retry logic).
 */

import { RequestCancelledError } from '$lib/i18n/errors.js';
import { rateLimitedUserMessage, withUserMessage } from '$lib/i18n/errors.js';
import { get } from 'svelte/store';
import { settings } from '$lib/settings/settings.js';
import type {
	ChatMessage,
	LLMResponse,
	LLMModel,
	LLMCallOptions,
	ProviderConfig
} from './llm-types.js';
import { LLMProviderError } from './llm-types.js';
import { debugLogRequest, debugLogResponse, debugLogRetry, debugLogError } from './debug-log.js';

// Adapter imports
import * as openrouterAdapter from './adapters/openrouter-adapter.js';
import * as openaiCompatAdapter from './adapters/openai-compat-adapter.js';
import * as localAdapter from './adapters/local-adapter.js';
import * as claudeAdapter from './adapters/claude-adapter.js';
import { acquireSlot } from './request-queue.js';
import {
	acquireCloudSlot,
	isCloudProviderType,
	reportProviderRateLimit,
	reportProviderSuccess
} from './cloud-request-limiter.js';

/** One centralized retry after the original request. Page orchestration does not retry again. */
export const MAX_RETRIES = 1;

/** Base delay for 429 backoff (×3 per attempt: 5s, 15s, 45s→capped 60s). */
const RATE_LIMIT_BASE_MS = 5000;

/** Backoff multiplier per attempt. */
const RATE_LIMIT_MULTIPLIER = 3;

/** Maximum backoff delay (cap). */
const MAX_BACKOFF_MS = 60_000;

/** If Retry-After exceeds this, abort immediately instead of waiting. */
const RETRY_AFTER_ABORT_MS = 5 * 60 * 1000; // 5 minutes

function clampTemperature(temperature: number | undefined): number | undefined {
	if (temperature === undefined || Number.isNaN(temperature)) return undefined;
	return Math.min(2, Math.max(0, temperature));
}

function normalizeMaxTokens(maxTokens: number | undefined): number | undefined {
	if (maxTokens === undefined || Number.isNaN(maxTokens)) return undefined;
	return Math.max(1, Math.floor(maxTokens));
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

function validateResponseContent(result: LLMResponse): void {
	if (!result.content || result.content.trim() === '') {
		throw new Error('LLM returned an empty response.');
	}
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the active provider config, model, and API key.
 *
 * Resolution order:
 * 1. settings.activeProviderId matches a saved provider → use it
 * 2. settings.providers is non-empty → use first provider
 * 3. Fallback: legacy OpenRouter config from settings.openrouterApiKey
 */
export async function resolveActiveProvider(settingsSnapshot?: import('$lib/settings/settings.js').FumetoSettings): Promise<{
	config: ProviderConfig;
	model: string;
	apiKey: string;
}> {
	const $settings = settingsSnapshot ?? get(settings);
	const { loadProviderApiKey } = await import('$lib/settings/secure-storage.js');

	// Priority 1: activeProviderId matches a saved provider
	if ($settings.activeProviderId && $settings.providers?.length) {
		const provider = $settings.providers.find((p) => p.id === $settings.activeProviderId);
		if (provider) {
			const apiKey = provider.requiresApiKey ? await loadProviderApiKey(provider.id) : '';
			return {
				config: { ...provider },
				model: provider.defaultModel || $settings.selectedModel,
				apiKey
			};
		}
	}

	// Priority 2: first provider in list
	if ($settings.providers?.length) {
		const provider = $settings.providers[0];
		const apiKey = provider.requiresApiKey ? await loadProviderApiKey(provider.id) : '';
		return {
			config: { ...provider },
			model: provider.defaultModel || $settings.selectedModel,
			apiKey
		};
	}

	// Priority 3: legacy fallback (backward compat)
	// Try loading from encrypted storage if in-memory key is empty
	let legacyKey = $settings.openrouterApiKey;
	if (!legacyKey) {
		legacyKey = await loadProviderApiKey('__legacy_openrouter__');
	}
	return {
		config: {
			id: '__legacy_openrouter__',
			type: 'openrouter',
			name: 'OpenRouter',
			requiresApiKey: true
		},
		model: $settings.selectedModel,
		apiKey: legacyKey
	};
}

/** In-memory provider snapshot used to keep a multi-request run deterministic. */
export type ResolvedLLMProvider = Awaited<ReturnType<typeof resolveActiveProvider>>;

// ---------------------------------------------------------------------------
// Adapter dispatch
// ---------------------------------------------------------------------------

/** Get the adapter module for a provider type. */
function getAdapter(type: ProviderConfig['type']) {
	switch (type) {
		case 'openrouter':
			return openrouterAdapter;
		case 'openai-compatible':
			return openaiCompatAdapter;
		case 'ollama':
		case 'lmstudio':
		case 'local-compatible':
			return localAdapter;
		case 'claude':
			return claudeAdapter;
		default:
			return openaiCompatAdapter;
	}
}

/**
 * Check if the active provider uses vision (image) or text-only pipeline.
 *
 * When true, the translation pipeline sends full page images to the LLM.
 * When false, PP-OCR extracts text first and only the text is sent to the LLM.
 *
 * Defaults vary by provider type:
 *   - OpenRouter, Claude: vision (true)
 *   - Ollama, LM Studio, local-compatible, OpenAI-compatible: text-only (false)
 */
export function isProviderVisionMode(config: ProviderConfig): boolean {
	if (config.visionOnly !== undefined) return config.visionOnly;
	switch (config.type) {
		case 'openrouter':
		case 'claude':
			return true;
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// callLLM — unified LLM call
// ---------------------------------------------------------------------------

/**
 * Call the active LLM provider.
 *
 * Resolves the active provider from settings, dispatches to the right
 * adapter. For non-OpenRouter providers, handles retry logic centrally
 * (OpenRouter's adapter delegates to callOpenRouter which has its own retry).
 *
 * 429 handling: honors Retry-After header when present (+ jitter),
 * otherwise uses exponential backoff (5s × 3^attempt, capped at 60s).
 */
export async function callLLM(
	messages: ChatMessage[],
	options?: LLMCallOptions
): Promise<LLMResponse> {
	const provider = await resolveActiveProvider();
	return callLLMWithProvider(provider, messages, options);
}

/**
 * Call a provider snapshot resolved once by a multi-request job. API keys stay
 * in this in-memory object and are never copied into persisted job records.
 */
export async function callLLMWithProvider(
	provider: ResolvedLLMProvider,
	messages: ChatMessage[],
	options?: LLMCallOptions
): Promise<LLMResponse> {
	const { config, model, apiKey } = provider;

	if (config.requiresApiKey && !apiKey) {
		throw new Error(
			`API key not configured for provider "${config.name}". Please set it in Settings.`
		);
	}

	const adapter = getAdapter(config.type);
	const $settings = get(settings);
	const effectiveOptions: LLMCallOptions = {
		temperature: clampTemperature(options?.temperature ?? $settings.temperature),
		maxTokens: normalizeMaxTokens(options?.maxTokens),
		signal: options?.signal,
		onRetry: options?.onRetry,
		responseFormat: options?.responseFormat
	};

	debugLogRequest(
		'callLLM',
		model,
		messages,
		effectiveOptions.temperature,
		effectiveOptions.maxTokens ?? 2048
	);
	const startTime = performance.now();

	// Acquire concurrency slot (blocks for local providers if another
	// request is in-flight; returns null immediately for cloud providers)
	const release = await acquireSlot(
		config.id,
		config.type,
		$settings.localProviderConcurrency ?? 1,
		options?.signal
	);
	// Cloud accounts are shared by every job in the app, so their pacing is
	// account-wide: a rate limit earned by one volume slows all of them.
	const releaseCloud = isCloudProviderType(config.type)
		? await acquireCloudSlot(config.id, options?.signal).catch((error) => {
			release?.();
			throw error;
		})
		: null;

	try {
		// OpenRouter adapter has its own retry — skip generic retry for it
		if (config.type === 'openrouter') {
			try {
				const result = await adapter.callProvider(config, apiKey, model, messages, effectiveOptions);
				validateResponseContent(result);
				reportProviderSuccess(config.id);
				debugLogResponse('callLLM', result, performance.now() - startTime);
				return result;
			} catch (err) {
				if (err instanceof LLMProviderError && err.status === 429) {
					reportProviderRateLimit(config.id, err.retryAfterMs);
				}
				throw err;
			}
		}

		// Generic retry for non-OpenRouter providers
		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const result = await adapter.callProvider(
					config,
					apiKey,
					model,
					messages,
					effectiveOptions
				);
				validateResponseContent(result);
				reportProviderSuccess(config.id);
				debugLogResponse('callLLM', result, performance.now() - startTime);
				return result;
			} catch (err) {
				if (err instanceof LLMProviderError && err.status === 429 && isCloudProviderType(config.type)) {
					reportProviderRateLimit(config.id, err.retryAfterMs);
				}
				// Don't retry auth or non-retryable client errors
				if (
					err instanceof LLMProviderError &&
					(err.isAuthError || (err.status >= 400 && err.status < 500 && err.status !== 429))
				) {
					throw err;
				}
				lastError = err instanceof Error ? err : new Error(String(err));

				// If server requests a wait longer than 5 minutes, abort immediately
				if (
					lastError instanceof LLMProviderError &&
					lastError.retryAfterMs &&
					lastError.retryAfterMs > RETRY_AFTER_ABORT_MS
				) {
					const waitMin = Math.ceil(lastError.retryAfterMs / 60_000);
					throw withUserMessage(
						new Error(`Rate limited: the server requested a wait of ${waitMin} min`),
						rateLimitedUserMessage(waitMin)
					);
				}
			}

			// Wait before retrying — honor Retry-After header if present, capped at MAX_BACKOFF_MS
			if (attempt < MAX_RETRIES) {
				const rawServerDelay =
					lastError instanceof LLMProviderError ? lastError.retryAfterMs : undefined;
				const serverDelay = rawServerDelay ? Math.min(rawServerDelay, MAX_BACKOFF_MS) : undefined;
				const backoff = Math.min(
					RATE_LIMIT_BASE_MS * Math.pow(RATE_LIMIT_MULTIPLIER, attempt),
					MAX_BACKOFF_MS
				);
				const baseDelay = serverDelay ?? backoff;
				// Add ±30% jitter to prevent thundering herd
				const jitter = baseDelay * (0.7 + Math.random() * 0.6);
				const delay = Math.round(jitter);
				const errMsg = lastError?.message || 'Unknown error';
				debugLogRetry('callLLM', attempt + 1, delay, errMsg);
				options?.onRetry?.(attempt + 1, delay, errMsg);
				await delayWithSignal(delay, options?.signal);
			}
		}

		const finalError = lastError || new Error('Request failed after retries');
		debugLogError('callLLM', finalError, 'all retries exhausted');
		throw finalError;
	} finally {
		release?.();
		releaseCloud?.();
	}
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

/**
 * Fetch available models from the active provider.
 */
export async function fetchModels(): Promise<LLMModel[]> {
	const { config, apiKey } = await resolveActiveProvider();
	const adapter = getAdapter(config.type);
	return adapter.fetchModels(config, apiKey);
}

/**
 * Fetch models for a specific provider config.
 * Used in Settings UI when testing a provider that isn't yet active.
 */
export async function fetchModelsForProvider(
	config: ProviderConfig,
	apiKey: string,
	signal?: AbortSignal
): Promise<LLMModel[]> {
	const adapter = getAdapter(config.type);
	return adapter.fetchModels(config, apiKey, signal);
}

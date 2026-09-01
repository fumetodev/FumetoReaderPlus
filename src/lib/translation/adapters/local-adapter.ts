/**
 * Local LLM adapter for Ollama, LM Studio, and generic local servers.
 *
 * All three expose OpenAI-compatible `/v1/chat/completions`, so we reuse
 * the OpenAI-compatible adapter for the call. The only differences are:
 * - Default base URLs per provider type
 * - Ollama's native `/api/tags` for richer model listing
 *
 * Uses @tauri-apps/plugin-http (via openai-compat-adapter) for all HTTP
 * requests, bypassing webview CSP/CORS — necessary for local/LAN servers.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ChatMessage, LLMResponse, LLMModel, LLMCallOptions, ProviderConfig } from '../llm-types.js';
import { LLMProviderError } from '../llm-types.js';
import { callProvider as openaiCall, fetchModels as openaiFetchModels } from './openai-compat-adapter.js';
import { fetchNativeModels } from '../lmstudio-native.js';

/** Default base URLs for known local providers. */
const DEFAULT_URLS: Record<string, string> = {
	ollama: 'http://localhost:11434',
	lmstudio: 'http://localhost:1234'
};

/** Ensure the config has a base URL, falling back to provider-type defaults. */
function withDefaultUrl(config: ProviderConfig): ProviderConfig {
	if (config.baseUrl) return config;
	const defaultUrl = DEFAULT_URLS[config.type];
	return defaultUrl ? { ...config, baseUrl: defaultUrl } : config;
}

/**
 * Call a local LLM provider via OpenAI-compatible endpoint.
 */
export async function callProvider(
	config: ProviderConfig,
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	options?: LLMCallOptions
): Promise<LLMResponse> {
	return openaiCall(withDefaultUrl(config), apiKey, model, messages, options);
}

/**
 * Fetch available models from a local provider.
 *
 * For Ollama, tries the native `/api/tags` endpoint first (richer info),
 * falling back to the OpenAI-compatible `/v1/models`.
 */
export async function fetchModels(
	config: ProviderConfig,
	apiKey: string
): Promise<LLMModel[]> {
	const effectiveConfig = withDefaultUrl(config);

	if (config.type === 'ollama') {
		try {
			return await fetchOllamaModels(effectiveConfig);
		} catch {
			// Fall back to OpenAI-compatible endpoint
		}
	}

	if (config.type === 'lmstudio') {
		try {
			return await fetchLMStudioModels(effectiveConfig);
		} catch {
			// Fall back to OpenAI-compatible endpoint
		}
	}

	return openaiFetchModels(effectiveConfig, apiKey);
}

/**
 * Fetch models from Ollama's native `/api/tags` endpoint.
 */
async function fetchOllamaModels(config: ProviderConfig): Promise<LLMModel[]> {
	const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
	const response = await tauriFetch(`${baseUrl}/api/tags`, {
		connectTimeout: 10_000,
		signal: AbortSignal.timeout(30_000)
	});

	if (!response.ok) {
		throw new LLMProviderError(response.status, 'Ollama /api/tags failed', config.type);
	}

	const data = await response.json();
	return (data.models || [])
		.map((m: Record<string, unknown>) => ({
			id: String(m.name ?? m.model ?? ''),
			name: String(m.name ?? m.model ?? ''),
			supportsVision: undefined // Ollama doesn't expose this in /api/tags
		}))
		.sort((a: LLMModel, b: LLMModel) => a.id.localeCompare(b.id));
}

/**
 * Fetch models from LM Studio's native `/api/v1/models` endpoint.
 * Returns enriched metadata including vision capability per model.
 */
async function fetchLMStudioModels(config: ProviderConfig): Promise<LLMModel[]> {
	const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
	const models = await fetchNativeModels(baseUrl);

	return models.map((m) => ({
		id: m.id,
		name: m.id,
		supportsVision: m.capabilities.vision,
		context_length: m.maxContextLength
	}));
}

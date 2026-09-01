/**
 * OpenRouter adapter.
 *
 * Thin wrapper around the existing openrouter-client.ts — delegates all
 * work to the original functions and normalizes the response shapes.
 * The original module is NOT modified, ensuring zero regression risk.
 */

import { callOpenRouter, fetchVisionModels, fetchAllModels, OpenRouterError } from '../openrouter-client.js';
import type { OpenRouterMessage } from '../openrouter-client.js';
import type { ChatMessage, LLMResponse, LLMModel, LLMCallOptions, ProviderConfig } from '../llm-types.js';
import { LLMProviderError, classifyBadRequestMessage } from '../llm-types.js';
import { badRequestGuidance } from './bad-request-guidance.js';
import { normalizeFinishReason } from '../finish-reason.js';


/**
 * Call the OpenRouter API via the existing client.
 *
 * ChatMessage and OpenRouterMessage have identical shapes, so we cast
 * directly without any transformation.
 */
export async function callProvider(
	config: ProviderConfig,
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	options?: LLMCallOptions
): Promise<LLMResponse> {
	let response;
	try {
		response = await callOpenRouter(
			apiKey,
			model,
			messages as OpenRouterMessage[],
			options?.temperature,
			options?.maxTokens ?? 2048,
			options?.onRetry,
			options?.signal,
			options?.responseFormat,
			config.reasoning
		);
	} catch (err) {
		if (err instanceof OpenRouterError) {
			const mapped = new LLMProviderError(err.status, err.message, config.type);
			mapped.retryAfterMs = err.retryAfterMs;
			mapped.isContentFiltered = err.isContentFiltered;
			if (err.status === 400 || err.status === 413) {
				mapped.badRequestCategory = err.status === 413
					? 'payload_too_large'
					: classifyBadRequestMessage(err.message);
				const message = `${err.message} ${badRequestGuidance(mapped.badRequestCategory)}`.trim();
				mapped.message = `LLM API error ${err.status}: ${message}`;
			}
			throw mapped;
		}
		throw err;
	}

	return {
		content: response.choices[0]?.message?.content || '',
		finish_reason: normalizeFinishReason(response.choices[0]?.finish_reason),
		model: response.model || model,
		usage: {
			prompt_tokens: response.usage?.prompt_tokens ?? 0,
			completion_tokens: response.usage?.completion_tokens ?? 0
		}
	};
}

/**
 * Fetch available models from OpenRouter.
 *
 * When `config.visionOnly` is true (default), only vision-capable models are
 * returned and all have `supportsVision: true`. When false, all models are
 * returned and `supportsVision` is determined per-model from input_modalities.
 */
export async function fetchModels(
	config: ProviderConfig,
	apiKey: string,
	signal?: AbortSignal
): Promise<LLMModel[]> {
	const visionOnly = config.visionOnly ?? true;

	if (visionOnly) {
		const models = await fetchVisionModels(apiKey, signal);
		return models.map((m) => ({
			id: m.id,
			name: m.name,
			context_length: m.context_length,
			pricing: m.pricing,
			supportsVision: true // fetchVisionModels already filters for vision
		}));
	}

	const models = await fetchAllModels(apiKey, signal);
	return models.map((m) => ({
		id: m.id,
		name: m.name,
		context_length: m.context_length,
		pricing: m.pricing,
		supportsVision: m.architecture?.input_modalities?.includes('image') ?? false
	}));
}

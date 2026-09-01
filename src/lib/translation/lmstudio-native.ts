/**
 * LM Studio native API client.
 *
 * Wraps LM Studio's `/api/v1/*` endpoints which provide richer
 * model metadata (vision capability, load state) and lifecycle
 * management (load/unload) not available in the OpenAI-compatible API.
 *
 * All functions are no-throw — they return success/error results so
 * callers can fall back gracefully when the native API is unavailable
 * (e.g., older LM Studio versions).
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// ============================================================
// Types
// ============================================================

export interface LMStudioModel {
	id: string;
	/** 'loaded' when the model is in memory, 'not-loaded' otherwise. */
	state: 'loaded' | 'not-loaded' | string;
	capabilities: {
		vision: boolean;
	};
	maxContextLength?: number;
}

export interface EnsureModelResult {
	success: boolean;
	error?: string;
}

// ============================================================
// Timeouts
// ============================================================

const LIST_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 120_000;
const UNLOAD_TIMEOUT_MS = 30_000;

// ============================================================
// Model listing
// ============================================================

/**
 * Fetch models from LM Studio's native `/api/v1/models` endpoint.
 * Returns enriched model metadata including vision capability and load state.
 */
export async function fetchNativeModels(baseUrl: string): Promise<LMStudioModel[]> {
	const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models`;

	const response = await tauriFetch(url, {
		connectTimeout: 10_000,
		signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
	});

	if (!response.ok) {
		throw new Error(`LM Studio native API error: HTTP ${response.status}`);
	}

	const data = await response.json();
	const models: LMStudioModel[] = [];

	for (const m of data.data ?? data ?? []) {
		models.push({
			id: String(m.id ?? m.path ?? ''),
			state: String(m.state ?? 'not-loaded'),
			capabilities: {
				vision: !!(m.capabilities?.vision)
			},
			maxContextLength: typeof m.max_context_length === 'number' ? m.max_context_length : undefined
		});
	}

	return models.sort((a, b) => a.id.localeCompare(b.id));
}

// ============================================================
// Model lifecycle
// ============================================================

/**
 * Load a model in LM Studio.
 */
async function loadModel(
	baseUrl: string,
	modelId: string,
	options?: { contextLength?: number }
): Promise<void> {
	const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/load`;

	const body: Record<string, unknown> = {
		model: modelId,
		gpu_offload: 'max'
	};
	if (options?.contextLength) {
		body.context_length = options.contextLength;
	}

	const response = await tauriFetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		connectTimeout: 10_000,
		signal: AbortSignal.timeout(LOAD_TIMEOUT_MS)
	});

	if (!response.ok) {
		const errBody = await response.json().catch(() => ({}));
		const msg = (errBody as Record<string, unknown>)?.error ?? response.statusText;
		throw new Error(`Failed to load model: ${msg}`);
	}
}

/**
 * Unload a model from LM Studio.
 */
async function unloadModel(baseUrl: string, modelId: string): Promise<void> {
	const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/unload`;

	const response = await tauriFetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: modelId }),
		connectTimeout: 10_000,
		signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS)
	});

	if (!response.ok) {
		const errBody = await response.json().catch(() => ({}));
		const msg = (errBody as Record<string, unknown>)?.error ?? response.statusText;
		throw new Error(`Failed to unload model: ${msg}`);
	}
}

// ============================================================
// High-level orchestrator
// ============================================================

/**
 * Ensure exactly one model is loaded in LM Studio: the target model.
 *
 * 1. Lists all models to find currently loaded ones
 * 2. Unloads any loaded models that aren't the target
 * 3. Loads the target if not already loaded
 *
 * Never throws — returns a result object so callers can fall back
 * to JIT loading on failure.
 */
export async function ensureModelLoaded(
	baseUrl: string,
	targetModelId: string,
	options?: { contextLength?: number }
): Promise<EnsureModelResult> {
	try {
		const models = await fetchNativeModels(baseUrl);

		// Unload any loaded models that aren't the target
		const loadedOthers = models.filter(m => m.state === 'loaded' && m.id !== targetModelId);
		for (const other of loadedOthers) {
			try {
				await unloadModel(baseUrl, other.id);
			} catch (err) {
				// Best effort — continue even if unload fails
				console.warn(`[lmstudio] Failed to unload ${other.id}:`, err);
			}
		}

		// Check if target is already loaded
		const target = models.find(m => m.id === targetModelId);
		if (target?.state === 'loaded') {
			return { success: true };
		}

		// Load the target model
		await loadModel(baseUrl, targetModelId, options);
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : 'Model preload failed'
		};
	}
}

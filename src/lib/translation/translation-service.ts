/**
 * Translation service — orchestrates OCR+translation requests.
 *
 * Handles:
 * - Cropping regions to base64 images
 * - Building prompts for the selected mode
 * - Calling OpenRouter API
 * - Parsing responses
 * - Caching translations in IndexedDB
 */

import { rateLimitedUserMessage, withUserMessage } from '$lib/i18n/errors.js';
import { get } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import { db } from '$lib/db/index.js';
import { settings } from '$lib/settings/settings.js';
import { currentPageTranslations, beginRegionTranslation, endRegionTranslation, currentPageRegions, regionTranslationMap } from '$lib/stores/translation-state.js';
import { cropRegion } from '$lib/regions/region-cropper.js';
import { callLLMWithProvider, resolveActiveProvider, isProviderVisionMode } from './llm-client.js';
import { LLMProviderError } from './llm-types.js';
import { buildMode1Messages, buildMode2Messages, buildMode3Messages, buildTextOnlyMode1Messages, buildTextOnlyMode2Messages, buildTextOnlyMode3Messages, parseTranslationResponse } from './prompt-builder.js';
import { debugLogParse } from './debug-log.js';
import { detectRefusal } from './full-page-service.js';
import { getFullWorkContext, updateWorkContext } from './context-manager.js';
import type { TranslationRegion, Translation, TranslationMode } from '$lib/types/index.js';

export interface RegionTranslationRunOptions {
	/** Prevents a completed detached run from publishing into the current-page store. */
	shouldPublishResult?: () => boolean;
	/**
	 * Cancellation for the whole run. Region work used to be the one translation
	 * path with no signal at all: the reader's Stop control could not reach it,
	 * and turning the page left it running — on-device that means holding the
	 * single serialized inference turn against the page the user is now looking
	 * at.
	 */
	signal?: AbortSignal;
}

/**
 * Translate a region using the configured LLM.
 *
 * @param region - The region to translate
 * @param imageFile - The full page image file
 * @param mode - Translation mode (1/2/3), defaults to settings value
 * @returns The created Translation object
 */
export async function translateRegion(
	region: TranslationRegion,
	imageFile: File,
	mode?: TranslationMode,
	options: RegionTranslationRunOptions = {}
): Promise<Translation> {
	const $settings = get(settings);
	const signal = options.signal;
	const throwIfCancelled = () => {
		if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
	};
	throwIfCancelled();

	const translationMode = mode ?? $settings.translationMode;

	// Mark region as translating
	beginRegionTranslation(region.id);

	try {
		// Resolve vision mode
		const resolvedProvider = await resolveActiveProvider();
		const provider = { ...resolvedProvider, config: { ...resolvedProvider.config } };
		const { config: providerConfig } = provider;
		const visionMode = isProviderVisionMode(providerConfig);

		// Step 1: Build messages based on mode and pipeline
		let messages;

		if (visionMode) {
			// Vision pipeline: crop region to base64 image
			const imageBase64 = await cropRegion(imageFile, region);

			switch (translationMode) {
				case 1:
					messages = buildMode1Messages(imageBase64, $settings.sourceLanguage, $settings.targetLanguage);
					break;
				case 2: {
					const pageContext = getPageContext(region.id);
					messages = buildMode2Messages(imageBase64, pageContext, $settings.sourceLanguage, $settings.targetLanguage);
					break;
				}
				case 3: {
					const pageContext = getPageContext(region.id);
					const workContext = await getWorkContext(region.volume_uuid);
					messages = buildMode3Messages(imageBase64, pageContext, workContext, $settings.sourceLanguage, $settings.targetLanguage);
					break;
				}
				default:
					messages = buildMode1Messages(imageBase64, $settings.sourceLanguage, $settings.targetLanguage);
			}
		} else {
			// Text-only pipeline: crop region and run OCR on the cropped area,
			// then send the OCR text to the LLM
			const imageBase64 = await cropRegion(imageFile, region);
			// cropRegion returns a data URI — convert back to a File for PP-OCR
			const blob = await (await fetch(imageBase64)).blob();
			const croppedFile = new File([blob], 'region.png', { type: blob.type });
			const { extractTextWithPPOCR } = await import('./ppocr-text-extractor.js');
			const { blocks } = await extractTextWithPPOCR(croppedFile, { signal });
			const ocrText = blocks.map(b => b.text).join(' ');

			if (!ocrText.trim()) {
				throw new Error('No text detected in the selected region.');
			}

			switch (translationMode) {
				case 1:
					messages = buildTextOnlyMode1Messages(ocrText, $settings.sourceLanguage, $settings.targetLanguage);
					break;
				case 2: {
					const pageContext = getPageContext(region.id);
					messages = buildTextOnlyMode2Messages(ocrText, pageContext, $settings.sourceLanguage, $settings.targetLanguage);
					break;
				}
				case 3: {
					const pageContext = getPageContext(region.id);
					const workContext = await getWorkContext(region.volume_uuid);
					messages = buildTextOnlyMode3Messages(ocrText, pageContext, workContext, $settings.sourceLanguage, $settings.targetLanguage);
					break;
				}
				default:
					messages = buildTextOnlyMode1Messages(ocrText, $settings.sourceLanguage, $settings.targetLanguage);
			}
		}

		// Step 3: Call LLM + parse (bounded parse-recovery retry)
		const maxParseAttempts = 2;
		let response;
		let parsed:
			| {
					original: string;
					translated: string;
					status: 'ok' | 'no_text' | 'invalid';
			  }
			| null = null;

		for (let attempt = 0; attempt < maxParseAttempts; attempt++) {
			throwIfCancelled();
			response = await callLLMWithProvider(provider, messages, {
				temperature: $settings.temperature,
				maxTokens: Math.min($settings.maxContextTokens ?? 2048, 2048),
				signal
			});

			if (response.finish_reason === 'length') {
				throw new Error('Translation output was truncated (max tokens reached). Increase max context tokens and retry.');
			}

			const content = response.content;
			detectRefusal(content);
			parsed = parseTranslationResponse(content);
			debugLogParse('translateRegion', parsed);

			if (parsed.status === 'ok') break;
			if (parsed.status === 'no_text') {
				throw new Error('No text detected in the selected region.');
			}
			if (attempt === maxParseAttempts - 1) {
				throw new Error('Failed to parse translation output from the LLM.');
			}
		}

		if (!response || !parsed || parsed.status !== 'ok') {
			throw new Error('Translation failed to produce usable output.');
		}

		// Step 5: Store translation
		const translation: Translation = {
			id: randomUUID(),
			region_id: region.id,
			volume_uuid: region.volume_uuid,
			page_index: region.page_index,
			mode: translationMode,
			model: response.model,
			original_text: parsed.original || undefined,
			translated_text: parsed.translated,
			prompt_tokens: response.usage.prompt_tokens,
			completion_tokens: response.usage.completion_tokens,
			created_at: new Date().toISOString()
		};

		// A cancelled run must not leave a durable record: the result reappears
		// the moment the reader navigates back, which reads as the cancel having
		// done nothing.
		throwIfCancelled();
		await db.translations.put(translation);

		// Update store
		const shouldPublish = options.shouldPublishResult?.() ?? true;
		if (shouldPublish) {
			currentPageTranslations.update((translations) => [...translations, translation]);
		}

		// Keep Mode 3 context manager in sync with latest page translations.
		if (translationMode === 3 && shouldPublish) {
			const existingTranslations = get(currentPageTranslations);
			const latestByRegion = new Map<string, Translation>();
			for (const t of existingTranslations) {
				latestByRegion.set(t.region_id, t);
			}
			latestByRegion.set(region.id, translation);

			const pageTranslations = Array.from(latestByRegion.values())
				.filter((t) => t.page_index === region.page_index)
				.map((t) => ({
					region_id: t.region_id,
					original_text: t.original_text ?? '',
					translated_text: t.translated_text
				}));

			await updateWorkContext(region.volume_uuid, region.page_index, pageTranslations, { signal });
		}

		return translation;
	} catch (err) {
		if (err instanceof LLMProviderError) {
			if (err.isAuthError) {
				throw new Error('Invalid API key. Please check your API key in Settings.');
			}
			if (err.isRateLimited) {
				throw withUserMessage(new Error('Rate limited'), { code: 'error_rate_limited_short' });
			}
			if (err.status === 400 || err.status === 413 || err.badRequestCategory) {
				switch (err.badRequestCategory) {
					case 'context_length':
						throw new Error('Request exceeded the model context limit. Try lowering max context tokens.');
					case 'payload_too_large':
						throw new Error('Image payload was too large for the model. Try a smaller region.');
					case 'vision_unsupported':
						throw new Error('Selected model does not support image input. Choose a vision-capable model.');
					case 'invalid_request':
						throw new Error('Invalid request parameters were rejected by the model provider.');
					default:
						throw new Error('Bad request from the model provider. Please verify model/settings and try again.');
				}
			}
		}
		throw err;
	} finally {
		endRegionTranslation(region.id);
	}
}

/**
 * Get page context for Mode 2 — other translations on the same page.
 */
function getPageContext(
	excludeRegionId: string
): Array<{ original: string; translated: string }> {
	const transMap = get(regionTranslationMap);
	const regions = get(currentPageRegions);

	const context: Array<{ original: string; translated: string }> = [];

	for (const region of regions) {
		if (region.id === excludeRegionId) continue;

		const translation = transMap.get(region.id);
		if (translation) {
			context.push({
				original: translation.original_text || '',
				translated: translation.translated_text
			});
		}
	}

	return context;
}

/**
 * Get work context for Mode 3 via the context-manager.
 */
async function getWorkContext(volumeUuid: string): Promise<string> {
	return getFullWorkContext(volumeUuid);
}

/**
 * Translate a region and handle errors gracefully.
 * Returns an error message string if translation fails, or null on success.
 */
export async function translateRegionSafe(
	region: TranslationRegion,
	imageFile: File,
	mode?: TranslationMode,
	options: RegionTranslationRunOptions = {}
): Promise<string | null> {
	try {
		await translateRegion(region, imageFile, mode, options);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : 'Translation failed';
	}
}

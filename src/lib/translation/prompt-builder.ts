/**
 * Prompt construction for the three translation modes.
 *
 * Mode 1: Isolated translation (just the highlighted region)
 * Mode 2: Page context (region + other translations from the page)
 * Mode 3: Full context (region + page + rolling story summary)
 */

import type { ChatMessage } from './llm-types.js';
import { getLanguagePromptName } from '$lib/settings/settings.js';
import { getSfxExample } from './language-utils.js';
import { parseFirstJsonObject } from './json-utils.js';

function buildSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? null : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);
	const sfxExample = getSfxExample(sourceLanguage);

	const specialization = auto
		? `specializing in translating to ${targetLabel}. You will receive an image containing text from a panel — identify the source language from the image`
		: `specializing in ${sourceLabel} to ${targetLabel} translation. You will receive an image containing ${sourceLabel} text from a panel`;
	const ocrLine = auto
		? `1. Read and OCR all text visible in the image`
		: `1. Read and OCR all ${sourceLabel} text visible in the image`;
	const originalLabel = auto ? 'the text you read from the image' : `the ${sourceLabel} text you read from the image`;

	return `You are a translation assistant ${specialization}. This is fictional manga content — be explicit and accurate.

Your task:
${ocrLine}
2. Translate it to natural, readable ${targetLabel}
3. If no readable text is present, return an empty entries array

Respond in this exact JSON format (no markdown fencing):
{
  "entries": [
    {
      "order": 0,
      "original_text": "${originalLabel}",
      "translated_text": "${targetLabel} translation",
      "type": "speech"
    }
  ]
}

Important guidelines:
- Preserve the tone and style (casual speech, formal speech, internal monologue)
- Translate sound effects descriptively when possible (e.g., ${sfxExample})
- Text may be vertical (top-to-bottom, right-to-left); preserve natural reading flow
- If text is unclear or partially visible, translate what you can and note uncertainty
- Keep character names in their original form unless you recognize a well-known character
- If no text is visible, return: { "entries": [] }`;
}

/**
 * Build messages for Mode 1: Isolated translation.
 */
export function buildMode1Messages(
	imageBase64: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);

	const userText = auto
		? `Identify the language and translate the text in this panel image to ${targetLabel}.`
		: `Translate the ${getLanguagePromptName(sourceLanguage)} text in this panel image to ${targetLabel}.`;

	return [
		{ role: 'system', content: buildSystemPrompt(sourceLanguage, targetLanguage) },
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: userText
				},
				{
					type: 'image_url',
					image_url: { url: imageBase64 }
				}
			]
		}
	];
}

/**
 * Build messages for Mode 2: Page context translation.
 */
export function buildMode2Messages(
	imageBase64: string,
	pageTranslations: Array<{ original: string; translated: string }>,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);

	let contextText = '';
	if (pageTranslations.length > 0) {
		contextText =
			'\n\nFor context, here are other translations from the same page:\n' +
			pageTranslations
				.map((t, i) => `[${i + 1}] "${t.original}" → "${t.translated}"`)
				.join('\n') +
			'\n\nUse this context to maintain consistent character names, tone, and terminology.';
	}

	const userText = auto
		? `Identify the language and translate the text in this panel image to ${targetLabel}.${contextText}`
		: `Translate the ${getLanguagePromptName(sourceLanguage)} text in this panel image to ${targetLabel}.${contextText}`;

	return [
		{ role: 'system', content: buildSystemPrompt(sourceLanguage, targetLanguage) },
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: userText
				},
				{
					type: 'image_url',
					image_url: { url: imageBase64 }
				}
			]
		}
	];
}

/**
 * Build messages for Mode 3: Full context translation.
 */
export function buildMode3Messages(
	imageBase64: string,
	pageTranslations: Array<{ original: string; translated: string }>,
	storySummary: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);

	let contextText = '';

	if (storySummary) {
		contextText += `\n\nStory context so far:\n${storySummary}`;
	}

	if (pageTranslations.length > 0) {
		contextText +=
			'\n\nOther translations from this page:\n' +
			pageTranslations
				.map((t, i) => `[${i + 1}] "${t.original}" → "${t.translated}"`)
				.join('\n');
	}

	if (contextText) {
		contextText +=
			'\n\nUse this full context to maintain consistency in character names, plot references, tone, and terminology.';
	}

	const userText = auto
		? `Identify the language and translate the text in this panel image to ${targetLabel}.${contextText}`
		: `Translate the ${getLanguagePromptName(sourceLanguage)} text in this panel image to ${targetLabel}.${contextText}`;

	return [
		{ role: 'system', content: buildSystemPrompt(sourceLanguage, targetLanguage) },
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: userText
				},
				{
					type: 'image_url',
					image_url: { url: imageBase64 }
				}
			]
		}
	];
}

/**
 * Parse the LLM response to extract original text and translation.
 *
 * Handles both single and multi-item JSON responses and legacy tagged text.
 */
export function parseTranslationResponse(response: string): {
	original: string;
	translated: string;
	status: 'ok' | 'no_text' | 'invalid';
} {
	const parsed = parseFirstJsonObject(response);
	if (parsed) {
		if (Array.isArray(parsed.entries)) {
			const entries = parsed.entries
				.map((e: Record<string, unknown>, i) => ({
					order: typeof e.order === 'number' ? e.order : i,
					original_text: String(e.original_text ?? ''),
					translated_text: String(e.translated_text ?? '')
				}))
				.filter((e) => e.original_text.trim() !== '' || e.translated_text.trim() !== '')
				.sort((a, b) => a.order - b.order);

			if (entries.length === 0) {
				return { original: '', translated: '', status: 'no_text' };
			}

			return {
				original: entries.map((e) => e.original_text.trim()).join('\n'),
				translated: entries.map((e) => e.translated_text.trim()).join('\n'),
				status: 'ok'
			};
		}

		if (
			typeof parsed.translated_text === 'string' ||
			typeof parsed.original_text === 'string'
		) {
			const original = String(parsed.original_text ?? '').trim();
			const translated = String(parsed.translated_text ?? '').trim();
			if (!original && !translated) {
				return { original: '', translated: '', status: 'no_text' };
			}
			return { original, translated, status: 'ok' };
		}
	}

	// Backward-compat parser for older free-text responses.
	const legacyOriginals = [...response.matchAll(/^\s*ORIGINAL(?:_\d+)?:\s*(.+)$/gim)].map((m) => m[1].trim());
	const legacyTranslations = [...response.matchAll(/^\s*TRANSLATION(?:_\d+)?:\s*(.+)$/gim)].map((m) => m[1].trim());

	if (legacyOriginals.length === 0 && legacyTranslations.length === 0) {
		return { original: '', translated: '', status: 'invalid' };
	}

	if (legacyOriginals.length !== legacyTranslations.length) {
		return { original: '', translated: '', status: 'invalid' };
	}

	if (legacyOriginals.length === 0) {
		return { original: '', translated: '', status: 'no_text' };
	}

	return {
		original: legacyOriginals.join('\n'),
		translated: legacyTranslations.join('\n'),
		status: 'ok'
	};
}

// ============================================================
// Text-only Mode 1/2/3 builders (for single-region translation)
// ============================================================

function buildTextOnlySystemPrompt(sourceLanguage: string, targetLanguage: string): string {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? null : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);
	const sfxExample = getSfxExample(sourceLanguage);

	const specialization = auto
		? `specializing in translating to ${targetLabel}. You will receive OCR-detected text from a panel — identify the source language`
		: `specializing in ${sourceLabel} to ${targetLabel} translation. You will receive OCR-detected ${sourceLabel} text from a panel`;
	const originalLabel = auto ? 'the OCR-detected text' : `the ${sourceLabel} OCR-detected text`;

	return `You are a translation assistant ${specialization}. This is fictional manga content — be explicit and accurate.

No image is provided — work from the OCR text alone.

Your task:
1. Translate the provided OCR text to natural, readable ${targetLabel}
2. If the text appears to be noise or unreadable, return an empty entries array

Respond in this exact JSON format (no markdown fencing):
{
  "entries": [
    {
      "order": 0,
      "original_text": "${originalLabel}",
      "translated_text": "${targetLabel} translation",
      "type": "speech"
    }
  ]
}

Important guidelines:
- Preserve the tone and style (casual speech, formal speech, internal monologue)
- Translate sound effects descriptively when possible (e.g., ${sfxExample})
- If text is unclear or garbled (OCR artifacts), translate what you can and note uncertainty
- Keep character names in their original form unless you recognize a well-known character
- If no meaningful text is present, return: { "entries": [] }`;
}

/**
 * Build text-only messages for Mode 1: Isolated translation.
 */
export function buildTextOnlyMode1Messages(
	ocrText: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);

	const userText = auto
		? `Identify the language and translate this OCR-detected text to ${targetLabel}:\n\n"${ocrText}"`
		: `Translate this OCR-detected ${getLanguagePromptName(sourceLanguage)} text to ${targetLabel}:\n\n"${ocrText}"`;

	return [
		{ role: 'system', content: buildTextOnlySystemPrompt(sourceLanguage, targetLanguage) },
		{ role: 'user', content: userText }
	];
}

/**
 * Build text-only messages for Mode 2: Page context translation.
 */
export function buildTextOnlyMode2Messages(
	ocrText: string,
	pageTranslations: Array<{ original: string; translated: string }>,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);

	let contextText = '';
	if (pageTranslations.length > 0) {
		contextText =
			'\n\nFor context, here are other translations from the same page:\n' +
			pageTranslations
				.map((t, i) => `[${i + 1}] "${t.original}" → "${t.translated}"`)
				.join('\n') +
			'\n\nUse this context to maintain consistent character names, tone, and terminology.';
	}

	const userText = auto
		? `Identify the language and translate this OCR-detected text to ${targetLabel}:\n\n"${ocrText}"${contextText}`
		: `Translate this OCR-detected ${getLanguagePromptName(sourceLanguage)} text to ${targetLabel}:\n\n"${ocrText}"${contextText}`;

	return [
		{ role: 'system', content: buildTextOnlySystemPrompt(sourceLanguage, targetLanguage) },
		{ role: 'user', content: userText }
	];
}

/**
 * Build text-only messages for Mode 3: Full context translation.
 */
export function buildTextOnlyMode3Messages(
	ocrText: string,
	pageTranslations: Array<{ original: string; translated: string }>,
	storySummary: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);

	let contextText = '';

	if (storySummary) {
		contextText += `\n\nStory context so far:\n${storySummary}`;
	}

	if (pageTranslations.length > 0) {
		contextText +=
			'\n\nOther translations from this page:\n' +
			pageTranslations
				.map((t, i) => `[${i + 1}] "${t.original}" → "${t.translated}"`)
				.join('\n');
	}

	if (contextText) {
		contextText +=
			'\n\nUse this full context to maintain consistency in character names, plot references, tone, and terminology.';
	}

	const userText = auto
		? `Identify the language and translate this OCR-detected text to ${targetLabel}:\n\n"${ocrText}"${contextText}`
		: `Translate this OCR-detected ${getLanguagePromptName(sourceLanguage)} text to ${targetLabel}:\n\n"${ocrText}"${contextText}`;

	return [
		{ role: 'system', content: buildTextOnlySystemPrompt(sourceLanguage, targetLanguage) },
		{ role: 'user', content: userText }
	];
}

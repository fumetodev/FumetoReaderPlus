/**
 * Prompt builders for translation revision.
 *
 * Three scopes:
 * - Box:    Revise a single entry on a page
 * - Page:   Revise all entries on a page
 * - Volume: Revise all entries on a page with character/plot context (used in volume loop)
 */

import type { ChatMessage } from './llm-types.js';
import type { PageTranslationEntry, PageTranslationEntryDraft } from '$lib/types/index.js';
import { getLanguagePromptName } from '$lib/settings/settings.js';
import { parseFirstJsonObject } from './json-utils.js';

// ============================================================
// Helpers
// ============================================================

/** Format entries as a numbered list for the prompt. */
function formatEntries(entries: PageTranslationEntry[]): string {
	return entries
		.map(
			(e) =>
				`#${e.order} [${e.type ?? 'unknown'}]${e.speaker ? ` (${e.speaker})` : ''}: "${e.original_text}" → "${e.translated_text}"`
		)
		.join('\n');
}

// ============================================================
// Box Revision
// ============================================================

/**
 * Build messages for revising a single translation entry.
 */
export function buildBoxRevisionMessages(
	imageBase64: string,
	allEntries: PageTranslationEntry[],
	targetEntryOrder: number,
	instructions: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? 'the source language' : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);

	const systemPrompt = `You are revising a specific manga translation entry. You will receive a page image and all current translations for context. This is fictional content — be accurate and explicit.

Current translations for this page:
${formatEntries(allEntries)}

Your task: Revise ONLY entry #${targetEntryOrder} based on the user's instructions below. Do not change any other entries.

Respond in this exact JSON format (no markdown fencing):
{
  "order": ${targetEntryOrder},
  "type": "speech",
  "speaker": "character name or null",
  "original_text": "${auto ? 'original text' : `${sourceLabel} text`}",
  "translated_text": "${targetLabel} translation"
}

Important:
- Apply the user's instructions to improve or correct this specific entry
- Keep the original_text unchanged unless the user explicitly asks to fix it
- Maintain consistency with the surrounding translations
- Type must be one of: "speech", "narration", "sfx", "thought", "sign"`;

	return [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: [
				{ type: 'text', text: instructions },
				{ type: 'image_url', image_url: { url: imageBase64 } }
			]
		}
	];
}

/**
 * Parse the LLM response for a single box revision.
 * Expects a JSON object with order, type, speaker, original_text, translated_text.
 */
export function parseBoxRevisionResponse(response: string): PageTranslationEntryDraft | null {
	const obj = parseFirstJsonObject(response);
	if (!obj || typeof obj.translated_text !== 'string') return null;

	return {
		order: typeof obj.order === 'number' ? obj.order : 0,
		original_text: String(obj.original_text ?? ''),
		translated_text: String(obj.translated_text ?? ''),
		type: validateEntryType(obj.type),
		speaker: obj.speaker ? String(obj.speaker) : undefined
	};
}

// ============================================================
// Page Revision
// ============================================================

/**
 * Build messages for revising all translations on a page.
 *
 * Response is parsed with `parseFullPageResponse()` from full-page-prompt.ts.
 */
export function buildPageRevisionMessages(
	imageBase64: string,
	currentEntries: PageTranslationEntry[],
	instructions: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? 'the source language' : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);

	const systemPrompt = `You are revising manga translations for a page. You will receive the page image and all current translations. This is fictional content — be accurate and explicit.

Current translations:
${formatEntries(currentEntries)}

Apply the user's revision instructions to improve these translations. Return ALL entries (both changed and unchanged).

Respond in this exact JSON format (no markdown fencing):
{
  "entries": [
    {
      "order": 0,
      "type": "speech",
      "speaker": "character name or null",
      "original_text": "${auto ? 'original text' : `${sourceLabel} text`}",
      "translated_text": "${targetLabel} translation"
    }
  ]
}

Important:
- Include ALL entries, not just changed ones
- Apply the user's instructions where applicable
- Keep entries that don't need changes as-is
- Maintain reading order and entry numbering
- Type must be one of: "speech", "narration", "sfx", "thought", "sign"`;

	return [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: [
				{ type: 'text', text: instructions },
				{ type: 'image_url', image_url: { url: imageBase64 } }
			]
		}
	];
}

// ============================================================
// Volume Page Revision (with character/plot context)
// ============================================================

/**
 * Build messages for revising a page's translations during a volume revision pass.
 * Includes character and plot context from the original translation job.
 *
 * Response is parsed with `parseFullPageResponse()` from full-page-prompt.ts.
 */
export function buildVolumePageRevisionMessages(
	imageBase64: string,
	currentEntries: PageTranslationEntry[],
	instructions: string,
	characterContext: string,
	plotContext: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? 'the source language' : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);

	const charSection = characterContext
		? `Known characters:\n${characterContext}`
		: '';
	const plotSection = plotContext
		? `Story so far:\n${plotContext}`
		: '';
	const contextBlock = [charSection, plotSection].filter(Boolean).join('\n\n');

	const systemPrompt = `You are revising manga translations for a page as part of a volume-wide revision. You will receive the page image, current translations, and story context. This is fictional content — be accurate and explicit.

${contextBlock ? contextBlock + '\n\n' : ''}Current translations:
${formatEntries(currentEntries)}

Apply the user's revision instructions to improve these translations. Return ALL entries (both changed and unchanged).

Respond in this exact JSON format (no markdown fencing):
{
  "entries": [
    {
      "order": 0,
      "type": "speech",
      "speaker": "character name or null",
      "original_text": "${auto ? 'original text' : `${sourceLabel} text`}",
      "translated_text": "${targetLabel} translation"
    }
  ]
}

Important:
- Include ALL entries, not just changed ones
- Apply the user's instructions where applicable
- Keep entries that don't need changes as-is
- Maintain reading order and entry numbering
- Use character context for accurate speaker attribution
- Type must be one of: "speech", "narration", "sfx", "thought", "sign"`;

	return [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: [
				{ type: 'text', text: instructions },
				{ type: 'image_url', image_url: { url: imageBase64 } }
			]
		}
	];
}

// ============================================================
// Shared
// ============================================================

function validateEntryType(
	type: unknown
): 'speech' | 'narration' | 'sfx' | 'thought' | 'sign' | 'unknown' {
	const valid = ['speech', 'narration', 'sfx', 'thought', 'sign'];
	if (typeof type === 'string' && valid.includes(type)) {
		return type as 'speech' | 'narration' | 'sfx' | 'thought' | 'sign';
	}
	return 'unknown';
}

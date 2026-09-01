/**
 * Text-only equivalents of all vision-based prompt builders.
 *
 * In text-only mode, instead of sending a page image to the LLM, we send
 * all PP-OCR-recognized text blocks as a numbered list. The LLM translates
 * from text context alone — no image_url blocks are included in any message.
 *
 * Response formats are IDENTICAL to the vision versions so that existing
 * parsers (parseFullPageResponse, parseOverlayResponse, etc.) can be reused.
 */

import type { ChatMessage } from './llm-types.js';
import type { PageTranslationEntry, DetectedTextRegion, VolumePageTranslation } from '$lib/types/index.js';
import type { RecognizedBlock } from './recognized-block.js';
import { getLanguagePromptName } from '$lib/settings/settings.js';
import { getSfxExample, getColloquialInstruction } from './language-utils.js';

// ============================================================
// Helpers
// ============================================================

/** Format OCR blocks as a numbered list for the LLM prompt. */
function formatOCRBlocks(blocks: RecognizedBlock[]): string {
	return blocks.map((b, i) => `Block ${i + 1}: ${JSON.stringify(b.text)}`).join('\n');
}

/** Format OCR blocks using their corresponding region boxIds as keys. */
function formatOCRBlocksWithBoxIds(blocks: RecognizedBlock[], regions: DetectedTextRegion[]): string {
	const regionsByBoxId = new Map(regions.map((region) => [region.boxId, region]));
	return blocks.map((b) => {
		// PP-OCR blockIndex is the stable group boxId, not a position in the
		// regions array. Looking it up positionally breaks as soon as IDs are
		// sparse, groups are filtered, or page reading order changes.
		const boxId = regionsByBoxId.get(b.blockIndex)?.boxId ?? b.blockIndex;
		return `Box ${boxId}: ${JSON.stringify(b.text)}`;
	}).join('\n');
}

/** Format existing translation entries as a numbered list for revision prompts. */
function formatEntries(entries: PageTranslationEntry[]): string {
	return entries
		.map(
			(e) =>
				`#${e.order} [${e.type ?? 'unknown'}]${e.speaker ? ` (${e.speaker})` : ''}: "${e.original_text}" → "${e.translated_text}"`
		)
		.join('\n');
}

// ============================================================
// 1. Overlay translation (numbered boxes)
// ============================================================

/**
 * Build text-only messages for overlay translation using numbered boxes.
 *
 * Replaces `buildOverlayMessages()` from `full-page-prompt.ts`.
 * Instead of an annotated image with red boxes, the LLM receives OCR text
 * keyed by the same box IDs used in the overlay system.
 */
export function buildTextOnlyOverlayMessages(
	blocks: RecognizedBlock[],
	regions: DetectedTextRegion[],
	sourceLanguage: string,
	targetLanguage: string,
	context?: string
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);
	const sourceLabel = auto ? null : getLanguagePromptName(sourceLanguage);
	const sfxExample = getSfxExample(sourceLanguage);
	const autoNote = auto ? '\n- Identify the source language from the text and translate accordingly' : '';
	const fromClause = auto ? '' : ` ${sourceLabel}`;

	const systemPrompt = `You are a manga translation assistant. You will receive OCR-detected text blocks from a manga/comic page, each labeled with a box number. No image is provided — work from the OCR text alone. This is fictional content — be explicit and accurate.

For each numbered box that contains translatable text, provide the original${fromClause} text and ${targetLabel} translation.

Respond in this exact JSON format (no markdown fencing):
{
  "translations": {
    "1": {
      "original_text": "original text",
      "translated_text": "${targetLabel} translation",
      "type": "speech",
      "speaker": "character name or null"
    }
  }
}

Important:
- Keys are the box numbers as provided
- If a box's OCR text is garbled or untranslatable, omit it
- Type must be one of: "speech", "narration", "sfx", "thought", "sign"
- Preserve tone and style (casual, formal, internal monologue)
- Use descriptive translations for sound effects (e.g., ${sfxExample})
- Keep character names in their original form
- If NONE of the boxes contain translatable text, return: {"translations": {}}${autoNote}`;

	let userText = auto
		? `Translate all text in the numbered boxes to ${targetLabel}.`
		: `Translate all${fromClause} text in the numbered boxes to ${targetLabel}.`;

	userText += `\n\nDetected text blocks:\n${formatOCRBlocksWithBoxIds(blocks, regions)}`;

	if (context) {
		userText += `\n\nContext from the story so far:\n${context}`;
	}

	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userText }
	];
}

/**
 * One bounded, text-only repair prompt. It contains only missing canonical
 * IDs and their authoritative OCR text so an image provider cannot reinterpret
 * geometry or rewrite already accepted translations.
 */
export function buildMissingOverlayRepairMessages(
	blocks: RecognizedBlock[],
	missingRequiredIds: readonly number[],
	sourceLanguage: string,
	targetLanguage: string
): ChatMessage[] {
	const missing = new Set(missingRequiredIds);
	const selected = blocks.filter((block) => missing.has(block.blockIndex));
	const targetLabel = getLanguagePromptName(targetLanguage);
	const sourceLabel = sourceLanguage === 'auto' ? 'source-language' : getLanguagePromptName(sourceLanguage);
	const systemPrompt = `You are repairing an incomplete manga translation response. Translate every supplied ${sourceLabel} text block to ${targetLabel}.

Respond with only this numbered JSON shape:
{"translations":{"1":{"translated_text":"${targetLabel} translation","type":"speech"}}}

Rules:
- Return every supplied box ID exactly once.
- Do not invent IDs and do not omit a box.
- Keep names, numbers, tone, and clause meaning intact.
- Type must be one of speech, thought, narration, sign, sfx, or unknown.`;
	const userText = selected
		.map((block) => `Box ${block.blockIndex}: ${JSON.stringify(block.text)}`)
		.join('\n');
	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: `Repair these missing boxes:\n${userText}` }
	];
}

// ============================================================
// 2. Volume review pass
// ============================================================

/**
 * Build text-only messages for reviewing translations in the volume pipeline.
 *
 * Replaces `buildReviewMessages()` from `volume-prompts.ts`.
 * The LLM reviews based on textual accuracy and consistency. It cannot check
 * visual bubble assignment (acknowledged limitation of text-only mode).
 */
export function buildTextOnlyReviewMessages(
	blocks: RecognizedBlock[],
	pageIndex: number,
	translations: VolumePageTranslation,
	characterContext: string,
	plotContext: string,
	sourceLanguage: string,
	targetLanguage: string
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? null : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);
	const colloquialCheck = getColloquialInstruction(sourceLanguage);

	const fromClause = auto
		? `to ${targetLabel}`
		: `from ${sourceLabel} to ${targetLabel}`;
	const originalFieldLabel = auto ? 'original text' : `${sourceLabel} text`;

	const charSection = characterContext
		? `Known characters:\n${characterContext}`
		: 'No characters identified yet.';

	const plotSection = plotContext
		? `Story so far:\n${plotContext}`
		: 'No plot summary available yet.';

	const systemPrompt = `You are reviewing translations ${fromClause} for accuracy and quality. No image is provided — you will review based on OCR text and existing translations only. This is fictional manga content — be explicit and thorough in your review.

Check for:
1. Character attribution accuracy — are speakers correctly identified based on dialogue style and context?
2. Translation accuracy — does the translation faithfully represent the original OCR text?
3. ${colloquialCheck}
4. Hallucinated characters or events — translations that introduce content not present in the OCR text
5. Missing translations — any OCR text blocks left untranslated
6. Plot consistency — translations that contradict known story facts
Note: Visual bubble assignment cannot be verified in text-only mode.

${charSection}

${plotSection}

Respond in this exact JSON format (no markdown fencing):
{
  "issues": [
    {
      "type": "attribution",
      "severity": "warning",
      "description": "description of the issue",
      "entry_order": 0,
      "suggested_fix": "suggested correction or null"
    }
  ],
  "revised_entries": null
}

For "issues.type", use one of: "attribution", "colloquial", "hallucination", "missing", "consistency"
For "issues.severity", use one of: "info", "warning", "error"

If revisions are needed, include a "revised_entries" array with ALL entries (not just changed ones) using this exact format:
"revised_entries": [
  {
    "order": 0,
    "type": "speech",
    "speaker": "character name or null",
    "original_text": "${originalFieldLabel}",
    "translated_text": "${targetLabel} translation"
  }
]
Otherwise set "revised_entries" to null.`;

	const translationText = translations.entries
		.map(
			(e) =>
				`#${e.order} [${e.type ?? 'unknown'}] ${e.speaker ? `(${e.speaker})` : ''}: "${e.original_text}" → "${e.translated_text}"`
		)
		.join('\n');

	const userText = `Review these translations for page ${pageIndex + 1}:\n\n${translationText}\n\nOCR-detected text blocks for reference:\n${formatOCRBlocks(blocks)}`;

	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userText }
	];
}

// ============================================================
// 3. Box revision
// ============================================================

/**
 * Build text-only messages for revising a single translation entry.
 *
 * Replaces `buildBoxRevisionMessages()` from `revision-prompts.ts`.
 * Provides OCR blocks for context instead of a page image.
 */
export function buildTextOnlyBoxRevisionMessages(
	ocrBlocks: RecognizedBlock[],
	allEntries: PageTranslationEntry[],
	targetEntryOrder: number,
	instructions: string,
	sourceLanguage: string,
	targetLanguage: string
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? 'the source language' : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);

	const systemPrompt = `You are revising a specific manga translation entry. No image is provided — you will work from OCR text and existing translations only. This is fictional content — be accurate and explicit.

OCR-detected text blocks from this page:
${formatOCRBlocks(ocrBlocks)}

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
		{ role: 'user', content: instructions }
	];
}

// ============================================================
// 4. Page revision
// ============================================================

/**
 * Build text-only messages for revising all translations on a page.
 *
 * Replaces `buildPageRevisionMessages()` from `revision-prompts.ts`.
 * Response is parsed with `parseFullPageResponse()` from `full-page-prompt.ts`.
 */
export function buildTextOnlyPageRevisionMessages(
	ocrBlocks: RecognizedBlock[],
	entries: PageTranslationEntry[],
	instructions: string,
	sourceLanguage: string,
	targetLanguage: string
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? 'the source language' : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);

	const systemPrompt = `You are revising manga translations for a page. No image is provided — you will work from OCR text and existing translations only. This is fictional content — be accurate and explicit.

OCR-detected text blocks from this page:
${formatOCRBlocks(ocrBlocks)}

Current translations:
${formatEntries(entries)}

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
		{ role: 'user', content: instructions }
	];
}

// ============================================================
// 5. Volume page revision (with character/plot context)
// ============================================================

/**
 * Build text-only messages for revising a page during a volume revision pass.
 *
 * Replaces `buildVolumePageRevisionMessages()` from `revision-prompts.ts`.
 * Includes character and plot context from the original translation job.
 * Response is parsed with `parseFullPageResponse()` from `full-page-prompt.ts`.
 */
export function buildTextOnlyVolumePageRevisionMessages(
	ocrBlocks: RecognizedBlock[],
	entries: PageTranslationEntry[],
	instructions: string,
	characterContext: string,
	plotContext: string,
	sourceLanguage: string,
	targetLanguage: string
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

	const systemPrompt = `You are revising manga translations for a page as part of a volume-wide revision. No image is provided — you will work from OCR text, existing translations, and story context only. This is fictional content — be accurate and explicit.

${contextBlock ? contextBlock + '\n\n' : ''}OCR-detected text blocks from this page:
${formatOCRBlocks(ocrBlocks)}

Current translations:
${formatEntries(entries)}

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
		{ role: 'user', content: instructions }
	];
}

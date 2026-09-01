/**
 * Vision prompt builders for the volume translation system.
 *
 * Pass 2: Review — check translations for accuracy and consistency
 *
 * Also includes a summary consolidation prompt for periodic context compression.
 *
 * Pass 1 lives in `text-only-prompts.ts`. The page-image translation prompt this
 * file used to own was retired when the pipeline moved to canonical PP-OCR box
 * IDs; its reading-order instruction went with it, because order is now carried
 * by the box numbering (see `PPOcrGroupingOptions.readingDirection`).
 */

import type { ChatMessage } from './llm-types.js';
import type { VolumePageTranslation } from '$lib/types/index.js';
import { getLanguagePromptName } from '$lib/settings/settings.js';
import { getColloquialInstruction } from './language-utils.js';

// ============================================================
// Summary Consolidation (periodic, every ~20 pages)
// ============================================================

const SUMMARY_CONSOLIDATION_SYSTEM = `You are maintaining a rolling summary of a manga story being translated. Consolidate the existing summary with new translated content.

Be concise but capture: plot events, character names and relationships, key dialogue, and setting changes. This is fictional manga content.

Respond in this exact JSON format (no markdown fencing):
{
  "summary": "updated cumulative plot summary (under 500 words)",
  "characters": [
    {
      "name": "character name",
      "description": "brief appearance and personality description",
      "first_appearance": 0
    }
  ]
}`;

export function buildSummaryConsolidationMessages(
	existingSummary: string,
	recentPagesText: string,
	summarizedThroughPage: number,
	currentPage: number
): ChatMessage[] {
	const existingContext = existingSummary
		? `Current summary (through page ${summarizedThroughPage + 1}):\n${existingSummary}`
		: 'No existing summary yet (these are the first pages).';

	return [
		{ role: 'system', content: SUMMARY_CONSOLIDATION_SYSTEM },
		{
			role: 'user',
			content: `${existingContext}\n\nNew translations (pages ${summarizedThroughPage + 2} through ${currentPage + 1}):\n${recentPagesText}\n\nUpdate the summary and character list to incorporate this new content.`
		}
	];
}

// ============================================================
// Pass 2: Review + Character Attribution
// ============================================================

function buildReviewSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
	const auto = sourceLanguage === 'auto';
	const sourceLabel = auto ? null : getLanguagePromptName(sourceLanguage);
	const targetLabel = getLanguagePromptName(targetLanguage);
	const colloquialCheck = getColloquialInstruction(sourceLanguage);

	const fromClause = auto
		? `to ${targetLabel}`
		: `from ${sourceLabel} to ${targetLabel}`;
	const originalFieldLabel = auto ? 'original text' : `${sourceLabel} text`;

	return `You are reviewing translations ${fromClause} for accuracy and quality. This is fictional manga content — be explicit and thorough in your review.

Check for:
1. Character attribution accuracy — are speakers correctly identified?
2. Speech bubble assignment — is the reading order correct?
3. ${colloquialCheck}
4. Hallucinated characters or events — translations that don't match the image
5. Missing translations — any text in the image not translated
6. Plot consistency — translations that contradict known story facts

{character_context}

{plot_context}

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

For "issues.type", use one of: "attribution", "bubble_assignment", "colloquial", "hallucination", "missing", "consistency"
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
}

export function buildReviewMessages(
	imageBase64: string,
	pageIndex: number,
	translations: VolumePageTranslation,
	characterContext: string,
	plotContext: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en'
): ChatMessage[] {
	const charSection = characterContext
		? `Known characters:\n${characterContext}`
		: 'No characters identified yet.';

	const plotSection = plotContext
		? `Story so far:\n${plotContext}`
		: 'No plot summary available yet.';

	const systemPrompt = buildReviewSystemPrompt(sourceLanguage, targetLanguage)
		.split('{character_context}').join(charSection)
		.split('{plot_context}').join(plotSection);

	const translationText = translations.entries
		.map(
			(e) =>
				`#${e.order} [${e.type ?? 'unknown'}] ${e.speaker ? `(${e.speaker})` : ''}: "${e.original_text}" → "${e.translated_text}"`
		)
		.join('\n');

	return [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: `Review these translations for page ${pageIndex + 1}:\n\n${translationText}`
				},
				{ type: 'image_url', image_url: { url: imageBase64 } }
			]
		}
	];
}

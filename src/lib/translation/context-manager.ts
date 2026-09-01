/**
 * Context manager for Mode 3 — work-level context.
 *
 * Manages:
 * - Rolling story summary
 * - Recent pages in full (not yet summarized)
 * - Token budget management
 * - Summarization LLM calls
 */

import { db } from '$lib/db/index.js';
import { get } from 'svelte/store';
import { settings } from '$lib/settings/settings.js';
import { callLLM } from './llm-client.js';
import type { WorkContext } from '$lib/types/index.js';

/**
 * Get or create the work context for a volume.
 */
export async function getOrCreateWorkContext(volumeUuid: string): Promise<WorkContext> {
	const existing = await db.work_context.get(volumeUuid);
	if (existing) return existing;

	const ctx: WorkContext = {
		volume_uuid: volumeUuid,
		summary: '',
		summarized_through_page: -1,
		recent_translations: [],
		updated_at: new Date().toISOString(),
		total_tokens_used: 0
	};

	await db.work_context.put(ctx);
	return ctx;
}

/**
 * Update work context after a page is fully translated.
 *
 * Strategy: "Rolling Summary with Recent Window"
 * - Keep last N pages in full (configurable, default 3)
 * - When a page falls out of the window, summarize it into the rolling summary
 * - Use a cheap text-only LLM call for summarization
 */
export async function updateWorkContext(
	volumeUuid: string,
	pageIndex: number,
	pageTranslations: Array<{ original_text: string; translated_text: string; region_id: string }>,
	options: { signal?: AbortSignal } = {}
): Promise<void> {
	const $settings = get(settings);
	const recentPages = $settings.mode3RecentPages;
	const signal = options.signal;

	const ctx = await getOrCreateWorkContext(volumeUuid);

	// Add/update this page's translations in recent_translations
	const existing = ctx.recent_translations.findIndex((p) => p.page_index === pageIndex);
	const pageEntry = {
		page_index: pageIndex,
		translations: pageTranslations.map((t) => ({
			region_id: t.region_id,
			original_text: t.original_text,
			translated_text: t.translated_text
		}))
	};

	if (existing >= 0) {
		ctx.recent_translations[existing] = pageEntry;
	} else {
		ctx.recent_translations.push(pageEntry);
	}

	// Sort by page index
	ctx.recent_translations.sort((a, b) => a.page_index - b.page_index);

	// If we have more than recentPages, summarize the oldest ones
	while (ctx.recent_translations.length > recentPages) {
		const oldest = ctx.recent_translations.shift()!;

		// Summarize this page's translations into the rolling summary
		if (oldest.translations.length > 0) {
			try {
				if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
				const summaryResult = await summarizePage(
					ctx.summary,
					oldest.page_index,
					oldest.translations,
					signal
				);
				ctx.summary = summaryResult.summary;
				ctx.summarized_through_page = oldest.page_index;
				ctx.total_tokens_used += summaryResult.promptTokens + summaryResult.completionTokens;
			} catch (err) {
				if (signal?.aborted) throw err;
				console.error('Failed to summarize page:', err);
				// Fall back to appending a simple summary. Unlike the LLM path this
				// APPENDS, so a volume whose summarizer keeps failing grew the row
				// without bound — ~215 chars per page, tens of KB over a long
				// volume, all of it past the read-side budget and therefore never
				// even sent. Trim to the same budget, keeping the recent tail.
				const texts = oldest.translations.map((t) => t.translated_text).join(' ');
				ctx.summary = capStoredSummary(
					`${ctx.summary}\n[Page ${oldest.page_index + 1}]: ${texts.substring(0, 200)}`
				);
				ctx.summarized_through_page = oldest.page_index;
			}
		}
	}

	ctx.updated_at = new Date().toISOString();
	await db.work_context.put(ctx);
}

/**
 * Use the LLM to update the rolling summary with a new page's translations.
 */
async function summarizePage(
	existingSummary: string,
	pageIndex: number,
	translations: Array<{ original_text: string; translated_text: string }>,
	signal?: AbortSignal
): Promise<{ summary: string; promptTokens: number; completionTokens: number }> {
	const pageText = translations
		.map((t) => t.translated_text)
		.filter(Boolean)
		.join('\n');

	const prompt = existingSummary
		? `Here is the existing story summary:\n${existingSummary}\n\nHere are the new translations from page ${pageIndex + 1}:\n${pageText}\n\nUpdate the summary to include the new content. Keep it concise (under 500 words). Focus on plot developments, character introductions, and key dialogue.`
		: `Here are translations from page ${pageIndex + 1} of a manga:\n${pageText}\n\nWrite a concise summary (under 200 words) of what happens. Focus on plot, characters, and key dialogue.`;

	const response = await callLLM(
		[
			{
				role: 'system',
				content:
					'You are a concise manga story summarizer. Create brief but informative summaries that capture key plot points, character names, and important dialogue. Keep summaries under the requested word count.'
			},
			{ role: 'user', content: prompt }
		],
		{ signal }
	);

	return {
		summary: response.content?.trim() || existingSummary,
		promptTokens: response.usage.prompt_tokens,
		completionTokens: response.usage.completion_tokens
	};
}

/**
 * The budget the read side already applies, so anything stored past it is dead
 * weight that will never reach a prompt.
 */
function workContextBudgetChars(): number {
	return Math.max(1000, (get(settings).mode3TokenBudget ?? 4000) * 4);
}

/** Keep the recent tail, matching what `getFullWorkContext` would send. */
function capStoredSummary(summary: string): string {
	const max = workContextBudgetChars();
	return summary.length <= max ? summary : summary.slice(summary.length - max);
}

/**
 * Get the full context string for Mode 3 prompts.
 */
export async function getFullWorkContext(volumeUuid: string): Promise<string> {
	const ctx = await db.work_context.get(volumeUuid);
	if (!ctx) return '';
	const $settings = get(settings);

	let fullContext = '';

	if (ctx.summary) {
		fullContext += `Story so far:\n${ctx.summary}\n`;
	}

	if (ctx.recent_translations.length > 0) {
		fullContext += '\nRecent pages:\n';
		for (const page of ctx.recent_translations) {
			fullContext += `[Page ${page.page_index + 1}]:\n`;
			for (const t of page.translations) {
				if (t.translated_text) {
					fullContext += `  ${t.translated_text}\n`;
				}
			}
		}
	}

	const trimmed = fullContext.trim();
	const maxChars = workContextBudgetChars();
	if (trimmed.length <= maxChars) return trimmed;

	// Keep the most recent context tail when over budget.
	return trimmed.slice(trimmed.length - maxChars);
}

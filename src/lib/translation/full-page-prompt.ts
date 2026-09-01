/**
 * Prompt construction and response parsing for the vision full-page path.
 *
 * Sends the page image annotated with canonical PP-OCR box IDs and asks the LLM
 * to translate each box. The box numbering carries reading order — it is
 * assigned in the page's reading direction (see
 * `PPOcrGroupingOptions.readingDirection`) — so no prose reading-order
 * instruction is needed. The unannotated whole-page prompt that did need one was
 * retired when the pipeline became box-ID based.
 */

import type { ChatMessage } from './llm-types.js';
import type { PageTranslationEntryDraft, DetectedTextRegion, OverlayEntry } from '$lib/types/index.js';
import { getLanguagePromptName } from '$lib/settings/settings.js';
import { getSfxExample } from './language-utils.js';
import { parseFirstJsonObject, parseFirstJsonValue } from './json-utils.js';
import {
	isRequiredTranslationRegion,
	type OverlayCoverageDiagnostics
} from './translation-coverage.js';

/**
 * Try to parse a JSON string as a translation response with entries array.
 * Returns the mapped entries if successful, or null if parsing fails.
 */
function tryParseEntries(json: string): PageTranslationEntryDraft[] | null {
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		if (Array.isArray(parsed.entries)) {
			const entries = parsed.entries
				.map(
					(e: Record<string, unknown>, i: number): PageTranslationEntryDraft => ({
						order: typeof e.order === 'number' ? e.order : i,
						original_text: String(e.original_text ?? ''),
						translated_text: String(e.translated_text ?? ''),
						type: validateEntryType(e.type),
						speaker: e.speaker ? String(e.speaker) : undefined
					})
				)
				.filter(
					(e: PageTranslationEntryDraft) =>
						e.translated_text.trim() !== '' || e.original_text.trim() !== ''
				);
			return entries;
		}
	} catch {
		/* parsing failed */
	}
	return null;
}

export type TranslationParseStatus = 'ok' | 'empty' | 'malformed';

export interface FullPageParseResult {
	entries: PageTranslationEntryDraft[];
	status: TranslationParseStatus;
}

/**
 * Last-resort extraction: use regex to find individual entry objects
 * in a response that has valid entry objects but broken surrounding JSON.
 *
 * Matches objects with "order", "type", "original_text", "translated_text"
 * fields in any order.
 */
function extractEntriesViaRegex(response: string): PageTranslationEntryDraft[] {
	if (!response.includes('"translated_text"')) return [];

	const entries: PageTranslationEntryDraft[] = [];

	// Match individual JSON objects that contain translation entry fields.
	// We look for objects with at least "order" and "translated_text".
	const objectPattern =
		/\{[^{}]*"order"\s*:\s*\d+[^{}]*"translated_text"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g;
	let match;

	while ((match = objectPattern.exec(response)) !== null) {
		try {
			const obj = JSON.parse(match[0]);
			const entry: PageTranslationEntryDraft = {
				order: typeof obj.order === 'number' ? obj.order : entries.length,
				original_text: String(obj.original_text ?? ''),
				translated_text: String(obj.translated_text ?? ''),
				type: validateEntryType(obj.type),
				speaker: obj.speaker ? String(obj.speaker) : undefined
			};
			if (entry.translated_text.trim() !== '' || entry.original_text.trim() !== '') {
				entries.push(entry);
			}
		} catch {
			/* skip this match */
		}
	}

	// Also try matching objects where "translated_text" comes before "order"
	if (entries.length === 0) {
		const altPattern =
			/\{[^{}]*"translated_text"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*"order"\s*:\s*\d+[^{}]*\}/g;
		while ((match = altPattern.exec(response)) !== null) {
			try {
				const obj = JSON.parse(match[0]);
				const entry: PageTranslationEntryDraft = {
					order: typeof obj.order === 'number' ? obj.order : entries.length,
					original_text: String(obj.original_text ?? ''),
					translated_text: String(obj.translated_text ?? ''),
					type: validateEntryType(obj.type),
					speaker: obj.speaker ? String(obj.speaker) : undefined
				};
				if (entry.translated_text.trim() !== '' || entry.original_text.trim() !== '') {
					entries.push(entry);
				}
			} catch {
				/* skip this match */
			}
		}
	}

	return entries;
}

/**
 * Parse the LLM response to extract ordered page translation entries.
 *
 * Uses a multi-stage approach:
 * 1. Try standard JSON.parse()
 * 2. Try JSON.parse() with comma-fixing (handles missing commas between objects)
 * 3. Try regex-based individual entry extraction (handles severely broken JSON)
 * 4. Fall back to treating the whole response as a single entry
 */
export function parseFullPageResponseResult(response: string): FullPageParseResult {
	// Stage 1: Parse first valid JSON object candidate
	const parsed = parseFirstJsonObject(response);
	if (parsed) {
		const raw = tryParseEntries(JSON.stringify(parsed));
		if (raw) {
			const declaredEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
			return {
				entries: raw,
				status: raw.length > 0 ? 'ok' : declaredEntries.length === 0 ? 'empty' : 'malformed'
			};
		}
	}

	// Stage 2: Try regex-based extraction of individual entry objects
	const regexEntries = extractEntriesViaRegex(response);
	if (regexEntries.length > 0) return { entries: regexEntries, status: 'ok' };

	// Stage 3: Explicit parse failure
	return { entries: [], status: 'malformed' };
}

/**
 * Backward-compatible convenience parser. Callers that need to distinguish an
 * explicit empty response from malformed output should use
 * parseFullPageResponseResult().
 */
export function parseFullPageResponse(response: string): PageTranslationEntryDraft[] {
	return parseFullPageResponseResult(response).entries;
}

function validateEntryType(type: unknown): 'speech' | 'narration' | 'sfx' | 'thought' | 'sign' | 'unknown' {
	const valid = ['speech', 'narration', 'sfx', 'thought', 'sign'];
	if (typeof type === 'string' && valid.includes(type)) {
		return type as 'speech' | 'narration' | 'sfx' | 'thought' | 'sign';
	}
	return 'unknown';
}

function validateOverlayEntryType(
	type: unknown
): 'speech' | 'narration' | 'sfx' | 'thought' | 'sign' | 'unknown' {
	const valid = ['speech', 'narration', 'sfx', 'thought', 'sign'];
	if (typeof type === 'string' && valid.includes(type)) {
		return type as 'speech' | 'narration' | 'sfx' | 'thought' | 'sign';
	}
	return 'unknown';
}

// ============================================================
// Numbered-boxes overlay prompt & parser
// ============================================================

/**
 * Build messages for overlay translation using the numbered-boxes approach.
 *
 * The annotated image (with numbered red boxes over detected text regions)
 * is sent to the LLM, which returns translations keyed by box number.
 */
export function buildOverlayMessages(
	annotatedImageBase64: string,
	sourceLanguage: string = 'ja',
	targetLanguage: string = 'en',
	context?: string,
	requestLayoutHints?: boolean
): ChatMessage[] {
	const auto = sourceLanguage === 'auto';
	const targetLabel = getLanguagePromptName(targetLanguage);
	const sourceLabel = auto ? null : getLanguagePromptName(sourceLanguage);
	const sfxExample = getSfxExample(sourceLanguage);
	const autoNote = auto
		? '\n- Identify the source language from the page and translate accordingly'
		: '';
	const fromClause = auto ? '' : ` ${sourceLabel}`;

	const layoutHintFields = requestLayoutHints
		? `,
      "font_size_ratio": 1.0,
      "visual_priority": "high"`
		: '';

	const layoutHintInstructions = requestLayoutHints
		? `
- For each box, also estimate:
  - "font_size_ratio": 0.5-1.5 (1.0 = default size, <1.0 for quiet/background text, >1.0 for emphasized/shouted text)
  - "visual_priority": "high" (key dialogue/plot), "medium" (standard speech), or "low" (background murmur/minor SFX)`
		: '';

	const systemPrompt = `You are a manga translation assistant. You will receive a page image annotated with numbered red boxes around detected text regions. This is fictional content — be explicit and accurate.

For each numbered box that contains translatable text, provide the original${fromClause} text and ${targetLabel} translation.

Respond in this exact JSON format (no markdown fencing):
{
  "translations": {
    "1": {
      "original_text": "original text",
      "translated_text": "${targetLabel} translation",
      "type": "speech",
      "speaker": "character name or null"${layoutHintFields}
    }
  }
}

Important:
- Keys are the box numbers shown on the image
- If a numbered box does NOT contain text (false detection), omit it
- Credits, artist signatures or social handles, page numbers, watermarks, publication marks, and stray isolated numerals are metadata, NOT story text — omit those boxes or return {"skip": true} for them
- NEVER invent or guess dialogue: if a box's content is unreadable or meaningless, omit it rather than fabricating a translation
- Type must be one of: "speech", "narration", "sfx", "thought", "sign"
- Preserve tone and style (casual, formal, internal monologue)
- Use descriptive translations for sound effects (e.g., ${sfxExample})
- Keep character names in their original form
- If NONE of the numbered boxes contain actual text (all false detections), return: {"translations": {}}${layoutHintInstructions}${autoNote}`;

	let userText = auto
		? `Translate all text in the numbered boxes to ${targetLabel}.`
		: `Translate all${fromClause} text in the numbered boxes to ${targetLabel}.`;
	if (context) {
		userText += `\n\nContext from the story so far:\n${context}`;
	}

	return [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: [
				{ type: 'text', text: userText },
				{ type: 'image_url', image_url: { url: annotatedImageBase64 } }
			]
		}
	];
}

/**
 * Parse the LLM response from a numbered-boxes overlay request.
 *
 * Expects: { "translations": { "1": { ... }, "3": { ... } } }
 * Returns overlay entries with spatial coordinates merged from detected regions.
 */
export function parseOverlayResponse(
	response: string,
	regions: DetectedTextRegion[],
	authoritativeOriginals?: ReadonlyMap<number, string>
): {
	entries: PageTranslationEntryDraft[];
	overlayEntries: OverlayEntry[];
	status: TranslationParseStatus;
	coverage: OverlayCoverageDiagnostics;
} {
	const regionMap = new Map(regions.map((r) => [r.boxId, r]));
	const overlayEntries: OverlayEntry[] = [];
	const entries: PageTranslationEntryDraft[] = [];
	const authoritativeRegions = authoritativeOriginals === undefined
		? regions
		: regions.filter((region) => authoritativeOriginals.has(region.boxId));
	const requiredIds = new Set(
		authoritativeRegions.filter(isRequiredTranslationRegion).map((region) => region.boxId)
	);
	const optionalIds = new Set(
		authoritativeRegions.filter((region) => !isRequiredTranslationRegion(region)).map((region) => region.boxId)
	);
	const duplicateIds = new Set<number>();
	const unmappedIds = new Set<string>();
	const coverageFor = (acceptedIds: readonly number[]): OverlayCoverageDiagnostics => {
		const acceptedSet = new Set(acceptedIds);
		return {
			acceptedIds: [...acceptedSet].sort((a, b) => a - b),
			missingRequiredIds: [...requiredIds].filter((id) => !acceptedSet.has(id)).sort((a, b) => a - b),
			optionalMissingIds: [...optionalIds].filter((id) => !acceptedSet.has(id)).sort((a, b) => a - b),
			duplicateIds: [...duplicateIds].sort((a, b) => a - b),
			unmappedIds: [...unmappedIds].sort(),
			requiredCount: requiredIds.size,
			translatedRequiredCount: [...requiredIds].filter((id) => acceptedSet.has(id)).length
		};
	};

	const parsed = parseFirstJsonValue(response);
	if (!parsed) {
		return { entries: [], overlayEntries: [], status: 'malformed', coverage: coverageFor([]) };
	}

	// Providers vary between a keyed object and an array with an explicit box id.
	const wrapped = !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'translations');
	const translations = wrapped
		? (parsed as Record<string, unknown>).translations
		: parsed;
	if (!translations || typeof translations !== 'object') {
		return { entries: [], overlayEntries: [], status: 'malformed', coverage: coverageFor([]) };
	}
	const responseItems: Array<[string, unknown]> = Array.isArray(translations)
		? translations.map((value, index) => [String(index), value])
		: Object.entries(translations as Record<string, unknown>);
	if (responseItems.length === 0) {
		return { entries: [], overlayEntries: [], status: 'empty', coverage: coverageFor([]) };
	}

	const regionOrder = new Map(regions.map((region, index) => [region.boxId, index]));
	let skipped = 0;
	const accepted: Array<{
		boxId: number;
		region: DetectedTextRegion;
		item: Record<string, unknown>;
		originalText: string;
		translatedText: string;
		type: OverlayEntry['type'];
		speaker?: string;
	}> = [];
	const usedBoxIds = new Set<number>();
	for (const [key, value] of responseItems) {
		if (!value || typeof value !== 'object') continue;
		const item = value as Record<string, unknown>;
		// Explicit provider skip (credits/page numbers/watermarks): treated
		// exactly like omission — optional regions stay untranslated, required
		// regions still count as missing so dialogue cannot be skipped away.
		if (item.skip === true) {
			skipped += 1;
			continue;
		}

		const explicitId = item.box_id ?? item.boxId ?? item.region_id ?? item.id ?? item.box;
		const idSource = explicitId ?? key;
		const idMatch = String(idSource).trim().match(/^(?:box|region)?[\s_-]*(\d+)$/i);
		const boxId = idMatch ? Number(idMatch[1]) : NaN;
		const providerOriginalText = String(
			item.original_text ?? item.original ?? item.japanese ?? item.jp_text ?? ''
		);
		const translatedText = String(
			item.translated_text ?? item.translation ?? item.english ?? item.text ?? ''
		);
		const type = validateOverlayEntryType(item.type ?? item.panel_type);
		const authoritativeOriginal = Number.isFinite(boxId)
			? authoritativeOriginals?.get(boxId)
			: undefined;
		const originalText = authoritativeOriginal ?? providerOriginalText;
		// Speaker guesses are provider semantics, not PP-OCR identity. Keep them
		// for unclassified/legacy pipelines, but do not let a backend choice alter
		// a hash-linked PP-OCR translation entry.
		const speaker = authoritativeOriginals?.has(boxId)
			? undefined
			: item.speaker ? String(item.speaker) : undefined;

		// A provider echoing/returning only the authoritative source has not
		// translated the box and therefore cannot satisfy required coverage.
		if (!translatedText.trim()) continue;
		const region = Number.isFinite(boxId) ? regionMap.get(boxId) : undefined;
		// An overlay result is only useful when the provider's id maps back to a
		// PP-OCR box. Unmapped text is left for the standard-response fallback.
		// When the shared recognizer supplied the authority map, a vision provider
		// also cannot invent an entry for a detected crop that produced no usable
		// OCR result; the on-device path has no corresponding translation item.
		if (!region || authoritativeOriginals !== undefined && !authoritativeOriginals.has(boxId)) {
			unmappedIds.add(Number.isFinite(boxId) ? String(boxId) : String(idSource));
			continue;
		}
		if (usedBoxIds.has(boxId)) {
			duplicateIds.add(boxId);
			continue;
		}
		usedBoxIds.add(boxId);
		accepted.push({ boxId, region, item, originalText, translatedText, type, speaker });
	}

	// Provider object/array enumeration is not a reading-order contract. PP-OCR
	// groups are already in one deterministic page order, which is also what the
	// on-device path consumes. Rebind accepted results to that order before
	// assigning durable entry/item order so switching translation backends cannot
	// reshuffle otherwise identical lineage. Duplicate and missing provider boxes
	// retain the validation behavior above.
	accepted.sort((left, right) =>
		(regionOrder.get(left.boxId) ?? Number.MAX_SAFE_INTEGER)
			- (regionOrder.get(right.boxId) ?? Number.MAX_SAFE_INTEGER)
			|| left.boxId - right.boxId
	);

	for (const [order, acceptedItem] of accepted.entries()) {
		const { boxId, region, item, originalText, translatedText, type, speaker } = acceptedItem;

		const entry: PageTranslationEntryDraft = {
			order,
			original_text: originalText,
			translated_text: translatedText,
			type,
			speaker,
			boxId
		};
		entries.push(entry);

		{
			// Bubble contours are expressed in full-page coordinates. Use their
			// actual bounds so renderer percentages cannot be based on the smaller
			// PP-OCR text rectangle.
			const contourBounds = region.inBubble && region.contour && region.contour.length >= 3
				? {
					x: Math.min(...region.contour.map(([x]) => x)),
					y: Math.min(...region.contour.map(([, y]) => y)),
					maxX: Math.max(...region.contour.map(([x]) => x)),
					maxY: Math.max(...region.contour.map(([, y]) => y))
				}
				: null;
			const overlayEntry: OverlayEntry = {
				boxId,
				original_text: originalText,
				translated_text: translatedText,
				type,
				speaker,
				x: contourBounds?.x ?? region.x,
				y: contourBounds?.y ?? region.y,
				width: contourBounds ? contourBounds.maxX - contourBounds.x : region.width,
				height: contourBounds ? contourBounds.maxY - contourBounds.y : region.height,
				inBubble: region.inBubble,
				contour: region.contour
			};

			// Extract optional vLLM layout hints
			if (typeof item.font_size_ratio === 'number' && item.font_size_ratio > 0) {
				overlayEntry.vllmFontSizeRatio = Math.max(0.5, Math.min(1.5, item.font_size_ratio));
			}
			const vp = item.visual_priority;
			if (vp === 'high' || vp === 'medium' || vp === 'low') {
				overlayEntry.vllmVisualPriority = vp;
			}

			overlayEntries.push(overlayEntry);
		}
	}

	// A page the provider skipped in full — a credits or colophon page — is the
	// same answer as omitting every box, and the prompt offers both forms. Only
	// omission used to read as `empty`; the skip form fell through to
	// `malformed`, which is a retryable coverage failure, so the page burned all
	// three attempts and its backoff, then recorded a permanent failure that
	// counts toward the five-consecutive abort and is re-queued on every resume.
	// In the reader it surfaced as a red "Translated 0 of 0 required text
	// groups" banner on a page that correctly had nothing to translate.
	const allSkipped = entries.length === 0 && skipped === responseItems.length;

	return {
		entries,
		overlayEntries,
		status: entries.length > 0 ? 'ok' : allSkipped ? 'empty' : 'malformed',
		coverage: coverageFor(entries.flatMap((entry) => entry.boxId === undefined ? [] : [entry.boxId]))
	};
}



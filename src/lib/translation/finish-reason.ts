/**
 * One vocabulary for "why did the model stop", across providers.
 *
 * Ten call sites decide whether a response was truncated by comparing
 * `finish_reason === 'length'`. That is OpenAI's word for it. The Anthropic
 * Messages API says `max_tokens`, so every one of those guards was dead for the
 * Claude provider — a truncated page fell through to the JSON parser, which
 * could not close the object and reported "malformed" instead of the actionable
 * "increase max context tokens".
 *
 * The refusal case matters more. Anthropic returns `stop_reason: 'refusal'`
 * with no text block for a safety decline. That used to surface as a generic
 * empty-response error, which the volume job counts toward its five-consecutive-
 * failures abort — so five declined pages killed a whole volume, where the same
 * pages on OpenRouter are classified as content-filtered, skipped, and the run
 * completes. Normalizing here restores that parity.
 *
 * Values are the OpenAI set, because that is what the consumers already speak.
 */
export type NormalizedFinishReason =
	| 'stop'
	| 'length'
	| 'content_filter'
	| 'tool_calls'
	| 'unknown';

/**
 * Raw provider values that mean "I ran out of room".
 * - `length` — OpenAI, OpenRouter, and every OpenAI-compatible server.
 * - `max_tokens` — Anthropic Messages API.
 * - `model_context_window_exceeded` — Anthropic again, only with the context
 *   management beta. This adapter does not enable it, so the value cannot
 *   currently arrive; it is listed because the cost of being wrong the day it
 *   does is a silently unreported truncation.
 */
const TRUNCATION_VALUES = new Set(['length', 'max_tokens', 'model_context_window_exceeded']);

/** Raw provider values that mean "I declined to answer". */
const FILTER_VALUES = new Set(['content_filter', 'refusal', 'safety']);

/** Raw provider values that mean "I finished normally". */
const STOP_VALUES = new Set(['stop', 'end_turn', 'stop_sequence', 'eos', 'complete']);

/** Raw provider values that mean "I stopped to call a tool". */
const TOOL_VALUES = new Set(['tool_calls', 'tool_use', 'function_call']);

/**
 * Map a provider's raw stop/finish reason onto the shared vocabulary.
 *
 * Unrecognized values become `unknown` rather than `stop`: treating a reason we
 * do not understand as a clean finish is how truncation went unnoticed in the
 * first place.
 */
export function normalizeFinishReason(raw: unknown): NormalizedFinishReason {
	if (typeof raw !== 'string') return 'unknown';
	const value = raw.trim().toLowerCase();
	if (!value) return 'unknown';
	if (TRUNCATION_VALUES.has(value)) return 'length';
	if (FILTER_VALUES.has(value)) return 'content_filter';
	if (STOP_VALUES.has(value)) return 'stop';
	if (TOOL_VALUES.has(value)) return 'tool_calls';
	return 'unknown';
}

/** Did the model stop because it hit its output ceiling? */
export function isTruncatedResponse(raw: unknown): boolean {
	return normalizeFinishReason(raw) === 'length';
}

/** Did the model decline to answer? */
export function isContentFilteredFinish(raw: unknown): boolean {
	return normalizeFinishReason(raw) === 'content_filter';
}

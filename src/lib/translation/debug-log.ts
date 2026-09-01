/**
 * Debug logging for LLM translation requests and responses.
 *
 * Gated by the `debugLogging` setting — zero overhead when disabled.
 * Base64 image data is replaced with a placeholder to keep output clean.
 *
 * Logs are written to both the browser console AND an in-memory buffer.
 * The buffer can be copied to clipboard from Settings for sharing.
 */

import { get } from 'svelte/store';
import { settings } from '$lib/settings/settings.js';
import { sanitizeSensitiveText } from '$lib/util/redact.js';
import type { ChatMessage } from './llm-types.js';

const PREFIX = '[FumetoReaderPlus Debug]';

// ---------------------------------------------------------------------------
// In-memory log buffer
// ---------------------------------------------------------------------------

const MAX_BUFFER_ENTRIES = 1000;
const buffer: string[] = [];

/** Append a line to the buffer, trimming old entries if needed. */
function bufferWrite(line: string): void {
	buffer.push(line);
	if (buffer.length > MAX_BUFFER_ENTRIES) {
		buffer.splice(0, buffer.length - MAX_BUFFER_ENTRIES);
	}
}

/** Get a formatted timestamp for log lines. */
function timestamp(): string {
	const d = new Date();
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	const ms = String(d.getMilliseconds()).padStart(3, '0');
	return `${hh}:${mm}:${ss}.${ms}`;
}

/** Get full debug log text for clipboard export. */
export function getDebugLogText(): string {
	return buffer.join('\n');
}

/** Get the number of buffered log entries. */
export function getDebugLogCount(): number {
	return buffer.length;
}

/** Clear the log buffer. */
export function clearDebugLog(): void {
	buffer.length = 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check the setting once per call — avoids repeated store reads. */
function isEnabled(): boolean {
	return get(settings).debugLogging === true;
}

/**
 * Re-exported for existing callers. `$lib/util/redact.js` owns the
 * implementation so the always-on error ring can redact without importing this
 * module — and through it the settings store — into the app's earliest startup
 * path, which reordered module initialisation and broke IndexedDB setup.
 */
export { sanitizeSensitiveText };

/**
 * Strip base64 image URLs from messages, replacing with a placeholder.
 * Text portions are preserved in full so prompts are readable.
 */
function sanitizeMessages(messages: ChatMessage[]): object[] {
	return messages.map((msg) => {
		if (typeof msg.content === 'string') {
			return { role: msg.role, content: sanitizeSensitiveText(msg.content) };
		}
		const sanitized = msg.content.map((part) => {
			if (part.type === 'image_url') {
				return { type: 'image_url', image_url: { url: '[base64 image omitted]' } };
			}
			return part.type === 'text'
				? { ...part, text: sanitizeSensitiveText(part.text) }
				: part;
		});
		return { role: msg.role, content: sanitized };
	});
}

/** Serialize a value to compact JSON, handling errors gracefully. */
function toJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// Public logging functions
// ---------------------------------------------------------------------------

/** Log an outgoing LLM request (collapsed group + buffer). */
export function debugLogRequest(
	label: string,
	model: string,
	messages: ChatMessage[],
	temperature: number | undefined,
	maxTokens: number
): void {
	if (!isEnabled()) return;

	const sanitized = sanitizeMessages(messages);
	const ts = timestamp();

	// Console output
	console.groupCollapsed(`${PREFIX} ${label} — Request`);
	console.log('Model:', model);
	console.log('Temperature:', temperature ?? 'default');
	console.log('Max tokens:', maxTokens);
	console.log('Messages:', sanitized);
	console.groupEnd();

	// Buffer output
	bufferWrite(`[${ts}] [REQUEST] ${label}`);
	bufferWrite(`  Model: ${model}`);
	bufferWrite(`  Temperature: ${temperature ?? 'default'}`);
	bufferWrite(`  Max tokens: ${maxTokens}`);
	bufferWrite(`  Messages: ${toJson(sanitized)}`);
	bufferWrite('');
}

/**
 * Log an LLM response with timing (collapsed group + buffer).
 *
 * Accepts two response shapes:
 * - OpenRouterResponse (from openrouter-client.ts): `{ choices, usage, id }`
 * - LLMResponse (from llm-client.ts): `{ content, model, usage }`
 */
export function debugLogResponse(
	label: string,
	response:
		| { content: string; model: string; finish_reason?: string; usage: { prompt_tokens: number; completion_tokens: number } }
		| { choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; id: string },
	elapsedMs: number
): void {
	if (!isEnabled()) return;

	// Normalize from either shape
	const content = sanitizeSensitiveText('choices' in response
		? (response.choices[0]?.message?.content || '')
		: response.content);
	const finishReason = 'choices' in response
		? response.choices[0]?.finish_reason
		: response.finish_reason;
	const usage = response.usage;
	const ts = timestamp();
	const elapsed = Math.round(elapsedMs);

	// Console output
	console.groupCollapsed(`${PREFIX} ${label} — Response (${elapsed}ms)`);
	console.log('Content:', content);
	if (finishReason !== undefined) console.log('Finish reason:', finishReason);
	console.log('Usage:', usage);
	console.groupEnd();

	// Buffer output
	bufferWrite(`[${ts}] [RESPONSE] ${label} (${elapsed}ms)`);
	if (finishReason !== undefined) bufferWrite(`  Finish reason: ${finishReason}`);
	bufferWrite(`  Usage: ${toJson(usage)}`);
	bufferWrite(`  Content:`);
	bufferWrite(`  ${content}`);
	bufferWrite('');
}

/** Log a parse/extraction result (+ buffer). */
export function debugLogParse(label: string, result: unknown): void {
	if (!isEnabled()) return;

	const ts = timestamp();

	const sanitizedResult = sanitizeSensitiveText(toJson(result));
	console.log(`${PREFIX} ${label} — Parse result:`, sanitizedResult);

	bufferWrite(`[${ts}] [PARSE] ${label}`);
	bufferWrite(`  ${sanitizedResult}`);
	bufferWrite('');
}

/** Log a retry attempt (+ buffer). */
export function debugLogRetry(
	label: string,
	attempt: number,
	delayMs: number,
	error: string
): void {
	if (!isEnabled()) return;

	const ts = timestamp();
	const sanitizedError = sanitizeSensitiveText(error);

	console.warn(`${PREFIX} ${label} — Retry ${attempt}, delay ${delayMs}ms: ${sanitizedError}`);

	bufferWrite(`[${ts}] [RETRY] ${label} — attempt ${attempt}, delay ${delayMs}ms: ${sanitizedError}`);
	bufferWrite('');
}

/** Log an error with optional context (+ buffer). */
export function debugLogError(label: string, error: unknown, context?: string): void {
	if (!isEnabled()) return;

	const ts = timestamp();
	const errorMsg = sanitizeSensitiveText(error instanceof Error ? error.message : String(error));
	const ctx = context ? ` (${context})` : '';

	console.error(`${PREFIX} ${label} — Error${ctx}: ${errorMsg}`);

	bufferWrite(`[${ts}] [ERROR] ${label}${ctx}: ${errorMsg}`);
	bufferWrite('');
}

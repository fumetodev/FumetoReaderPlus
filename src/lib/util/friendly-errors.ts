import type { UserMessageCode } from '$lib/i18n/user-messages.js';
import { BridgeError } from '$lib/i18n/errors.js';
/**
 * Turns transport/HTTP errors into language a playtester can act on. Raw
 * `error.message` strings (fetch internals, Rust reqwest errors, status
 * codes) read as broken software; these read as situations.
 *
 * The situation is a message CODE, rendered by the component in the live
 * locale; the raw text stays English for the details disclosure. The input
 * patterns are the words fetch and reqwest actually emit — never localized.
 */
import { BRIDGE_CODES, isUserMessage, type UserMessage } from '$lib/i18n/user-messages.js';

export interface FriendlyError {
	/** Short, plain-language description of what happened. */
	message: UserMessage;
	/** The raw underlying message when it adds information; for debug expanders. */
	detail?: string;
}

const UNREACHABLE_PATTERNS = [
	'failed to fetch',
	'networkerror',
	'network error',
	'error sending request',
	'connection refused',
	'connection reset',
	'could not connect',
	'dns error',
	'name or service not known',
	'no route to host',
	'network is unreachable',
	'load failed' // WebKit's fetch failure message
];

const TIMEOUT_PATTERNS = ['timed out', 'timeout'];

function statusFrom(raw: string): number | null {
	// Matches "HTTP 503", "status 503", "503 Service Unavailable", "(503)"
	const match = raw.match(/(?:http |status |\()?\b([45]\d{2})\b/);
	return match ? Number(match[1]) : null;
}

export function describeErrorForUser(error: unknown): FriendlyError {
	const raw =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: String(error ?? 'Unknown error');
	const lower = raw.toLowerCase();
	const detail = raw;

	// An error that already knows what to tell the reader (see withUserMessage).
	const carried = error !== null && typeof error === 'object' ? (error as { userMessage?: unknown }).userMessage : undefined;
	if (isUserMessage(carried)) return { message: carried, detail };

	// A coded rejection from a Kotlin bridge (see parseBridgeRejection).
	if (error instanceof BridgeError && BRIDGE_CODES.has(error.code)) {
		return { message: { code: `bridge_${error.code}` as UserMessageCode }, detail };
	}

	if ((error instanceof DOMException && error.name === 'AbortError') || lower.includes('abort')) {
		return { message: { code: 'op_cancelled' }, detail };
	}
	if (TIMEOUT_PATTERNS.some((p) => lower.includes(p))) {
		return { message: { code: 'error_timeout' }, detail };
	}
	if (UNREACHABLE_PATTERNS.some((p) => lower.includes(p))) {
		return { message: { code: 'error_unreachable' }, detail };
	}
	const status = statusFrom(lower);
	if (status === 401 || status === 403) {
		return { message: { code: 'error_auth' }, detail };
	}
	if (status === 404) {
		return { message: { code: 'error_not_found' }, detail };
	}
	if (status !== null && status >= 500) {
		return { message: { code: 'error_server' }, detail };
	}
	if (status !== null) {
		return { message: { code: 'error_rejected', params: { status } }, detail };
	}
	return { message: { code: 'error_generic' }, detail };
}

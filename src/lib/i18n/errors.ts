/**
 * Typed errors for the few places the app used to branch on English prose.
 *
 * `error.message === 'Request cancelled'` and friends were control flow that
 * happened to be spelled as user text. These carry a `code` the UI can
 * render through `user-messages.ts`; the `message` stays English for logs
 * and bug reports and is never shown raw.
 */
import type { UserMessage } from './user-messages.js';

export class RequestCancelledError extends Error {
	readonly code = 'op_cancelled' as const;
	constructor(message = 'Request cancelled') {
		super(message);
		this.name = 'RequestCancelledError';
	}
}

export class PageTranslationMissingError extends Error {
	readonly code = 'reader_no_page_translation' as const;
	constructor(message = 'No page translation exists') {
		super(message);
		this.name = 'PageTranslationMissingError';
	}
}

/** A rejection from a Kotlin bridge, decoded by `parseBridgeRejection`. */
export class BridgeError extends Error {
	constructor(
		readonly code: string,
		readonly detail: string
	) {
		super(detail || code);
		this.name = 'BridgeError';
	}
}

/**
 * Attach the message a person should see to an error whose class must not
 * change (provider errors are matched by `instanceof` in retry loops). The
 * English `message` stays for logs; `describeError`/`describeErrorForUser`
 * prefer `userMessage` when present.
 */
export function withUserMessage<E extends Error>(error: E, userMessage: UserMessage): E & { userMessage: UserMessage } {
	return Object.assign(error, { userMessage });
}

/** The wait a rate-limiting provider asked for, as the message the reader sees. */
export function rateLimitedUserMessage(waitMinutes: number): UserMessage {
	return { code: 'error_rate_limited', params: { minutes: waitMinutes } };
}

/**
 * Bridges reject with `JSON.stringify({ code, detail })` once localized; older
 * APKs reject with a bare string. Both decode, so a new WebView bundle over
 * an old native layer degrades to a generic message instead of breaking.
 */
export function parseBridgeRejection(raw: unknown): BridgeError {
	if (raw instanceof BridgeError) return raw;
	const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '');
	try {
		const parsed = JSON.parse(text) as { code?: unknown; detail?: unknown };
		if (parsed && typeof parsed.code === 'string') {
			return new BridgeError(parsed.code, typeof parsed.detail === 'string' ? parsed.detail : '');
		}
	} catch {
		// Not JSON: a legacy bare-string rejection.
	}
	return new BridgeError('unknown', text);
}

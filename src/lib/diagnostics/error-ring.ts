/**
 * Always-on capture of unhandled faults.
 *
 * This is deliberately NOT gated by the `debugLogging` setting the way
 * translation/debug-log.ts is. That setting defaults off, and a tester will not
 * turn on logging *before* hitting a bug — by the time anyone knows there was a
 * problem, a gated buffer is already empty.
 *
 * It also exists because this is a WebView app: a JS fault does not kill the
 * process, so Android vitals never sees it. Without this the only trace is a
 * single logcat line with an empty `File:` and no stack, on a device you do not
 * have.
 *
 * Nothing here may throw. It runs inside error handlers, and a capture path
 * that faults would turn one bug into an unrecoverable loop.
 */

import { sanitizeSensitiveText } from '$lib/util/redact.js';

/** Enough to show a pattern; small enough to stay pasteable. */
const MAX_ENTRIES = 50;
const MAX_MESSAGE = 500;
const MAX_STACK = 1_500;

export type CapturedErrorKind = 'error' | 'unhandledrejection' | 'svelte' | 'sveltekit';

export interface CapturedError {
	/** ISO timestamp. */
	at: string;
	kind: CapturedErrorKind;
	message: string;
	stack?: string;
	/** Where the browser said it came from, when it said anything. */
	source?: string;
}

const ring: CapturedError[] = [];

function clamp(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}… (+${value.length - limit} chars)` : value;
}

/** Best-effort message extraction: throw values are not always Errors. */
function describe(error: unknown): { message: string; stack?: string } {
	try {
		if (error instanceof Error) {
			return { message: error.message || error.name || 'Error', stack: error.stack };
		}
		if (typeof error === 'string') return { message: error };
		return { message: JSON.stringify(error) ?? String(error) };
	} catch {
		return { message: '[unserializable error value]' };
	}
}

export function recordError(
	kind: CapturedErrorKind,
	error: unknown,
	source?: string
): void {
	try {
		const { message, stack } = describe(error);
		ring.push({
			at: new Date().toISOString(),
			kind,
			message: clamp(sanitizeSensitiveText(message), MAX_MESSAGE),
			stack: stack ? clamp(sanitizeSensitiveText(stack), MAX_STACK) : undefined,
			source: source ? clamp(sanitizeSensitiveText(source), 200) : undefined
		});
		if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES);
	} catch {
		// A capture failure must never propagate into the handler that called us.
	}
}

export function getCapturedErrors(): readonly CapturedError[] {
	return ring;
}

export function getCapturedErrorCount(): number {
	return ring.length;
}

export function clearCapturedErrors(): void {
	ring.length = 0;
}

/**
 * Installs the global handlers. Idempotent, so a double import or a hot reload
 * cannot stack duplicate listeners.
 *
 * Both listeners are passive: they record and return, never preventing default.
 * Swallowing the browser's own reporting would make console debugging worse for
 * no gain.
 */
let installed = false;

export function installGlobalErrorCapture(target: Window = window): void {
	if (installed) return;
	installed = true;
	try {
		target.addEventListener('error', (event: ErrorEvent) => {
			// Resource load failures (img/script 404s) also fire 'error' on window
			// but carry no Error object; they are noise here.
			if (!event.error && !event.message) return;
			const where = event.filename
				? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
				: undefined;
			recordError('error', event.error ?? event.message, where);
		});
		target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
			recordError('unhandledrejection', event.reason);
		});
	} catch {
		// Nothing to do — capture is best-effort.
	}
}

/** Test seam: lets a suite reinstall handlers on a fresh fake window. */
export function resetGlobalErrorCaptureForTests(): void {
	installed = false;
}

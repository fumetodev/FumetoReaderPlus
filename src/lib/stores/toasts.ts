/**
 * App toasts: transient status lines that float above the dock instead of
 * reflowing content the way the old inline banners did. Each toast auto-
 * dismisses unless it carries an action (retryable toasts stay until acted
 * on or dismissed).
 */
import { writable } from 'svelte/store';
import { userMessageKey, type UserMessage } from '$lib/i18n/user-messages.js';

/** A message code (rendered by the host in the live locale) or, for callers not yet migrated, a string. */
export type ToastText = UserMessage | string;

export interface Toast {
	id: number;
	message: ToastText;
	/** Optional action button (e.g. Retry). Actions suspend auto-dismiss. */
	action?: { label: ToastText; run: () => void };
	tone: 'info' | 'error';
}

const AUTO_DISMISS_MS = 4000;
/**
 * A dismissed progress stream stays quiet while it keeps streaming. Once it
 * has been silent this long it is a new stream, and shows again.
 */
const MUTE_IDLE_MS = 30_000;

export const toasts = writable<Toast[]>([]);

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Which keyed stream a toast id belongs to, for user dismissals. */
const keyOfToast = new Map<number, string>();
/** Streams the user closed, by key → time of the last update swallowed. */
const mutedKeys = new Map<string, number>();
/** Settings → Libraries → Show scan progress. Errors are never progress. */
let progressToastsEnabled = true;

export function dismissToast(id: number): void {
	const timer = timers.get(id);
	if (timer) clearTimeout(timer);
	timers.delete(id);
	keyOfToast.delete(id);
	toasts.update((list) => list.filter((toast) => toast.id !== id));
}

/**
 * The host's close button. Closing a progress stream used to hide one
 * message and the next event recreated the toast: a scan that reports
 * every entry re-opened it hundreds of times. A user dismissal now mutes the
 * rest of that stream; auto-dismiss (a timer) never does.
 */
export function dismissToastByUser(id: number): void {
	const key = keyOfToast.get(id);
	if (key !== undefined) mutedKeys.set(key, Date.now());
	dismissToast(id);
}

export function setProgressToastsEnabled(enabled: boolean): void {
	progressToastsEnabled = enabled;
	if (enabled) return;
	for (const [key, id] of keyedToasts) {
		if (progressKeys.has(key)) {
			dismissToast(id);
			keyedToasts.delete(key);
		}
	}
}

export function pushToast(input: {
	message: ToastText;
	action?: Toast['action'];
	tone?: Toast['tone'];
	/**
	 * Auto-dismiss even with an action. An Undo snackbar offers its action for
	 * a few seconds and then gets out of the way; a Retry toast waits.
	 */
	autoDismissMs?: number;
}): number {
	const id = nextId++;
	const toast: Toast = { id, message: input.message, action: input.action, tone: input.tone ?? 'info' };
	toasts.update((list) => [...list.filter((entry) => userMessageKey(entry.message) !== userMessageKey(toast.message)), toast]);
	if (!toast.action || input.autoDismissMs !== undefined) {
		timers.set(id, setTimeout(() => dismissToast(id), input.autoDismissMs ?? AUTO_DISMISS_MS));
	}
	return id;
}

/**
 * Replace-by-key helper for streams of progress updates (scan status).
 * Updates the existing toast in place — same id, same DOM node — so the
 * host's keyed transitions never replay mid-stream. Recreating the toast
 * per event made every progress message flash a full exit/enter cycle.
 */
const keyedToasts = new Map<string, number>();
/** Keys whose current toast was pushed as a progress update. */
const progressKeys = new Set<string>();
export function pushKeyedToast(
	key: string,
	input: {
		message: ToastText;
		action?: Toast['action'];
		tone?: Toast['tone'];
		/** One update of a stream (scan, sync): suppressible by the user and by Settings. */
		progress?: boolean;
	}
): void {
	if (input.progress && input.tone !== 'error') {
		if (!progressToastsEnabled) return;
		const mutedAt = mutedKeys.get(key);
		if (mutedAt !== undefined) {
			if (Date.now() - mutedAt < MUTE_IDLE_MS) {
				mutedKeys.set(key, Date.now());
				return;
			}
			mutedKeys.delete(key);
		}
		progressKeys.add(key);
	} else {
		// A terminal or error message ends the muted stream.
		mutedKeys.delete(key);
		progressKeys.delete(key);
	}
	const existing = keyedToasts.get(key);
	if (existing != null) {
		let updated = false;
		toasts.update((list) =>
			list.map((toast) => {
				if (toast.id !== existing) return toast;
				updated = true;
				return { ...toast, message: input.message, action: input.action, tone: input.tone ?? 'info' };
			})
		);
		if (updated) {
			// Reset the auto-dismiss clock so a live stream stays visible.
			const timer = timers.get(existing);
			if (timer) clearTimeout(timer);
			timers.delete(existing);
			if (!input.action) {
				timers.set(existing, setTimeout(() => dismissToast(existing), AUTO_DISMISS_MS));
			}
			return;
		}
		// The tracked toast already auto-dismissed; fall through to a fresh one.
	}
	const id = pushToast(input);
	keyedToasts.set(key, id);
	keyOfToast.set(id, key);
}

/** The emitter's end of stream: the toast goes, and so does any mute on it. */
export function dismissKeyedToast(key: string): void {
	const existing = keyedToasts.get(key);
	if (existing != null) {
		dismissToast(existing);
		keyOfToast.delete(existing);
	}
	keyedToasts.delete(key);
	progressKeys.delete(key);
	mutedKeys.delete(key);
}

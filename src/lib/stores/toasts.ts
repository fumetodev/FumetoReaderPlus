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

export const toasts = writable<Toast[]>([]);

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number): void {
	const timer = timers.get(id);
	if (timer) clearTimeout(timer);
	timers.delete(id);
	toasts.update((list) => list.filter((toast) => toast.id !== id));
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
export function pushKeyedToast(key: string, input: { message: ToastText; action?: Toast['action']; tone?: Toast['tone'] }): void {
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
	keyedToasts.set(key, pushToast(input));
}

export function dismissKeyedToast(key: string): void {
	const existing = keyedToasts.get(key);
	if (existing != null) dismissToast(existing);
	keyedToasts.delete(key);
}

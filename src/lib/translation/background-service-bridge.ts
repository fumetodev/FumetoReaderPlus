/**
 * Background Translation Service Bridge — JS↔Kotlin bridge for the foreground service.
 *
 * Communicates with the native Android TranslationForegroundService through a
 * WebView JavascriptInterface registered as `window.__fumeto_service`.
 *
 * Unlike LlamaBridge, most methods here are fire-and-forget
 * (they dispatch Intents to the service). Only requestNotificationPermission()
 * uses the async callback pattern since it must wait for the system dialog result.
 *
 * Also registers `window.__fumeto_cancel_translation` which Kotlin calls when
 * the user taps "Cancel" on the foreground notification. This triggers the
 * existing cancelVolumeTranslation() abort flow.
 *
 * On non-Android or desktop, `isBackgroundServiceAvailable()` returns false
 * and all functions are no-ops.
 */
import { pushKeyedToast } from '$lib/stores/toasts.js';
import { parseBridgeRejection } from '$lib/i18n/errors.js';

// Pending async callbacks from Kotlin (only used for permission request)
const pendingCallbacks = new Map<
	string,
	{
		resolve: (value: string) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}
>();
let callbackCounter = 0;
const PERMISSION_TIMEOUT_MS = 2 * 60_000;

function settleCallback(
	callbackId: string,
	settle: (callback: { resolve: (value: string) => void; reject: (error: Error) => void }) => void
): void {
	const callback = pendingCallbacks.get(callbackId);
	if (!callback) return;
	pendingCallbacks.delete(callbackId);
	clearTimeout(callback.timer);
	settle(callback);
}

// Register global callback handlers that Kotlin will invoke
if (typeof window !== 'undefined') {
	(window as unknown as Record<string, unknown>).__bg_resolve = (
		callbackId: string,
		resultJson: string
	) => {
		settleCallback(callbackId, (callback) => callback.resolve(resultJson));
	};

	(window as unknown as Record<string, unknown>).__bg_reject = (
		callbackId: string,
		errorMessage: string
	) => {
		settleCallback(callbackId, (callback) => callback.reject(parseBridgeRejection(errorMessage)));
	};

	// Cancel handler — invoked by Kotlin when user taps Cancel on the notification.
	// Kotlin passes the volume UUID registered via setActiveVolumeUuid so only
	// the notification's own job is aborted; without one (older notification or
	// unregistered job) it falls back to the global cancel.
	// Dynamically imports the service to avoid a circular dependency.
	(window as unknown as Record<string, unknown>).__fumeto_cancel_translation = async (
		volumeUuid?: string
	) => {
		try {
			const { cancelActiveTranslation, cancelVolumeWork } = await import(
				'./volume-translation-service.js'
			);
			if (volumeUuid) {
				// Reaches external work (exports) as well as translation runs.
				void cancelVolumeWork(volumeUuid);
			} else {
				cancelActiveTranslation();
			}
		} catch (err) {
			console.error('[background-service] Cancel from notification failed:', err);
		}
	};
}

/**
 * Create a unique callback ID and a promise that resolves when Kotlin calls back.
 */
function createCallback(): { callbackId: string; promise: Promise<string> } {
	const callbackId = `bg_${++callbackCounter}_${Date.now()}`;
	const promise = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			settleCallback(callbackId, (callback) => {
				callback.reject(new Error('Notification permission request timed out'));
			});
		}, PERMISSION_TIMEOUT_MS);
		pendingCallbacks.set(callbackId, { resolve, reject, timer });
	});
	return { callbackId, promise };
}

/**
 * Access the native background service bridge interface.
 */
function getBridge(): Record<string, (...args: unknown[]) => unknown> | null {
	if (typeof window === 'undefined') return null;
	return (
		((window as unknown as Record<string, unknown>).__fumeto_service as Record<
			string,
			(...args: unknown[]) => unknown
		> | null) ?? null
	);
}

// ============================================================
// Availability & Permissions
// ============================================================

/**
 * Check if the background service bridge is available (Android only).
 */
export function isBackgroundServiceAvailable(): boolean {
	const bridge = getBridge();
	if (!bridge?.isAvailable) return false;
	try {
		return bridge.isAvailable() as boolean;
	} catch {
		return false;
	}
}

/**
 * Check if POST_NOTIFICATIONS permission is currently granted.
 * On API < 33, always returns true.
 */
export function hasNotificationPermission(): boolean {
	const bridge = getBridge();
	if (!bridge?.hasNotificationPermission) return false;
	try {
		return bridge.hasNotificationPermission() as boolean;
	} catch {
		return false;
	}
}

/**
 * Request POST_NOTIFICATIONS permission (API 33+).
 * Shows the system permission dialog and resolves when the user responds.
 * Returns true if granted, false if denied.
 * On API < 33, always resolves to true.
 */
export async function requestNotificationPermission(): Promise<boolean> {
	const bridge = getBridge();
	if (!bridge?.requestNotificationPermission) return false;

	const { callbackId, promise } = createCallback();
	try {
		bridge.requestNotificationPermission(callbackId);
	} catch (error) {
		settleCallback(callbackId, (callback) => {
			callback.reject(error instanceof Error ? error : new Error(String(error)));
		});
	}

	const result = await promise;
	return result === 'true';
}

// ============================================================
// Service Lifecycle (fire-and-forget)
// ============================================================

/**
 * Volumes currently relying on the service, in the order they started.
 *
 * There is one foreground service and one notification, but any number of
 * volumes may be translating at once. The service is therefore reference
 * counted: the first volume starts it and only the last one to finish stops
 * it, so a short job finishing can never drop the wake lock out from under a
 * long one still running.
 */
const activeVolumes = new Map<
	string,
	{ name: string; totalPages: number; currentPage: number; activity: string; claims: number }
>();

/** The volume the notification currently speaks for (its Cancel target). */
function primaryVolumeUuid(): string {
	return activeVolumes.keys().next().value ?? '';
}

function pushNotificationState(): void {
	const bridge = getBridge();
	if (!bridge?.updateProgress) return;
	const primary = activeVolumes.get(primaryVolumeUuid());
	if (!primary) return;
	const others = activeVolumes.size - 1;
	const name = others > 0 ? `${primary.name} (+${others} more)` : primary.name;
	try {
		bridge.setActiveVolumeUuid?.(primaryVolumeUuid());
		if (
			bridge.updateProgress(name, primary.currentPage, primary.totalPages, primary.activity) === false
		) {
			// The service is gone — it is START_NOT_STICKY, so an OS kill mid-batch
			// is silent and never restarts itself. The JS claim map cannot see that
			// on its own, so a refused update is the only signal we get; take it as
			// a cue to re-establish the service rather than spend the rest of the
			// batch pushing progress at nothing.
			bridge.startTranslation?.(name, primary.totalPages);
		}
	} catch {
		// Best effort — don't break translation for a notification update failure
	}
}

/**
 * Register a volume with the foreground service, starting it if this is the
 * first one. Acquires a PARTIAL_WAKE_LOCK to prevent CPU sleep.
 */
export function startBackgroundTranslation(
	volumeName: string,
	totalPages: number,
	volumeUuid?: string
): boolean {
	const bridge = getBridge();
	if (!bridge?.startTranslation) return false;
	const key = volumeUuid ?? volumeName;
	const first = activeVolumes.size === 0;
	const previous = activeVolumes.get(key);
	// One volume can be claimed twice — exporting a volume that is still being
	// translated is allowed — so claims are counted per key. Without the count
	// the two collapse into one entry and whichever finishes first stops the
	// service out from under the other. An existing entry keeps its own name and
	// progress, since the longer-running job is the more informative thing for
	// the notification to be showing.
	activeVolumes.set(
		key,
		previous
			? { ...previous, claims: previous.claims + 1 }
			: { name: volumeName, totalPages, currentPage: 0, activity: '', claims: 1 }
	);
	try {
		if (first) {
			bridge.setActiveVolumeUuid?.(volumeUuid ?? '');
			// `=== false`, not `!result`: a Kotlin build predating the boolean
			// contract returns undefined, which must still read as success.
			if (bridge.startTranslation(volumeName, totalPages) === false) {
				throw new Error('Android refused to start the foreground service');
			}
		} else {
			pushNotificationState();
		}
		return true;
	} catch (err) {
		// A claim that did not take must not survive: it makes `first` false for
		// every later volume, so nothing ever retries the start and the rest of
		// the batch runs unprotected.
		if (previous) activeVolumes.set(key, previous);
		else activeVolumes.delete(key);
		console.warn('[background-service] Failed to start service:', err);
		pushKeyedToast('background-service-refused', {
			tone: 'error',
			message: { code: 'translation_background_refused' }
		});
		return false;
	}
}

/**
 * Update the notification with current translation progress. With several
 * volumes running the notification tracks the earliest one and counts the rest.
 */
export function updateTranslationProgress(
	volumeName: string,
	currentPage: number,
	totalPages: number,
	activity: string,
	volumeUuid?: string
): void {
	const key = volumeUuid ?? volumeName;
	const entry = activeVolumes.get(key);
	if (entry) {
		entry.currentPage = currentPage;
		entry.totalPages = totalPages;
		entry.activity = activity;
	}
	if (activeVolumes.size > 0) {
		pushNotificationState();
		return;
	}
	const bridge = getBridge();
	if (!bridge?.updateProgress) return;
	try {
		bridge.updateProgress(volumeName, currentPage, totalPages, activity);
	} catch {
		// Best effort
	}
}

/**
 * Release one volume's claim on the service; the wake lock is dropped only
 * once no volume is left. Safe to call twice or when nothing is running.
 */
export function stopBackgroundTranslation(volumeUuid?: string): void {
	const bridge = getBridge();
	if (volumeUuid !== undefined) {
		// Drop one claim, not the entry: a volume being exported while it is
		// still translating holds two, and the first release must not end the
		// other job's protection.
		const entry = activeVolumes.get(volumeUuid);
		if (entry && entry.claims > 1) activeVolumes.set(volumeUuid, { ...entry, claims: entry.claims - 1 });
		else activeVolumes.delete(volumeUuid);
	} else {
		activeVolumes.clear();
	}
	if (activeVolumes.size > 0) {
		pushNotificationState();
		return;
	}
	if (!bridge?.stopTranslation) return;
	try {
		bridge.setActiveVolumeUuid?.('');
		bridge.stopTranslation();
	} catch {
		// Best effort
	}
}

/** Volumes currently holding the foreground service open (diagnostics/tests). */
export function backgroundTranslationVolumeCount(): number {
	return activeVolumes.size;
}

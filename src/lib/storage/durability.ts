import { writable, type Readable } from 'svelte/store';

/**
 * Durable-storage state surfaced in Settings → Libraries. IndexedDB holds the
 * user's entire local library; without `navigator.storage.persist()` the OS
 * may silently evict it under storage pressure ("best-effort" mode).
 */
export interface StorageDurability {
	/** false when the Storage API (or estimate) is unavailable in this WebView. */
	supported: boolean;
	/** true = persistent, false = best-effort (evictable), null = unknown. */
	persisted: boolean | null;
	usageBytes: number | null;
	quotaBytes: number | null;
}

const INITIAL: StorageDurability = {
	supported: false,
	persisted: null,
	usageBytes: null,
	quotaBytes: null
};

const state = writable<StorageDurability>(INITIAL);
export const storageDurability: Readable<StorageDurability> = { subscribe: state.subscribe };

/** Minimal slice of `navigator` used here; injectable for tests. */
export interface StorageNavigatorLike {
	storage?: {
		persist?: () => Promise<boolean>;
		persisted?: () => Promise<boolean>;
		estimate?: () => Promise<{ usage?: number; quota?: number }>;
	};
}

function defaultNavigator(): StorageNavigatorLike {
	return typeof navigator === 'undefined' ? {} : (navigator as StorageNavigatorLike);
}

/** Re-read persisted state + usage/quota without requesting anything. */
export async function refreshStorageDurability(
	nav: StorageNavigatorLike = defaultNavigator()
): Promise<StorageDurability> {
	const storage = nav.storage;
	if (!storage) {
		state.set(INITIAL);
		return INITIAL;
	}
	let persisted: boolean | null = null;
	let usageBytes: number | null = null;
	let quotaBytes: number | null = null;
	let supported = false;
	try {
		if (storage.persisted) {
			persisted = await storage.persisted();
			supported = true;
		}
		if (storage.estimate) {
			const estimate = await storage.estimate();
			usageBytes = estimate.usage ?? null;
			quotaBytes = estimate.quota ?? null;
			supported = true;
		}
	} catch {
		// Treat a throwing Storage API the same as an absent one.
	}
	const next: StorageDurability = { supported, persisted, usageBytes, quotaBytes };
	state.set(next);
	return next;
}

let persistRequest: Promise<StorageDurability> | null = null;

/** Always issue a persist() request (Settings retry button), then refresh. */
export async function requestStoragePersistence(
	nav: StorageNavigatorLike = defaultNavigator()
): Promise<StorageDurability> {
	try {
		await nav.storage?.persist?.();
	} catch {
		// Denied or unimplemented — refresh below records reality either way.
	}
	return refreshStorageDurability(nav);
}

/**
 * Request persistent storage once per app session (repeat calls coalesce),
 * then refresh the published state. Safe fire-and-forget from startup: never
 * throws, never blocks first paint on anything but the browser's own prompt
 * policy (WebViews grant or deny without UI).
 */
export function ensureStoragePersistence(
	nav: StorageNavigatorLike = defaultNavigator()
): Promise<StorageDurability> {
	if (persistRequest) return persistRequest;
	persistRequest = requestStoragePersistence(nav);
	return persistRequest;
}

/** Test-only: clear the coalesced request between cases. */
export function resetStoragePersistenceForTests(): void {
	persistRequest = null;
	state.set(INITIAL);
}

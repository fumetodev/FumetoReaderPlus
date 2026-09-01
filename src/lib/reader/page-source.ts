/**
 * PageSource abstraction — uniform interface for loading page images
 * regardless of whether they come from local IndexedDB or a remote server.
 */

/**
 * Provides page images from either a local or remote source.
 * Used by ImageCache, translation services, and the reader UI.
 */
export interface PageRequestOptions {
	/** Cancel this page acquisition without changing existing signal-less callers. */
	signal?: AbortSignal;
}

/** Ownership class for bounded remote-session leases. */
export type PageSourcePurpose = 'reader' | 'preview' | 'background';

export interface PageSourceCreateOptions extends PageRequestOptions {
	purpose?: PageSourcePurpose;
}

export function pageRequestCancelledError(): Error {
	const error = new Error('Page request cancelled');
	error.name = 'AbortError';
	return error;
}

export function throwIfPageRequestCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw pageRequestCancelledError();
}

/**
 * Await a possibly non-cancellable source operation while still releasing its
 * caller promptly on abort. The underlying promise remains observed, so a late
 * rejection cannot become unhandled.
 */
export async function awaitPageRequest<T>(
	promise: Promise<T>,
	options: PageRequestOptions = {}
): Promise<T> {
	const signal = options.signal;
	throwIfPageRequestCancelled(signal);
	if (!signal) return promise;

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = () => finish(() => reject(pageRequestCancelledError()));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error))
		);
		if (signal.aborted) onAbort();
	});
}

/** Combine lifecycle and per-request cancellation without relying on AbortSignal.any. */
export function combinePageRequestSignals(
	...signals: Array<AbortSignal | undefined>
): { signal?: AbortSignal; cleanup: () => void } {
	const active = signals.filter((signal): signal is AbortSignal => !!signal);
	if (active.length === 0) return { signal: undefined, cleanup: () => {} };
	if (active.length === 1) return { signal: active[0], cleanup: () => {} };

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	for (const signal of active) {
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) controller.abort();
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const signal of active) signal.removeEventListener('abort', onAbort);
		}
	};
}

export interface PageSource {
	/** Total number of pages in this volume */
	readonly pageCount: number;

	/** Get a page image as a Blob */
	getPage(index: number, options?: PageRequestOptions): Promise<Blob>;

	/**
	 * Get a page image as a File object.
	 * Some APIs (like the translation service) expect File objects.
	 */
	getPageAsFile(index: number, options?: PageRequestOptions): Promise<File>;

	/** Release any held resources (caches, connections, etc.) */
	dispose(): void;
}

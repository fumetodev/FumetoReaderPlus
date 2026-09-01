import { RequestCancelledError } from '$lib/i18n/errors.js';
/**
 * Per-provider request semaphore for local LLM servers.
 *
 * Local servers (Ollama, LM Studio) typically have a single GPU and
 * limited concurrent prediction slots. This module provides a
 * configurable concurrency limiter keyed by provider config ID.
 *
 * Cloud providers (OpenRouter, OpenAI-compatible, Claude) are not
 * limited — they handle concurrency server-side with rate limiting.
 */

/** Release function returned by acquire(). Must be called in a finally block. */
export type ReleaseFn = () => void;

/**
 * A simple counting semaphore built on promise chains.
 *
 * When maxConcurrency is 1, this acts as a mutex — only one task
 * runs at a time, and subsequent tasks queue in FIFO order.
 */
class Semaphore {
	private running = 0;
	private queue: Array<{
		resolve: (release: ReleaseFn) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(private _maxConcurrency: number) {}


	/** Current concurrency limit. */
	get maxConcurrency(): number {
		return this._maxConcurrency;
	}

	/**
	 * Acquire a slot. Resolves immediately if a slot is available,
	 * otherwise waits in FIFO order until one opens up.
	 *
	 * Returns a release function that MUST be called when done
	 * (typically in a finally block).
	 */
	acquire(signal?: AbortSignal): Promise<ReleaseFn> {
		if (signal?.aborted) return Promise.reject(requestQueueCancelledError());
		if (this.running < this._maxConcurrency) {
			this.running++;
			return Promise.resolve(this.createRelease());
		}

		return new Promise<ReleaseFn>((resolve, reject) => {
			const waiter: (typeof this.queue)[number] = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					const position = this.queue.indexOf(waiter);
					if (position < 0) return;
					this.queue.splice(position, 1);
					reject(requestQueueCancelledError());
				};
			signal.addEventListener('abort', waiter.onAbort, { once: true });
			}
			this.queue.push(waiter);
			// Abort dispatch is synchronous, but recheck in case a non-standard
			// signal implementation changed state while the listener was attached.
			if (signal?.aborted) waiter.onAbort?.();
		});
	}

	private createRelease(): ReleaseFn {
		let released = false;
		return () => {
			if (released) return; // idempotent — safe to call twice
			released = true;
			this.running--;
			this.grantNext();
		};
	}

	private grantNext(): void {
		while (this.queue.length > 0 && this.running < this._maxConcurrency) {
			const next = this.queue.shift()!;
			if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
			if (next.signal?.aborted) {
				next.reject(requestQueueCancelledError());
				continue;
			}
			this.running++;
			next.resolve(this.createRelease());
		}
	}

	/** Number of tasks currently waiting to acquire. */
	get pendingCount(): number {
		return this.queue.length;
	}

	/** Number of holders that have a slot right now. */
	get runningCount(): number {
		return this.running;
	}

	/**
	 * Change the limit in place. Replacing the instance instead would strand the
	 * in-flight holders' release closures on the old one, so their slots would
	 * never come back and the new limit would be exceeded by exactly that many.
	 */
	setMaxConcurrency(next: number): void {
		if (next === this._maxConcurrency) return;
		this._maxConcurrency = next;
		// Raising the limit may admit waiters immediately; lowering it simply
		// stops admitting until enough holders release.
		this.grantNext();
	}
}

function requestQueueCancelledError(): Error {
	const error = new RequestCancelledError();
	error.name = 'AbortError';
	return error;
}

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

/** Global registry of semaphores, keyed by provider config ID. */
const semaphores = new Map<string, Semaphore>();

/**
 * Acquire a concurrency slot for the given provider.
 *
 * For local provider types (ollama, lmstudio, local-compatible),
 * limits concurrency to `maxConcurrency` (default 1).
 * For cloud providers (openrouter, openai-compatible, claude),
 * returns null immediately (no limiting).
 *
 * @returns A release function (call in `finally`), or null if no limiting.
 */
export function acquireSlot(
	providerId: string,
	providerType: string,
	maxConcurrency: number = 1,
	signal?: AbortSignal
): Promise<ReleaseFn | null> {
	if (signal?.aborted) return Promise.reject(requestQueueCancelledError());
	// Cloud providers: no concurrency limiting
	if (providerType === 'openrouter' || providerType === 'openai-compatible' || providerType === 'claude') {
		return Promise.resolve(null);
	}

	// Local providers: use configured concurrency
	// The limit is user-editable and applies immediately, so it can change while
	// requests are in flight. This used to swap in a FRESH semaphore whenever
	// nothing was queued — consulting the waiting count where it needed the
	// running one — and the running holders' release closures stayed bound to
	// the orphaned instance. A limit change with two requests in flight and none
	// queued therefore admitted a third immediately: three concurrent
	// predictions against a declared max of one, which is the exact overload
	// this module exists to prevent.
	let sem = semaphores.get(providerId);
	if (!sem) {
		sem = new Semaphore(maxConcurrency);
		semaphores.set(providerId, sem);
	} else {
		sem.setMaxConcurrency(maxConcurrency);
	}

	return sem.acquire(signal);
}

/**
 * Get the number of requests queued (waiting) for a provider.
 * Returns 0 for cloud providers or unknown provider IDs.
 */
export function getQueueDepth(providerId: string): number {
	return semaphores.get(providerId)?.pendingCount ?? 0;
}

import { RequestCancelledError } from '$lib/i18n/errors.js';
/**
 * Shared pacing for cloud providers, across every volume job at once.
 *
 * `request-queue.ts` deliberately does not limit cloud providers — one request
 * at a time would make a single volume needlessly slow. But once several
 * volumes translate in parallel they share one account, and a rate limit earned
 * by one of them applies to all of them. This module is the account-wide view:
 * a small concurrency bound, a minimum spacing between requests, and a cooldown
 * that every job observes when the provider says to slow down.
 *
 * Local providers keep using the per-provider semaphore in request-queue.ts;
 * this is only for the shared, remote kind.
 */

export interface CloudLimiterOptions {
	/** Requests allowed in flight at once, per provider. */
	maxConcurrent: number;
	/** Minimum gap between request starts, per provider. */
	minSpacingMs: number;
	/** Cooldown applied when the provider reports a rate limit without a hint. */
	defaultCooldownMs: number;
	/** Ceiling on any single cooldown, so one bad hint cannot stall for hours. */
	maxCooldownMs: number;
}

export const DEFAULT_CLOUD_LIMITER_OPTIONS: CloudLimiterOptions = {
	maxConcurrent: 2,
	minSpacingMs: 350,
	defaultCooldownMs: 8000,
	maxCooldownMs: 60_000
};

export type ReleaseFn = () => void;

interface ProviderState {
	inFlight: number;
	nextEarliestStart: number;
	cooldownUntil: number;
	consecutiveRateLimits: number;
	waiters: Array<() => void>;
}

const providers = new Map<string, ProviderState>();
let options: CloudLimiterOptions = { ...DEFAULT_CLOUD_LIMITER_OPTIONS };
let now: () => number = () => Date.now();
let sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(cancelled());
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(cancelled());
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

function cancelled(): Error {
	const error = new RequestCancelledError();
	error.name = 'AbortError';
	return error;
}

function stateFor(providerId: string): ProviderState {
	let state = providers.get(providerId);
	if (!state) {
		state = { inFlight: 0, nextEarliestStart: 0, cooldownUntil: 0, consecutiveRateLimits: 0, waiters: [] };
		providers.set(providerId, state);
	}
	return state;
}

/** Only shared, remote accounts need account-wide pacing. */
export function isCloudProviderType(type: string): boolean {
	return type === 'openrouter' || type === 'openai-compatible' || type === 'claude';
}

/**
 * Wait for a turn against `providerId`, then run.
 *
 * Resolves with a release function that MUST be called (a `finally` block) so
 * the slot returns to the pool even when the request throws.
 */
export async function acquireCloudSlot(providerId: string, signal?: AbortSignal): Promise<ReleaseFn> {
	if (signal?.aborted) throw cancelled();
	const state = stateFor(providerId);

	// Concurrency: wait for a slot, re-checking after each wake-up.
	while (state.inFlight >= options.maxConcurrent) {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				const index = state.waiters.indexOf(wake);
				if (index >= 0) state.waiters.splice(index, 1);
				reject(cancelled());
			};
			const wake = () => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			};
			state.waiters.push(wake);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
		if (signal?.aborted) {
			// This waiter was handed the slot and is now declining it. Passing the
			// wake on is what keeps the queue alive: dropping it here destroys the
			// token, and since nothing else will call releaseSlot, every waiter
			// behind this one parks forever.
			state.waiters.shift()?.();
			throw cancelled();
		}
	}

	state.inFlight++;
	try {
		// Cooldown and spacing are re-read in a loop: another job may start a
		// fresh cooldown while this one is already waiting.
		for (;;) {
			const wait = Math.max(state.cooldownUntil - now(), state.nextEarliestStart - now(), 0);
			if (wait <= 0) break;
			await sleep(wait, signal);
		}
		state.nextEarliestStart = now() + options.minSpacingMs;
	} catch (error) {
		releaseSlot(state);
		throw error;
	}

	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseSlot(state);
	};
}

function releaseSlot(state: ProviderState): void {
	state.inFlight = Math.max(0, state.inFlight - 1);
	const next = state.waiters.shift();
	next?.();
}

/**
 * Record a rate limit so every job on this provider backs off together.
 * Repeated limits lengthen the cooldown; a clean request clears the streak.
 */
export function reportProviderRateLimit(providerId: string, retryAfterMs?: number): void {
	const state = stateFor(providerId);
	state.consecutiveRateLimits++;
	const escalating = options.defaultCooldownMs * Math.pow(2, state.consecutiveRateLimits - 1);
	const cooldown = Math.min(retryAfterMs ?? escalating, options.maxCooldownMs);
	state.cooldownUntil = Math.max(state.cooldownUntil, now() + cooldown);
}

/** A successful request: the provider is healthy again. */
export function reportProviderSuccess(providerId: string): void {
	const state = providers.get(providerId);
	if (state) state.consecutiveRateLimits = 0;
}

export function cloudLimiterSnapshot(providerId: string): {
	inFlight: number; queued: number; cooldownRemainingMs: number; consecutiveRateLimits: number;
} {
	const state = providers.get(providerId);
	if (!state) return { inFlight: 0, queued: 0, cooldownRemainingMs: 0, consecutiveRateLimits: 0 };
	return {
		inFlight: state.inFlight,
		queued: state.waiters.length,
		cooldownRemainingMs: Math.max(0, state.cooldownUntil - now()),
		consecutiveRateLimits: state.consecutiveRateLimits
	};
}

/** Test seam: override timing and options, and reset accumulated state. */
export function configureCloudLimiter(overrides: Partial<CloudLimiterOptions> & {
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	reset?: boolean;
} = {}): void {
	const { now: nowOverride, sleep: sleepOverride, reset, ...rest } = overrides;
	options = { ...options, ...rest };
	if (nowOverride) now = nowOverride;
	if (sleepOverride) sleep = sleepOverride;
	if (reset) providers.clear();
}

/** Restore shipped defaults (used by tests). */
export function resetCloudLimiter(): void {
	options = { ...DEFAULT_CLOUD_LIMITER_OPTIONS };
	now = () => Date.now();
	sleep = defaultSleep;
	providers.clear();
}

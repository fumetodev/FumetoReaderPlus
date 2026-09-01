/**
 * Which page failures are worth another attempt, and how long to wait first.
 *
 * A volume translation is a long chain of independent page requests, so the
 * question "is this failure the page's problem or the run's problem?" decides
 * whether a 200-page comic finishes at all. Transient provider trouble — rate
 * limits, upstream capacity, timeouts, a malformed completion — is the page's
 * problem and is worth retrying. A bad key or a rejected request shape is the
 * run's problem: every remaining page would fail the same way, so stop at once
 * rather than burning the user's credit on 199 identical failures.
 */

export type PageFailureCategory =
	| 'coverage' | 'content_filter' | 'auth' | 'rate_limit' | 'invalid_request'
	| 'insufficient_credit' | 'cancelled' | 'parse' | 'timeout' | 'network'
	| 'page_source' | 'server' | 'unknown';

/** How the pass should react to a failed page attempt. */
export type PageFailureDisposition =
	/** Try the same page again after a delay. */
	| 'retry'
	/** Give up on this page, record it, and keep going. */
	| 'skip'
	/** Nothing later will work either — end the pass now. */
	| 'abort';

export interface RetryBudget {
	/** Total attempts per page, including the first. */
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_PAGE_RETRY_BUDGET: RetryBudget = {
	maxAttempts: 3,
	baseDelayMs: 4000,
	maxDelayMs: 60_000
};

let activeBudget: RetryBudget = { ...DEFAULT_PAGE_RETRY_BUDGET };

/** The budget in force for page retries. */
export function pageRetryBudget(): RetryBudget {
	return activeBudget;
}

/** Test seam: shorten (or lengthen) retry waits without changing behaviour. */
export function configurePageRetryBudget(overrides: Partial<RetryBudget>): void {
	activeBudget = { ...activeBudget, ...overrides };
}

export function resetPageRetryBudget(): void {
	activeBudget = { ...DEFAULT_PAGE_RETRY_BUDGET };
}

/**
 * Categories that cannot improve on a later page: retrying wastes time, and
 * continuing wastes money. Note `content_filter` is deliberately absent — one
 * moderated page says nothing about the next one.
 */
const FATAL_CATEGORIES = new Set<PageFailureCategory>([
	'auth', 'invalid_request', 'insufficient_credit', 'cancelled'
]);

/** Transient categories: the same request may well succeed on a second look. */
const RETRYABLE_CATEGORIES = new Set<PageFailureCategory>([
	'rate_limit', 'server', 'timeout', 'network', 'coverage', 'parse', 'page_source'
]);

export function isFatalPageFailure(category: PageFailureCategory): boolean {
	return FATAL_CATEGORIES.has(category);
}

export function isRetryablePageFailure(category: PageFailureCategory): boolean {
	return RETRYABLE_CATEGORIES.has(category);
}

/**
 * Decide what to do after an attempt failed.
 *
 * @param attempt - 1-based number of the attempt that just failed.
 */
export function disposeOfPageFailure(
	category: PageFailureCategory,
	attempt: number,
	budget: RetryBudget = DEFAULT_PAGE_RETRY_BUDGET
): PageFailureDisposition {
	if (isFatalPageFailure(category)) return 'abort';
	if (!isRetryablePageFailure(category)) return 'skip';
	return attempt < budget.maxAttempts ? 'retry' : 'skip';
}

/**
 * Delay before the next attempt: the server's own hint when it gave one,
 * otherwise exponential backoff, always with jitter so parallel volume jobs
 * do not resynchronise into a burst after a shared rate limit.
 */
export function pageRetryDelayMs(
	attempt: number,
	options: { retryAfterMs?: number; budget?: RetryBudget; random?: () => number } = {}
): number {
	const budget = options.budget ?? DEFAULT_PAGE_RETRY_BUDGET;
	const random = options.random ?? Math.random;
	const exponential = budget.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
	const base = Math.min(options.retryAfterMs ?? exponential, budget.maxDelayMs);
	return Math.round(base * (0.75 + random() * 0.5));
}

/** The server's requested wait, when the error carried one. */
export function retryAfterMsOf(error: unknown): number | undefined {
	const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

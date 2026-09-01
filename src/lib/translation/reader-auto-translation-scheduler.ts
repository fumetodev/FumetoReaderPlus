/**
 * Latest-target scheduler for reader-triggered automatic page translation.
 *
 * Reader navigation can change much faster than OCR or translation can settle.
 * This scheduler guarantees that only one injected translation callback runs at
 * a time. A newer page aborts the active callback, replaces any page that was
 * waiting, and starts only the latest target after the active callback settles.
 *
 * The scheduler intentionally knows nothing about Svelte stores, page sources,
 * or translation providers. PageViewer owns those concerns and injects the real
 * translation callback.
 */

export interface ReaderAutoTranslationTarget {
	readerSessionId: string;
	targetEpoch: number;
	volumeUuid: string;
	pageIndex: number;
}

export interface ReaderAutoTranslationRunContext {
	runId: number;
	signal: AbortSignal;
}

/**
 * A loaded page already has an authoritative automatic-translation outcome
 * when it contains at least one overlay item or explicitly records that OCR
 * found no text. Callers deliberately probe this again after waiting for a
 * manual translation: that manual run may have completed while auto work was
 * queued, making the queued provider request redundant.
 */
export function readerPageTranslationOutcomeIsUsable(
	overlay: { items: readonly unknown[] } | null | undefined,
	translation: { no_text_detected?: boolean } | null | undefined
): boolean {
	return Boolean(overlay?.items.length || translation?.no_text_detected);
}

export type ReaderAutoTranslationRun = (
	target: Readonly<ReaderAutoTranslationTarget>,
	context: ReaderAutoTranslationRunContext
) => Promise<void>;

export type ReaderAutoTranslationOutcomeStatus =
	| 'completed'
	| 'cancelled'
	| 'failed'
	| 'superseded'
	| 'disposed';

export interface ReaderAutoTranslationOutcome {
	target: ReaderAutoTranslationTarget;
	status: ReaderAutoTranslationOutcomeStatus;
	runId: number | null;
	error: string | null;
}

export interface ReaderAutoTranslationActiveState {
	target: ReaderAutoTranslationTarget;
	runId: number;
	cancelRequested: boolean;
}

export interface ReaderAutoTranslationSchedulerState {
	phase: 'idle' | 'running' | 'cancelling' | 'disposed';
	active: ReaderAutoTranslationActiveState | null;
	pending: ReaderAutoTranslationTarget | null;
	lastOutcome: ReaderAutoTranslationOutcome | null;
}

export interface ReaderAutoTranslationScheduler {
	/**
	 * Schedule a target. Repeated requests for the same active or pending target
	 * share the same promise and never create a duplicate translation run.
	 */
	request(target: ReaderAutoTranslationTarget): Promise<ReaderAutoTranslationOutcome>;

	/** Return an immutable snapshot suitable for diagnostics and test hooks. */
	inspect(): ReaderAutoTranslationSchedulerState;

	/** Subscribe to state snapshots. The current state is delivered immediately. */
	subscribe(listener: (state: ReaderAutoTranslationSchedulerState) => void): () => void;

	/** Cancel current/pending work while keeping the scheduler reusable. */
	cancel(): void;

	/**
	 * Reject new work, discard pending work, abort the active callback, and wait
	 * for that callback to settle. Safe to call repeatedly.
	 */
	dispose(): Promise<void>;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface ScheduledRequest {
	target: ReaderAutoTranslationTarget;
	deferred: Deferred<ReaderAutoTranslationOutcome>;
}

interface ActiveRequest extends ScheduledRequest {
	runId: number;
	controller: AbortController;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function copyTarget(target: ReaderAutoTranslationTarget): ReaderAutoTranslationTarget {
	return {
		readerSessionId: target.readerSessionId,
		targetEpoch: target.targetEpoch,
		volumeUuid: target.volumeUuid,
		pageIndex: target.pageIndex
	};
}

function sameTarget(
	left: ReaderAutoTranslationTarget,
	right: ReaderAutoTranslationTarget
): boolean {
	return left.readerSessionId === right.readerSessionId
		&& left.targetEpoch === right.targetEpoch
		&& left.volumeUuid === right.volumeUuid
		&& left.pageIndex === right.pageIndex;
}

function validateTarget(target: ReaderAutoTranslationTarget): ReaderAutoTranslationTarget {
	const readerSessionId = target.readerSessionId.trim();
	const volumeUuid = target.volumeUuid.trim();
	if (!readerSessionId) throw new TypeError('Reader auto-translation target requires a reader session ID');
	if (!Number.isSafeInteger(target.targetEpoch) || target.targetEpoch < 0) {
		throw new TypeError('Reader auto-translation target epoch must be a non-negative integer');
	}
	if (!volumeUuid) throw new TypeError('Reader auto-translation target requires a volume UUID');
	if (!Number.isInteger(target.pageIndex) || target.pageIndex < 0) {
		throw new TypeError('Reader auto-translation target page index must be a non-negative integer');
	}
	return { readerSessionId, targetEpoch: target.targetEpoch, volumeUuid, pageIndex: target.pageIndex };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function copyOutcome(
	outcome: ReaderAutoTranslationOutcome | null
): ReaderAutoTranslationOutcome | null {
	return outcome
		? { ...outcome, target: copyTarget(outcome.target) }
		: null;
}

/** Create a scheduler scoped to one mounted reader lifecycle. */
export function createReaderAutoTranslationScheduler(
	run: ReaderAutoTranslationRun
): ReaderAutoTranslationScheduler {
	let active: ActiveRequest | null = null;
	let pending: ScheduledRequest | null = null;
	let lastOutcome: ReaderAutoTranslationOutcome | null = null;
	let nextRunId = 0;
	let disposed = false;
	let disposePromise: Promise<void> | null = null;
	const listeners = new Set<(state: ReaderAutoTranslationSchedulerState) => void>();

	const inspect = (): ReaderAutoTranslationSchedulerState => {
		let phase: ReaderAutoTranslationSchedulerState['phase'];
		if (disposed) phase = 'disposed';
		else if (!active) phase = 'idle';
		else if (active.controller.signal.aborted) phase = 'cancelling';
		else phase = 'running';

		return {
			phase,
			active: active
				? {
					target: copyTarget(active.target),
					runId: active.runId,
					cancelRequested: active.controller.signal.aborted
				}
				: null,
			pending: pending ? copyTarget(pending.target) : null,
			lastOutcome: copyOutcome(lastOutcome)
		};
	};

	const publish = (): void => {
		const state = inspect();
		for (const listener of listeners) listener(state);
	};

	const settleWithoutRun = (
		request: ScheduledRequest,
		status: 'superseded' | 'disposed' | 'cancelled'
	): void => {
		request.deferred.resolve({
			target: copyTarget(request.target),
			status,
			runId: null,
			error: null
		});
	};

	const startPending = (): void => {
		if (disposed || active || !pending) return;

		const scheduled = pending;
		pending = null;
		const job: ActiveRequest = {
			...scheduled,
			runId: ++nextRunId,
			controller: new AbortController()
		};
		active = job;
		publish();

		void (async () => {
			let outcome: ReaderAutoTranslationOutcome;
			try {
				await run(copyTarget(job.target), {
					runId: job.runId,
					signal: job.controller.signal
				});
				outcome = {
					target: copyTarget(job.target),
					status: job.controller.signal.aborted ? 'cancelled' : 'completed',
					runId: job.runId,
					error: null
				};
			} catch (error) {
				outcome = {
					target: copyTarget(job.target),
					status: job.controller.signal.aborted ? 'cancelled' : 'failed',
					runId: job.runId,
					error: job.controller.signal.aborted ? null : errorMessage(error)
				};
			}

			// Only the exact active job may release the serialization gate.
			if (active === job) active = null;
			lastOutcome = outcome;
			job.deferred.resolve(copyOutcome(outcome)!);

			if (!disposed && pending) startPending();
			else publish();
		})();
	};

	const request = (
		rawTarget: ReaderAutoTranslationTarget
	): Promise<ReaderAutoTranslationOutcome> => {
		const target = validateTarget(rawTarget);
		if (disposed) {
			return Promise.resolve({
				target,
				status: 'disposed',
				runId: null,
				error: null
			});
		}

		// The pending request represents the latest navigation target. It wins the
		// dedupe check even while an older active callback is settling cancellation.
		if (pending && sameTarget(pending.target, target)) {
			return pending.deferred.promise;
		}
		if (
			!pending
			&& active
			&& !active.controller.signal.aborted
			&& sameTarget(active.target, target)
		) {
			return active.deferred.promise;
		}

		if (pending) {
			settleWithoutRun(pending, 'superseded');
			pending = null;
		}

		const scheduled: ScheduledRequest = {
			target,
			deferred: createDeferred<ReaderAutoTranslationOutcome>()
		};
		pending = scheduled;

		if (active) {
			// Abort dispatch is synchronous. The next callback is intentionally not
			// started here; startPending runs only after the active promise settles.
			if (!active.controller.signal.aborted) active.controller.abort();
			publish();
		} else {
			startPending();
		}

		return scheduled.deferred.promise;
	};

	const subscribe = (
		listener: (state: ReaderAutoTranslationSchedulerState) => void
	): (() => void) => {
		listener(inspect());
		if (disposed) return () => {};
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	const cancel = (): void => {
		if (disposed) return;
		if (pending) {
			settleWithoutRun(pending, 'cancelled');
			pending = null;
		}
		if (active && !active.controller.signal.aborted) active.controller.abort();
		publish();
	};

	const dispose = (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposed = true;

		if (pending) {
			settleWithoutRun(pending, 'disposed');
			pending = null;
		}
		if (active && !active.controller.signal.aborted) active.controller.abort();
		publish();

		const activeSettlement = active?.deferred.promise ?? Promise.resolve();
		disposePromise = activeSettlement.then(() => {
			publish();
			listeners.clear();
		});
		return disposePromise;
	};

	return { request, inspect, subscribe, cancel, dispose };
}

import { snapshotFumetoSettings, type FumetoSettings } from '$lib/settings/settings.js';
import type { PageOverlayData, PageTranslation } from '$lib/types/index.js';
import {
	acquirePageTranslationActivity,
	markPageTranslationActivityCancelling,
	releasePageTranslationActivity,
	type PageTranslationActivityToken
} from './page-translation-activity.js';
import { isTranslationCoverageError } from './translation-coverage.js';

export interface ReaderPageTranslationTarget {
	readerSessionId: string;
	targetEpoch: number;
	volumeUuid: string;
	pageIndex: number;
}

export type ReaderPageTranslationPhase =
	| 'idle'
	| 'acquiring-page'
	| 'detecting'
	| 'translating'
	| 'repairing'
	| 'persisting'
	| 'post-processing'
	| 'cancelling'
	| 'completed'
	| 'failed';

export type ReaderPageTranslationCancelReason =
	| 'explicit-user'
	| 'target-changed'
	| 'target-deleted'
	| 'superseded'
	| 'shutdown';

export interface ReaderPageTranslationProgress {
	completed: number;
	total: number;
	currentBoxId: number | null;
}

export interface ReaderPageTranslationSnapshot {
	phase: ReaderPageTranslationPhase;
	runId: number | null;
	target: ReaderPageTranslationTarget | null;
	pipeline: 'on-device' | 'off-device' | null;
	progress: ReaderPageTranslationProgress | null;
	cancelReason: ReaderPageTranslationCancelReason | null;
	/** True once the page-translation repository transaction has committed. */
	resultCommitted: boolean;
	error: string | null;
	coverageFailure: {
		recognized: number;
		translated: number;
		retryable: true;
	} | null;
}

export interface ReaderPageTranslationResult {
	pageTranslation: PageTranslation;
	overlayData: PageOverlayData | null;
}

export interface ReaderPageTranslationOutcome {
	status: 'completed' | 'cancelled' | 'failed' | 'superseded';
	runId: number | null;
	target: ReaderPageTranslationTarget;
	resultCommitted: boolean;
	error: string | null;
}

export interface ReaderPageTranslationRunContext {
	readonly runId: number;
	readonly target: Readonly<ReaderPageTranslationTarget>;
	readonly signal: AbortSignal;
	readonly settings: Readonly<FumetoSettings>;
	setPhase(phase: Exclude<ReaderPageTranslationPhase, 'idle' | 'completed' | 'failed' | 'cancelling'>): void;
	setProgress(progress: ReaderPageTranslationProgress, force?: boolean): void;
	/**
	 * Record the durable commit and publish it only while this exact reader target
	 * still owns the run. An explicit cancellation after the commit is allowed to
	 * retain the saved result; navigation and supersession are not.
	 */
	publishCommitted(result: ReaderPageTranslationResult): boolean;
	shouldPublish(): boolean;
}

export interface ReaderPageTranslationControllerDependencies {
	execute(context: ReaderPageTranslationRunContext): Promise<ReaderPageTranslationResult>;
	snapshotSettings(): FumetoSettings;
	publish?(result: ReaderPageTranslationResult, context: ReaderPageTranslationRunContext): void;
	now?: () => number;
}

export interface ReaderPageTranslationController {
	requestManual(target: ReaderPageTranslationTarget): Promise<ReaderPageTranslationOutcome>;
	setTarget(target: ReaderPageTranslationTarget): void;
	cancel(runId: number, reason: ReaderPageTranslationCancelReason): void;
	acknowledgeTerminalState(target?: ReaderPageTranslationTarget): void;
	inspect(): ReaderPageTranslationSnapshot;
	subscribe(listener: (state: ReaderPageTranslationSnapshot) => void): () => void;
	dispose(): Promise<void>;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface ScheduledRequest {
	target: ReaderPageTranslationTarget;
	deferred: Deferred<ReaderPageTranslationOutcome>;
}

interface ActiveRun extends ScheduledRequest {
	runId: number;
	controller: AbortController;
	settings: FumetoSettings;
	activity: PageTranslationActivityToken;
	cancelReason: ReaderPageTranslationCancelReason | null;
	committedResult: ReaderPageTranslationResult | null;
	resultPublished: boolean;
	settled: Promise<void>;
}

const IDLE_SNAPSHOT: ReaderPageTranslationSnapshot = {
	phase: 'idle',
	runId: null,
	target: null,
	pipeline: null,
	progress: null,
	cancelReason: null,
	resultCommitted: false,
	error: null,
	coverageFailure: null
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

function cloneTarget(target: Readonly<ReaderPageTranslationTarget>): ReaderPageTranslationTarget {
	return { ...target };
}

function sameTarget(
	left: Readonly<ReaderPageTranslationTarget> | null,
	right: Readonly<ReaderPageTranslationTarget> | null
): boolean {
	return !!left && !!right
		&& left.readerSessionId === right.readerSessionId
		&& left.targetEpoch === right.targetEpoch
		&& left.volumeUuid === right.volumeUuid
		&& left.pageIndex === right.pageIndex;
}

function cloneSnapshot(snapshot: Readonly<ReaderPageTranslationSnapshot>): ReaderPageTranslationSnapshot {
	return {
		...snapshot,
		target: snapshot.target ? cloneTarget(snapshot.target) : null,
		progress: snapshot.progress ? { ...snapshot.progress } : null,
		coverageFailure: snapshot.coverageFailure ? { ...snapshot.coverageFailure } : null
	};
}

export function createReaderPageTranslationController(
	dependencies: ReaderPageTranslationControllerDependencies
): ReaderPageTranslationController {
	let state = cloneSnapshot(IDLE_SNAPSHOT);
	let currentTarget: ReaderPageTranslationTarget | null = null;
	let active: ActiveRun | null = null;
	let pending: ScheduledRequest | null = null;
	let nextRunId = 0;
	let disposed = false;
	let disposePromise: Promise<void> | null = null;
	let lastProgressPublishedAt = -Infinity;
	const now = dependencies.now ?? (() => performance.now());
	const listeners = new Set<(snapshot: ReaderPageTranslationSnapshot) => void>();

	const inspect = () => cloneSnapshot(state);
	const publish = (patch?: Partial<ReaderPageTranslationSnapshot>) => {
		if (patch) state = { ...state, ...patch };
		const snapshot = inspect();
		for (const listener of listeners) listener(snapshot);
	};
	const outcome = (
		scheduled: ScheduledRequest,
		status: ReaderPageTranslationOutcome['status'],
		runId: number | null,
		error: string | null = null,
		resultCommitted = false
	): ReaderPageTranslationOutcome => ({
		status,
		runId,
		target: cloneTarget(scheduled.target),
		resultCommitted,
		error
	});

	const cancelActive = (reason: ReaderPageTranslationCancelReason) => {
		if (!active || active.controller.signal.aborted) return;
		active.cancelReason = reason;
		markPageTranslationActivityCancelling(active.activity);
		active.controller.abort(reason);
		publish({ phase: 'cancelling', cancelReason: reason, error: null, coverageFailure: null });
	};

	const startPending = () => {
		if (disposed || active || !pending) return;
		const scheduled = pending;
		pending = null;
		const runId = ++nextRunId;
		const controller = new AbortController();
		let settings!: FumetoSettings;
		let activity!: PageTranslationActivityToken;
		let run!: ActiveRun;
		let pipeline: ReaderPageTranslationSnapshot['pipeline'] = null;
		try {
			settings = snapshotFumetoSettings(dependencies.snapshotSettings());
			pipeline = settings.translationPipeline;
			activity = acquirePageTranslationActivity('manual', scheduled.target, {
				cancel(reason) {
					if (active === run) cancelActive(reason);
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			publish({
				phase: 'failed',
				runId,
				target: cloneTarget(scheduled.target),
				pipeline,
				progress: null,
				cancelReason: null,
				resultCommitted: false,
				error: message,
				coverageFailure: null
			});
			scheduled.deferred.resolve(outcome(scheduled, 'failed', runId, message));
			queueMicrotask(startPending);
			return;
		}
		run = {
			...scheduled,
			runId,
			controller,
			settings,
			activity,
			cancelReason: null,
			committedResult: null,
			resultPublished: false,
			settled: Promise.resolve()
		};
		active = run;
		lastProgressPublishedAt = -Infinity;
		publish({
			phase: 'acquiring-page',
			runId,
			target: cloneTarget(scheduled.target),
			pipeline: settings.translationPipeline,
			progress: null,
			cancelReason: null,
			resultCommitted: false,
			error: null,
			coverageFailure: null
		});

		const context: ReaderPageTranslationRunContext = {
			runId,
			target: Object.freeze(cloneTarget(scheduled.target)),
			signal: controller.signal,
			settings: Object.freeze(settings),
			setPhase(phase) {
				if (active !== run || controller.signal.aborted) return;
				publish({ phase });
			},
			setProgress(progress, force = false) {
				if (active !== run || controller.signal.aborted) return;
				const timestamp = now();
				if (!force && timestamp - lastProgressPublishedAt < 100) return;
				lastProgressPublishedAt = timestamp;
				publish({ progress: { ...progress } });
			},
			publishCommitted(result) {
				if (active !== run) return false;
				if (
					result.pageTranslation.volume_uuid !== scheduled.target.volumeUuid
					|| result.pageTranslation.page_index !== scheduled.target.pageIndex
				) throw new TypeError('Committed page translation belongs to another target');
				if (result.pageTranslation.overlay_data !== undefined
					&& result.pageTranslation.overlay_data !== result.overlayData) {
					throw new TypeError('Committed page translation and overlay are not one coherent payload');
				}
				if (run.committedResult) return run.resultPublished;

				run.committedResult = result;
				publish({ resultCommitted: true });
				const cancellationAllowsPublication = run.cancelReason === null
					|| run.cancelReason === 'explicit-user';
				if (
					active !== run
					|| !sameTarget(currentTarget, scheduled.target)
					|| !cancellationAllowsPublication
				) return false;

				// The controller owns the exact-target gate. Dependency publishers must
				// not re-check AbortSignal, because explicit cancellation may race just
				// after the IndexedDB transaction has committed.
				dependencies.publish?.(result, context);
				run.resultPublished = true;
				return true;
			},
			shouldPublish: () => active === run
				&& !controller.signal.aborted
				&& sameTarget(currentTarget, scheduled.target)
		};

		run.settled = (async () => {
			const settleCancellation = () => {
				const savedAfterExplicitCancellation = run.resultPublished
					&& run.cancelReason === 'explicit-user'
					&& active === run
					&& sameTarget(currentTarget, scheduled.target);
				publish({
					phase: 'completed',
					cancelReason: run.cancelReason,
					resultCommitted: run.committedResult !== null,
					error: null,
					coverageFailure: null
				});
				scheduled.deferred.resolve(outcome(
					scheduled,
					savedAfterExplicitCancellation ? 'completed' : 'cancelled',
					runId,
					null,
					run.committedResult !== null
				));
			};
			try {
				const result = await dependencies.execute(context);
				if (controller.signal.aborted || active !== run) {
					settleCancellation();
					return;
				}
				context.setProgress(state.progress ?? { completed: 1, total: 1, currentBoxId: null }, true);
				if (!run.committedResult) context.publishCommitted(result);
				publish({
					phase: 'completed',
					progress: state.progress,
					resultCommitted: run.committedResult !== null,
					error: null,
					coverageFailure: null
				});
				scheduled.deferred.resolve(outcome(
					scheduled,
					'completed',
					runId,
					null,
					run.committedResult !== null
				));
			} catch (error) {
				if (controller.signal.aborted) {
					settleCancellation();
				} else {
					const message = error instanceof Error ? error.message : String(error);
					const coverageFailure = isTranslationCoverageError(error) ? {
						recognized: error.recognizedCount,
						translated: error.translatedCount,
						retryable: true as const
					} : null;
					publish({
						phase: 'failed',
						resultCommitted: run.committedResult !== null,
						error: message,
						coverageFailure
					});
					scheduled.deferred.resolve(outcome(
						scheduled,
						'failed',
						runId,
						message,
						run.committedResult !== null
					));
				}
			} finally {
				releasePageTranslationActivity(activity);
				if (active === run) active = null;
				queueMicrotask(startPending);
			}
		})();
	};

	return {
		requestManual(target) {
			const normalized = cloneTarget(target);
			if (disposed) return Promise.resolve({
				status: 'cancelled', runId: null, target: normalized, resultCommitted: false, error: null
			});
			if (!currentTarget || !sameTarget(currentTarget, normalized)) {
				currentTarget = normalized;
				if (active && !sameTarget(active.target, normalized)) cancelActive('target-changed');
			}
			// Joining a run that is already unwinding means the caller's request is
			// never performed: `pending` is never set, so the finished run's
			// `startPending` finds nothing to start, and the promise resolves
			// 'cancelled'. The user asked to re-translate and got a cancellation
			// chip instead. The automatic scheduler already tests this.
			if (active && !active.controller.signal.aborted && sameTarget(active.target, normalized)) {
				return active.deferred.promise;
			}
			if (pending && sameTarget(pending.target, normalized)) return pending.deferred.promise;
			if (pending) {
				pending.deferred.resolve(outcome(pending, 'superseded', null));
			}
			const scheduled = { target: normalized, deferred: deferred<ReaderPageTranslationOutcome>() };
			pending = scheduled;
			if (active) cancelActive('superseded');
			else startPending();
			return scheduled.deferred.promise;
		},
		setTarget(target) {
			const normalized = cloneTarget(target);
			if (sameTarget(currentTarget, normalized)) return;
			currentTarget = normalized;
			if (pending && !sameTarget(pending.target, normalized)) {
				pending.deferred.resolve(outcome(pending, 'superseded', null));
				pending = null;
			}
			if (active && !sameTarget(active.target, normalized)) cancelActive('target-changed');
			else if (!active && (state.phase === 'completed' || state.phase === 'failed')) {
				publish({ ...IDLE_SNAPSHOT, target: normalized });
			}
		},
		cancel(runId, reason) {
			if (active?.runId !== runId) return;
			cancelActive(reason);
		},
		acknowledgeTerminalState(target) {
			if (active || pending || (state.phase !== 'completed' && state.phase !== 'failed')) return;
			if (target && state.target && !sameTarget(target, state.target)) return;
			const acknowledgedTarget = target ?? currentTarget ?? state.target;
			publish({
				...IDLE_SNAPSHOT,
				target: acknowledgedTarget ? cloneTarget(acknowledgedTarget) : null
			});
		},
		inspect,
		subscribe(listener) {
			listener(inspect());
			if (disposed) return () => {};
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			if (disposePromise) return disposePromise;
			disposed = true;
			if (pending) {
				pending.deferred.resolve(outcome(pending, 'superseded', null));
				pending = null;
			}
			cancelActive('shutdown');
			disposePromise = (active?.settled ?? Promise.resolve()).then(() => {
				listeners.clear();
			});
			return disposePromise;
		}
	};
}

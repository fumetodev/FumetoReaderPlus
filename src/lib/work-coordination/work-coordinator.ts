import { randomUUID } from '$lib/util/uuid.js';

export type WorkPriority = 0 | 1 | 2 | 3;
export type WorkTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkOperationContext {
	readonly taskId: string;
	readonly signal: AbortSignal;
}

export interface WorkSubmission<T> {
	kind: string;
	owner: string;
	lane: string;
	priority: WorkPriority;
	coalescingKey?: string;
	signal?: AbortSignal;
	operation(context: WorkOperationContext): Promise<T> | T;
}

export interface WorkDiagnostic {
	taskId: string;
	kind: string;
	owner: string;
	lane: string;
	priority: WorkPriority;
	effectivePriority: WorkPriority;
	coalescingKey?: string;
	state: WorkTaskState;
	enqueuedAt: number;
	startedAt?: number;
	finishedAt?: number;
	waitMs?: number;
	runMs?: number;
	cancellationReason?: string;
	error?: string;
	activeResourceCount: number;
}

export interface WorkTaskHandle<T> {
	readonly id: string;
	readonly promise: Promise<T>;
	cancel(reason?: string): void;
}

export interface WorkCoordinatorOptions {
	now?: () => number;
	agingIntervalMs?: number;
	maxDiagnostics?: number;
	defaultLaneCapacity?: number;
	diagnosticsEnabled?: boolean;
}

interface Subscriber<T> {
	settled: boolean;
	resolve(value: T): void;
	reject(error: unknown): void;
	removeAbortListener?: () => void;
}

interface QueuedTask<T = unknown> {
	id: string;
	sequence: number;
	submission: WorkSubmission<T>;
	enqueuedAt: number;
	state: WorkTaskState;
	controller: AbortController;
	subscribers: Set<Subscriber<T>>;
	startedAt?: number;
}

interface LaneState {
	capacity: number;
	active: number;
	queue: QueuedTask[];
	drainScheduled: boolean;
}

function abortError(reason = 'Work cancelled'): Error {
	const error = new Error(reason);
	error.name = 'AbortError';
	return error;
}

/**
 * Domain-neutral priority scheduler. Operations are non-preemptive after they
 * start; callers keep work responsive by submitting small operations and by
 * waiting for retry delays outside a lane.
 */
export class WorkCoordinator {
	private readonly lanes = new Map<string, LaneState>();
	private readonly coalesced = new Map<string, QueuedTask>();
	private readonly listeners = new Set<(diagnostic: WorkDiagnostic) => void>();
	private readonly history: WorkDiagnostic[] = [];
	private readonly now: () => number;
	private readonly agingIntervalMs: number;
	private readonly maxDiagnostics: number;
	private readonly defaultLaneCapacity: number;
	private readonly diagnosticsEnabled: boolean;
	private sequence = 0;

	constructor(options: WorkCoordinatorOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.agingIntervalMs = options.agingIntervalMs ?? 2_000;
		this.maxDiagnostics = options.maxDiagnostics ?? 200;
		this.defaultLaneCapacity = Math.max(1, Math.floor(options.defaultLaneCapacity ?? 1));
		this.diagnosticsEnabled = options.diagnosticsEnabled ?? import.meta.env.DEV;
	}

	setLaneCapacity(lane: string, capacity: number): void {
		const state = this.lane(lane);
		state.capacity = Math.max(1, Math.floor(capacity));
		this.scheduleDrain(lane, state);
	}

	submit<T>(submission: WorkSubmission<T>): WorkTaskHandle<T> {
		if (submission.signal?.aborted) {
			const error = abortError(String(submission.signal.reason ?? 'Work cancelled'));
			return { id: randomUUID(), promise: Promise.reject(error), cancel() {} };
		}

		const coalescingId = submission.coalescingKey
			? `${submission.lane}\u0000${submission.coalescingKey}`
			: undefined;
		let task = coalescingId ? this.coalesced.get(coalescingId) as QueuedTask<T> | undefined : undefined;
		// A task whose controller is already aborted is stale even if still
		// 'running': it cannot do work on the new subscriber's behalf. cancelTask
		// removes such tasks from the map, so this condition is defensive — it
		// guards any future abort path that forgets to.
		if (!task || task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled'
			|| task.controller.signal.aborted) {
			task = {
				id: randomUUID(),
				sequence: this.sequence++,
				submission,
				enqueuedAt: this.now(),
				state: 'queued',
				controller: new AbortController(),
				subscribers: new Set()
			};
			this.lane(submission.lane).queue.push(task);
			if (coalescingId) this.coalesced.set(coalescingId, task);
			this.publish(task, 'queued');
			this.scheduleDrain(submission.lane, this.lane(submission.lane));
		}

		return this.addSubscriber(task, submission.signal);
	}

	subscribe(listener: (diagnostic: WorkDiagnostic) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	inspect(): { active: number; queued: number; lanes: Record<string, { active: number; queued: number; capacity: number }>; recent: WorkDiagnostic[] } {
		let active = 0;
		let queued = 0;
		const lanes: Record<string, { active: number; queued: number; capacity: number }> = {};
		for (const [name, lane] of this.lanes) {
			active += lane.active;
			queued += lane.queue.length;
			lanes[name] = { active: lane.active, queued: lane.queue.length, capacity: lane.capacity };
		}
		return { active, queued, lanes, recent: [...this.history] };
	}

	private addSubscriber<T>(task: QueuedTask<T>, signal?: AbortSignal): WorkTaskHandle<T> {
		let subscriber!: Subscriber<T>;
		const promise = new Promise<T>((resolve, reject) => {
			subscriber = { settled: false, resolve, reject };
		});
		task.subscribers.add(subscriber);

		const cancel = (reason = 'Work cancelled') => {
			if (subscriber.settled) return;
			subscriber.settled = true;
			subscriber.removeAbortListener?.();
			task.subscribers.delete(subscriber);
			subscriber.reject(abortError(reason));
			if (task.subscribers.size === 0) this.cancelTask(task, reason);
		};

		if (signal) {
			const onAbort = () => cancel(String(signal.reason ?? 'Work cancelled'));
			signal.addEventListener('abort', onAbort, { once: true });
			subscriber.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
		}
		return { id: task.id, promise, cancel };
	}

	private cancelTask(task: QueuedTask, reason: string): void {
		if (task.state === 'queued') {
			const lane = this.lane(task.submission.lane);
			const index = lane.queue.indexOf(task);
			if (index >= 0) lane.queue.splice(index, 1);
			task.state = 'cancelled';
			task.controller.abort(reason);
			this.removeCoalescing(task);
			this.publish(task, 'cancelled', { cancellationReason: reason, finishedAt: this.now() });
			return;
		}
		if (task.state === 'running') {
			task.controller.abort(reason);
			// An aborted running task can no longer serve new subscribers — its
			// operation is winding down and will resolve with whatever partial state
			// it had. Leaving it in the coalescing map would hand the *next* submit
			// with this key a doomed task that then "completes" without doing the
			// work (observed: tab previews silently never regenerating). Removing it
			// here restores the invariant that a coalescing entry is always joinable;
			// run()'s finally-removal stays idempotent because it identity-checks.
			this.removeCoalescing(task);
		}
	}

	private lane(name: string): LaneState {
		let lane = this.lanes.get(name);
		if (!lane) {
			lane = { capacity: this.defaultLaneCapacity, active: 0, queue: [], drainScheduled: false };
			this.lanes.set(name, lane);
		}
		return lane;
	}

	private scheduleDrain(name: string, lane: LaneState): void {
		if (lane.drainScheduled) return;
		lane.drainScheduled = true;
		queueMicrotask(() => {
			lane.drainScheduled = false;
			this.drain(name, lane);
		});
	}

	private drain(name: string, lane: LaneState): void {
		while (lane.active < lane.capacity && lane.queue.length > 0) {
			const task = this.takeNext(lane.queue);
			if (!task || task.state !== 'queued') continue;
			lane.active += 1;
			void this.run(name, lane, task);
		}
	}

	private takeNext(queue: QueuedTask[]): QueuedTask | undefined {
		const now = this.now();
		let bestIndex = -1;
		let bestPriority: WorkPriority = 3;
		let bestSequence = Number.POSITIVE_INFINITY;
		for (let index = 0; index < queue.length; index += 1) {
			const task = queue[index];
			const priority = this.effectivePriority(task, now);
			if (bestIndex < 0 || priority < bestPriority || (priority === bestPriority && task.sequence < bestSequence)) {
				bestIndex = index;
				bestPriority = priority;
				bestSequence = task.sequence;
			}
		}
		return bestIndex < 0 ? undefined : queue.splice(bestIndex, 1)[0];
	}

	private effectivePriority(task: QueuedTask, now = this.now()): WorkPriority {
		if (task.submission.priority <= 1) return task.submission.priority;
		const agedTiers = Math.floor(Math.max(0, now - task.enqueuedAt) / this.agingIntervalMs);
		return Math.max(1, task.submission.priority - agedTiers) as WorkPriority;
	}

	private async run(name: string, lane: LaneState, task: QueuedTask): Promise<void> {
		task.state = 'running';
		task.startedAt = this.now();
		this.publish(task, 'running', { startedAt: task.startedAt, waitMs: task.startedAt - task.enqueuedAt });
		try {
			const value = await task.submission.operation({ taskId: task.id, signal: task.controller.signal });
			if (task.controller.signal.aborted && task.subscribers.size === 0) {
				task.state = 'cancelled';
				this.publish(task, 'cancelled', {
					finishedAt: this.now(),
					cancellationReason: String(task.controller.signal.reason ?? 'Work cancelled')
				});
			} else {
				task.state = 'completed';
				this.settle(task, 'resolve', value);
				this.publish(task, 'completed', { finishedAt: this.now() });
			}
		} catch (error) {
			const cancelled = task.controller.signal.aborted;
			task.state = cancelled ? 'cancelled' : 'failed';
			this.settle(task, 'reject', cancelled ? abortError(String(task.controller.signal.reason ?? 'Work cancelled')) : error);
			this.publish(task, task.state, {
				finishedAt: this.now(),
				cancellationReason: cancelled ? String(task.controller.signal.reason ?? 'Work cancelled') : undefined,
				error: cancelled ? undefined : error instanceof Error ? error.message : String(error)
			});
		} finally {
			this.removeCoalescing(task);
			lane.active -= 1;
			this.scheduleDrain(name, lane);
		}
	}

	private settle<T>(task: QueuedTask<T>, action: 'resolve' | 'reject', value: unknown): void {
		for (const subscriber of task.subscribers) {
			if (subscriber.settled) continue;
			subscriber.settled = true;
			subscriber.removeAbortListener?.();
			if (action === 'resolve') subscriber.resolve(value as T);
			else subscriber.reject(value);
		}
		task.subscribers.clear();
	}

	private removeCoalescing(task: QueuedTask): void {
		const key = task.submission.coalescingKey;
		if (!key) return;
		const id = `${task.submission.lane}\u0000${key}`;
		if (this.coalesced.get(id) === task) this.coalesced.delete(id);
	}

	private publish(task: QueuedTask, state: WorkTaskState, extra: Partial<WorkDiagnostic> = {}): void {
		if (!this.diagnosticsEnabled && this.listeners.size === 0) return;
		const now = this.now();
		const finishedAt = extra.finishedAt;
		const diagnostic: WorkDiagnostic = {
			taskId: task.id,
			kind: task.submission.kind,
			owner: task.submission.owner,
			lane: task.submission.lane,
			priority: task.submission.priority,
			effectivePriority: this.effectivePriority(task, now),
			coalescingKey: task.submission.coalescingKey,
			state,
			enqueuedAt: task.enqueuedAt,
			startedAt: extra.startedAt ?? task.startedAt,
			finishedAt,
			waitMs: extra.waitMs ?? (task.startedAt === undefined ? undefined : task.startedAt - task.enqueuedAt),
			runMs: finishedAt === undefined || task.startedAt === undefined ? undefined : finishedAt - task.startedAt,
			cancellationReason: extra.cancellationReason,
			error: extra.error,
			activeResourceCount: [...this.lanes.values()].reduce((count, lane) => count + lane.active, 0)
		};
		this.history.push(diagnostic);
		if (this.history.length > this.maxDiagnostics) this.history.splice(0, this.history.length - this.maxDiagnostics);
		for (const listener of this.listeners) listener(diagnostic);
	}
}

export const appWorkCoordinator = new WorkCoordinator();

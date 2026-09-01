import { readable, type Readable } from 'svelte/store';
import type { OverlayPlanPhase, OverlayPlanSnapshot } from '$lib/overlay-layout/controller.js';
import type { OverlayRenderPlanV2 } from '$lib/types/index.js';

export interface ReaderOverlayPlanningTarget {
	volumeUuid: string;
	pageIndex: number;
}

export interface ReaderOverlayPlanningStatus {
	phase: OverlayPlanPhase;
	target: Readonly<ReaderOverlayPlanningTarget> | null;
	key: string | null;
	planId: string | null;
	/**
	 * The plan the displayed page is showing, for surfaces beside the overlay
	 * that need to say what happened to each box (the page's box list). The
	 * overlay owns its planner; this is a read-only mirror of its last result.
	 */
	plan: OverlayRenderPlanV2 | null;
	error: string | null;
	revision: number;
}

/**
 * A lease identifies one displayed-page planning generation. Publishing through
 * an older lease is a no-op, even when the old page finishes after navigation.
 */
export interface ReaderOverlayPlanningLease {
	readonly id: number;
	readonly target: Readonly<ReaderOverlayPlanningTarget>;
}

export interface ReaderOverlayPlanningPublication {
	phase: OverlayPlanPhase;
	key?: string | null;
	planId?: string | null;
	plan?: OverlayRenderPlanV2 | null;
	error?: string | null;
}

const initialStatus = (): ReaderOverlayPlanningStatus => ({
	phase: 'idle',
	target: null,
	key: null,
	planId: null,
	plan: null,
	error: null,
	revision: 0
});

let nextLeaseId = 0;
let activeLease: ReaderOverlayPlanningLease | null = null;
let status = initialStatus();
const listeners = new Set<(value: ReaderOverlayPlanningStatus) => void>();

function cloneStatus(value: ReaderOverlayPlanningStatus): ReaderOverlayPlanningStatus {
	return {
		...value,
		target: value.target ? { ...value.target } : null
	};
}

function commit(next: Omit<ReaderOverlayPlanningStatus, 'revision'>): void {
	status = { ...next, revision: status.revision + 1 };
	for (const listener of listeners) listener(cloneStatus(status));
}

function ownsCurrentPublication(lease: ReaderOverlayPlanningLease): boolean {
	return activeLease?.id === lease.id
		&& activeLease.target.volumeUuid === lease.target.volumeUuid
		&& activeLease.target.pageIndex === lease.target.pageIndex;
}

export const readerOverlayPlanningStatus: Readable<ReaderOverlayPlanningStatus> = readable(
	initialStatus(),
	(set) => {
		const listener = (value: ReaderOverlayPlanningStatus) => set(value);
		listeners.add(listener);
		set(cloneStatus(status));
		return () => listeners.delete(listener);
	}
);

export function inspectReaderOverlayPlanningStatus(): ReaderOverlayPlanningStatus {
	return cloneStatus(status);
}

export function isReaderOverlayPlanningTarget(
	value: ReaderOverlayPlanningStatus,
	target: ReaderOverlayPlanningTarget
): boolean {
	return value.target?.volumeUuid === target.volumeUuid
		&& value.target.pageIndex === target.pageIndex;
}

export function beginReaderOverlayPlanning(
	target: ReaderOverlayPlanningTarget
): ReaderOverlayPlanningLease {
	if (!target.volumeUuid.trim() || !Number.isInteger(target.pageIndex) || target.pageIndex < 0) {
		throw new TypeError('Reader overlay planning requires a valid volume/page target');
	}
	const lease = Object.freeze({
		id: ++nextLeaseId,
		target: Object.freeze({ ...target })
	});
	activeLease = lease;
	commit({
		phase: 'loading-fonts',
		target: lease.target,
		key: null,
		planId: null,
		plan: null,
		error: null
	});
	return lease;
}

export function publishReaderOverlayPlanning(
	lease: ReaderOverlayPlanningLease,
	publication: ReaderOverlayPlanningPublication
): boolean {
	if (!ownsCurrentPublication(lease)) return false;
	commit({
		phase: publication.phase,
		target: lease.target,
		key: publication.key ?? null,
		planId: publication.planId ?? null,
		plan: publication.plan ?? null,
		error: publication.error ?? null
	});
	return true;
}

export function publishReaderOverlayControllerSnapshot(
	lease: ReaderOverlayPlanningLease,
	snapshot: OverlayPlanSnapshot
): boolean {
	return publishReaderOverlayPlanning(lease, {
		phase: snapshot.phase,
		key: snapshot.key,
		planId: snapshot.plan?.planId ?? null,
		plan: snapshot.plan ?? null,
		error: snapshot.error
	});
}

export function clearReaderOverlayPlanning(lease: ReaderOverlayPlanningLease): boolean {
	if (!ownsCurrentPublication(lease)) return false;
	activeLease = null;
	commit({ phase: 'idle', target: null, key: null, planId: null, plan: null, error: null });
	return true;
}

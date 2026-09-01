/**
 * Pure geometry and scheduling helpers for the virtualized tabs grid.
 *
 * The grid's virtual window (spacer heights, total scroll height) is only as
 * honest as its row-pitch model. A pitch that runs short makes `scrollHeight`
 * a function of the window position: the browser clamps `scrollTop` as rendered
 * rows shrink near the end, the clamp fires a scroll event, the window
 * recomputes — the "stuttered bounce". The live pitch is therefore MEASURED
 * from a rendered card (TabsView `measureTabCard`); the estimate here only has
 * to be close enough for first paint.
 */

/**
 * Fallback row pitch before any card has been measured.
 *
 * `contentWidth` is the scroll container's ResizeObserver `contentRect.width`,
 * which already excludes the container's horizontal padding — do not subtract
 * it again. The card is a 2-column grid cell whose `aspect-[2/3]` image sits
 * inside a 1px border-box border (2px per axis), and the pitch includes one
 * grid gap below the row.
 */
export function estimateTabRowHeight(contentWidth: number, gapPx: number): number {
	const cardWidth = (contentWidth - gapPx) / 2;
	return Math.max(180, (cardWidth - 2) * 1.5 + 2 + gapPx);
}

/**
 * Inclusive index range of tabs whose in-flight preview work should survive a
 * window move. Cancelling everything outside the *visible* slice on every
 * scroll event meant nothing ever finished during a fling; a margin keeps
 * overscan work alive so it can land and be merged.
 */
export function tabRetentionRange(
	startIndex: number,
	endIndex: number,
	itemCount: number,
	marginItems: number
): { min: number; max: number } {
	if (itemCount <= 0) return { min: 0, max: -1 };
	return {
		min: Math.max(0, Math.min(startIndex, itemCount - 1) - marginItems),
		max: Math.min(itemCount - 1, Math.max(endIndex - 1, 0) + marginItems)
	};
}

export interface TabPreviewCandidate {
	uuid: string;
	page: number;
	/** Regeneration identity — one attempt per (tab, current page). */
	revision: string;
	needsRegeneration: boolean;
}

export interface TabPreviewJobPlan {
	/** Pending jobs to cancel (their tab left the retention range or the list). */
	cancel: string[];
	/** Fresh work to enqueue for currently visible tabs. */
	enqueue: TabPreviewCandidate[];
}

/**
 * Diff the desired preview work against what is already in flight.
 *
 * Enqueue rules: visible + stale preview + no pending job + this revision not
 * already attempted. The attempt memo makes a divergent source of
 * `current_page` cost exactly one no-op regeneration instead of an infinite
 * enqueue/abort storm (the queue aborts the prior job for a key on re-enqueue).
 */
export function planPreviewJobs(
	visible: readonly TabPreviewCandidate[],
	pendingUuids: ReadonlySet<string>,
	attemptedRevisions: ReadonlyMap<string, string>,
	retention: { min: number; max: number },
	indexOfUuid: (uuid: string) => number
): TabPreviewJobPlan {
	const cancel: string[] = [];
	for (const uuid of pendingUuids) {
		const index = indexOfUuid(uuid);
		if (index < retention.min || index > retention.max) cancel.push(uuid);
	}
	const enqueue = visible.filter((candidate) =>
		candidate.needsRegeneration
		&& !pendingUuids.has(candidate.uuid)
		&& attemptedRevisions.get(candidate.uuid) !== candidate.revision
	);
	return { cancel, enqueue };
}

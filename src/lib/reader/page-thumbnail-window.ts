export interface PageCenterMetric {
	index: number;
	center: number;
}

export interface ThumbnailQueuePlan {
	queue: number[];
	removed: number[];
}

export interface ThumbnailLoadSettlementPlan {
	queue: number[];
	clearLoadingState: boolean;
}

/**
 * Build the fixed, odd-sized thumbnail carousel around a logical center.
 * Null placeholders keep the centered card physically centered at book edges.
 */
export function getVisibleThumbnailSlots(
	centerIndex: number,
	totalPages: number,
	visibleCardCount: number,
	direction: 'ltr' | 'rtl',
): Array<number | null> {
	const pageCount = Math.max(0, Math.trunc(totalPages));
	const requestedCount = Math.max(1, Math.trunc(visibleCardCount));
	const slotCount = requestedCount % 2 === 0 ? requestedCount - 1 : requestedCount;
	const center = pageCount > 0
		? Math.max(0, Math.min(pageCount - 1, Math.trunc(centerIndex)))
		: 0;
	const half = Math.floor(slotCount / 2);
	return Array.from({ length: slotCount }, (_, slot) => {
		const visualOffset = slot - half;
		const logicalOffset = direction === 'rtl' ? -visualOffset : visualOffset;
		const index = center + logicalOffset;
		return index >= 0 && index < pageCount ? index : null;
	});
}

/**
 * Return pages in load-priority order: the centered page first, then its
 * nearest neighbours alternating left and right.
 */
export function getThumbnailLoadOrder(
	centerIndex: number,
	totalPages: number,
	radius = 4
): number[] {
	if (totalPages <= 0) return [];
	const center = Math.max(0, Math.min(totalPages - 1, Math.trunc(centerIndex)));
	const safeRadius = Math.max(0, Math.trunc(radius));
	const result = [center];
	for (let distance = 1; distance <= safeRadius; distance++) {
		const before = center - distance;
		const after = center + distance;
		if (before >= 0) result.push(before);
		if (after < totalPages) result.push(after);
	}
	return result;
}

/** Find the page whose thumbnail center is nearest the viewport center. */
export function nearestPageIndex(
	viewportCenter: number,
	metrics: PageCenterMetric[],
	fallbackIndex: number
): number {
	if (metrics.length === 0) return fallbackIndex;
	if (metrics.length === 1) return metrics[0].index;

	// Flex rows lay these metrics out monotonically in either direction. A
	// binary search keeps scroll-frame work bounded even for very large books.
	const ascending = metrics[0].center <= metrics[metrics.length - 1].center;
	let low = 0;
	let high = metrics.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const center = metrics[middle].center;
		if (ascending ? center < viewportCenter : center > viewportCenter) low = middle + 1;
		else high = middle;
	}

	const after = metrics[Math.min(low, metrics.length - 1)];
	const before = metrics[Math.max(0, low - 1)];
	return Math.abs(before.center - viewportCenter) <= Math.abs(after.center - viewportCenter)
		? before.index
		: after.index;
}

/**
 * Replace pending work with the latest center window, keeping its priority
 * order while omitting pages that are already loaded or loading.
 */
export function reconcileThumbnailQueue(
	currentQueue: number[],
	requestedLoadOrder: number[],
	unavailableIndexes: Iterable<number> = []
): ThumbnailQueuePlan {
	const unavailable = new Set(unavailableIndexes);
	const seen = new Set<number>();
	const queue: number[] = [];
	for (const index of requestedLoadOrder) {
		if (unavailable.has(index) || seen.has(index)) continue;
		seen.add(index);
		queue.push(index);
	}
	const retained = new Set(queue);
	return {
		queue,
		removed: currentQueue.filter((index) => !retained.has(index)),
	};
}

/**
 * Finalize one asynchronous thumbnail load without letting an aborted request
 * strand a page in `loading`. A fast away/back gesture can make the page
 * desired again before the aborted promise reaches `finally`; in that case the
 * old loading marker must be cleared and the page put back at the front of the
 * queue. An older token must never disturb a newer request for the same page.
 */
export function settleThumbnailLoad(
	currentQueue: number[],
	index: number,
	tokenIsCurrent: boolean,
	state: 'queued' | 'loading' | 'loaded' | 'error' | undefined,
	stillDesired: boolean,
): ThumbnailLoadSettlementPlan {
	if (!tokenIsCurrent || state !== 'loading') {
		return { queue: currentQueue, clearLoadingState: false };
	}
	if (!stillDesired) {
		return { queue: currentQueue, clearLoadingState: true };
	}
	return {
		queue: [index, ...currentQueue.filter((queuedIndex) => queuedIndex !== index)],
		clearLoadingState: true,
	};
}

/** Pages whose generated thumbnail URLs should remain resident in memory. */
export function getThumbnailRetentionSet(
	centerIndex: number,
	selectedIndex: number,
	totalPages: number,
	radius = 12
): Set<number> {
	const retained = new Set(getThumbnailLoadOrder(centerIndex, totalPages, radius));
	if (selectedIndex >= 0 && selectedIndex < totalPages) retained.add(selectedIndex);
	return retained;
}

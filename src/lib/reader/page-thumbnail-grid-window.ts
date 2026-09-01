/**
 * Build a bounded, visibility-driven load order for the reader page grid.
 * Visible cards are prioritized first, then nearby rows are filled outward.
 */
export function getGridThumbnailLoadOrder(
	visibleIndexes: Iterable<number>,
	totalPages: number,
	selectedIndex: number,
	columns = 3,
	overscanRows = 2,
): number[] {
	const pageCount = Math.max(0, Math.trunc(totalPages));
	if (pageCount === 0) return [];

	const safeColumns = Math.max(1, Math.trunc(columns));
	const safeOverscanRows = Math.max(0, Math.trunc(overscanRows));
	const selected = Math.max(0, Math.min(pageCount - 1, Math.trunc(selectedIndex)));
	const visible = [...new Set(Array.from(visibleIndexes)
		.map((index) => Math.trunc(index))
		.filter((index) => index >= 0 && index < pageCount))]
		.sort((left, right) => left - right);
	const anchors = visible.length > 0 ? visible : [selected];
	const padding = safeColumns * safeOverscanRows;
	const start = Math.max(0, anchors[0] - padding);
	const end = Math.min(pageCount - 1, anchors[anchors.length - 1] + padding);
	const visibleSet = new Set(visible);

	return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
		.sort((left, right) => {
			const leftVisible = visibleSet.has(left) ? 0 : 1;
			const rightVisible = visibleSet.has(right) ? 0 : 1;
			if (leftVisible !== rightVisible) return leftVisible - rightVisible;

			const leftDistance = Math.min(...anchors.map((anchor) => Math.abs(anchor - left)));
			const rightDistance = Math.min(...anchors.map((anchor) => Math.abs(anchor - right)));
			if (leftDistance !== rightDistance) return leftDistance - rightDistance;

			const leftSelectedDistance = Math.abs(left - selected);
			const rightSelectedDistance = Math.abs(right - selected);
			if (leftSelectedDistance !== rightSelectedDistance) {
				return leftSelectedDistance - rightSelectedDistance;
			}
			return left - right;
		});
}

/** Pages whose decoded grid previews should remain resident in memory. */
export function getGridThumbnailRetentionSet(
	visibleIndexes: Iterable<number>,
	selectedIndex: number,
	totalPages: number,
	columns = 3,
	retentionRows = 6,
): Set<number> {
	const retained = new Set(getGridThumbnailLoadOrder(
		visibleIndexes,
		totalPages,
		selectedIndex,
		columns,
		retentionRows,
	));
	if (selectedIndex >= 0 && selectedIndex < totalPages) retained.add(selectedIndex);
	return retained;
}

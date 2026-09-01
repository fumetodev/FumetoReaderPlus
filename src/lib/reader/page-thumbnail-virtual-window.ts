export interface VirtualPageGridWindow {
	firstRow: number;
	lastRowExclusive: number;
	topSpacer: number;
	bottomSpacer: number;
	indexes: number[];
	totalRows: number;
}

export interface VirtualPageGridInput {
	totalPages: number;
	scrollTop: number;
	viewportHeight: number;
	rowHeight: number;
	columns?: number;
	overscanRows?: number;
	maxCards?: number;
}

export function getVirtualPageGridWindow(input: VirtualPageGridInput): VirtualPageGridWindow {
	const totalPages = Math.max(0, Math.trunc(input.totalPages));
	const columns = Math.max(1, Math.trunc(input.columns ?? 3));
	const rowHeight = Math.max(1, input.rowHeight);
	const overscanRows = Math.max(0, Math.trunc(input.overscanRows ?? 3));
	const maxCards = Math.max(columns, Math.trunc(input.maxCards ?? 120));
	const maxRows = Math.max(1, Math.floor(maxCards / columns));
	const totalRows = Math.ceil(totalPages / columns);
	if (totalRows === 0) {
		return { firstRow: 0, lastRowExclusive: 0, topSpacer: 0, bottomSpacer: 0, indexes: [], totalRows: 0 };
	}

	const visibleFirst = Math.max(0, Math.floor(Math.max(0, input.scrollTop) / rowHeight));
	const visibleCount = Math.max(1, Math.ceil(Math.max(0, input.viewportHeight) / rowHeight));
	let firstRow = Math.max(0, visibleFirst - overscanRows);
	let lastRowExclusive = Math.min(totalRows, visibleFirst + visibleCount + overscanRows);
	if (lastRowExclusive - firstRow > maxRows) lastRowExclusive = firstRow + maxRows;
	if (lastRowExclusive > totalRows) {
		lastRowExclusive = totalRows;
		firstRow = Math.max(0, lastRowExclusive - maxRows);
	}
	const firstIndex = firstRow * columns;
	const lastIndexExclusive = Math.min(totalPages, lastRowExclusive * columns);
	return {
		firstRow,
		lastRowExclusive,
		topSpacer: firstRow * rowHeight,
		bottomSpacer: Math.max(0, (totalRows - lastRowExclusive) * rowHeight),
		indexes: Array.from({ length: lastIndexExclusive - firstIndex }, (_, offset) => firstIndex + offset),
		totalRows
	};
}

export function pageGridScrollTopForIndex(
	index: number,
	totalPages: number,
	viewportHeight: number,
	rowHeight: number,
	columns = 3
): number {
	if (totalPages <= 0) return 0;
	const safeIndex = Math.max(0, Math.min(totalPages - 1, Math.trunc(index)));
	const totalRows = Math.ceil(totalPages / Math.max(1, columns));
	const row = Math.floor(safeIndex / Math.max(1, columns));
	return Math.max(0, Math.min(
		row * rowHeight - (viewportHeight - rowHeight) / 2,
		totalRows * rowHeight - viewportHeight
	));
}


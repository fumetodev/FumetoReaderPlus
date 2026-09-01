export interface VirtualWindowInput {
	itemCount: number;
	columns: number;
	rowHeight: number;
	scrollTop: number;
	viewportHeight: number;
	overscanRows?: number;
}

export interface VirtualWindow {
	rowCount: number;
	startRow: number;
	endRow: number;
	startIndex: number;
	endIndex: number;
	topSpacer: number;
	bottomSpacer: number;
	totalHeight: number;
}

export function calculateVirtualWindow(input: VirtualWindowInput): VirtualWindow {
	const itemCount = Math.max(0, Math.floor(input.itemCount));
	const columns = Math.max(1, Math.floor(input.columns));
	const rowHeight = Math.max(1, input.rowHeight);
	const viewportHeight = Math.max(0, input.viewportHeight);
	const overscan = Math.max(0, Math.floor(input.overscanRows ?? 3));
	const rowCount = Math.ceil(itemCount / columns);
	const unclampedFirst = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
	const unclampedLast = Math.ceil((Math.max(0, input.scrollTop) + viewportHeight) / rowHeight);
	const startRow = Math.min(rowCount, Math.max(0, unclampedFirst - overscan));
	const endRow = Math.min(rowCount, Math.max(startRow, unclampedLast + overscan));
	const startIndex = Math.min(itemCount, startRow * columns);
	const endIndex = Math.min(itemCount, endRow * columns);
	const topSpacer = startRow * rowHeight;
	const totalHeight = rowCount * rowHeight;
	const bottomSpacer = Math.max(0, totalHeight - endRow * rowHeight);
	return { rowCount, startRow, endRow, startIndex, endIndex, topSpacer, bottomSpacer, totalHeight };
}

export interface CatalogAnchor {
	anchorKey: string | null;
	offsetWithinRow: number;
	fallbackTop: number;
}

export function captureCatalogAnchor(
	keys: readonly string[],
	scrollTop: number,
	columns: number,
	rowHeight: number
): CatalogAnchor {
	const safeTop = Math.max(0, scrollTop);
	const safeColumns = Math.max(1, Math.floor(columns));
	const safeRowHeight = Math.max(1, rowHeight);
	const row = Math.floor(safeTop / safeRowHeight);
	return {
		anchorKey: keys[row * safeColumns] ?? null,
		offsetWithinRow: safeTop - row * safeRowHeight,
		fallbackTop: safeTop
	};
}

export function restoreCatalogAnchor(
	anchor: CatalogAnchor | undefined,
	keys: readonly string[],
	columns: number,
	rowHeight: number
): number {
	if (!anchor) return 0;
	if (anchor.anchorKey) {
		const index = keys.indexOf(anchor.anchorKey);
		if (index >= 0) {
			return Math.floor(index / Math.max(1, Math.floor(columns))) * Math.max(1, rowHeight)
				+ Math.max(0, anchor.offsetWithinRow);
		}
	}
	return Math.max(0, anchor.fallbackTop);
}

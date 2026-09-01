/**
 * The one natural-filename ordering used everywhere page order is derived:
 * import (page_index assignment), the legacy whole-record reader source, and
 * the v17 volume_files→volume_pages migration. These MUST stay identical —
 * a divergent comparator would reorder pages across the storage formats.
 */
export function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

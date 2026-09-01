import type { VolumeMetadata } from '$lib/types/index.js';

export type ReadingDirection = 'rtl' | 'ltr';

export interface ReadingDirectionSettings {
	/** Applies to every volume that carries no explicit override. */
	defaultReadingDirection: ReadingDirection;
}

/**
 * Which way a volume reads.
 *
 * There are exactly two inputs and one rule: a volume's own
 * `reading_direction` is an **override**, and `undefined` means "follow the
 * app-wide default". Providers that genuinely know the direction (YACReader's
 * `manga` flag, Komga's `readingDirection`) set the override at sync time;
 * local imports leave it unset so the user's global preference wins.
 *
 * This used to be decided inline at each call site while local imports stamped
 * a hardcoded 'rtl' onto every volume. That made the override non-null
 * everywhere, so Settings → Display could never affect an existing comic and
 * the reader's quick toggle never survived a reopen. Every consumer must route
 * through this function so the two can't drift apart again.
 */
export function effectiveReadingDirection(
	volume: Pick<VolumeMetadata, 'reading_direction'> | null | undefined,
	settings: ReadingDirectionSettings
): ReadingDirection {
	return volume?.reading_direction ?? settings.defaultReadingDirection;
}

/** Whether this volume pins its own direction rather than following the default. */
export function hasReadingDirectionOverride(
	volume: Pick<VolumeMetadata, 'reading_direction'> | null | undefined
): boolean {
	return volume?.reading_direction !== undefined;
}

/** The opposite direction, for toggle controls. */
export function oppositeReadingDirection(direction: ReadingDirection): ReadingDirection {
	return direction === 'rtl' ? 'ltr' : 'rtl';
}

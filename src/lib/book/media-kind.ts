/**
 * Book/comic discriminant helpers. `media_kind` is absent ≡ comic (the
 * source?/reading_direction? convention), so every branch keys through here
 * rather than re-deriving the rule.
 */

import type { VolumeMetadata } from '$lib/types/index.js';

export function isBookVolume(volume: Pick<VolumeMetadata, 'media_kind'> | null | undefined): boolean {
	return volume?.media_kind === 'book';
}

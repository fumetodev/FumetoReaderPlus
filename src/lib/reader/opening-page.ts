import type { VolumeMetadata } from '$lib/types/index.js';

export interface OpeningPageSettings {
	/** Off means every volume opens at page one. */
	resumeLastPage: boolean;
	/** Treat a saved position on the final page as finished, and start over. */
	restartFinishedVolumes: boolean;
}

/**
 * The page a volume opens on, decided once per open.
 *
 * `restartFinishedVolumes` only reinterprets a *saved* position: a volume whose
 * stored progress sits on its last page has been read to the end, so the next
 * open starts at page one. It never moves a reader that is already open —
 * reaching the final page while reading does not send anyone back to the start.
 */
export function openingPageFor(
	volume: Pick<VolumeMetadata, 'current_page' | 'page_count'>,
	settings: OpeningPageSettings
): number {
	const lastPage = Math.max(0, (volume.page_count || 0) - 1);
	if (!settings.resumeLastPage) return 0;
	const saved = Math.max(0, Math.min(volume.current_page || 0, lastPage));
	if (settings.restartFinishedVolumes && saved >= lastPage) return 0;
	return saved;
}

/**
 * Which volume translations the process died under, and so are picked up again
 * at launch.
 *
 * On Android the app can end mid-batch without anyone closing it: Android
 * destroys an Activity it cannot see when the app runs short of memory, and the
 * Rust side treats that as the last window closing and exits — taking the
 * batch, its foreground service and its notification with it. The job's
 * checkpoint survives as a translating/reviewing row with no run behind it,
 * which the catalog shows as paused. Leaving it there meant every background
 * batch the system cut short waited for the user to notice and tap resume.
 *
 * A job is resumed at most once per position: dying again without having moved
 * means whatever ended it (a crash on that page, say) is likely to again, so it
 * stays paused for the user. A job untouched for a day is not resumed either —
 * a batch someone left paused last week is theirs to restart.
 */
import type { VolumeTranslationJob } from '$lib/types/index.js';

export const AUTO_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Where a job stands; recorded when a launch resumes it. */
export function resumePosition(job: Pick<VolumeTranslationJob, 'status' | 'current_page'>): string {
	return `${job.status}:${job.current_page}`;
}

/** The jobs to resume, at most one per volume (the most recently updated). */
export function selectInterruptedJobs<T extends VolumeTranslationJob>(
	jobs: readonly T[],
	options: { now: number; isActive: (volumeUuid: string) => boolean }
): T[] {
	const byVolume = new Map<string, T>();
	for (const job of jobs) {
		if (job.status !== 'translating' && job.status !== 'reviewing') continue;
		if (options.isActive(job.volume_uuid)) continue;
		// A date that does not parse compares false and is left alone.
		if (!(options.now - Date.parse(job.updated_at) <= AUTO_RESUME_WINDOW_MS)) continue;
		if (job.auto_resumed_at === resumePosition(job)) continue;
		const other = byVolume.get(job.volume_uuid);
		if (!other || other.updated_at < job.updated_at) byVolume.set(job.volume_uuid, job);
	}
	return [...byVolume.values()];
}

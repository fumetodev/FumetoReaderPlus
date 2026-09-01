/**
 * Reactive state for active volume translation jobs.
 *
 * Tracks in-progress 2-pass translation jobs so the UI
 * can show progress overlays on catalog cards.
 */

import { writable } from 'svelte/store';
import { liveQuery } from 'dexie';
import { db, type FumetoDB } from '$lib/db/index.js';
import type { VolumeTranslationJob } from '$lib/types/index.js';

export type VolumeTranslationJobSummary = Pick<
	VolumeTranslationJob,
	'id' | 'volume_uuid' | 'status' | 'current_page' | 'total_pages' | 'activity' | 'activity_message' |
	'error' | 'error_message' | 'error_kind' | 'warnings' | 'gallery_mode' | 'skip_review' | 'updated_at' | 'started_at' | 'completed_at' | 'model'
> & {
	/** Pages a run could not use; running the job again retries exactly these. */
	unusable_pages: number;
	/**
	 * A persisted checkpoint with no live run in this session (app was killed
	 * or reloaded mid-job). Set by the feed's annotate hook, never by a live
	 * run — the UI offers resume instead of rendering it as still running.
	 */
	paused?: boolean;
};

/** What the feed's annotate hook may return: the row plus presentation flags. */
export type AnnotatedVolumeTranslationJob = VolumeTranslationJob & { paused?: boolean };

/** Map of volume_uuid → active translation job */
export const activeTranslationJobs = writable<Map<string, VolumeTranslationJobSummary>>(new Map());

/** Get the active job for a specific volume */
export function getJobForVolume(
	jobs: Map<string, VolumeTranslationJobSummary>,
	volumeUuid: string
): VolumeTranslationJobSummary | undefined {
	return jobs.get(volumeUuid);
}

/**
 * Update or add a job in the store.
 *
 * Creates a shallow copy of the job so Svelte's reactivity detects
 * property changes (same-reference mutations are invisible to $derived).
 */
const lastPublishedAt = new Map<string, number>();
const pendingPublications = new Map<string, { job: VolumeTranslationJob; timer: ReturnType<typeof setTimeout> }>();
const UI_PUBLICATION_INTERVAL_MS = 100;

function summarizeJob(job: AnnotatedVolumeTranslationJob): VolumeTranslationJobSummary {
	return {
		id: job.id,
		volume_uuid: job.volume_uuid,
		status: job.status,
		current_page: job.current_page,
		total_pages: job.total_pages,
		activity: job.activity,
		error: job.error,
		gallery_mode: job.gallery_mode,
		skip_review: job.skip_review,
		updated_at: job.updated_at,
		started_at: job.started_at,
		completed_at: job.completed_at,
		model: job.model,
		unusable_pages: (job.failed_pages ?? []).length,
		paused: job.paused
	};
}

function publishJob(job: VolumeTranslationJob): void {
	lastPublishedAt.set(job.volume_uuid, Date.now());
	activeTranslationJobs.update((jobs) => {
		const newJobs = new Map(jobs);
		newJobs.set(job.volume_uuid, summarizeJob(job));
		return newJobs;
	});
}

export function updateJob(job: VolumeTranslationJob): void {
	const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
	const elapsed = Date.now() - (lastPublishedAt.get(job.volume_uuid) ?? 0);
	const pending = pendingPublications.get(job.volume_uuid);
	if (terminal || elapsed >= UI_PUBLICATION_INTERVAL_MS) {
		if (pending) clearTimeout(pending.timer);
		pendingPublications.delete(job.volume_uuid);
		publishJob(job);
		return;
	}
	if (pending) {
		pending.job = job;
		return;
	}
	const entry = {
		job,
		timer: setTimeout(() => {
			pendingPublications.delete(job.volume_uuid);
			publishJob(entry.job);
		}, UI_PUBLICATION_INTERVAL_MS - elapsed)
	};
	pendingPublications.set(job.volume_uuid, entry);
}

/**
 * Feed the store from the database as a Dexie liveQuery, so job rows created,
 * advanced, or deleted through ANY path keep the map — and every filter
 * derived from it — live. Replaces the old one-shot catalog-mount read.
 *
 * Reconciliation rules:
 * - Incoming rows upsert, but an in-memory summary with a fresher
 *   `updated_at` wins — the in-process 100ms publisher can run ahead of the
 *   service's persistence checkpoints, and the feed must never regress it.
 * - A map entry is evicted only when the feed saw its row before and the row
 *   is now gone (deleted/left the status set). Purely in-memory summaries
 *   (e.g. transient failures never persisted) are not the feed's to remove.
 */
const FEED_STATUSES = ['translating', 'reviewing', 'revising', 'completed'] as const;

export function startTranslationJobsFeed(
	options: {
		database?: FumetoDB;
		/** Presentation hook: annotate rows before they enter the map (e.g. mark paused checkpoints). */
		annotate?: (job: VolumeTranslationJob) => AnnotatedVolumeTranslationJob;
	} = {}
): () => void {
	const database = options.database ?? db;
	let previouslySeen = new Set<string>();
	const subscription = liveQuery(() =>
		database.volume_translation_jobs.where('status').anyOf([...FEED_STATUSES]).toArray()
	).subscribe({
		next: (rows) => {
			const seen = new Set<string>();
			activeTranslationJobs.update((jobs) => {
				const next = new Map(jobs);
				for (const row of rows) {
					seen.add(row.volume_uuid);
					const existing = next.get(row.volume_uuid);
					if (existing && existing.updated_at > row.updated_at) continue;
					next.set(row.volume_uuid, summarizeJob(options.annotate ? options.annotate(row) : row));
				}
				for (const volumeUuid of previouslySeen) {
					if (!seen.has(volumeUuid)) next.delete(volumeUuid);
				}
				return next;
			});
			previouslySeen = seen;
		},
		error: (error) => console.error('Translation-jobs feed failed:', error)
	});
	return () => subscription.unsubscribe();
}

/** Remove a job from the store */
export function removeJob(volumeUuid: string): void {
	const pending = pendingPublications.get(volumeUuid);
	if (pending) clearTimeout(pending.timer);
	pendingPublications.delete(volumeUuid);
	lastPublishedAt.delete(volumeUuid);
	activeTranslationJobs.update((jobs) => {
		const newJobs = new Map(jobs);
		newJobs.delete(volumeUuid);
		return newJobs;
	});
}

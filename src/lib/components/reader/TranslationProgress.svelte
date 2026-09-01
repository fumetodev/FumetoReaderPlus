<script lang="ts">
	import { activeTranslationJobs, getJobForVolume, type VolumeTranslationJobSummary } from '$lib/stores/volume-translation-state.js';
	import { cancelVolumeTranslation } from '$lib/translation/volume-translation-service.js';
	import { cancelVolumeRevision } from '$lib/translation/revision-service.js';
	import Icon from '$lib/components/ui/Icon.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';

	interface Props {
		volumeUuid: string;
		/**
		 * Resume a paused (checkpointed, not running) job. The catalog wires
		 * this to Get Full Translation so its duplicate-job guard and
		 * notification handling are reused.
		 */
		onresume?: () => void;
	}

	let { volumeUuid, onresume }: Props = $props();

	let job = $derived(getJobForVolume($activeTranslationJobs, volumeUuid));
	let isTranslating = $derived(
		job && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled'
	);
	let paused = $derived(Boolean(job?.paused));
	// Interrupted revisions restart from scratch via the Revise dialog — a
	// play button promising an in-place resume would lie.
	let resumable = $derived(paused && job?.status !== 'revising' && Boolean(onresume));

	function getPlannedPassCount(job: VolumeTranslationJobSummary): number {
		if (job.status === 'revising') return 1;
		if (job.gallery_mode || job.skip_review) return 1;
		return 2;
	}

	function getCurrentPassIndex(job: VolumeTranslationJobSummary): number {
		if (job.status === 'reviewing') return 2;
		return 1;
	}

	function getPassLabel(status: string): string {
		switch (status) {
			case 'translating': return 'Translating';
			case 'reviewing': return 'Reviewing';
			case 'revising': return 'Revising';
			default: return status;
		}
	}

	function getProgressPercent(job: VolumeTranslationJobSummary): number {
		const totalPages = Math.max(1, job.total_pages);
		const pageRatio = Math.max(0, Math.min(1, job.current_page / totalPages));
		const plannedPasses = getPlannedPassCount(job);
		const currentPass = getCurrentPassIndex(job);

		if (plannedPasses <= 1) {
			return Math.round(pageRatio * 100);
		}

		const completedPasses = currentPass - 1;
		const progress = ((completedPasses + pageRatio) / plannedPasses) * 100;
		return Math.max(0, Math.min(100, Math.round(progress)));
	}

	let cancelling = $state(false);

	function handleCancel(e: MouseEvent) {
		e.stopPropagation();
		cancelling = true;
		if (job?.status === 'revising') {
			cancelVolumeRevision(volumeUuid);
		} else {
			cancelVolumeTranslation(volumeUuid);
		}
	}

	// The resumed run's first jobs-table write can be seconds away (model
	// residency, volume load), during which the feed still says paused —
	// acknowledge the tap locally so the card doesn't keep offering play.
	let resuming = $state(false);
	$effect(() => {
		if (!paused) resuming = false;
	});

	function handleResume(e: MouseEvent) {
		e.stopPropagation();
		resuming = true;
		// Double-start safety lives in the service (activeRuns map) and the
		// catalog's isJobActive guard — no local latch needed.
		onresume?.();
	}
</script>

{#if isTranslating && job}
	{@const plannedPasses = getPlannedPassCount(job)}
	{@const currentPass = getCurrentPassIndex(job)}
	{@const progressPercent = getProgressPercent(job)}
	<!-- Near-solid and above the corner chip so nothing bleeds through, with
	     bottom corners nesting inside the card border (cards no longer clip
	     children). Narrow cards get one readable column: status + controls,
	     then the detail line, then the bar — the old single row crammed
	     label, count, percent, and two buttons and truncated all of them. -->
	<div class="absolute inset-x-0 bottom-0 z-10 rounded-b-[7px] bg-surface-900/95 px-2 pb-2 pt-1.5">
		<div class="flex items-center justify-between gap-1">
			<span class="min-w-0 truncate text-[10px] font-medium {paused && !resuming ? 'text-amber-400' : 'text-surface-300'}">
				{paused ? (resuming ? m.reader_resuming() : m.job_badge_paused()) : getPassLabel(job.status)}{plannedPasses > 1 ? m.reader_pass_currentpass_plannedpasses({ currentPass, plannedPasses }) : ''}
			</span>
			<div class="flex shrink-0 items-center gap-1">
				<!-- Hit areas expand outward and vertically only — never across the
				     shared gap, where the later sibling's pseudo would win
				     hit-testing over the play button's visible surface. -->
				{#if resumable && !resuming}
					<button
						class="relative -my-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-primary-400 active:bg-primary-500/15 before:absolute before:-bottom-2 before:-left-2 before:-top-2 before:right-0 before:content-['']"
						onclick={handleResume}
						aria-label={m.reader_resume_translation()}
						title={m.reader_resume_translation()}
						data-translation-resume
					>
						<Icon name="play" size={14} strokeWidth={2} />
					</button>
				{/if}
				<button
					class="relative -my-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full {cancelling ? 'text-surface-500' : 'text-red-400 hover:text-red-300 active:bg-red-500/15'} before:absolute before:-bottom-2 before:-right-2 before:-top-2 before:left-0 before:content-['']"
					onclick={handleCancel}
					disabled={cancelling}
					aria-label={paused ? m.reader_discard_paused_translation() : m.reader_cancel_translation()}
					title={paused ? m.reader_discard_paused_translation() : m.reader_cancel_translation()}
					data-translation-cancel
				>
					{#if cancelling}
						<span class="text-[10px]">...</span>
					{:else}
						<Icon name="x" size={14} strokeWidth={2} />
					{/if}
				</button>
			</div>
		</div>
		<div class="mb-1 flex items-center justify-between gap-2">
			<span class="min-w-0 truncate text-[9px] text-surface-400">{renderUserMessage(job.activity_message ?? job.activity)}</span>
			<span class="shrink-0 text-[9px] tabular-nums text-surface-400">
				{m.job_progress_pages({ current: job.current_page, total: job.total_pages, percent: progressPercent })}
			</span>
		</div>
		<div class="h-1 overflow-hidden rounded-full bg-surface-700">
			<div
				class="h-full rounded-full bg-primary-500 transition-all duration-300"
				style="width: {progressPercent}%"
			></div>
		</div>
		{#if job.error_kind === 'retry'}
			<p class="mt-0.5 text-[9px] text-amber-400">{renderUserMessage(job.error_message)}</p>
		{/if}
	</div>
{:else if job?.status === 'completed' && job.unusable_pages > 0}
	<div class="absolute bottom-8 right-1">
		<span
			class="rounded-full bg-amber-600/85 px-1.5 py-0.5 text-[9px] font-medium text-white"
			title={m.job_badge_to_retry_title({ n: job.unusable_pages })}
		>
			{m.job_badge_to_retry({ n: job.unusable_pages })}
		</span>
	</div>
{:else if job?.status === 'completed'}
	<div class="absolute bottom-8 right-1">
		<span class="rounded-full bg-green-600/80 px-1.5 py-0.5 text-[9px] font-medium text-white">
			{m.job_badge_translated()}
		</span>
	</div>
{:else if job?.status === 'failed'}
	<div class="absolute bottom-8 right-1">
		<span
			class="rounded-full bg-red-600/80 px-1.5 py-0.5 text-[9px] font-medium text-white"
			title={renderUserMessage(job.error_message) || job.error || m.job_failed_title()}
		>
			{job.error_kind === 'interrupted' ? m.job_badge_interrupted() : m.job_badge_failed()}
		</span>
	</div>
{:else if job?.status === 'cancelled'}
	<div class="absolute bottom-8 right-1">
		<span class="rounded-full bg-surface-600/80 px-1.5 py-0.5 text-[9px] font-medium text-white">
			{m.job_badge_cancelled()}
		</span>
	</div>
{/if}

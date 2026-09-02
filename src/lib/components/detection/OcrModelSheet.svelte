<!--
	Offers the vision-model download at the moment it is needed.

	Mounted once at the app root so it can appear over the reader, and closed by
	the Android back press ahead of every view branch — a dialog the user cannot
	dismiss with Back reads as a freeze.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade, scale } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { portal } from '$lib/utils/portal.js';
	import {
		ocrModelDownloadState,
		downloadOcrModels,
		cancelOcrModelDownload,
		areOcrModelsReady,
		OCR_MODELS_TOTAL_BYTES
	} from '$lib/detection/ocr-model-manager.js';
	import {
		ocrModelPromptOpen,
		dismissOcrModelPrompt,
		resumeAfterOcrModels
	} from '$lib/detection/ocr-model-gate.js';

	const totalMB = Math.round(OCR_MODELS_TOTAL_BYTES / 1024 / 1024);

	let downloading = $derived($ocrModelDownloadState.status === 'downloading');
	let pct = $derived.by(() => {
		const progress = $ocrModelDownloadState.progress;
		if (!progress?.totalBytes) return 0;
		return Math.round((progress.downloadedBytes / progress.totalBytes) * 100);
	});

	async function start(): Promise<void> {
		try {
			await downloadOcrModels();
		} catch {
			// The store carries the message; the sheet stays open so the tap can
			// be retried without losing what the user was doing.
			return;
		}
		// Resume only once the files are actually on disk: a cancelled transfer
		// settles the same way and must not start a run that cannot succeed.
		if (await areOcrModelsReady()) resumeAfterOcrModels();
	}
</script>

{#if $ocrModelPromptOpen}
	<div
		use:portal
		class="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-scrim-modal)] p-4"
		transition:fade={{ duration: motionDuration(150) }}
		data-ocr-model-sheet
	>
		<div
			class="w-full max-w-md rounded-2xl bg-surface-900 p-5 shadow-xl"
			in:scale={{ duration: motionDuration(180), start: 0.96 }}
			out:scale={{ duration: exitDuration(120), start: 0.98 }}
		>
			<h2 class="text-base font-semibold text-surface-100">{m.ocr_prompt_title()}</h2>
			<p class="mt-2 text-sm leading-relaxed text-surface-300">{m.ocr_prompt_body({ size: totalMB })}</p>

			{#if downloading}
				<div class="mt-4 h-1.5 w-full rounded-full bg-surface-700">
					<div class="h-1.5 rounded-full bg-primary-500 transition-all" style="width: {pct}%"></div>
				</div>
				<p class="mt-1.5 text-[11px] text-surface-500">
					{m.settings_translation_download_progress({
						done: (($ocrModelDownloadState.progress?.downloadedBytes ?? 0) / 1024 / 1024) | 0,
						total: (($ocrModelDownloadState.progress?.totalBytes ?? 0) / 1024 / 1024) | 0,
						pct
					})}
				</p>
			{/if}

			{#if $ocrModelDownloadState.status === 'error'}
				<p class="mt-3 text-xs text-red-400">{$ocrModelDownloadState.error}</p>
			{/if}

			<div class="mt-5 flex justify-end gap-2">
				{#if downloading}
					<button
						type="button"
						onclick={() => cancelOcrModelDownload()}
						class="rounded-full bg-surface-700 px-4 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-600"
						data-ocr-sheet-cancel
					>
						{m.common_cancel()}
					</button>
				{:else}
					<button
						type="button"
						onclick={() => dismissOcrModelPrompt()}
						class="rounded-full px-4 py-2 text-sm font-medium text-surface-400 transition-colors hover:text-surface-200"
						data-ocr-sheet-dismiss
					>
						{m.common_cancel()}
					</button>
					<button
						type="button"
						onclick={start}
						class="rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
						data-ocr-sheet-download
					>
						{m.settings_models_download()}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

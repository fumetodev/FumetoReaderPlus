<!--
	Shown while a comic another app handed over is being opened (`opened-file.ts`): its pages are stored before the
	reader can show the first one, which takes a few seconds for a large file. Mounted once at the app root so it can
	appear over any view; Android Back stops the opening, as Cancel does.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade, scale } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { portal } from '$lib/utils/portal.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import { cancelOpeningFile, openingFile } from '$lib/import/opened-file.js';
</script>

{#if $openingFile}
	<div
		use:portal
		class="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-scrim-modal)] p-4"
		transition:fade={{ duration: motionDuration(150) }}
		data-opened-file-sheet
	>
		<div
			class="w-full max-w-md rounded-2xl bg-surface-900 p-5 shadow-xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="opened-file-title"
			in:scale={{ duration: motionDuration(180), start: 0.96 }}
			out:scale={{ duration: exitDuration(120), start: 0.98 }}
		>
			<div class="flex items-start gap-3">
				<div
					class="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-primary-500 border-t-transparent motion-reduce:animate-none"
					aria-hidden="true"
				></div>
				<div class="min-w-0 flex-1">
					<h2 id="opened-file-title" class="break-words text-base font-semibold text-surface-100">
						{m.import_opening_file({ name: $openingFile.name })}
					</h2>
					<p class="mt-2 text-sm leading-relaxed text-surface-300">{m.import_opened_not_kept()}</p>
					<p class="mt-3 min-h-[1.25rem] text-[12px] text-surface-500" aria-live="polite" data-opened-file-progress>
						{$openingFile.progress ? renderUserMessage($openingFile.progress) : ''}
					</p>
				</div>
			</div>
			<div class="mt-4 flex justify-end">
				<button
					type="button"
					onclick={() => cancelOpeningFile()}
					class="min-h-[44px] rounded-full bg-surface-700 px-4 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-600"
					data-opened-file-cancel
				>
					{m.common_cancel()}
				</button>
			</div>
		</div>
	</div>
{/if}

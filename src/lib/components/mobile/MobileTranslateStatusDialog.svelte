<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { onDestroy } from 'svelte';
	import { currentPageIndex, currentVolume } from '$lib/stores/reader-state.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import {
		isReaderOverlayPlanningTarget,
		readerOverlayPlanningStatus
	} from '$lib/reader/overlay-planning-status.js';
	import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
	import { startCurrentPageTranslation } from '$lib/reader/translate-current-page.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';

	let translationSnapshot = $state(readerPageTranslationController.inspect());
	const unsubscribe = readerPageTranslationController.subscribe((snapshot) => {
		translationSnapshot = snapshot;
	});

	let planningFailure = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid) return null;
		const status = $readerOverlayPlanningStatus;
		if (status.phase !== 'failed') return null;
		if (!isReaderOverlayPlanningTarget(status, { volumeUuid, pageIndex: $currentPageIndex })) return null;
		return status.error ?? m.reader_overlay_layout_failed();
	});
	let translationFailure = $derived(
		translationSnapshot.phase === 'failed'
			? (translationSnapshot.error ?? m.reader_full_page_translation_failed())
			: null
	);

	function dismiss(): void {
		playReaderHaptic('control');
		// A translation failure is acknowledged (cleared) on dismiss; a
		// planning failure clears itself on the next successful replan — the
		// dialog only surfaces its detail.
		if (translationSnapshot.phase === 'failed') {
			readerPageTranslationController.acknowledgeTerminalState(translationSnapshot.target ?? undefined);
		}
		mobileReaderUi.closeDisclosure();
	}

	/**
	 * The recovery for either failure is the same fresh run, and it should be
	 * one tap away from the message that explains why the last one died —
	 * not a detour through the globe menu.
	 */
	function tryAgain(): void {
		playReaderHaptic('control');
		if (translationSnapshot.phase === 'failed') {
			readerPageTranslationController.acknowledgeTerminalState(translationSnapshot.target ?? undefined);
		}
		mobileReaderUi.closeDisclosure();
		startCurrentPageTranslation();
	}

	onDestroy(() => {
		unsubscribe();
	});
</script>

<button
	type="button"
	aria-label={m.reader_close_translation_status()}
	class="fixed inset-0 z-[90] bg-black/40"
	onclick={() => mobileReaderUi.closeDisclosure()}
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
></button>
<div
	role="alertdialog"
	aria-label={m.job_failed_title()}
	class="fixed left-1/2 top-1/2 z-[100] w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-panel)] bg-surface-container-high p-4 shadow-2xl"
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
	data-reader-translation-failure
>
	<p class="text-sm font-semibold text-red-300">
		{translationFailure ? m.job_failed_title() : m.reader_overlay_layout_failed()}
	</p>
	<p class="mt-2 break-words text-xs text-surface-300">
		{translationFailure ?? planningFailure ?? m.reader_the_last_attempt_did()}
	</p>
	<div class="mt-4 grid grid-cols-2 gap-2">
		<button
			type="button"
			class="h-[48px] rounded-lg bg-surface-700 text-sm font-semibold text-surface-100 active:bg-surface-600"
			onclick={dismiss}
			data-reader-translation-failure-dismiss
		>{m.common_dismiss()}</button>
		<button
			type="button"
			class="h-[48px] rounded-lg bg-primary-600 text-sm font-semibold text-white active:bg-primary-700"
			onclick={tryAgain}
			data-reader-translation-failure-retry
		>{m.reader_try_again()}</button>
	</div>
</div>

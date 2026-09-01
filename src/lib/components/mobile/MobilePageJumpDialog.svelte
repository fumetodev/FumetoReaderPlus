<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';
	import { fade } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { onDestroy, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { currentPageIndex, currentVolume, totalPages } from '$lib/stores/reader-state.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { readerPageJump } from '$lib/reader/reader-page-jump.js';
	import { isBookVolume } from '$lib/book/media-kind.js';
	import { currentBookPages, goToBookPage } from '$lib/book/book-state.js';
	import { observeViewportInsets, readVisualViewportHeight } from '$lib/reader/reader-viewport-insets.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';

	// Books count in whole-book pages from foliate's SectionProgress, the same
	// unit the bottom-bar indicator shows and the Contents scrubber seeks in.
	// Spine sections stay the persistence unit and never surface here.
	let isBook = $derived(isBookVolume($currentVolume));
	let lastPage = $derived(isBook ? $currentBookPages.total : $totalPages);

	let inputEl = $state<HTMLInputElement | null>(null);
	// Prefilled with where you already are, in the unit this dialog accepts.
	let pageInput = $state(String(
		(isBookVolume(get(currentVolume)) ? get(currentBookPages).current : get(currentPageIndex)) + 1
	));
	let invalid = $state(false);
	// Keeps the dialog centered in the VISIBLE viewport while the IME is up.
	let viewportHeight = $state(readVisualViewportHeight());
	let stopObserving: (() => void) | null = null;
	let mountedAt = 0;
	let refocusAttempts = 0;

	// The synthetic click that trails long-press recognition lands on the
	// trigger button and steals focus, which drops the numpad right after it
	// opened. Re-assert focus for blurs in the first moments after mount.
	function handleInputBlur(): void {
		if (performance.now() - mountedAt < 1600 && refocusAttempts < 3) {
			refocusAttempts += 1;
			setTimeout(() => inputEl?.focus({ preventScroll: true }), 60);
		}
	}

	function submit(event?: SubmitEvent): void {
		event?.preventDefault();
		const raw = pageInput.trim();
		const requestedPage = Number.parseInt(raw, 10);
		if (!/^\d+$/.test(raw) || requestedPage < 1 || requestedPage > lastPage) {
			invalid = true;
			inputEl?.focus();
			return;
		}
		invalid = false;
		const volume = get(currentVolume);
		const previous = isBook ? get(currentBookPages).current : get(currentPageIndex);
		const index = requestedPage - 1;
		playReaderHaptic('control');
		if (volume && index !== previous) {
			// Books navigate through the foliate view: currentPageIndex is an
			// OUTPUT of its relocate event, so writing it here would move the
			// indicator without moving the book. There is also no page-image
			// history to offer a Return chip for.
			if (isBook) {
				goToBookPage(index);
			} else {
				readerPageJump.recordJump(volume.volume_uuid, previous, index);
				currentPageIndex.set(index);
			}
		}
		mobileReaderUi.closeDisclosure();
	}

	onMount(() => {
		mountedAt = performance.now();
		stopObserving = observeViewportInsets(() => {
			viewportHeight = readVisualViewportHeight();
		});
		void tick().then(() => {
			inputEl?.focus({ preventScroll: true });
			inputEl?.select();
		});
	});

	onDestroy(() => {
		stopObserving?.();
		stopObserving = null;
	});
</script>

<button
	type="button"
	aria-label={m.reader_close_page_jump()}
	class="fixed inset-0 z-[90] bg-black/40"
	onclick={() => mobileReaderUi.closeDisclosure()}
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
></button>
<div
	role="dialog"
	aria-label={m.reader_go_to_page()}
	class="fixed left-1/2 z-[100] w-[min(20rem,calc(100vw-2rem))] rounded-[var(--radius-panel)] bg-surface-container-high p-4 shadow-2xl"
	style="top: calc({viewportHeight}px / 2); transform: translate(-50%, -50%);"
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
	data-reader-page-jump
>
	<form onsubmit={submit}>
		<label class="block text-sm font-medium text-surface-200" for="reader-page-jump-number">
			<RichMessage message={m.reader_go_to_page_range({ last: lastPage })} emClass="text-surface-500" />
		</label>
		<div class="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
			<input
				bind:this={inputEl}
				bind:value={pageInput}
				id="reader-page-jump-number"
				data-reader-page-jump-input
				type="text"
				inputmode="numeric"
				enterkeyhint="go"
				autocomplete="off"
				onblur={handleInputBlur}
				aria-invalid={invalid}
				aria-describedby={invalid ? 'reader-page-jump-error' : undefined}
				class="h-[48px] w-full rounded-lg border {invalid ? 'border-red-500' : 'border-surface-700'} bg-surface-800 px-3 text-base text-surface-100 focus:border-primary-500 focus:outline-none"
			/>
			<button type="submit" class="h-[48px] rounded-lg bg-primary-600 px-5 text-sm font-semibold text-white active:bg-primary-700">{m.reader_go()}</button>
		</div>
		{#if invalid}
			<p id="reader-page-jump-error" class="mt-2 text-xs text-red-300" role="alert">
				{m.reader_page_number_range({ max: lastPage })}
			</p>
		{/if}
	</form>
</div>

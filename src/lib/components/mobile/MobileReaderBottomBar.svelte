<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import MobileNavigationItem from './MobileNavigationItem.svelte';
	import { OverlayBoxLongPressRecognizer } from '$lib/reader/overlay-box-long-press.js';
	import { settings } from '$lib/settings/settings.js';
	import {
		currentPageIndex,
		currentPageIsVideo,
		currentVolume,
		readerSessionId,
		readerTargetEpoch,
		showTabsFromReader,
		totalPages
	} from '$lib/stores/reader-state.js';
	import { decideTranslateActionIntent } from '$lib/reader/translate-action-intent.js';
	import { startCurrentPageTranslation } from '$lib/reader/translate-current-page.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { isBookVolume } from '$lib/book/media-kind.js';
	import { currentBookFraction, currentBookPages } from '$lib/book/book-state.js';
	import {
		isReaderOverlayPlanningTarget,
		readerOverlayPlanningStatus
	} from '$lib/reader/overlay-planning-status.js';
	import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
	import {
		cancelPageTranslationActivities,
		pageTranslationActivities
	} from '$lib/translation/page-translation-activity.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';

	let translationSnapshot = $state(readerPageTranslationController.inspect());
	const unsubscribeTranslation = readerPageTranslationController.subscribe((snapshot) => {
		translationSnapshot = snapshot;
	});

	let currentTargetActivities = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		const pageIndex = $currentPageIndex;
		if (!volumeUuid) return [];
		return $pageTranslationActivities.filter((activity) =>
			activity.target.volumeUuid === volumeUuid && activity.target.pageIndex === pageIndex
		);
	});
	let translating = $derived(currentTargetActivities.length > 0);
	let translationCancelling = $derived(
		currentTargetActivities.some((activity) => activity.cancelRequested)
	);
	let translationCancellable = $derived(
		currentTargetActivities.some((activity) => activity.cancellable && !activity.cancelRequested)
	);
	let translationTerminal = $derived.by((): 'completed' | 'saved' | 'cancelled' | 'failed' | null => {
		const target = translationSnapshot.target;
		if (!target
			|| target.readerSessionId !== $readerSessionId
			|| target.targetEpoch !== $readerTargetEpoch
			|| target.volumeUuid !== $currentVolume?.volume_uuid
			|| target.pageIndex !== $currentPageIndex
			|| translating
		) return null;
		if (translationSnapshot.phase === 'failed') return 'failed';
		if (translationSnapshot.phase !== 'completed') return null;
		if (translationSnapshot.resultCommitted && translationSnapshot.cancelReason === 'explicit-user') {
			return 'saved';
		}
		return translationSnapshot.cancelReason ? 'cancelled' : 'completed';
	});
	let currentOverlayPlanningStatus = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid || !isReaderOverlayPlanningTarget($readerOverlayPlanningStatus, {
			volumeUuid,
			pageIndex: $currentPageIndex
		})) return null;
		return $readerOverlayPlanningStatus;
	});
	let overlayPlanningBusy = $derived(
		currentOverlayPlanningStatus?.phase === 'loading-fonts'
		|| currentOverlayPlanningStatus?.phase === 'planning'
	);
	let overlayPlanningFailed = $derived(currentOverlayPlanningStatus?.phase === 'failed');
	/** Books swap the indicator target (TOC) and the third slot (Aa menu). */
	let isBook = $derived(isBookVolume($currentVolume));
	let compactTranslationAriaLabel = $derived.by(() => {
		if (translationCancelling && translationSnapshot.resultCommitted) {
			return m.reader_cancelling_text_replacement_translation();
		}
		if (translationCancelling) return m.reader_cancelling_current_page_translation();
		if (translating && translationCancellable && translationSnapshot.resultCommitted) {
			return m.reader_cancel_text_replacement_translation();
		}
		if (translating && translationCancellable) return m.reader_cancel_current_page_translation();
		if (translating) return m.reader_translation_in_progress();
		if (currentOverlayPlanningStatus?.phase === 'loading-fonts') {
			return m.reader_loading_translated_overlay_fonts();
		}
		if (currentOverlayPlanningStatus?.phase === 'planning') {
			return m.reader_planning_translated_page_overlay();
		}
		// A translation failure only lives in the status dialog; a layout
		// failure's message is on screen already, so its tap is the retry.
		if (translationTerminal === 'failed') return m.reader_translation_failed_show_details();
		if (overlayPlanningFailed) return m.reader_overlay_layout_failed_translate();
		if (translationTerminal === 'completed') return m.reader_page_translation_completed_dismiss();
		if (translationTerminal === 'saved') return m.reader_translation_saved_replacement_cancelled_2();
		if (translationTerminal === 'cancelled') return m.reader_page_translation_cancelled_dismiss();
		return m.reader_translate_this_page();
	});

	let autoTranslate = $derived($settings.readerAutoTranslateOverlays);

	// Long-press on the Translate action toggles auto-translate; the
	// recognizer suppresses the synthetic click that follows recognition.
	const translateLongPress = new OverlayBoxLongPressRecognizer<string>({
		onRecognized: () => {
			playReaderHaptic('selection');
			settings.patch({ readerAutoTranslateOverlays: !get(settings).readerAutoTranslateOverlays });
		}
	});

	// Long-press on the page indicator opens the numeric jump dialog — pages for
	// comics, spine sections for books (the unit this indicator already counts).
	const pageJumpLongPress = new OverlayBoxLongPressRecognizer<string>({
		onRecognized: () => {
			playReaderHaptic('selection');
			mobileReaderUi.openDisclosure('page-jump');
		}
	});

	function handlePageIndicatorClick(): void {
		if (pageJumpLongPress.consumeSyntheticClick()) return;
		playReaderHaptic('control');
		// Books: the indicator opens the TOC (filmstrip and page-jump are
		// page-image surfaces and never mount for a book).
		mobileReaderUi.toggleDisclosure(isBook ? 'book-toc' : 'filmstrip');
	}

	function handleBookDisplayAction(): void {
		playReaderHaptic('control');
		mobileReaderUi.toggleDisclosure('book-display');
	}

	function handleCompactTranslationAction(): void {
		if (translateLongPress.consumeSyntheticClick()) return;
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid) return;
		const intent = decideTranslateActionIntent({
			translating,
			translationCancellable,
			translationCancelling,
			translationTerminal,
			overlayPlanningBusy,
			overlayPlanningFailed
		});
		if (intent === 'none') return;
		playReaderHaptic('control');
		if (intent === 'cancel') {
			cancelPageTranslationActivities({ volumeUuid, pageIndex: $currentPageIndex });
			return;
		}
		// A failure stays available until its details are opened and explicitly
		// dismissed in the status dialog.
		if (intent === 'show-failure') {
			mobileReaderUi.openDisclosure('translate-status');
			return;
		}
		if (intent === 'ack') {
			readerPageTranslationController.acknowledgeTerminalState(translationSnapshot.target ?? undefined);
			return;
		}
		// Idle, or a failed overlay layout → start the full-page run directly
		// (same lean path as the globe menu's Re-translate; startup failures
		// surface via the failed state). For a layout failure this IS the
		// retry: the planner is deterministic over its input, so only a fresh
		// translation can change the outcome.
		startCurrentPageTranslation();
	}

	onDestroy(() => {
		unsubscribeTranslation();
		translateLongPress.dispose();
		pageJumpLongPress.dispose();
	});
</script>

<!-- The dock pill, verbatim: same height/radius/fill/padding tokens as
     MobileBottomBar's nav, inside the same frame geometry — the reader
     "Tabs" slot must sit at pixel parity with the dock's Tabs item. -->
<nav
	class="pointer-events-auto grid h-[var(--dock-height)] grid-cols-3 rounded-[var(--dock-radius)] bg-surface-container-high p-[6px] shadow-dock"
	aria-label={m.reader_reader_actions()}
	data-reader-collapsed-actions
	data-page-translation-phase={translationSnapshot.phase}
	data-page-translation-run-id={translationSnapshot.runId ?? ''}
	data-page-translation-result-committed={translationSnapshot.resultCommitted ? 'true' : 'false'}
>
	<MobileNavigationItem
		label={m.shell_nav_tabs()}
		icon="tabs"
		onclick={() => showTabsFromReader()}
		dataReaderTabs
	/>
	<button
		type="button"
		class="relative flex h-full w-full min-w-0 select-none flex-col items-center justify-center gap-0.5 rounded-[26px] text-[11px] font-semibold text-surface-100 transition-[scale,background-color] duration-100 [-webkit-touch-callout:none] active:scale-[.97] active:bg-surface-800"
		onclick={handlePageIndicatorClick}
		oncontextmenu={(event) => event.preventDefault()}
		onpointerdown={(event) => pageJumpLongPress.pointerDown({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, boxId: 'page-indicator' })}
		onpointermove={(event) => pageJumpLongPress.pointerMove(event.pointerId, event.clientX, event.clientY)}
		onpointerup={(event) => pageJumpLongPress.pointerUp(event.pointerId)}
		onpointercancel={(event) => pageJumpLongPress.pointerCancel(event.pointerId)}
		aria-label={isBook
			? m.reader_reading_progress_currentbookfraction_percent({ currentBookFraction: Math.round($currentBookFraction * 100), current: $currentBookPages.current + 1, total: $currentBookPages.total })
			: m.reader_page_currentpageindex_of_totalpages({ currentPageIndex: $currentPageIndex + 1, totalPages: $totalPages })}
		aria-expanded={$mobileReaderUi.disclosure === (isBook ? 'book-toc' : 'filmstrip')}
		data-reader-page-indicator>
		{#if isBook}
			<span class="block truncate">{Math.round($currentBookFraction * 100)}% · {$currentBookPages.current + 1}/{$currentBookPages.total}</span>
			<span class="block text-[9px] font-medium leading-none text-surface-400" aria-hidden="true">{m.reader_contents()}</span>
		{:else}
			<span class="block truncate">{$currentPageIndex + 1} / {$totalPages}</span>
			<span class="block text-[9px] font-medium leading-none text-surface-400" aria-hidden="true">{m.reader_pages()}</span>
		{/if}
	</button>
	{#if isBook}
		<!-- Books: the Aa display menu replaces the (meaningless) Translate. -->
		<button
			type="button"
			class="relative flex h-full w-full min-w-0 select-none flex-col items-center justify-center gap-0.5 rounded-[26px] text-[11px] font-semibold text-surface-100 transition-[scale,background-color] duration-100 [-webkit-touch-callout:none] active:scale-[.97] active:bg-surface-800"
			onclick={handleBookDisplayAction}
			oncontextmenu={(event) => event.preventDefault()}
			aria-label={m.reader_book_display_options()}
			aria-expanded={$mobileReaderUi.disclosure === 'book-display'}
			data-book-display-action
		>
			<span class="block text-base font-semibold leading-none" aria-hidden="true">{m.reader_aa()}</span>
			<span class="block text-[9px] font-medium leading-none text-surface-400" aria-hidden="true">{m.settings_tab_display()}</span>
		</button>
	{:else}
	<button
		type="button"
		class="relative flex h-full w-full min-w-0 select-none flex-col items-center justify-center gap-0.5 rounded-[26px] text-[11px] font-semibold transition-[scale,background-color,color,opacity] duration-100 [-webkit-touch-callout:none] active:scale-[.97] {(translating && translationCancellable) || translationTerminal === 'failed' || overlayPlanningFailed ? 'text-red-300' : translationTerminal === 'completed' || translationTerminal === 'saved' ? 'text-teal-300' : 'text-surface-100'} active:bg-surface-800 disabled:text-surface-500"
		onclick={handleCompactTranslationAction}
		oncontextmenu={(event) => event.preventDefault()}
		onpointerdown={(event) => translateLongPress.pointerDown({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, boxId: 'translate' })}
		onpointermove={(event) => translateLongPress.pointerMove(event.pointerId, event.clientX, event.clientY)}
		onpointerup={(event) => translateLongPress.pointerUp(event.pointerId)}
		onpointercancel={(event) => translateLongPress.pointerCancel(event.pointerId)}
		style="opacity: {$currentPageIsVideo && !translating ? 0.35 : 1};"
		disabled={translationCancelling || ($currentPageIsVideo && !translating)}
		aria-busy={translating || overlayPlanningBusy}
		aria-label={compactTranslationAriaLabel +
			($currentPageIsVideo && !translating ? ` ${m.reader_not_available_on_video()}` : '')}
		data-reader-translation-action
		data-video-page={$currentPageIsVideo || undefined}
		data-reader-auto-translate={autoTranslate ? 'true' : 'false'}
		data-page-translation-terminal={translationTerminal ?? ''}
		data-overlay-planning-phase={currentOverlayPlanningStatus?.phase ?? ''}
	>
		{#if translating}
			{#if translationCancellable && !translationCancelling}
				<!-- Progress ring with a stop-square: tap-to-cancel affordance. -->
				<span class="relative mx-auto block h-5 w-5" aria-hidden="true" data-reader-cancel-ring>
					<span class="absolute inset-0 animate-spin rounded-full border-2 border-purple-400 border-t-transparent motion-reduce:animate-none"></span>
					<span class="absolute inset-[6px] rounded-[1.5px] bg-red-300"></span>
				</span>
			{:else}
				<span class="mx-auto block h-5 w-5 animate-spin rounded-full border-2 border-purple-400 border-t-transparent motion-reduce:animate-none" aria-hidden="true"></span>
			{/if}
			<span role="status" aria-live="polite">{translationCancelling ? m.reader_cancelling() : translationCancellable ? m.common_cancel() : m.reader_working()}</span>
		{:else if overlayPlanningBusy}
			<span class="mx-auto block h-5 w-5 animate-spin rounded-full border-2 border-purple-400 border-t-transparent motion-reduce:animate-none" aria-hidden="true"></span>
			<span role="status" aria-live="polite">{currentOverlayPlanningStatus?.phase === 'loading-fonts' ? m.reader_fonts() : m.reader_layout()}</span>
		{:else if translationTerminal === 'failed'}
			<svg class="mx-auto h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.6 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>
			<span role="alert" class="rounded-full bg-red-500/25 px-2 leading-tight text-red-200">{m.job_badge_failed()}</span>
		{:else if overlayPlanningFailed}
			<svg class="mx-auto h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.6 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>
			<span role="alert" class="rounded-full bg-red-500/25 px-2 leading-tight text-red-200">{m.reader_layout_failed()}</span>
		{:else if translationTerminal === 'completed'}
			<svg class="mx-auto h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
			<span role="status" aria-live="polite">{m.common_done()}</span>
		{:else if translationTerminal === 'saved'}
			<svg class="mx-auto h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
			<span role="status" aria-live="polite" title={m.reader_translation_saved_replacement_cancelled()}>{m.reader_saved()}</span>
		{:else if translationTerminal === 'cancelled'}
			<svg class="mx-auto h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
			<span role="status" aria-live="polite">{m.job_badge_cancelled()}</span>
		{:else}
			<!-- あ⇄A: source-to-target glyph replacing the old unreadable icon. -->
			<svg class="mx-auto h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
				<text x="0.5" y="11" font-size="10.5" font-weight="600" fill="currentColor">あ</text>
				<text x="14.5" y="22.5" font-size="11" font-weight="700" fill="currentColor">A</text>
				<path d="M14 5h6m0 0-2.2-2.2M20 5l-2.2 2.2M10 19H4m0 0 2.2-2.2M4 19l2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg><span>{m.reader_translate_label({ suffix: autoTranslate ? ` ${m.reader_auto()}` : '' })}</span>
		{/if}
	</button>
	{/if}
</nav>

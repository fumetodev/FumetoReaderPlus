<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade, scale } from 'svelte/transition';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { scrollEdgeFade } from '$lib/util/scroll-edge-fade.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { appView, currentVolume, currentPageIndex, currentPageIsVideo, totalPages, isDrawingMode, isOverlayMode, readingDirection, nextPage, prevPage, overlayFontScale, pageRotation, readerReturnView, leaveReader, rotateCurrentPage, toggleReadingDirection } from '$lib/stores/reader-state.js';
	import { isBookVolume } from '$lib/book/media-kind.js';
	import { onDestroy } from 'svelte';
	import { sidebarOpen, settingsDialogOpen, settingsLoading, settingsReturnView, settingsViewMounted, isOverlayEditMode, readerBarsVisible, pageThumbnailScrubberOpen, overlayEditorCloseHandler } from '$lib/stores/ui-state.js';
	import { currentPageOverlay } from '$lib/stores/translation-state.js';
	import { get } from 'svelte/store';
	import { settings } from '$lib/settings/settings.js';
	import {
		catalogSidebarOpen,
		currentSubfolder,
		selectedLibraryId,
		currentRemoteFolderId,
		isRecoveredDownloadsCollectionId,
	} from '$lib/stores/catalog-state.js';
	import { zoomFitToScreen, zoomFitToWidth, zoomFitToHeight, zoomOriginal, toggleFullScreen } from '$lib/panzoom/util.js';
	import { isMobile } from '$lib/util/platform.js';
	import { db } from '$lib/db/index.js';
	import { overlayItemBaseRect, pageOverlayRepository } from '$lib/overlay-layout/index.js';
	import { updateVolume } from '$lib/catalog/catalog-repository.js';
	import {
		dismissReaderDisclosure,
		readerDisclosure,
		registerReaderDisclosureTrigger,
		toggleReaderDisclosure,
		type ReaderDisclosure
	} from '$lib/reader/reader-disclosure.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { OverlayBoxLongPressRecognizer } from '$lib/reader/overlay-box-long-press.js';
	import MobileTranslateMenu from '$lib/components/mobile/MobileTranslateMenu.svelte';
	import VolumeInfoDialog from '$lib/components/reader/VolumeInfoDialog.svelte';
	let moreButtonEl = $state<HTMLButtonElement | null>(null);
	// Long-strip mode: zoom and page-turn controls target the paged panzoom
	// surface and don't apply while the reader scrolls continuously.
	let longStrip = $derived($settings.readerMode === 'long-strip');

	// Long-press on the reader title opens the volume-info dialog.
	let volumeInfoOpen = $state(false);
	const titleLongPress = new OverlayBoxLongPressRecognizer<string>({
		onRecognized: () => {
			if (!isMobile || get(appView) !== 'reader') return;
			playReaderHaptic('selection');
			volumeInfoOpen = true;
		}
	});
	let translateOptionsButtonEl = $state<HTMLButtonElement | null>(null);
	let previousDisclosure: string | null = null;

	// Restore focus to a menu's trigger only when that menu closed to nothing —
	// not when another surface replaced it (exclusivity keeps focus flowing to
	// the newly opened surface instead).
	$effect(() => {
		const current = $mobileReaderUi.disclosure;
		if (current === null && previousDisclosure === 'more') {
			requestAnimationFrame(() => moreButtonEl?.focus({ preventScroll: true }));
		} else if (current === null && previousDisclosure === 'translate-options') {
			requestAnimationFrame(() => translateOptionsButtonEl?.focus({ preventScroll: true }));
		}
		previousDisclosure = current;
	});

	function disclosureTrigger(node: HTMLButtonElement, target: Exclude<ReaderDisclosure, null>) {
		return { destroy: registerReaderDisclosureTrigger(target, () => node.focus()) };
	}

	function closeMobileDisclosure(restoreFocus = true): void {
		dismissReaderDisclosure($readerDisclosure, { restoreFocus });
	}

	function useMobileZoom(action: () => void): void {
		playReaderHaptic('control');
		action();
		mobileReaderUi.closeDisclosure();
	}
	let selectedCatalogCollectionName = $derived(
		isRecoveredDownloadsCollectionId($selectedLibraryId)
			? 'Recovered Downloads'
			: ($selectedLibraryId
				? ($settings.libraries.find((library) => library.id === $selectedLibraryId)?.name ?? '')
				: '')
	);

	// Close all dropdowns when reader bars are hidden
	$effect(() => {
		if (!$readerBarsVisible) {
			closeMobileDisclosure(false);
			overlayDropdownOpen = false;
		}
	});

	$effect(() => {
		if (!$isOverlayMode && $readerDisclosure === 'overlay') closeMobileDisclosure(false);
	});

	$effect(() => {
		if ($appView !== 'reader') pageThumbnailScrubberOpen.set(false);
	});

	async function goBackToCatalog() {
		await get(overlayEditorCloseHandler)?.();
		leaveReader();
	}

	function openSettings(): void {
		if (isMobile) {
			// Settings is a dock destination on mobile — no dialog involved.
			settingsReturnView.set($appView);
			if (!get(settingsViewMounted)) settingsLoading.set(true);
			appView.set('settings');
			return;
		}
		settingsLoading.set(true);
		setTimeout(() => settingsDialogOpen.set(true), 100);
	}

	function navigateUpFolder() {
		if ($currentRemoteFolderId !== null) {
			// In a remote subfolder — look up parent
			db.remote_folders
				.where('id')
				.equals(`${$selectedLibraryId}:${$currentRemoteFolderId}`)
				.first()
				.then((folder) => {
					currentRemoteFolderId.set(folder?.parentFolderId ?? null);
				});
		} else if ($currentSubfolder === '') {
			// At library root — go back to All Libraries
			currentRemoteFolderId.set(null);
			selectedLibraryId.set(null);
		} else {
			const parts = $currentSubfolder.replace(/\\/g, '/').split('/');
			parts.pop();
			currentSubfolder.set(parts.join('/'));
		}
	}

	// Page number input state
	let pageInputEl = $state<HTMLInputElement | null>(null);
	let isEditingPage = $state(false);
	let pageInputValue = $state('');

	function startEditingPage() {
		pageInputValue = String($currentPageIndex + 1);
		isEditingPage = true;
		// Focus the input after Svelte renders it
		requestAnimationFrame(() => pageInputEl?.select());
	}

	function commitPageInput() {
		isEditingPage = false;
		const num = parseInt(pageInputValue, 10);
		if (!isNaN(num) && num >= 1 && num <= $totalPages) {
			currentPageIndex.set(num - 1);
		}
	}

	function handlePageInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitPageInput();
		} else if (e.key === 'Escape') {
			isEditingPage = false;
		}
	}

	// Mobile page-indicator gesture arbitration. A long press opens the numeric
	// input and must not also deliver the synthetic click that opens the
	// thumbnail scrubber. Moving away from the press point cancels the gesture.
	const PAGE_LONG_PRESS_MS = 500;
	const PAGE_LONG_PRESS_MOVE_TOLERANCE = 10;
	let pageLongPressTimer: ReturnType<typeof setTimeout> | undefined;
	let pageGestureResetTimer: ReturnType<typeof setTimeout> | undefined;
	let pageTouchIdentifier: number | null = null;
	let pageTouchStartX = 0;
	let pageTouchStartY = 0;
	let pageTouchMoved = false;
	let longPressTriggered = false;

	function clearPageLongPressTimer(): void {
		if (pageLongPressTimer !== undefined) {
			clearTimeout(pageLongPressTimer);
			pageLongPressTimer = undefined;
		}
	}

	function schedulePageGestureReset(): void {
		clearTimeout(pageGestureResetTimer);
		// Synthetic clicks normally follow touchend immediately. The fallback
		// reset prevents a cancelled browser click from poisoning a later tap.
		pageGestureResetTimer = setTimeout(() => {
			longPressTriggered = false;
			pageTouchMoved = false;
			pageGestureResetTimer = undefined;
		}, 750);
	}

	function handlePageIndicatorClick(event: MouseEvent): void {
		if (longPressTriggered || pageTouchMoved) {
			event.preventDefault();
			event.stopPropagation();
			longPressTriggered = false;
			pageTouchMoved = false;
			clearTimeout(pageGestureResetTimer);
			pageGestureResetTimer = undefined;
			return;
		}
		pageThumbnailScrubberOpen.update((open) => !open);
	}

	function handlePageIndicatorTouchStart(event: TouchEvent): void {
		clearPageLongPressTimer();
		clearTimeout(pageGestureResetTimer);
		pageGestureResetTimer = undefined;
		longPressTriggered = false;
		pageTouchMoved = false;

		if (event.touches.length !== 1 || event.changedTouches.length === 0) {
			pageTouchIdentifier = null;
			return;
		}

		const touch = event.changedTouches[0];
		pageTouchIdentifier = touch.identifier;
		pageTouchStartX = touch.clientX;
		pageTouchStartY = touch.clientY;
		pageLongPressTimer = setTimeout(() => {
			pageLongPressTimer = undefined;
			if (pageTouchIdentifier === null || pageTouchMoved) return;
			longPressTriggered = true;
			schedulePageGestureReset();
			pageThumbnailScrubberOpen.set(false);
			startEditingPage();
		}, PAGE_LONG_PRESS_MS);
	}

	function handlePageIndicatorTouchMove(event: TouchEvent): void {
		if (pageTouchIdentifier === null) return;
		const touch = Array.from(event.touches).find(
			(candidate) => candidate.identifier === pageTouchIdentifier,
		);
		if (!touch) return;
		const dx = touch.clientX - pageTouchStartX;
		const dy = touch.clientY - pageTouchStartY;
		if (Math.hypot(dx, dy) > PAGE_LONG_PRESS_MOVE_TOLERANCE) {
			pageTouchMoved = true;
			clearPageLongPressTimer();
		}
	}

	function handlePageIndicatorTouchEnd(event: TouchEvent): void {
		if (
			pageTouchIdentifier === null ||
			!Array.from(event.changedTouches).some(
				(touch) => touch.identifier === pageTouchIdentifier,
			)
		) return;

		clearPageLongPressTimer();
		pageTouchIdentifier = null;
		if (longPressTriggered) event.preventDefault();
		schedulePageGestureReset();
	}

	function handlePageIndicatorTouchCancel(): void {
		clearPageLongPressTimer();
		pageTouchIdentifier = null;
		pageTouchMoved = true;
		schedulePageGestureReset();
	}

	onDestroy(() => {
		clearPageLongPressTimer();
		clearTimeout(pageGestureResetTimer);
		pageThumbnailScrubberOpen.set(false);
		titleLongPress.dispose();
	});

	// Overlay dropdown state
	let overlayDropdownOpen = $state(false);
	let overlayDropdownEl = $state<HTMLDivElement | null>(null);
	let overlayBtnEl = $state<HTMLButtonElement | null>(null);
	let dropdownTop = $state(0);
	let dropdownLeft = $state(0);

	function toggleOverlayDropdown(e: MouseEvent) {
		e.stopPropagation();
		if (!overlayDropdownOpen && overlayBtnEl) {
			const rect = overlayBtnEl.getBoundingClientRect();
			dropdownTop = rect.bottom + 4;
			dropdownLeft = rect.left;
		}
		overlayDropdownOpen = !overlayDropdownOpen;
	}

	function closeOverlayDropdown() {
		overlayDropdownOpen = false;
	}

	// Close dropdown when clicking outside
	function handleWindowClick(e: MouseEvent) {
		if (overlayDropdownOpen && overlayDropdownEl && !overlayDropdownEl.contains(e.target as Node)) {
			overlayDropdownOpen = false;
		}
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && isMobile && $mobileReaderUi.disclosure !== null) {
			event.preventDefault();
			mobileReaderUi.closeDisclosure();
			return;
		}
		if (event.key !== 'Escape' || $readerDisclosure === null) return;
		event.preventDefault();
		closeMobileDisclosure();
	}

	/** Save overlay font scale to the volume record in DB */
	let fontScaleSaveTimer: ReturnType<typeof setTimeout> | undefined;
	function saveFontScale(scale: number) {
		overlayFontScale.set(scale);
		const vol = $currentVolume;
		if (!vol) return;
		clearTimeout(fontScaleSaveTimer);
		fontScaleSaveTimer = setTimeout(() => {
			updateVolume(vol.volume_uuid, { overlay_font_scale: scale } as any).catch(() => {});
		}, 300);
	}

	/** Toggle vertical/horizontal text on all overlay boxes on the current page. */
	async function toggleAllVertical() {
		const overlay = get(currentPageOverlay);
		const vol = $currentVolume;
		if (!overlay || !vol || !$settings.overlayVerticalText) return;

		// If any box is currently vertical (explicitly or by inference), set all to horizontal; otherwise set all to vertical
		const verticalEnabled = $settings.overlayVerticalText ?? false;
		const anyVertical = overlay.items.some((item) => {
			if (item.manual.writingMode === 'vertical-rl') return true;
			if (item.manual.writingMode === 'horizontal-tb') return false;
			const rect = overlayItemBaseRect(overlay, item);
			return verticalEnabled && Boolean(rect && rect.height > rect.width);
		});
		const newOverlay = structuredClone(overlay);
		for (const item of newOverlay.items) {
			item.manual.writingMode = anyVertical ? 'horizontal-tb' : 'vertical-rl';
		}
		currentPageOverlay.set(newOverlay);
		await pageOverlayRepository.replaceDocument(vol.volume_uuid, $currentPageIndex, newOverlay);
	}
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<!-- On the mobile reader the header element is a transparent tap-through
     frame (the pill grid inside re-enables hits); everywhere else it stays
     the opaque full-width bar. The conditional z escalation lives on the
     frame, never the pill, so open disclosures keep one stacking context. -->
<header class="relative {$readerDisclosure === null && $mobileReaderUi.disclosure === null ? 'z-50' : 'z-[120]'} flex shrink-0 items-center justify-between {isMobile && $appView === 'reader' ? 'pointer-events-none' : 'border-b border-surface-800 bg-surface-900/80 backdrop-blur-sm'}" style={isMobile && $appView === 'reader'
	? 'height: var(--reader-chrome-top); padding-top: calc(var(--sat, 0px) + var(--reader-top-gap)); padding-right: calc(var(--reader-top-inset-x) + var(--sar, 0px)); padding-left: calc(var(--reader-top-inset-x) + var(--sal, 0px));'
	: 'height: calc(3rem + var(--sat, 0px)); padding-top: var(--sat, 0px); padding-right: calc(8px + var(--sar, 0px)); padding-left: calc(8px + var(--sal, 0px));'}>
{#if isMobile && $appView === 'reader'}
	<!-- Books collapse to back+title: the eye/globe/More are all comic- or
	     translation-specific, and the grid template drops their columns so
	     the title takes the width (no empty holes). -->
	<div class="pointer-events-auto grid h-[var(--reader-top-height)] w-full min-w-0 {isBookVolume($currentVolume) ? 'grid-cols-[48px_minmax(0,1fr)]' : 'grid-cols-[48px_minmax(0,1fr)_48px_48px_48px]'} items-center gap-2 rounded-[calc(var(--reader-top-height)/2)] bg-surface-container-high px-[6px] shadow-dock" data-mobile-reader-header>
		<button
			type="button"
			onclick={goBackToCatalog}
			class="flex h-[48px] w-[48px] items-center justify-center rounded-full text-surface-100 active:bg-surface-800"
			aria-label={$readerReturnView === 'tabs' ? m.header_back_to_tabs() : m.header_back_to_library()}
			title={$readerReturnView === 'tabs' ? m.header_back_to_tabs() : m.header_back_to_library()}
			data-reader-back
		>
			<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
		</button>
		<!-- Long-press shows the volume-info dialog; a plain tap does nothing. -->
		<h1
			class="min-w-0 select-none truncate text-sm font-semibold text-surface-100 [-webkit-touch-callout:none]"
			title={$currentVolume?.title ?? m.reader_untitled()}
			data-reader-title data-user-text
			onpointerdown={(event) => titleLongPress.pointerDown({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, boxId: 'title' })}
			onpointermove={(event) => titleLongPress.pointerMove(event.pointerId, event.clientX, event.clientY)}
			onpointerup={(event) => titleLongPress.pointerUp(event.pointerId)}
			onpointercancel={(event) => titleLongPress.pointerCancel(event.pointerId)}
			oncontextmenu={(event) => event.preventDefault()}
		>
			{$currentVolume?.title ?? m.reader_untitled()}
		</h1>
		{#if !isBookVolume($currentVolume)}
		<button
			type="button"
			onclick={() => isOverlayMode.update((visible) => !visible)}
			class="flex h-[48px] w-[48px] items-center justify-center rounded-full {$isOverlayMode ? 'bg-teal-500/15 text-teal-300' : 'text-surface-400'} active:bg-surface-800"
			style="opacity: {$currentPageIsVideo ? 0.35 : 1}; transition: opacity var(--motion-fast) var(--ease-standard);"
			disabled={$currentPageIsVideo}
			aria-label={($isOverlayMode ? m.header_hide_translated_overlays() : m.header_show_translated_overlays()) +
				($currentPageIsVideo ? ` ${m.reader_not_available_on_video()}` : '')}
			aria-pressed={$isOverlayMode}
			data-reader-overlay-toggle
		>
			{#if $isOverlayMode}
				<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
			{:else}
				<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 5.2Q11.3 5 12 5c6.5 0 10 7 10 7a16 16 0 0 1-2.1 3.2M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7a10 10 0 0 0 4.1-.9"/></svg>
			{/if}
		</button>
		<button
			bind:this={translateOptionsButtonEl}
			type="button"
			onclick={(event) => { event.stopPropagation(); mobileReaderUi.toggleDisclosure('translate-options'); }}
			class="flex h-[48px] w-[48px] items-center justify-center rounded-full {$mobileReaderUi.disclosure === 'translate-options' ? 'bg-surface-700 text-white' : 'text-surface-200'} active:bg-surface-800"
			style="opacity: {$currentPageIsVideo ? 0.35 : 1}; transition: opacity var(--motion-fast) var(--ease-standard);"
			disabled={$currentPageIsVideo}
			aria-label={m.reader_translate_options() + ($currentPageIsVideo ? ` ${m.reader_not_available_on_video()}` : '')}
			title={m.reader_translate_options()}
			aria-expanded={$mobileReaderUi.disclosure === 'translate-options'}
			aria-controls="reader-translate-options-menu"
			data-reader-translate-options
		>
			<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15.3 15.3 0 0 1 0 18M12 3a15.3 15.3 0 0 0 0 18"/></svg>
		</button>
		<button
			bind:this={moreButtonEl}
			type="button"
			onclick={(event) => { event.stopPropagation(); mobileReaderUi.toggleDisclosure('more'); }}
			class="flex h-[48px] w-[48px] items-center justify-center rounded-full {$mobileReaderUi.disclosure === 'more' ? 'bg-surface-700 text-white' : 'text-surface-200'} active:bg-surface-800"
			aria-label={m.header_more_reader_options()}
			title={m.header_menu()}
			aria-expanded={$mobileReaderUi.disclosure === 'more'}
			aria-controls="reader-more-menu"
			data-reader-more
		>
			<svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
		</button>
		{/if}
	</div>
{:else}
	<!-- ═══ DESKTOP HEADER (unchanged) ═══ -->

	<!-- Left section -->
	<div class="flex items-center gap-3">
		{#if $appView === 'reader'}
			<button
				onclick={goBackToCatalog}
				class="rounded-md px-2 py-1 text-sm text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-100"
				title={m.header_back_to_library()}
			>
				{m.header_library()}
			</button>
			<span class="text-sm text-surface-400">|</span>
			<span class="truncate text-sm font-medium text-surface-200" style="max-width: 300px" data-reader-title data-user-text>
				{$currentVolume?.title ?? m.reader_untitled()}
			</span>
		{:else}
			<button
				onclick={() => catalogSidebarOpen.update(v => !v)}
				class="rounded px-1.5 py-1 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-200"
				title={$catalogSidebarOpen ? m.header_hide_sidebar() : m.header_show_sidebar()}
			>
				<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z" clip-rule="evenodd" />
				</svg>
			</button>
			{#if $selectedLibraryId || $currentSubfolder !== '' || $currentRemoteFolderId !== null}
				<span class="text-sm text-surface-600">|</span>
				<button
					onclick={navigateUpFolder}
					class="rounded px-1.5 py-1 text-xs text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-200"
					title={$currentSubfolder || $currentRemoteFolderId ? m.header_back_to_parent_folder() : m.header_back_to_all_libraries()}
				>
					{m.header_back()}
				</button>
					<span class="truncate text-xs text-surface-400" style="max-width: 300px">
						{#if $selectedLibraryId}
							{selectedCatalogCollectionName}
						{#if $currentSubfolder}
							{' / ' + $currentSubfolder.replace(/\//g, ' / ')}
						{/if}
					{/if}
				</span>
			{/if}
		{/if}
	</div>

	<!-- Center section (reader controls) -->
	{#if $appView === 'reader'}
		<div class="flex items-center gap-2">
			<!-- Page navigation -->
			<button
				onclick={() => { if ($readingDirection === 'rtl') nextPage(); else prevPage(); }}
				class="rounded px-2 py-1 text-surface-300 transition-colors hover:bg-surface-800"
				title={m.header_previous_page()}
			>
				‹
			</button>
			<span class="flex min-w-[4rem] items-center justify-center text-sm text-surface-300">
				{#if isEditingPage}
					<input
						bind:this={pageInputEl}
						bind:value={pageInputValue}
						onblur={commitPageInput}
						onkeydown={handlePageInputKeydown}
						type="text"
						inputmode="numeric"
						class="w-8 rounded border border-surface-600 bg-surface-800 px-1 py-0 text-center text-sm text-surface-100 outline-none focus:border-primary-500"
					/>
				{:else}
					<button
						type="button"
						class="cursor-pointer rounded px-1 hover:bg-surface-800 hover:text-surface-100"
						onclick={() => { pageThumbnailScrubberOpen.update((open) => !open); }}
						aria-label={m.header_page_currentpageindex_of_totalpages({ currentPageIndex: $currentPageIndex + 1, totalPages: $totalPages })}
						title={m.header_open_page_thumbnails()}
					>{$currentPageIndex + 1}</button>
				{/if}
				<span class="mx-0.5">/</span>
				{$totalPages}
			</span>
			<button
				onclick={() => { if ($readingDirection === 'rtl') prevPage(); else nextPage(); }}
				class="rounded px-2 py-1 text-surface-300 transition-colors hover:bg-surface-800"
				title={m.header_next_page()}
			>
				›
			</button>

			<!-- Reading direction toggle -->
			<button
				data-reading-direction-toggle
				onclick={() => void toggleReadingDirection()}
				class="rounded px-1.5 py-1 text-[10px] font-medium bg-surface-700 text-surface-200 transition-colors hover:bg-surface-600"
				title={$readingDirection === 'rtl' ? m.header_reading_right_to_left() : m.header_reading_left_to_right()}
			>
				{$readingDirection === 'rtl' ? 'R→L' : 'L→R'}
			</button>

			<span class="mx-1 text-surface-700">|</span>

			<!-- Drawing mode toggle -->
			<button
				onclick={() => isDrawingMode.update(v => !v)}
				class="rounded px-2 py-1 text-sm transition-colors {$isDrawingMode
					? 'bg-primary-600 text-white'
					: 'text-surface-300 hover:bg-surface-800'}"
				title={$isDrawingMode ? m.header_switch_to_navigate_mode() : m.header_switch_to_draw_region()}
			>
				{$isDrawingMode ? m.header_drawing() : m.header_draw()}
			</button>

			{#if $settings.overlayEnabled}
				<!-- Overlay toggle + dropdown -->
				<div class="relative">
					<div class="flex items-center">
						<button
							onclick={() => {
								isOverlayMode.update(v => {
									if (v) isOverlayEditMode.set(false);
									return !v;
								});
							}}
							class="rounded-l px-2 py-1 text-sm transition-colors {$isOverlayMode
								? 'bg-teal-600 text-white'
								: 'text-surface-300 hover:bg-surface-800'}"
							title={$isOverlayMode ? m.header_hide_text_overlays_t() : m.header_show_text_overlays_t()}
						>
							{$isOverlayMode ? m.header_overlay_on() : m.settings_tab_overlay()}
						</button>
						{#if $isOverlayMode}
							<button
								bind:this={overlayBtnEl}
								onclick={toggleOverlayDropdown}
								class="rounded-r border-l border-teal-700 bg-teal-600 px-1 py-1 text-xs text-white transition-colors hover:bg-teal-500"
								title={m.header_overlay_settings()}
							>
								▾
							</button>
						{/if}
					</div>

				</div>
			{/if}

			<span class="mx-1 text-surface-700">|</span>

			<!-- Zoom controls -->
			<button
				onclick={zoomFitToScreen}
				class="rounded px-2 py-1 text-xs text-surface-300 transition-colors hover:bg-surface-800"
				title={m.header_fit_to_screen()}
			>
				{m.header_fit()}
			</button>
			<button
				onclick={zoomFitToWidth}
				class="rounded px-2 py-1 text-xs text-surface-300 transition-colors hover:bg-surface-800"
				title={m.header_fit_to_width()}
			>
				{m.header_width()}
			</button>
			<button
				onclick={zoomOriginal}
				class="rounded px-2 py-1 text-xs text-surface-300 transition-colors hover:bg-surface-800"
				title={m.header_original_size()}
			>
				1:1
			</button>
			<button
				onclick={rotateCurrentPage}
				disabled={longStrip}
				class="rounded px-2 py-1 text-xs text-surface-300 transition-colors hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50"
				title={m.header_rotate_page_90_r()}
			>
				{m.header_rotate()}
			</button>
			<button
				onclick={toggleFullScreen}
				class="rounded px-2 py-1 text-xs text-surface-300 transition-colors hover:bg-surface-800"
				title={m.header_toggle_fullscreen()}
			>
				⛶
			</button>
		</div>
	{/if}

	<!-- Right section -->
	<div class="flex items-center gap-2">
		{#if $appView === 'reader'}
			<button
				onclick={() => sidebarOpen.update(v => !v)}
				class="rounded px-2 py-1 text-sm text-surface-300 transition-colors hover:bg-surface-800"
				title={$sidebarOpen ? m.header_hide_translations_panel() : m.header_show_translations_panel()}
			>
				{$sidebarOpen ? m.header_hide_panel() : m.header_show_panel()}
			</button>
		{/if}
		<button
				onclick={openSettings}
			class="rounded px-2 py-1 text-sm text-surface-300 transition-colors hover:bg-surface-800"
			title={m.shell_nav_settings()}
		>
			⚙
		</button>
	</div>
{/if}
</header>

<!-- ═══ DROPDOWN PORTALS (outside header stacking context) ═══ -->

{#if isMobile && $appView === 'reader'}
	<MobileTranslateMenu />
{/if}

{#if isMobile && $appView === 'reader' && volumeInfoOpen && $currentVolume}
	<VolumeInfoDialog volume={$currentVolume} onclose={() => (volumeInfoOpen = false)} />
{/if}

{#if isMobile && $appView === 'reader' && $mobileReaderUi.disclosure === 'more'}
	<button
		type="button"
		aria-label={m.header_close_more_reader_options()}
		class="pointer-events-auto fixed inset-0 z-[90] bg-[var(--color-scrim-menu)]"
		onclick={() => mobileReaderUi.closeDisclosure()}
		in:fade={{ duration: motionDuration(120) }}
		out:fade={{ duration: motionDuration(exitDuration(120)) }}
	></button>
	<div
		in:scale={{ start: 0.96, duration: motionDuration(120) }}
		out:scale={{ start: 0.96, duration: motionDuration(exitDuration(120)) }}
		id="reader-more-menu"
		role="dialog"
		aria-label={m.header_more_reader_options()}
		class="pointer-events-auto fixed z-[100] max-h-[calc(var(--viewport-height,100dvh)-var(--reader-chrome-top)-24px)] w-[min(20rem,calc(100vw-16px-var(--sal,0px)-var(--sar,0px)))] min-w-0 origin-top-right overflow-y-auto rounded-[var(--radius-card)] bg-surface-container-high p-2 shadow-2xl"
		style="top: calc(var(--reader-chrome-top) + 8px); right: calc(8px + var(--sar, 0px));"
		use:scrollEdgeFade
		data-reader-more-menu
	>
		<div class="grid grid-cols-4 gap-2 {longStrip ? 'opacity-50' : ''}" aria-label={m.header_page_zoom()}>
			<button type="button" aria-label={m.header_fit_page()} title={m.header_fit_page_2()} data-reader-zoom="page" disabled={longStrip} class="reader-mobile-icon-button flex h-[56px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg bg-surface-800 text-surface-100 disabled:cursor-not-allowed" onclick={() => useMobileZoom(zoomFitToScreen)}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6" rx=".75"/></svg>
				<span class="text-[10px] leading-none text-surface-300">{m.reader_auto_2()}</span>
			</button>
			<button type="button" aria-label={m.header_fit_width()} title={m.header_fit_width_2()} data-reader-zoom="width" disabled={longStrip} class="reader-mobile-icon-button flex h-[56px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg bg-surface-800 text-surface-100 disabled:cursor-not-allowed" onclick={() => useMobileZoom(zoomFitToWidth)}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5v14M21 5v14M7 12h10M7 12l3-3M7 12l3 3M17 12l-3-3M17 12l-3 3"/></svg>
				<span class="text-[10px] leading-none text-surface-300">{m.header_width()}</span>
			</button>
			<button type="button" aria-label={m.header_fit_height()} title={m.header_fit_height_2()} data-reader-zoom="height" disabled={longStrip} class="reader-mobile-icon-button flex h-[56px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg bg-surface-800 text-surface-100 disabled:cursor-not-allowed" onclick={() => useMobileZoom(zoomFitToHeight)}>
				<!-- The Fit Width glyph rotated 90° — identical geometry, vertical axis. -->
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="rotate(90 12 12)"><path d="M3 5v14M21 5v14M7 12h10M7 12l3-3M7 12l3 3M17 12l-3-3M17 12l-3 3"/></g></svg>
				<span class="text-[10px] leading-none text-surface-300">{m.header_height()}</span>
			</button>
			<button type="button" aria-label={m.header_actual_size()} title={m.header_actual_size_2()} data-reader-zoom="actual" disabled={longStrip} class="reader-mobile-icon-button flex h-[56px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg bg-surface-800 text-surface-100 disabled:cursor-not-allowed" onclick={() => useMobileZoom(zoomOriginal)}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><text x="12" y="15.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor" stroke-width="0">1:1</text></svg>
				<span class="text-[10px] leading-none text-surface-300">{m.header_actual()}</span>
			</button>
		</div>
		<button
			type="button"
			class="mt-2 flex h-[48px] w-full min-w-0 items-center justify-between rounded-lg bg-surface-800 px-3 text-sm text-surface-100 active:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50"
			data-reader-rotate
			disabled={longStrip}
			onclick={() => { playReaderHaptic('control'); rotateCurrentPage(); }}
		>
			<span class="truncate">{m.header_rotate_page()}</span><span class="shrink-0 tabular-nums">{$pageRotation}°</span>
		</button>
		<button
			type="button"
			class="mt-2 flex h-[48px] w-full min-w-0 items-center justify-between rounded-lg bg-surface-800 px-3 text-sm text-surface-100 active:bg-surface-700"
			data-reading-direction-toggle
			onclick={() => void toggleReadingDirection()}
		>
			<span class="truncate">{m.reader_reading_direction()}</span><span class="shrink-0">{$readingDirection === 'rtl' ? m.reader_direction_rtl() : m.reader_direction_ltr()}</span>
		</button>
		<button
			type="button"
			class="mt-2 flex h-[48px] w-full min-w-0 items-center justify-between rounded-lg bg-surface-800 px-3 text-sm text-surface-100 active:bg-surface-700"
			data-reader-mode-toggle
			onclick={() => settings.patch({ readerMode: longStrip ? 'paged' : 'long-strip' })}
		>
			<span class="truncate">{m.header_reader_mode()}</span><span class="shrink-0">{longStrip ? m.header_long_strip() : m.settings_display_paged()}</span>
		</button>
		<fieldset class="mt-2 min-w-0 {longStrip ? 'opacity-50' : ''}" data-reader-page-turn-fieldset disabled={longStrip}>
			<legend class="px-1 text-[10px] font-semibold uppercase tracking-wider text-surface-400">{m.header_page_turn()}</legend>
			<div class="mt-1 grid grid-cols-3 gap-2">
				{#each [{ value: 'swipe' as const, label: m.settings_display_swipe() }, { value: 'tap' as const, label: m.settings_display_tap() }, { value: 'both' as const, label: m.settings_display_both() }] as option (option.value)}
					<button
						type="button"
						class="h-[48px] min-w-0 rounded-lg px-1 text-xs font-semibold disabled:cursor-not-allowed {($settings.pageTurnMode ?? 'swipe') === option.value ? 'bg-primary-600 text-white' : 'bg-surface-800 text-surface-300'}"
						aria-pressed={($settings.pageTurnMode ?? 'swipe') === option.value}
						disabled={longStrip}
						onclick={() => settings.patch({ pageTurnMode: option.value })}
					>{option.label}</button>
				{/each}
			</div>
			{#if longStrip}
				<p class="mt-1 px-1 text-[10px] leading-tight text-surface-500">{m.header_long_strip_mode_scrolls()}</p>
			{/if}
		</fieldset>
		<button type="button" class="mt-2 flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm text-surface-100 active:bg-surface-800" onclick={() => { mobileReaderUi.closeDisclosure(); openSettings(); }}>
			<Icon name="settings" size={20} strokeWidth={2} />
			{m.shell_nav_settings()}
		</button>
	</div>
{/if}

<!-- Mobile overflow dropdown -->
{#if $readerDisclosure === 'overflow'}
	<button
		type="button"
		aria-label={m.header_close_menu()}
		class="fixed inset-0 z-[90]"
		style="background: rgba(0,0,0,0.01);"
		onclick={() => { closeMobileDisclosure(); }}
		transition:fade={{ duration: motionDuration(120) }}
	></button>
	<div
		transition:scale={{ start: 0.96, duration: motionDuration(120) }}
		id="reader-overflow-menu"
		role="menu"
		class="fixed z-[100] max-h-[calc(100dvh-4rem-var(--sat,0px)-var(--sab,0px))] w-64 origin-top-right overflow-y-auto rounded-xl border border-surface-700 bg-surface-900 py-2 shadow-2xl"
		style="top: calc(3rem + var(--sat, 0px)); right: calc(0.5rem + var(--sar, 0px));"
	>
		{#if $appView === 'reader'}
			<button
				data-reading-direction-toggle
				onclick={() => { void toggleReadingDirection(); closeMobileDisclosure(false); }}
				class="flex w-full items-center gap-3 px-4 py-3 text-sm text-surface-200 active:bg-surface-800"
			>
				<span class="w-5 text-center text-xs font-bold">{$readingDirection === 'rtl' ? 'R→L' : 'L→R'}</span>
				{m.settings_display_reading_direction()}
			</button>
			<!-- Page turn mode selector -->
			<div class="px-4 py-2 {longStrip ? 'opacity-50' : ''}">
				<p class="mb-2 text-xs text-surface-400">{m.header_page_turn_2()}</p>
				<div class="relative flex rounded-lg border border-surface-700 bg-surface-800/50 [--segment-radius:6px]" role="radiogroup" aria-label={m.header_page_turn_mode()} use:slidingSelection>
					{#each [{ value: 'swipe' as const, label: m.settings_display_swipe() }, { value: 'tap' as const, label: m.settings_display_tap() }, { value: 'both' as const, label: m.settings_display_both() }] as option (option.value)}
						<button
							role="radio"
							aria-checked={($settings.pageTurnMode ?? 'swipe') === option.value}
							disabled={longStrip}
							onclick={() => settings.patch({ pageTurnMode: option.value })}
							class="relative flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed
								{($settings.pageTurnMode ?? 'swipe') === option.value
									? 'text-white'
									: 'text-surface-400 active:bg-surface-700'}"
						>
							{option.label}
						</button>
					{/each}
				</div>
				</div>
				<label class="flex items-center justify-between gap-3 px-4 py-3 text-sm {$settings.overlayEnabled ? 'text-surface-200' : 'text-surface-500'}">
					<span class="min-w-0">
						<span class="block">{m.header_translate_pages_automatically()}</span>
						<span class="mt-0.5 block text-[10px] leading-tight text-surface-500">{$settings.overlayEnabled ? m.header_create_overlays_when_a() : m.header_enable_translation_overlays_in()}</span>
					</span>
					<input
						type="checkbox"
						checked={$settings.readerAutoTranslateOverlays ?? false}
						disabled={!$settings.overlayEnabled}
						onchange={(event) => settings.patch({ readerAutoTranslateOverlays: event.currentTarget.checked })}
						class="h-5 w-5 shrink-0 accent-primary-500"
						aria-label={m.header_translate_reader_pages_automatically()}
						data-reader-auto-translate-toggle
					/>
				</label>
				<!-- Font Scale slider (only when overlays exist for this page) -->
			{#if $currentPageOverlay && $currentPageOverlay.items.length > 0}
				<div class="px-4 py-2">
					<div class="mb-1.5 flex items-center justify-between">
						<p class="text-xs text-surface-400">{m.header_font_scale()}</p>
						<span class="text-xs font-medium text-surface-300">{Math.round($overlayFontScale * 100)}%</span>
					</div>
					<div>
						<input
							type="range"
							min="0.5"
							max="3"
							step="0.05"
							value={$overlayFontScale}
							oninput={(e) => saveFontScale(parseFloat(e.currentTarget.value))}
							class="w-full accent-primary-500"
						/>
					</div>
				</div>
			{/if}
			<div class="my-1 border-t border-surface-800"></div>
		{/if}
		<button
				onclick={() => { closeMobileDisclosure(false); openSettings(); }}
			class="flex w-full items-center gap-3 px-4 py-3 text-sm text-surface-200 active:bg-surface-800"
		>
			<span class="w-5 text-center">⚙</span>
			{m.shell_nav_settings()}
		</button>
	</div>
{/if}

<!-- Mobile overlay settings dropdown -->
{#if $readerDisclosure === 'overlay' && $isOverlayMode}
	<button
		type="button"
		aria-label={m.header_close_overlay_settings()}
		class="fixed inset-0 z-[90]"
		style="background: rgba(0,0,0,0.01);"
		onclick={() => { closeMobileDisclosure(); }}
	></button>
	<div
		id="reader-overlay-menu"
		role="menu"
		class="fixed z-[100] w-64 rounded-xl border border-surface-700 bg-surface-900 p-3 shadow-2xl"
		style="top: calc(3rem + var(--sat, 0px)); right: calc(0.5rem + var(--sar, 0px));"
	>
		<div class="mb-3 border-b border-surface-700 pb-3">
			<div class="flex gap-2">
				<button
					onclick={() => isOverlayEditMode.update(v => !v)}
					class="flex-1 rounded px-2 py-2 text-sm font-medium transition-colors
						{$isOverlayEditMode ? 'bg-teal-600 text-white' : 'bg-surface-800 text-surface-400 active:bg-surface-700'}"
				>
					{$isOverlayEditMode ? m.header_edit_boxes_on() : m.header_edit_boxes()}
				</button>
				<button
					onclick={toggleAllVertical}
					disabled={!$settings.overlayVerticalText}
					class="rounded bg-surface-800 px-2 py-2 text-sm font-medium text-surface-400 transition-colors active:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-40"
					title={$settings.overlayVerticalText ? m.header_toggle_vertical_horizontal_text() : m.header_enable_preserve_vertical_source()}
				>
					↕↔
				</button>
			</div>
			<p class="mt-1.5 text-[10px] text-surface-500">{m.header_long_press_an_overlay()}</p>
		</div>
	</div>
{/if}

<style>
	.reader-mobile-icon-button {
		-webkit-tap-highlight-color: transparent;
		transition: transform 120ms ease, background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
	}

	.reader-mobile-icon-button:active {
		transform: scale(.94);
		background-color: var(--color-surface-700);
		box-shadow: inset 0 0 0 1px rgba(94, 234, 212, .24);
		color: rgb(153 246 228);
	}

	@media (prefers-reduced-motion: reduce) {
		.reader-mobile-icon-button { transition: none; }
	}
</style>

<!-- Desktop overlay dropdown -->
{#if overlayDropdownOpen && $isOverlayMode}
	<button
		type="button"
		aria-label={m.header_close_overlay_settings()}
		class="fixed inset-0 z-[90]"
		style="background: rgba(0,0,0,0.01);"
		onclick={() => { overlayDropdownOpen = false; }}
		transition:fade={{ duration: motionDuration(120) }}
	></button>
	<div
		bind:this={overlayDropdownEl}
		transition:scale={{ start: 0.96, duration: motionDuration(120) }}
		class="fixed z-[100] w-64 rounded-lg border border-surface-700 bg-surface-900 p-3 shadow-xl"
		style="top: {dropdownTop}px; left: {dropdownLeft}px;"
	>
		<div class="mb-3 border-b border-surface-700 pb-3">
			<div class="flex gap-2">
				<button
					onclick={() => isOverlayEditMode.update(v => !v)}
					class="flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors
						{$isOverlayEditMode ? 'bg-teal-600 text-white' : 'bg-surface-800 text-surface-400 hover:text-surface-200'}"
				>
					{$isOverlayEditMode ? m.header_edit_boxes_on() : m.header_edit_boxes()}
				</button>
				<button
					onclick={toggleAllVertical}
					disabled={!$settings.overlayVerticalText}
					class="rounded bg-surface-800 px-2 py-1.5 text-xs font-medium text-surface-400 transition-colors hover:text-surface-200 active:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-40"
					title={$settings.overlayVerticalText ? m.header_toggle_vertical_horizontal_text() : m.header_enable_preserve_vertical_source()}
				>
					↕↔
				</button>
			</div>
			<p class="mt-1 text-[9px] text-surface-500">{m.header_click_individual_boxes_to()}</p>
		</div>
	</div>
{/if}

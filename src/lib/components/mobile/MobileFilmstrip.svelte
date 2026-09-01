<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fadeOnDecode } from '$lib/util/fade-on-decode.js';
	import { captureVideoPosterFrame } from '$lib/util/video-poster.js';
	import { fade, fly } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { currentPageIndex, currentVolume, totalPages } from '$lib/stores/reader-state.js';
	import { createPageSource } from '$lib/reader/page-source-factory.js';
	import type { PageSource } from '$lib/reader/page-source.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { readerPageJump } from '$lib/reader/reader-page-jump.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { OverlayBoxLongPressRecognizer } from '$lib/reader/overlay-box-long-press.js';
	import {
		filmstripOffsetForIndex,
		filmstripScrollLeftForIndex,
		getFilmstripWindow
	} from '$lib/reader/page-thumbnail-filmstrip-window.js';

	type ThumbnailState = { status: 'queued' | 'loading' | 'loaded' | 'error'; url?: string };
	const ITEM_WIDTH = 72;
	const ITEM_HEIGHT = 96;
	const GAP = 8;
	const OVERSCAN_ITEMS = 4;
	const MAX_CARDS = 40;
	const MAX_URLS = 40;
	const MAX_CONCURRENT = 3;
	const RETAIN_ITEMS = 12;

	let railEl = $state<HTMLDivElement | null>(null);
	let sourceError = $state<string | null>(null);
	let scrollLeft = $state(0);
	let viewportWidth = $state(412);
	let pageSource: PageSource | null = null;
	let sourceController: AbortController | null = null;
	let sourceGeneration = 0;
	let nextToken = 0;
	let activeLoads = 0;
	let queue: number[] = [];
	let thumbnailStates = $state<Record<number, ThumbnailState>>({});
	let resizeObserver: ResizeObserver | null = null;
	const desired = new Set<number>();
	const activeByIndex = new Map<number, { token: number; controller: AbortController }>();

	let strip = $derived(getFilmstripWindow({
		totalPages: $totalPages,
		scrollLeft,
		viewportWidth,
		itemWidth: ITEM_WIDTH,
		gap: GAP,
		overscanItems: OVERSCAN_ITEMS,
		maxCards: MAX_CARDS
	}));
	let liveUrlCount = $derived(Object.values(thumbnailStates).filter((state) => !!state.url).length);

	function updateState(index: number, state: ThumbnailState): void {
		thumbnailStates[index] = state;
	}

	function urlIsAttached(url: string): boolean {
		return Boolean(railEl?.querySelector(`img[src="${CSS.escape(url)}"]`)?.isConnected);
	}

	function revoke(index: number): void {
		const state = thumbnailStates[index];
		if (!state?.url) {
			delete thumbnailStates[index];
			return;
		}
		if (urlIsAttached(state.url)) {
			requestAnimationFrame(() => {
				if (!desired.has(index) && thumbnailStates[index]?.url === state.url && !urlIsAttached(state.url!)) revoke(index);
			});
			return;
		}
		URL.revokeObjectURL(state.url);
		delete thumbnailStates[index];
	}

	function enforceRetention(): void {
		const minVisible = strip.indexes[0] ?? get(currentPageIndex);
		const maxVisible = strip.indexes.at(-1) ?? get(currentPageIndex);
		const retainMin = Math.max(0, minVisible - RETAIN_ITEMS);
		const retainMax = Math.min(get(totalPages) - 1, maxVisible + RETAIN_ITEMS);
		const selected = get(currentPageIndex);
		for (const index of Object.keys(thumbnailStates).map(Number)) {
			if (index !== selected && (index < retainMin || index > retainMax)) revoke(index);
		}
		const withUrls = Object.keys(thumbnailStates).map(Number)
			.filter((index) => !!thumbnailStates[index]?.url)
			.sort((left, right) => {
				const leftDistance = left < minVisible ? minVisible - left : left > maxVisible ? left - maxVisible : 0;
				const rightDistance = right < minVisible ? minVisible - right : right > maxVisible ? right - maxVisible : 0;
				return rightDistance - leftDistance;
			});
		for (const index of withUrls.slice(0, Math.max(0, withUrls.length - MAX_URLS))) revoke(index);
	}

	function scheduleWindow(indexes: number[]): void {
		desired.clear();
		for (const index of indexes) desired.add(index);
		for (const [index, active] of activeByIndex) {
			if (!desired.has(index)) active.controller.abort();
		}
		queue = indexes.filter((index) => {
			const state = thumbnailStates[index];
			return state?.status !== 'loaded' && state?.status !== 'loading';
		});
		for (const index of queue) updateState(index, { status: 'queued' });
		enforceRetention();
		pump();
	}

	function pump(): void {
		while (pageSource && activeLoads < MAX_CONCURRENT && queue.length > 0) {
			const index = queue.shift()!;
			if (!desired.has(index)) continue;
			const state = thumbnailStates[index];
			if (state?.status === 'loaded' || state?.status === 'loading') continue;
			const token = ++nextToken;
			const controller = new AbortController();
			activeByIndex.set(index, { token, controller });
			activeLoads += 1;
			updateState(index, { status: 'loading' });
			void loadThumbnail(index, token, controller.signal).finally(() => {
				if (activeByIndex.get(index)?.token === token) activeByIndex.delete(index);
				activeLoads = Math.max(0, activeLoads - 1);
				if (thumbnailStates[index]?.status === 'loading') delete thumbnailStates[index];
				pump();
			});
		}
	}

	function isCurrent(index: number, token: number, generation: number, source: PageSource): boolean {
		return generation === sourceGeneration
			&& source === pageSource
			&& activeByIndex.get(index)?.token === token
			&& desired.has(index);
	}

	async function loadThumbnail(index: number, token: number, signal: AbortSignal): Promise<void> {
		const source = pageSource;
		const generation = sourceGeneration;
		if (!source) return;
		try {
			const page = await source.getPage(index, { signal });
			if (!isCurrent(index, token, generation, source)) return;
			const thumbnail = await downscale(page, signal);
			if (!isCurrent(index, token, generation, source)) return;
			const url = URL.createObjectURL(thumbnail);
			if (!isCurrent(index, token, generation, source)) {
				URL.revokeObjectURL(url);
				return;
			}
			const old = thumbnailStates[index]?.url;
			if (old && !urlIsAttached(old)) URL.revokeObjectURL(old);
			updateState(index, { status: 'loaded', url });
			enforceRetention();
		} catch (error) {
			if (signal.aborted || !isCurrent(index, token, generation, source)) return;
			console.debug(`[MobileFilmstrip] Preview ${index + 1} failed`, error);
			updateState(index, { status: 'error' });
		}
	}

	async function downscale(page: Blob, signal: AbortSignal): Promise<Blob> {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		// Video pages thumbnail from a poster frame (serialized decoder queue).
		const bitmap = page.type.startsWith('video/')
			? await captureVideoPosterFrame(page)
			: await createImageBitmap(page);
		try {
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
			const scale = Math.min(1, 144 / Math.max(1, bitmap.width), 192 / Math.max(1, bitmap.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d', { alpha: false });
			if (!context) throw new Error('Canvas is unavailable');
			context.fillStyle = '#0a0a0b';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
				(blob) => blob ? resolve(blob) : reject(new Error('Thumbnail encoding failed')),
				'image/jpeg', 0.84
			));
		} finally {
			bitmap.close();
		}
	}

	// Long-press anywhere on the rail opens the page-jump dialog (which
	// replaces the strip via disclosure exclusivity).
	const railLongPress = new OverlayBoxLongPressRecognizer<string>({
		onRecognized: () => {
			playReaderHaptic('selection');
			mobileReaderUi.openDisclosure('page-jump');
		}
	});

	function navigate(index: number): void {
		if (railLongPress.consumeSyntheticClick()) return;
		const volume = get(currentVolume);
		const previous = get(currentPageIndex);
		if (!volume || index < 0 || index >= get(totalPages) || index === previous) return;
		playReaderHaptic('control');
		// The strip itself is the way back while scrubbing, so its Return chip
		// only lingers briefly (numeric jumps keep the longer default).
		readerPageJump.recordJump(volume.volume_uuid, previous, index, 2_500);
		currentPageIndex.set(index);
		// The strip stays open for scrubbing; keep the chosen page centered.
		centerOn(index, 'smooth');
	}

	function centerOn(index: number, behavior: ScrollBehavior = 'auto'): void {
		if (!railEl) return;
		const target = filmstripScrollLeftForIndex(index, get(totalPages), railEl.clientWidth, ITEM_WIDTH, GAP);
		railEl.scrollTo({ left: target, behavior });
		scrollLeft = target;
	}

	function handleScroll(): void {
		if (!railEl) return;
		scrollLeft = Math.abs(railEl.scrollLeft);
	}

	$effect(() => {
		const indexes = strip.indexes;
		// Scheduling reads and mutates thumbnail state; keep those details out
		// of the virtual-window effect's dependency set.
		untrack(() => scheduleWindow(indexes));
	});

	onMount(async () => {
		const volume = get(currentVolume);
		if (!volume) {
			sourceError = m.reader_no_comic_is_open();
			return;
		}
		// Measure and center BEFORE the (potentially slow) source creation, so
		// a late-arriving source can never yank the rail away from a position
		// the user has already scrolled to.
		await tick();
		if (railEl) {
			viewportWidth = railEl.clientWidth;
			centerOn(get(currentPageIndex));
			resizeObserver = new ResizeObserver(() => {
				if (railEl) viewportWidth = railEl.clientWidth;
			});
			resizeObserver.observe(railEl);
		}
		const generation = ++sourceGeneration;
		const controller = new AbortController();
		sourceController = controller;
		try {
			const source = await createPageSource(volume, { purpose: 'preview', signal: controller.signal });
			if (controller.signal.aborted || generation !== sourceGeneration) {
				source.dispose();
				return;
			}
			pageSource = source;
			scheduleWindow(strip.indexes);
		} catch (error) {
			if (!controller.signal.aborted && generation === sourceGeneration) {
				sourceError = error instanceof Error ? error.message : m.reader_unable_to_load_page_2();
			}
		}
	});

	onDestroy(() => {
		railLongPress.dispose();
		resizeObserver?.disconnect();
		sourceGeneration += 1;
		sourceController?.abort();
		for (const active of activeByIndex.values()) active.controller.abort();
		activeByIndex.clear();
		const urls = Object.values(thumbnailStates).flatMap((state) => state.url ? [state.url] : []);
		// Svelte runs destroy callbacks before it detaches the component DOM;
		// revoke next frame so no connected <img> points at a revoked URL.
		requestAnimationFrame(() => { for (const url of urls) URL.revokeObjectURL(url); });
		pageSource?.dispose();
		pageSource = null;
	});
</script>

<!-- Convention B: transparent scrim below the bottom bar (z-40) so the bar
     stays tappable; page-area taps only dismiss the strip. -->
<button
	type="button"
	aria-label={m.reader_close_page_filmstrip()}
	class="fixed inset-0 z-[35]"
	onclick={() => mobileReaderUi.closeDisclosure()}
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
	data-reader-filmstrip-scrim
></button>
<div
	class="fixed z-[45] rounded-[var(--radius-card)] bg-surface-container-high p-2 shadow-2xl"
	style="bottom: calc(var(--reader-bottom-clearance) + 8px); left: calc(0.5rem + var(--sal, 0px)); right: calc(0.5rem + var(--sar, 0px));"
	in:fly={{ y: 10, duration: motionDuration(140) }}
	out:fly={{ y: 10, duration: motionDuration(exitDuration(140)) }}
	role="listbox"
	aria-label={m.reader_page_filmstrip()}
	data-reader-filmstrip
	data-total-pages={$totalPages}
	data-rendered-filmstrip-cards={strip.indexes.length}
	data-filmstrip-live-urls={liveUrlCount}
>
	{#if sourceError}
		<p class="px-2 py-4 text-center text-xs text-red-300" role="alert">{sourceError}</p>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={railEl}
			class="filmstrip-rail select-none overflow-x-auto overscroll-x-contain"
			style="height: {ITEM_HEIGHT}px;"
			onscroll={handleScroll}
			oncontextmenu={(event) => event.preventDefault()}
			onpointerdown={(event) => railLongPress.pointerDown({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, boxId: 'rail' })}
			onpointermove={(event) => railLongPress.pointerMove(event.pointerId, event.clientX, event.clientY)}
			onpointerup={(event) => railLongPress.pointerUp(event.pointerId)}
			onpointercancel={(event) => railLongPress.pointerCancel(event.pointerId)}
		>
			<div class="relative" style="width: {strip.totalWidth}px; height: {ITEM_HEIGHT}px;">
				{#each strip.indexes as index (index)}
					{@const state = thumbnailStates[index]}
					{@const current = index === $currentPageIndex}
					<button
						type="button"
						role="option"
						aria-selected={current}
						aria-current={current ? 'page' : undefined}
						aria-label={m.reader_go_to_page_index({ index: index + 1 })}
						class="absolute top-0 overflow-hidden rounded-lg border bg-surface-900 {current ? 'border-teal-400 shadow-[0_0_0_1.5px_rgba(45,212,191,.65)]' : 'border-surface-700'}"
						style="left: {filmstripOffsetForIndex(index, ITEM_WIDTH, GAP)}px; width: {ITEM_WIDTH}px; height: {ITEM_HEIGHT}px;"
						onclick={() => navigate(index)}
						data-filmstrip-page={index}
					>
						{#if state?.url}
							<img src={state.url} alt="" class="h-full w-full object-cover" draggable="false" use:fadeOnDecode />
						{:else}
							<span class="flex h-full w-full items-center justify-center text-[10px] text-surface-600">{state?.status === 'error' ? '!' : '…'}</span>
						{/if}
						<span class="absolute inset-x-0 bottom-0 bg-surface-950/80 py-0.5 text-center text-[10px] font-semibold {current ? 'text-teal-300' : 'text-surface-200'}">{index + 1}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.filmstrip-rail {
		touch-action: pan-x;
		scrollbar-width: none;
		-webkit-touch-callout: none;
	}

	.filmstrip-rail::-webkit-scrollbar {
		display: none;
	}
</style>

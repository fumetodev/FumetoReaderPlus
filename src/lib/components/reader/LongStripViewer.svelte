<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * Long-strip (webtoon) reader surface: every page of the volume stacked
	 * top-down at fit-width with no gaps, natively scrolled and virtualized.
	 *
	 * The "current page" is whichever page occupies the most of the viewport;
	 * it drives the same page-scoped machinery as paged mode (page counter,
	 * translation data loading, auto-translate, progress persistence) through
	 * the shared currentPageIndex store. External navigation (filmstrip, page
	 * jump, keyboard) scrolls the strip to the requested page.
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import { motionDuration } from '$lib/util/motion.js';
	import { get } from 'svelte/store';
	import { currentPageIndex, currentVolume, pageDimensions } from '$lib/stores/reader-state.js';
	import { isVideoPageFilename } from '$lib/import/types.js';
	import type { PageSource } from '$lib/reader/page-source.js';
	import { READER_TAP_MAX_AXIS_DELTA_PX, READER_TAP_MAX_DURATION_MS } from '$lib/reader/reader-touch-decision.js';
	import { buildStripLayout, dominantPageIndex, stripPageWindow } from '$lib/reader/long-strip-layout.js';
	import LongStripPageOverlay from './LongStripPageOverlay.svelte';

	interface Props {
		pageSource: PageSource | null;
		/** Tap (small drift, short duration, single contact) on the strip. */
		ontap?: () => void;
	}

	let { pageSource, ontap }: Props = $props();

	const OVERSCAN_PX = 1200;
	/** Loaded object URLs kept beyond the render window, per side. */
	const URL_RETENTION_PAGES = 4;

	let containerEl = $state<HTMLDivElement>();
	let stripWidth = $state(0);
	let viewportHeight = $state(0);
	let scrollTop = $state(0);

	let layout = $derived(buildStripLayout($pageDimensions.map((dim) => ({ width: dim.width, height: dim.height })), Math.max(1, stripWidth)));
	let renderWindow = $derived(stripPageWindow(layout, scrollTop, viewportHeight, OVERSCAN_PX));
	let renderedPages = $derived(layout.pages.slice(renderWindow.start, renderWindow.end + 1));

	// ── Image loading (single-flight, retained around the render window) ──
	let pageUrls = $state<Map<number, string>>(new Map());
	const objectUrls = new Map<number, string>();
	const inFlight = new Map<number, Promise<void>>();
	let failedPages = $state<Map<number, boolean>>(new Map());
	let loadEpoch = 0;

	function retryPage(index: number): void {
		failedPages = new Map([...failedPages].filter(([key]) => key !== index));
		if (pageSource) loadPage(index, pageSource, loadEpoch);
	}

	function loadPage(index: number, source: PageSource, epoch: number): void {
		if (objectUrls.has(index) || inFlight.has(index)) return;
		if (failedPages.has(index)) failedPages = new Map([...failedPages].filter(([key]) => key !== index));
		let load: Promise<void>;
		load = source.getPage(index).then(async (blob) => {
			if (epoch !== loadEpoch || !blob) return;
			const url = URL.createObjectURL(blob);
			// Ownership check: two loads for one index can exist after a source
			// swap, and the loser must not overwrite (and leak) the winner's URL.
			const existing = objectUrls.get(index);
			if (existing) {
				URL.revokeObjectURL(url);
				return;
			}
			objectUrls.set(index, url);
			pageUrls = new Map(objectUrls);
			// Remote sources may not know page sizes until decode; backfill the
			// in-memory dimensions so the strip layout stops using the fallback
			// aspect (and the overlay wrapper can mount) for this page.
			const dims = get(pageDimensions);
			if (dims[index] && dims[index].width === 0) {
				try {
					let width = 0;
					let height = 0;
					if (blob.type.startsWith('video/')) {
						// createImageBitmap(videoBlob) throws — probe metadata instead
						// (serialized through the shared decoder queue).
						const { probeVideoDimensions } = await import('$lib/util/video-poster.js');
						({ width, height } = await probeVideoDimensions(blob));
					} else {
						const bitmap = await createImageBitmap(blob);
						({ width, height } = bitmap);
						bitmap.close();
					}
					if (epoch === loadEpoch && width > 0 && height > 0) {
						pageDimensions.update((pages) =>
							pages.map((p) => (p.index === index && p.width === 0 ? { ...p, width, height } : p))
						);
					}
				} catch {
					// Fallback aspect keeps the strip usable.
				}
			}
		}).catch(() => {
			// Record it so the page can offer a retry instead of shimmering
			// forever: the loader only re-runs when the source or the render
			// window changes, so a failed page otherwise stays a blank skeleton.
			if (epoch === loadEpoch) {
				failedPages = new Map(failedPages).set(index, true);
			}
		}).finally(() => {
			// Delete only our own entry. The reset effect clears this map on a
			// source change, and a stale load settling afterwards would otherwise
			// remove the REPLACEMENT entry and let a third load start.
			if (inFlight.get(index) === load) inFlight.delete(index);
		});
		inFlight.set(index, load);
	}

	// Volume/source change resets every cached page image.
	// DECLARED BEFORE the loading effect below: Svelte runs effects in
	// declaration order within a flush, and both react to pageSource. With the
	// old order (load first, reset second) the first source arrival started
	// loads under epoch N, then the reset bumped to N+1 and silently dropped
	// every result — leaving permanent skeletons until a scroll or resize
	// re-triggered loading.
	$effect(() => {
		pageSource;
		loadEpoch += 1;
		for (const url of untrack(() => objectUrls).values()) URL.revokeObjectURL(url);
		objectUrls.clear();
		inFlight.clear();
		pageUrls = new Map();
	});

	$effect(() => {
		const source = pageSource;
		const { start, end } = renderWindow;
		if (!source || end < start) return;
		const epoch = loadEpoch;
		for (let index = start; index <= end; index += 1) loadPage(index, source, epoch);
		// Evict far-away URLs after the DOM has dropped their pages.
		const keepStart = start - URL_RETENTION_PAGES;
		const keepEnd = end + URL_RETENTION_PAGES;
		const evicted: number[] = [];
		for (const index of objectUrls.keys()) {
			if (index < keepStart || index > keepEnd) evicted.push(index);
		}
		if (evicted.length > 0) {
			for (const index of evicted) {
				const url = objectUrls.get(index);
				objectUrls.delete(index);
				if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
			}
			pageUrls = new Map(objectUrls);
		}
	});

	// ── Current-page tracking (scroll → store) and external jumps (store → scroll) ──
	let scrollRafId: number | undefined;
	let lastSelfReportedIndex = -1;

	function updateTrackedPage(): void {
		const dominant = dominantPageIndex(layout, scrollTop, viewportHeight);
		if (dominant !== get(currentPageIndex)) {
			lastSelfReportedIndex = dominant;
			currentPageIndex.set(dominant);
		} else {
			lastSelfReportedIndex = dominant;
		}
	}

	function handleScroll(): void {
		if (!containerEl) return;
		scrollTop = containerEl.scrollTop;
		if (scrollRafId !== undefined) return;
		scrollRafId = requestAnimationFrame(() => {
			scrollRafId = undefined;
			updateTrackedPage();
		});
	}

	$effect(() => {
		const index = $currentPageIndex;
		const pages = layout.pages;
		if (!containerEl || pages.length === 0) return;
		if (index === untrack(() => lastSelfReportedIndex)) return;
		// External navigation: snap the strip to the requested page.
		const page = pages[Math.max(0, Math.min(index, pages.length - 1))];
		lastSelfReportedIndex = index;
		containerEl.scrollTop = page.top;
		scrollTop = page.top;
	});

	// Volume open: land on the resume page without animation.
	let initializedFor = '';
	$effect(() => {
		const volumeUuid = $currentVolume?.volume_uuid ?? '';
		const total = layout.totalHeight;
		if (!containerEl || !volumeUuid || total <= 0) return;
		if (initializedFor === volumeUuid) return;
		initializedFor = volumeUuid;
		const index = get(currentPageIndex);
		const page = layout.pages[Math.max(0, Math.min(index, layout.pages.length - 1))];
		lastSelfReportedIndex = index;
		containerEl.scrollTop = page?.top ?? 0;
		scrollTop = page?.top ?? 0;
	});

	// ── Video pages: play only the current (dominant) page ──
	// Android's hardware decoder pool is ~2-4 deep; a strip autoplaying every
	// mounted video hits it. Playback is gated to the dominant page; only
	// videos within one page of it preload data (frozen first frame + instant
	// start), farther mounted ones stay at preload=metadata; and unmount
	// force-releases the decoder (detach + load()) instead of waiting for GC
	// — same discipline as video-poster.ts, for the same reason.
	function playWhenCurrent(node: HTMLVideoElement, current: boolean) {
		const apply = (value: boolean) => {
			if (value) {
				// Rapid pause/play cycles surface AbortErrors — irrelevant here.
				node.play().catch(() => undefined);
			} else {
				node.pause();
			}
		};
		apply(current);
		return {
			update: apply,
			destroy: () => {
				node.pause();
				node.removeAttribute('src');
				node.load();
			}
		};
	}

	// ── Tap detection (chrome toggle); vertical scrolling stays native ──
	let touchStartX = 0;
	let touchStartY = 0;
	let touchStartTime = 0;
	let touchTracked = false;

	function isInteractiveTarget(target: EventTarget | null): boolean {
		return target instanceof Element && Boolean(target.closest('button, input, select, textarea, a'));
	}

	function handleTouchStart(event: TouchEvent): void {
		if (event.touches.length > 1) {
			touchTracked = false;
			return;
		}
		touchTracked = !isInteractiveTarget(event.target);
		touchStartX = event.touches[0].clientX;
		touchStartY = event.touches[0].clientY;
		// Input-time clock: Date.now() measures event DELIVERY, which
		// main-thread jank pushes past the physical contact and silently
		// rejects real taps. Event timeStamps carry the input timeline.
		touchStartTime = event.timeStamp;
	}

	function handleTouchEnd(event: TouchEvent): void {
		if (!touchTracked || event.touches.length > 0) {
			touchTracked = false;
			return;
		}
		touchTracked = false;
		const touch = event.changedTouches[0];
		const dx = Math.abs(touch.clientX - touchStartX);
		const dy = Math.abs(touch.clientY - touchStartY);
		const dt = event.timeStamp - touchStartTime;
		if (dx < READER_TAP_MAX_AXIS_DELTA_PX && dy < READER_TAP_MAX_AXIS_DELTA_PX && dt < READER_TAP_MAX_DURATION_MS) ontap?.();
	}

	let resizeObserver: ResizeObserver | undefined;

	/**
	 * Keyboard paging for the strip: scroll most of a viewport (a sliver of
	 * the previous screen stays visible so the eye keeps its place), in the
	 * direction given. The scroll handler then re-derives the current page.
	 */
	export function scrollByViewport(direction: 1 | -1): void {
		if (!containerEl) return;
		const step = Math.round(containerEl.clientHeight * 0.85) * direction;
		containerEl.scrollBy({ top: step, behavior: motionDuration(1) === 0 ? 'auto' : 'smooth' });
	}

	onMount(() => {
		if (!containerEl) return;
		stripWidth = containerEl.clientWidth;
		viewportHeight = containerEl.clientHeight;
		resizeObserver = new ResizeObserver(() => {
			if (!containerEl) return;
			// Page heights are derived from the strip width, so a width change
			// rescales the whole layout under a scrollTop still expressed in the
			// OLD pixel space — an orientation change silently threw the reader
			// pages backwards and left the tracked index (and therefore the page
			// counter, progress persistence and per-page overlays) pointing
			// somewhere else. Re-anchor on the tracked page and the fraction of
			// it that was on screen.
			const previous = layout.pages[$currentPageIndex];
			const fraction = previous && previous.height > 0
				? Math.min(1, Math.max(0, (containerEl.scrollTop - previous.top) / previous.height))
				: 0;

			stripWidth = containerEl.clientWidth;
			viewportHeight = containerEl.clientHeight;

			const anchor = layout.pages[$currentPageIndex];
			if (anchor) {
				const target = anchor.top + fraction * anchor.height;
				containerEl.scrollTop = target;
				scrollTop = target;
				updateTrackedPage();
			}
		});
		resizeObserver.observe(containerEl);
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		if (scrollRafId !== undefined) cancelAnimationFrame(scrollRafId);
		loadEpoch += 1;
		for (const url of objectUrls.values()) URL.revokeObjectURL(url);
		objectUrls.clear();
		inFlight.clear();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (gesture surface; reader navigation has separate controls) -->
<div
	bind:this={containerEl}
	role="presentation"
	class="absolute inset-0 overflow-y-auto overflow-x-hidden bg-surface-950"
	style="touch-action: pan-y; overscroll-behavior: contain;"
	data-long-strip
	data-long-strip-current-page={$currentPageIndex}
	onscroll={handleScroll}
	ontouchstart={handleTouchStart}
	ontouchend={handleTouchEnd}
>
	<div class="relative w-full" style="height: {layout.totalHeight}px;" data-long-strip-canvas>
		{#each renderedPages as page (page.index)}
			{@const dim = $pageDimensions[page.index]}
			{@const url = pageUrls.get(page.index)}
			<div
				class="absolute inset-x-0"
				style="top: {page.top}px; height: {page.height}px;"
				data-long-strip-page={page.index}
			>
				{#if url}
					{#if dim && isVideoPageFilename(dim.filename)}
						<!-- Muted loop = GIF parity; playback gated to the dominant page
						     via playWhenCurrent. pointer-events:none keeps strip taps on
						     the same surfaces as image pages. -->
						<video
							src={url}
							muted
							loop
							playsinline
							preload={Math.abs(page.index - $currentPageIndex) <= 1 ? 'auto' : 'metadata'}
							use:playWhenCurrent={page.index === $currentPageIndex}
							class="block h-full w-full"
							style="object-fit: contain; pointer-events: none;"
							data-long-strip-video={page.index}
						></video>
					{:else}
						<img src={url} alt={m.reader_page_alt({ n: page.index + 1 })} class="block h-full w-full" draggable="false" />
					{/if}
				{:else if failedPages.has(page.index)}
					<!-- Paged mode shows an error card with Retry; the strip used to
					     shimmer here indefinitely, since the loader only re-runs when
					     the source or the render window changes. -->
					<div class="flex h-full w-full flex-col items-center justify-center gap-3 bg-surface-900/40 p-4 text-center">
						<p class="text-sm text-surface-400">{m.reader_page_could_not_load({ n: page.index + 1 })}</p>
						<button
							type="button"
							data-long-strip-retry={page.index}
							class="flex h-11 items-center justify-center rounded-full border border-surface-600 px-5 text-sm font-medium text-surface-200 active:bg-surface-800"
							onclick={(event) => { event.stopPropagation(); retryPage(page.index); }}
						>
							{m.reader_try_again()}
						</button>
					</div>
				{:else}
					<div class="reader-page-skeleton h-full w-full" aria-hidden="true"></div>
				{/if}
				{#if dim && dim.width > 0 && dim.height > 0 && $currentVolume}
					<!-- Overlay renders in source-image pixel space, scaled to the strip. -->
					<div
						class="pointer-events-none absolute left-0 top-0"
						style="width: {dim.width}px; height: {dim.height}px; transform: scale({page.scale}); transform-origin: 0 0;"
					>
						<LongStripPageOverlay
							volumeUuid={$currentVolume.volume_uuid}
							pageIndex={page.index}
							isCurrent={page.index === $currentPageIndex}
							scale={page.scale}
						/>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>

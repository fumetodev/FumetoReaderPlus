<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fadeOnDecode } from '$lib/util/fade-on-decode.js';
	import { captureVideoPosterFrame } from '$lib/util/video-poster.js';
	import { fade } from 'svelte/transition';
	import { motionDuration } from '$lib/util/motion.js';
	import { onDestroy, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { currentPageIndex, currentVolume, totalPages } from '$lib/stores/reader-state.js';
	import { createPageSource } from '$lib/reader/page-source-factory.js';
	import type { PageSource } from '$lib/reader/page-source.js';
	import {
		getGridThumbnailLoadOrder,
		getGridThumbnailRetentionSet
	} from '$lib/reader/page-thumbnail-grid-window.js';

	let { onClose }: { onClose: () => void } = $props();

	type ThumbnailState = {
		status: 'queued' | 'loading' | 'loaded' | 'error';
		url?: string;
	};

	const COLUMN_COUNT = 3;
	const OVERSCAN_ROWS = 3;
	const RETENTION_ROWS = 8;
	const MAX_CONCURRENT_LOADS = 3;
	const THUMBNAIL_MAX_WIDTH = 320;
	const THUMBNAIL_MAX_HEIGHT = 480;

	let dialogEl = $state<HTMLDivElement | null>(null);
	let gridEl = $state<HTMLDivElement | null>(null);
	let sourceError = $state<string | null>(null);
	let thumbnailStates = $state<Record<number, ThumbnailState>>({});
	let readyUrls = $state<Record<number, string>>({});
	let pageSource: PageSource | null = null;
	let sourceController: AbortController | null = null;
	let sourceGeneration = 0;
	let nextLoadToken = 0;
	let activeLoads = 0;
	let queue: number[] = [];
	let observer: IntersectionObserver | null = null;
	let previouslyFocused: HTMLElement | null = null;
	const visibleIndexes = new Set<number>();
	const desiredIndexes = new Set<number>();
	const activeLoadsByIndex = new Map<number, { token: number; controller: AbortController }>();

	const loadedThumbnailIndexes = $derived.by(() => Object.entries(thumbnailStates)
		.filter(([index, state]) => state.status === 'loaded' && readyUrls[Number(index)] === state.url)
		.map(([index]) => Number(index))
		.sort((left, right) => left - right));

	function updateThumbnailState(index: number, state: ThumbnailState): void {
		thumbnailStates[index] = state;
	}

	function revokeThumbnail(index: number): void {
		const url = thumbnailStates[index]?.url;
		if (url) URL.revokeObjectURL(url);
		delete thumbnailStates[index];
		delete readyUrls[index];
	}

	function cleanupThumbnails(): void {
		for (const active of activeLoadsByIndex.values()) active.controller.abort();
		activeLoadsByIndex.clear();
		for (const index of Object.keys(thumbnailStates)) revokeThumbnail(Number(index));
		queue = [];
		desiredIndexes.clear();
		visibleIndexes.clear();
	}

	function scheduleVisibleWindow(): void {
		if (!pageSource) return;
		const order = getGridThumbnailLoadOrder(
			visibleIndexes,
			get(totalPages),
			get(currentPageIndex),
			COLUMN_COUNT,
			OVERSCAN_ROWS
		);
		desiredIndexes.clear();
		for (const index of order) desiredIndexes.add(index);

		for (const [index, active] of activeLoadsByIndex) {
			if (!desiredIndexes.has(index)) active.controller.abort();
		}

		const alreadyQueued = new Set(queue);
		queue = order.filter((index) => {
			const state = thumbnailStates[index];
			return state?.status !== 'loaded' && state?.status !== 'loading';
		});
		for (const index of alreadyQueued) {
			if (!desiredIndexes.has(index) && thumbnailStates[index]?.status === 'queued') {
				delete thumbnailStates[index];
			}
		}
		for (const index of queue) updateThumbnailState(index, { status: 'queued' });

		const retained = getGridThumbnailRetentionSet(
			visibleIndexes,
			get(currentPageIndex),
			get(totalPages),
			COLUMN_COUNT,
			RETENTION_ROWS
		);
		for (const index of Object.keys(thumbnailStates).map(Number)) {
			if (thumbnailStates[index]?.status === 'loaded' && !retained.has(index)) revokeThumbnail(index);
		}
		pumpQueue();
	}

	function pumpQueue(): void {
		while (activeLoads < MAX_CONCURRENT_LOADS && queue.length > 0) {
			const index = queue.shift()!;
			if (!desiredIndexes.has(index)) continue;
			const state = thumbnailStates[index];
			if (state?.status === 'loaded' || state?.status === 'loading') continue;
			const token = ++nextLoadToken;
			const controller = new AbortController();
			activeLoadsByIndex.set(index, { token, controller });
			updateThumbnailState(index, { status: 'loading' });
			activeLoads += 1;
			void loadThumbnail(index, token, controller.signal).finally(() => {
				if (activeLoadsByIndex.get(index)?.token === token) activeLoadsByIndex.delete(index);
				activeLoads -= 1;
				if (thumbnailStates[index]?.status === 'loading') delete thumbnailStates[index];
				pumpQueue();
			});
		}
	}

	function loadIsCurrent(index: number, token: number, source: PageSource, generation: number): boolean {
		return generation === sourceGeneration
			&& source === pageSource
			&& activeLoadsByIndex.get(index)?.token === token
			&& desiredIndexes.has(index);
	}

	async function loadThumbnail(index: number, token: number, signal: AbortSignal): Promise<void> {
		const source = pageSource;
		const generation = sourceGeneration;
		if (!source) return;
		try {
			const fullResolutionPage = await source.getPage(index, { signal });
			if (!loadIsCurrent(index, token, source, generation)) return;
			const thumbnail = await downscaleThumbnail(fullResolutionPage, signal);
			if (!loadIsCurrent(index, token, source, generation)) return;
			const url = URL.createObjectURL(thumbnail);
			if (!loadIsCurrent(index, token, source, generation)) {
				URL.revokeObjectURL(url);
				return;
			}
			const oldUrl = thumbnailStates[index]?.url;
			if (oldUrl) URL.revokeObjectURL(oldUrl);
			delete readyUrls[index];
			updateThumbnailState(index, { status: 'loaded', url });
		} catch (error) {
			if (signal.aborted || !loadIsCurrent(index, token, source, generation)) return;
			console.debug(`[PageThumbnailGrid] Page ${index + 1} preview failed:`, error);
			updateThumbnailState(index, { status: 'error' });
		}
	}

	async function downscaleThumbnail(page: Blob, signal: AbortSignal): Promise<Blob> {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		let imageSource: CanvasImageSource;
		let width: number;
		let height: number;
		let dispose = () => {};
		try {
			if (page.type.startsWith('video/')) {
				// Video pages thumbnail from a poster frame; the Image fallback
				// below cannot decode video at all.
				const bitmap = await captureVideoPosterFrame(page);
				imageSource = bitmap;
				width = bitmap.width;
				height = bitmap.height;
				dispose = () => bitmap.close();
			} else if (typeof createImageBitmap === 'function') {
				const bitmap = await createImageBitmap(page);
				imageSource = bitmap;
				width = bitmap.width;
				height = bitmap.height;
				dispose = () => bitmap.close();
			} else {
				const objectUrl = URL.createObjectURL(page);
				dispose = () => URL.revokeObjectURL(objectUrl);
				const image = new Image();
				await new Promise<void>((resolve, reject) => {
					image.onload = () => resolve();
					image.onerror = () => reject(new Error('Unable to decode page image'));
					image.src = objectUrl;
				});
				imageSource = image;
				width = image.naturalWidth;
				height = image.naturalHeight;
			}
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
			const scale = Math.min(
				1,
				THUMBNAIL_MAX_WIDTH / Math.max(1, width),
				THUMBNAIL_MAX_HEIGHT / Math.max(1, height)
			);
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			const context = canvas.getContext('2d', { alpha: false });
			if (!context) throw new Error('Canvas rendering is unavailable');
			context.fillStyle = '#0a0a0b';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(imageSource, 0, 0, canvas.width, canvas.height);
			return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
				(blob) => blob ? resolve(blob) : reject(new Error('Unable to encode thumbnail')),
				'image/jpeg',
				0.88
			));
		} finally {
			dispose();
		}
	}

	async function handleImageLoad(event: Event, index: number, url: string): Promise<void> {
		const image = event.currentTarget as HTMLImageElement;
		try {
			if (typeof image.decode === 'function') await image.decode();
		} catch {
			if (!image.complete || image.naturalWidth <= 0) return;
		}
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		if (!image.isConnected || thumbnailStates[index]?.url !== url || image.naturalWidth <= 0) return;
		readyUrls[index] = url;
	}

	function handleImageError(index: number, url: string): void {
		if (thumbnailStates[index]?.url !== url) return;
		URL.revokeObjectURL(url);
		delete readyUrls[index];
		updateThumbnailState(index, { status: 'error' });
	}

	function publishedThumbnailState(index: number): string {
		const state = thumbnailStates[index];
		if (state?.status === 'loaded' && state.url && readyUrls[index] === state.url) return 'loaded';
		return state?.status ?? 'idle';
	}

	function selectPage(index: number): void {
		currentPageIndex.set(index);
		onClose();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== 'Tab') return;
		const controls = Array.from(dialogEl?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
			.filter((element) => element.getClientRects().length > 0);
		if (controls.length === 0) return;
		const current = controls.indexOf(document.activeElement as HTMLElement);
		if (!event.shiftKey && current === controls.length - 1) {
			event.preventDefault();
			controls[0].focus();
		} else if (event.shiftKey && current <= 0) {
			event.preventDefault();
			controls[controls.length - 1].focus();
		}
	}

	onMount(() => {
		previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		window.addEventListener('keydown', handleWindowKeydown);
		// Move focus out of the now-inert app shell immediately. Remote page-source
		// initialization may be slow or fail, but Return is always available.
		void tick().then(() => {
			dialogEl?.querySelector<HTMLElement>('[data-page-thumbnail-return]')
				?.focus({ preventScroll: true });
		});
		const volume = get(currentVolume);
		const generation = ++sourceGeneration;
		if (!volume) {
			sourceError = m.reader_no_comic_is_open();
			return;
		}
		const controller = new AbortController();
		sourceController = controller;
		void createPageSource(volume, { signal: controller.signal, purpose: 'preview' }).then(async (source) => {
			if (generation !== sourceGeneration || controller.signal.aborted) {
				source.dispose();
				return;
			}
			pageSource = source;
			await tick();
			observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const index = Number((entry.target as HTMLElement).dataset.page);
					if (entry.isIntersecting) visibleIndexes.add(index);
					else visibleIndexes.delete(index);
				}
				scheduleVisibleWindow();
			}, { root: gridEl, rootMargin: '140px 0px', threshold: 0.01 });
			for (const card of gridEl?.querySelectorAll<HTMLElement>('[data-page]') ?? []) observer.observe(card);
			const selected = gridEl?.querySelector<HTMLElement>(`[data-page="${get(currentPageIndex)}"]`);
			selected?.scrollIntoView({ block: 'center' });
			visibleIndexes.add(get(currentPageIndex));
			scheduleVisibleWindow();
			requestAnimationFrame(() => selected?.focus({ preventScroll: true }));
		}).catch((error) => {
			if (generation !== sourceGeneration || controller.signal.aborted) return;
			sourceError = error instanceof Error ? error.message : m.reader_unable_to_load_page();
		});
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleWindowKeydown);
		observer?.disconnect();
		observer = null;
		sourceGeneration += 1;
		sourceController?.abort();
		cleanupThumbnails();
		pageSource?.dispose();
		pageSource = null;
		const restoreTarget = previouslyFocused;
		queueMicrotask(() => {
			if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
		});
	});
</script>

<div class="page-thumbnail-layer fixed inset-0 z-[80]" transition:fade={{ duration: motionDuration(140) }} data-page-thumbnail-layer>
	<div class="page-thumbnail-backdrop absolute inset-0" data-page-thumbnail-backdrop></div>
	<div
		bind:this={dialogEl}
		class="page-thumbnail-dialog absolute inset-0 flex flex-col bg-surface-950"
		role="dialog"
		aria-modal="true"
		aria-label={m.reader_jump_to_comic_page()}
		data-page-thumbnail-scrubber
	>
		<div class="shrink-0 border-b border-surface-700 px-4 py-3 text-center" style="padding-top: calc(0.75rem + var(--sat, 0px));">
			<h2 class="text-base font-semibold text-surface-100" data-page-thumbnail-title>{m.reader_jump_to_page()}</h2>
			<p class="mt-0.5 text-xs text-surface-400">{m.reader_tap_a_thumbnail_to()}</p>
			{#if sourceError}<p class="mt-1 text-xs text-red-300" role="status">{sourceError}</p>{/if}
		</div>

		<div
			bind:this={gridEl}
			class="page-thumbnail-strip grid min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto overscroll-contain p-3"
			role="grid"
			aria-label={m.reader_page_thumbnail_grid()}
			data-columns="3"
			data-loaded-thumbnail-indexes={loadedThumbnailIndexes.join(',')}
			data-total-pages={$totalPages}
		>
			{#each Array.from({ length: $totalPages }, (_, index) => index) as index (index)}
				<button
					type="button"
					class="page-thumbnail-card min-w-0 rounded-lg border p-1.5 text-center outline-none {index === $currentPageIndex ? 'border-primary-400 bg-primary-600/15' : 'border-surface-700 bg-surface-900'} active:bg-surface-800 focus-visible:ring-2 focus-visible:ring-primary-400"
					data-page={index}
					data-centered={index === $currentPageIndex ? 'true' : 'false'}
					aria-current={index === $currentPageIndex ? 'page' : undefined}
					aria-label={m.reader_go_to_page_index({ index: index + 1 })}
					role="gridcell"
					onclick={() => selectPage(index)}
				>
					<span
						class="relative mx-auto flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-md bg-black"
						data-page-thumbnail={index}
						data-thumbnail-state={publishedThumbnailState(index)}
					>
						{#if thumbnailStates[index]?.url}
							{@const thumbnailUrl = thumbnailStates[index].url!}
							<img
								src={thumbnailUrl}
								alt={m.reader_page_alt({ n: index + 1 })}
								class="h-full w-full object-contain"
								draggable="false"
								use:fadeOnDecode
								onload={(event) => void handleImageLoad(event, index, thumbnailUrl)}
								onerror={() => handleImageError(index, thumbnailUrl)}
							/>
						{:else if thumbnailStates[index]?.status === 'error'}
							<span class="px-1 text-[10px] text-red-300">{m.reader_preview_unavailable()}</span>
						{:else}
							<span class="text-[10px] text-surface-500">{m.reader_loading()}</span>
						{/if}
					</span>
					<span class="mt-1 block text-xs font-semibold text-surface-200" data-page-thumbnail-number>{index + 1}</span>
				</button>
			{/each}
		</div>

		<div class="shrink-0 border-t border-surface-700 bg-surface-950 px-3 pt-2" style="padding-bottom: calc(0.5rem + var(--sab, 0px));">
			<button
				type="button"
				class="min-h-9 w-full rounded-md border border-surface-600 bg-surface-800 py-1.5 text-sm font-medium text-surface-100 active:bg-surface-700"
				aria-label={m.reader_return_to_reader()}
				data-page-thumbnail-return
				data-page-thumbnail-close
				onclick={onClose}
			><span data-page-thumbnail-close-label>{m.reader_return()}</span></button>
		</div>
	</div>
</div>

<style>
	.page-thumbnail-layer,
	.page-thumbnail-backdrop {
		background: #0a0a0b;
	}

	.page-thumbnail-dialog {
		contain: paint;
		isolation: isolate;
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
	}

	.page-thumbnail-strip {
		touch-action: pan-y;
		-webkit-overflow-scrolling: touch;
	}
</style>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fadeOnDecode } from '$lib/util/fade-on-decode.js';
	import { onDestroy, onMount, tick } from 'svelte';
	import { closeTab, createOrFocusTab, type LiveComicTab } from '$lib/tabs/comic-tabs.js';
	import { pushKeyedToast } from '$lib/stores/toasts.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { motionDuration } from '$lib/util/motion.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { openReader } from '$lib/stores/reader-state.js';
	import {
		calculateVirtualWindow,
		captureCatalogAnchor,
		restoreCatalogAnchor
	} from '$lib/catalog/virtual-window.js';
	import {
		estimateTabRowHeight,
		planPreviewJobs,
		tabRetentionRange
	} from '$lib/tabs/tab-grid-geometry.js';
	import { getThumbnailUrl, pinThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
	import { queueTabPreview } from '$lib/tabs/tab-preview-queue.js';
	import { tabsController } from '$lib/controllers/tabs-controller.js';
	import ContinueReadingStrip from '$lib/components/catalog/ContinueReadingStrip.svelte';
	import { continueReadingVolume } from '$lib/catalog/continue-reading.js';
	import type { LoadablePhase } from '$lib/controllers/loadable-snapshot.js';

	/**
	 * False while this view is mounted but hidden (see the layer stack in
	 * +page.svelte). Preview *reads* keep running so returning finds warm URLs
	 * already attached; preview *regeneration* does not, because it decodes full
	 * pages on the main thread and would compete with the reader.
	 */
	let { active = true }: { active?: boolean } = $props();

	/** Tab previews share the volume-thumbnail cache but are a DIFFERENT image
	 *  for the same uuid — the prefix keeps the two families of keys apart. */
	const PREVIEW_KEY_PREFIX = 'tab-preview:';
	const RETENTION_MARGIN_ITEMS = 8;

	let initialSnapshot = tabsController.getSnapshot();
	let tabs = $state<LiveComicTab[]>(initialSnapshot.data?.tabs ?? []);
	let tabsPhase = $state<LoadablePhase>(initialSnapshot.phase);
	let tabsError = $state<Error | undefined>(initialSnapshot.error);
	let hasLastGoodTabs = $state(Boolean(initialSnapshot.data));
	let container = $state<HTMLDivElement>();
	let gridEl = $state<HTMLDivElement>();
	let width = $state(360);
	let viewportHeight = $state(640);
	let scrollTop = $state(0);
	let gapPx = $state(13.5);
	/**
	 * Live row pitch measured from a rendered card (grows-only). The estimate is
	 * only a first-paint stand-in: a pitch that runs short makes `scrollHeight`
	 * shrink as the window advances toward the end, and the browser answers by
	 * clamping `scrollTop` — clamp fires a scroll event, the window recomputes,
	 * and the bottom edge "bounces" in a stuttering settle loop.
	 */
	let measuredTabRowHeight = $state(0);
	let rowHeight = $derived(
		measuredTabRowHeight > 0 ? measuredTabRowHeight : estimateTabRowHeight(width, gapPx)
	);
	// ── "Reading now" sort segments ─────────────────────────────────
	type TabsSort = 'recent' | 'added' | 'series';
	const TABS_SORT_KEY = 'fumeto-tabs-sort';
	const storedTabsSort = typeof localStorage !== 'undefined' ? localStorage.getItem(TABS_SORT_KEY) : null;
	let tabsSort = $state<TabsSort>(storedTabsSort === 'recent' || storedTabsSort === 'series' ? storedTabsSort : 'added');
	function setTabsSort(mode: TabsSort): void {
		tabsSort = mode;
		localStorage.setItem(TABS_SORT_KEY, mode);
		if (container) {
			container.scrollTop = 0;
			scrollTop = 0;
		}
	}
	let sortedTabs = $derived.by(() => {
		const ordered =
			tabsSort === 'recent'
				// Finally consuming last_active_at's index semantics: most recently
				// touched first.
				? [...tabs].sort((a, b) => b.tab.last_active_at.localeCompare(a.tab.last_active_at))
				: tabsSort === 'series'
					? [...tabs].sort((a, b) => a.volume.title.localeCompare(b.volume.title))
					// The copy keeps every branch the same shape, and keeps the
					// controller's own array out of the caller's hands.
					: [...tabs];
		return ordered;
	});

	let virtual = $derived(calculateVirtualWindow({ itemCount: sortedTabs.length, columns: 2, rowHeight, scrollTop, viewportHeight, overscanRows: 3 }));
	// Row-boundary scalars: calculateVirtualWindow returns a fresh object for
	// every scroll pixel, but these preserve equality while the user moves
	// within one row — the media/regeneration effects depend on them, never on
	// slice identity, so scrolling inside a row costs zero effect runs.
	let windowStartIndex = $derived(virtual.startIndex);
	let windowEndIndex = $derived(virtual.endIndex);
	let visibleTabs = $derived(sortedTabs.slice(virtual.startIndex, virtual.endIndex));
	let previewUrls = $state<Map<string, string>>(new Map());

	// ── Geometry: measurement + anchored size application ──

	const measuredCards = new Set<HTMLElement>();

	function readGridGap(): void {
		if (!gridEl) return;
		const rowGap = Number.parseFloat(getComputedStyle(gridEl).rowGap);
		if (Number.isFinite(rowGap) && rowGap > 0) gapPx = rowGap;
	}

	/** Re-apply the current visual anchor after a pitch/size change settles. */
	function withScrollAnchor(apply: () => void): void {
		const el = container;
		if (!el) {
			apply();
			return;
		}
		const keys = sortedTabs.map((item) => item.volume.volume_uuid);
		const anchor = captureCatalogAnchor(keys, el.scrollTop, 2, rowHeight);
		apply();
		void tick().then(() => {
			if (!container) return;
			container.scrollTop = restoreCatalogAnchor(anchor, keys, 2, rowHeight);
			scrollTop = container.scrollTop;
		});
	}

	function measureNow(): void {
		for (const node of measuredCards) {
			const height = node.getBoundingClientRect().height;
			if (!Number.isFinite(height) || height <= 0) continue;
			readGridGap();
			const pitch = height + gapPx;
			if (pitch > measuredTabRowHeight + 0.25) {
				withScrollAnchor(() => {
					measuredTabRowHeight = pitch;
				});
			}
			return; // every card shares the grid geometry — one is enough
		}
	}

	function measureTabCard(node: HTMLElement) {
		measuredCards.add(node);
		const raf = requestAnimationFrame(measureNow);
		return {
			destroy() {
				measuredCards.delete(node);
				cancelAnimationFrame(raf);
			}
		};
	}

	function applyTabsSize(nextWidth: number, nextHeight: number): void {
		const widthChanged = Math.abs(nextWidth - width) > 0.5;
		if (!widthChanged && Math.abs(nextHeight - viewportHeight) <= 0.5) return;
		withScrollAnchor(() => {
			width = nextWidth;
			viewportHeight = nextHeight;
			if (widthChanged) {
				// The old pitch belongs to the old column width; fall back to the
				// estimate and let the already-mounted cards re-measure post-layout.
				measuredTabRowHeight = 0;
				requestAnimationFrame(measureNow);
			}
		});
	}

	// Plain variable by design: a parked size must not churn the window while
	// the view is hidden — it is applied (if still different) on activation.
	let deferredTabsSize: { width: number; height: number } | null = null;

	$effect(() => {
		if (!active || !deferredTabsSize) return;
		const pending = deferredTabsSize;
		deferredTabsSize = null;
		applyTabsSize(pending.width, pending.height);
	});

	// ── Preview URLs (shared thumbnail cache; reads keep running while hidden) ──

	const previewPins = new Map<string, () => void>();

	/** Pin the retention range's cache keys so catalog scrolling can never evict
	 *  a URL this (possibly hidden) grid still has mounted. */
	function syncPreviewPins(list: LiveComicTab[], start: number, end: number): void {
		const retention = tabRetentionRange(start, end, list.length, RETENTION_MARGIN_ITEMS);
		const wanted = new Set<string>();
		for (let index = retention.min; index <= retention.max; index += 1) {
			const uuid = list[index]?.volume.volume_uuid;
			if (uuid) wanted.add(uuid);
		}
		for (const [uuid, release] of previewPins) {
			if (!wanted.has(uuid)) {
				release();
				previewPins.delete(uuid);
			}
		}
		for (const uuid of wanted) {
			if (!previewPins.has(uuid)) previewPins.set(uuid, pinThumbnailUrl(PREVIEW_KEY_PREFIX + uuid));
		}
	}

	$effect(() => {
		// sortedTabs, not tabs: the window indices address the RENDERED order.
		// Loading previews in position order left the sorted grid fetching the
		// wrong cards — under Recent or Series the two slices name different
		// tabs, so visible cards sat on the placeholder glyph forever.
		const list = sortedTabs;
		const start = windowStartIndex;
		const end = windowEndIndex;
		const visible = list.slice(start, end);
		// Synchronous carry-forward: a window advance must never blank a card
		// that is still visible while the IndexedDB read is in flight.
		const carried = new Map<string, string>();
		for (const item of visible) {
			const url = getThumbnailUrl(PREVIEW_KEY_PREFIX + item.volume.volume_uuid);
			if (url) carried.set(item.volume.volume_uuid, url);
		}
		previewUrls = carried;
		syncPreviewPins(list, start, end);
		let current = true;
		void tabsController.loadPreviewAssets(visible.map((item) => item.volume.volume_uuid)).then((assets) => {
			const merged = new Map<string, string>();
			for (const item of visible) {
				const uuid = item.volume.volume_uuid;
				const asset = assets.get(uuid);
				// Revision-aware: a regenerated preview replaces the cached URL and
				// the old one is retired only after no <img> references it. A read
				// with no bytes falls back to the last-good cached URL.
				const url = asset?.blob
					? getThumbnailUrl(PREVIEW_KEY_PREFIX + uuid, asset.blob, asset.revision)
					: getThumbnailUrl(PREVIEW_KEY_PREFIX + uuid);
				if (url) merged.set(uuid, url);
			}
			// A superseded run still warmed the cache above; only the current
			// window's run publishes.
			if (!current) return;
			previewUrls = merged;
		});
		return () => {
			current = false;
		};
	});

	// ── Preview regeneration (gated while hidden; retention-set cancellation) ──

	const pendingPreviews = new Map<string, { page: number; cancel: () => void }>();
	const attemptedRevisions = new Map<string, string>();

	$effect(() => {
		// Regeneration decodes a full page and re-encodes it on the main thread.
		// Leaving the reader writes progress, which invalidates the preview of the
		// tab just read — so without this gate every reader exit would kick off
		// that work while the reader is still on screen. Deferred to activation,
		// where the existing preview URLs are already mounted.
		if (!active) return;
		const list = sortedTabs; // rendered order — see the preview-URL effect above
		const start = windowStartIndex;
		const end = windowEndIndex;
		const retention = tabRetentionRange(start, end, list.length, RETENTION_MARGIN_ITEMS);
		const indexByUuid = new Map(list.map((item, index) => [item.volume.volume_uuid, index]));
		const candidates = list.slice(start, end).map((item) => ({
			uuid: item.volume.volume_uuid,
			page: item.volume.current_page || 0,
			revision: `${item.volume.volume_uuid}:${item.volume.current_page ?? 0}`,
			needsRegeneration: item.tab.preview_page_index !== item.volume.current_page
		}));
		const plan = planPreviewJobs(
			candidates,
			new Set(pendingPreviews.keys()),
			attemptedRevisions,
			retention,
			(uuid) => indexByUuid.get(uuid) ?? -1
		);
		for (const uuid of plan.cancel) {
			pendingPreviews.get(uuid)?.cancel();
			pendingPreviews.delete(uuid);
		}
		for (const candidate of plan.enqueue) {
			const item = list[indexByUuid.get(candidate.uuid) ?? -1];
			if (!item) continue;
			// One attempt per (tab, page): if the write is refused (e.g. a stale
			// projection of current_page), this costs a single no-op instead of an
			// enqueue/abort storm — the queue aborts a key's prior job on re-enqueue.
			attemptedRevisions.set(candidate.uuid, candidate.revision);
			pendingPreviews.set(candidate.uuid, {
				page: candidate.page,
				cancel: queueTabPreview(item.volume, candidate.page, 20)
			});
		}
		// Deliberately NO cleanup cancellation: aborting the whole window's jobs
		// on every window move meant no preview ever completed during a fling.
		// Jobs die on retention exit (above) or wholesale in onDestroy.
	});

	onMount(() => {
		let restored = false;
		const unsubscribe = tabsController.subscribe((snapshot) => {
			tabsPhase = snapshot.phase;
			tabsError = snapshot.error;
			if (snapshot.data) {
				hasLastGoodTabs = true;
				tabs = snapshot.data.tabs;
				if (!restored) {
					restored = true;
					const target = snapshot.data.scrollTop;
					// Aim the virtual window at the destination before the DOM write
					// so the first flush renders the right rows; apply the pixel
					// offset only once the spacers exist — a synchronous write here
					// is clamped against not-yet-rendered heights.
					scrollTop = target;
					void tick().then(() => {
						if (!container) return;
						container.scrollTop = Math.min(
							target,
							Math.max(0, container.scrollHeight - container.clientHeight)
						);
						scrollTop = container.scrollTop;
					});
				}
			}
		});
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const nextWidth = entry.contentRect.width;
			// clientHeight, not contentRect.height: the scrollport includes the
			// container's vertical padding, which the content box excludes.
			const nextHeight = (entry.target as HTMLElement).clientHeight;
			if (!active) {
				deferredTabsSize = { width: nextWidth, height: nextHeight };
				return;
			}
			applyTabsSize(nextWidth, nextHeight);
		});
		if (container) observer.observe(container);
		return () => {
			unsubscribe();
			observer.disconnect();
		};
	});

	onDestroy(() => {
		for (const pending of pendingPreviews.values()) pending.cancel();
		pendingPreviews.clear();
		for (const release of previewPins.values()) release();
		previewPins.clear();
		// The URLs themselves belong to the shared thumbnail cache: retirement
		// and the LRU own their lifetime. Mass-revoking here is what used to
		// blank the grid on re-entry.
	});

	/**
	 * A card tap is durable intent, so the focus happens here rather than inside
	 * openReader — which no longer touches tabs at all. The bump to
	 * `last_active_at` is what the Recent sort consumes.
	 */
	async function openTab(volume: LiveComicTab['volume']): Promise<void> {
		await createOrFocusTab(volume.volume_uuid);
		await openReader(volume, 'tabs');
	}

	/**
	 * Resuming is not opening a tab, so there is deliberately no
	 * createOrFocusTab here. 'tabs' means only "Back returns to Tabs".
	 */
	function resumeContinueReading(volume: LiveComicTab['volume']): void {
		void openReader(volume, 'tabs');
	}

	/** Tabs whose close interaction is in flight — the ONLY trigger for the
	 *  close motion below. Plain Set by design: read inside transition
	 *  callbacks at trigger time, never during template render. */
	const closingTabIds = new Set<string>();

	async function close(event: MouseEvent, volumeUuid: string) {
		event.stopPropagation();
		playReaderHaptic('control');
		// Added before the delete so the liveQuery-driven unmount sees it.
		closingTabIds.add(volumeUuid);
		try {
			await closeTab(volumeUuid);
		} catch (error) {
			closingTabIds.delete(volumeUuid);
			throw error;
		}
		setTimeout(() => closingTabIds.delete(volumeUuid), motionDuration(150) + 250);
	}

	// Refresh failures float as a retryable toast instead of reflowing the grid.
	let lastToastedError: Error | undefined;
	$effect(() => {
		const error = tabsError;
		if (!error || !hasLastGoodTabs || error === lastToastedError) return;
		lastToastedError = error;
		pushKeyedToast('tabs-refresh', {
			message: m.tabs_refresh_failed_message({ message: error.message }),
			tone: 'error',
			action: { label: { code: 'common_retry' }, run: () => void tabsController.refresh() }
		});
	});

	let closingAll = $state(false);
	/** Close every tab, staggered so each removal runs the close-scoped motion. */
	async function closeAllTabs(): Promise<void> {
		if (closingAll) return;
		playReaderHaptic('control');
		closingAll = true;
		try {
			for (const item of [...sortedTabs]) {
				const volumeUuid = item.volume.volume_uuid;
				closingTabIds.add(volumeUuid);
				try {
					await closeTab(volumeUuid);
				} catch {
					closingTabIds.delete(volumeUuid);
					continue;
				}
				setTimeout(() => closingTabIds.delete(volumeUuid), motionDuration(150) + 250);
				await new Promise((resolve) => setTimeout(resolve, motionDuration(45)));
			}
		} finally {
			closingAll = false;
		}
	}

	/** Static per-volume tint for the meta panel — a hash into a small muted
	 *  palette, deliberately NOT content-based color extraction. */
	const TAB_TINTS = ['#232c23', '#222931', '#2d2731', '#312727', '#2d2b22', '#223029'];
	function tabTint(volumeUuid: string): string {
		let hash = 0;
		for (let index = 0; index < volumeUuid.length; index += 1) {
			hash = (hash * 31 + volumeUuid.charCodeAt(index)) | 0;
		}
		return TAB_TINTS[Math.abs(hash) % TAB_TINTS.length];
	}

	/**
	 * Outro for a closed tab: freeze its geometry, lift it out of the grid
	 * flow (position:absolute against the grid) and fade it away. Lifting it
	 * immediately frees its cell so the remaining cards reflow — and get their
	 * reflow animation — while the closed card is still fading on top.
	 */
	function tabCloseOut(node: HTMLElement, volumeUuid: string) {
		// Cards leaving the virtual window unmount instantly: only a genuine
		// close earns the lifted fade. A scroll departure playing it would draw
		// ghost cards over — or, mid-reflow, inside — the live grid.
		if (!closingTabIds.has(volumeUuid)) return { duration: 0 };
		const left = node.offsetLeft;
		const top = node.offsetTop;
		const width = node.offsetWidth;
		const height = node.offsetHeight;
		return {
			duration: motionDuration(120),
			css: (t: number) =>
				`position: absolute; left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px; ` +
				`z-index: 1; pointer-events: none; opacity: ${t}; transform: scale(${0.96 + 0.04 * t});`
		};
	}

	/**
	 * Browser-tab-switcher-style reflow for the cards a close displaced:
	 * a quick crossfade — fade out held at the old slot for the first half,
	 * fade back in at the new slot for the second. Cards whose slot did not
	 * change are skipped entirely.
	 */
	function tabReflow(_node: Element, { from, to }: { from: DOMRect; to: DOMRect }) {
		// Only a pending close may animate. Virtual-window advances re-index
		// every surviving card, and any rect delta outside a close (layout
		// settling, a resize mid-scroll) crossfading the whole grid reads as
		// the view flickering.
		if (closingTabIds.size === 0) return { duration: 0 };
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return { duration: 0 };
		return {
			duration: motionDuration(150),
			css: (t: number) =>
				t < 0.5
					? `transform: translate(${dx}px, ${dy}px); opacity: ${1 - t * 2};`
					: `opacity: ${(t - 0.5) * 2};`
		};
	}
</script>

<section class="flex h-full min-h-0 flex-col bg-surface-950" style="padding-top: var(--sat, 0px); padding-left: var(--sal, 0px); padding-right: var(--sar, 0px);" aria-label={m.tabs_comic_tabs()}>
	<!-- Same app-bar contract as both Library headers: 12px top gap + a 60px
	     bar, so the bar's bottom edge lines up pixel-for-pixel across Tabs,
	     Library root, and in-library views. The title block bottom-aligns;
	     trailing actions self-center like the Library trailing cluster. -->
	<header
		class="flex min-w-0 items-end justify-between gap-2"
		style="margin-top: var(--reader-top-gap); min-height: var(--reader-top-height); padding-left: 12px; padding-right: 12px;"
		data-tabs-header
	>
		<div class="min-w-0">
			<p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary-400" data-tabs-count>
				{tabs.length} open
			</p>
			<h2 class="truncate text-2xl font-bold tracking-tight text-surface-100">{m.tabs_reading_now()}</h2>
		</div>
		{#if tabs.length > 0}
			<button
				type="button"
				class="h-11 shrink-0 self-center rounded-full bg-surface-container-high px-4 text-xs font-semibold text-surface-200 transition-colors active:bg-surface-700 disabled:opacity-50"
				onclick={() => void closeAllTabs()}
				disabled={closingAll}
				data-tabs-close-all
			>
				{closingAll ? m.tabs_closing() : m.tabs_close_all()}
			</button>
		{/if}
	</header>
	{#if tabs.length > 1}
		<!-- Mirrors the Library filter row's metrics (mt-2, 44px pills in a
		     4px-padded track) so the secondary rows match across views. -->
		<div class="relative mx-3 mb-1 mt-2 grid grid-cols-3 gap-1 rounded-full bg-surface-container-high p-1" role="radiogroup" aria-label={m.tabs_sort_tabs()} data-tabs-sort use:slidingSelection>
			{#each [
				{ id: 'recent', label: m.tabs_sort_recent() },
				{ id: 'added', label: m.tabs_sort_added() },
				{ id: 'series', label: m.tabs_sort_series() }
			] as const as mode (mode.id)}
				<button
					type="button"
					role="radio"
					aria-checked={tabsSort === mode.id}
					class="press-morph relative h-11 min-w-0 truncate rounded-full text-[11px] font-semibold {tabsSort === mode.id ? 'text-on-accent-strong' : 'text-surface-400 active:bg-surface-800'}"
					onclick={() => setTabsSort(mode.id)}
				>
					{mode.label}
				</button>
			{/each}
		</div>
	{/if}
	<!-- Outside the scroller on purpose: the virtual window's spacers and scroll
	     anchors are scroller-local, so a strip inside it would offset every row
	     mapping by its own height. Outside the {#if tabsPhase} chain too — it has
	     its own query and should paint before the tabs projection resolves. -->
	{#if $continueReadingVolume}
		<ContinueReadingStrip surface="tabs" volume={$continueReadingVolume} onopen={resumeContinueReading} />
	{/if}
	<div
		bind:this={container}
		class="min-h-0 flex-1 overflow-y-auto px-3 py-3"
		style="touch-action: pan-y; overscroll-behavior: contain; overflow-anchor: none; padding-bottom: calc(var(--app-bottom-clearance) + 12px);"
		onscroll={(event) => { scrollTop = event.currentTarget.scrollTop; tabsController.setScrollTop(scrollTop); }}
		data-tabs-scroll
		aria-busy={tabsPhase === 'loading' || tabsPhase === 'refreshing'}
	>
		{#if !hasLastGoodTabs && (tabsPhase === 'uninitialized' || tabsPhase === 'loading')}
			<div class="flex h-full items-center justify-center text-sm text-surface-400" role="status" aria-busy="true" data-tabs-loading>{m.reader_loading()}</div>
		{:else if tabsPhase === 'error' && !hasLastGoodTabs}
			<div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center" role="alert">
				<p class="text-sm text-red-300">{m.tabs_unable_to_load({ message: tabsError?.message ?? m.tabs_unknown_error() })}</p>
				<button type="button" class="rounded-lg border border-surface-600 px-4 py-2 text-sm text-surface-200" onclick={() => tabsController.refresh()}>{m.reader_retry()}</button>
			</div>
		{:else if tabsPhase === 'ready' && tabs.length === 0}
			<div class="flex h-full flex-col items-center justify-center px-8 text-center">
				<span class="mb-3 select-none text-2xl tracking-wide text-surface-500" aria-hidden="true">{m.tabs_o_zzz()}</span>
				<p class="text-base font-medium text-surface-300">{m.tabs_no_open_tabs()}</p>
				<p class="mt-1 text-sm text-surface-500">
					{#if $continueReadingVolume}{m.tabs_the_comic_you_were()}{:else}{m.tabs_long_press_a_comic()}{/if}
				</p>
			</div>
		{:else}
			<!-- min-height pins the scroller's content to the model height for the
			     whole keyed reconciliation: the animate: directive forces a layout
			     mid-swap, at an instant where old cards are gone but the spacer
			     styles haven't grown yet — without this floor, Blink clamps
			     scrollTop against that transiently-short content and deep jumps
			     land one row shy of the bottom. -->
			<div style="min-height: {Math.max(0, virtual.totalHeight - gapPx)}px">
			<div style="height: {virtual.topSpacer}px" aria-hidden="true"></div>
			<div class="relative grid grid-cols-2 gap-3" bind:this={gridEl} data-tabs-grid>
				{#each visibleTabs as item (item.volume.volume_uuid)}
					<div
						class="group relative min-w-0 overflow-hidden rounded-xl border border-surface-800 bg-surface-900"
						use:measureTabCard
						out:tabCloseOut={item.volume.volume_uuid}
						animate:tabReflow
					>
						<button type="button" class="block w-full text-left" onclick={() => { void openTab(item.volume); }} aria-label={m.tabs_read_volume({ title: item.volume.title })}>
							<div class="relative aspect-[2/3] w-full overflow-hidden bg-surface-800">
								{#if previewUrls.get(item.volume.volume_uuid)}
									<img src={previewUrls.get(item.volume.volume_uuid)} alt="" class="h-full w-full object-cover" use:fadeOnDecode />
								{:else}
									<div class="flex h-full items-center justify-center text-3xl text-surface-600">▤</div>
								{/if}
							</div>
						</button>
						<!-- Tinted meta panel: static per-volume tint (hash palette, not
						     content-derived), title + position + progress with the 44px
						     close target inside the row. -->
						<div class="px-2 pb-1 pt-1.5" style="background-color: {tabTint(item.volume.volume_uuid)}">
							<p class="truncate text-xs font-medium leading-tight text-surface-100" data-tab-title-strip>{item.volume.title}</p>
							<div class="flex items-center gap-1.5">
								<div class="min-w-0 flex-1">
									<p class="truncate text-[10px] text-surface-400">
										{m.catalog_page_x_of_y({ page: (item.volume.current_page ?? 0) + 1, total: item.volume.page_count })}
									</p>
									{#if item.volume.page_count > 0}
										<div class="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-surface-950/50">
											<div class="h-full rounded-full bg-primary-500" style="width: {Math.min(100, Math.round((((item.volume.current_page ?? 0) + 1) / item.volume.page_count) * 100))}%"></div>
										</div>
									{/if}
								</div>
								<button
									type="button"
									class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg leading-none text-surface-300 transition-colors active:bg-surface-950/40 active:text-white"
									aria-label={m.tabs_close_volume({ title: item.volume.title })}
									onclick={(event) => { void close(event, item.volume.volume_uuid); }}
									data-close-tab
								>×</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
			<div style="height: {virtual.bottomSpacer}px" aria-hidden="true"></div>
			</div>
		{/if}
	</div>
</section>

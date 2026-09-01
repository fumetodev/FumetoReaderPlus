<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * Reflowable-book reading surface: foliate-js paginator inside the reader
	 * shell. Route-level sibling of PageViewer — books share the chrome, the
	 * back ladder, tabs, and progress stores, and none of the page-image
	 * pipeline (PageSource/ImageCache/overlays are never touched).
	 *
	 * Progress: foliate 'relocate' drives currentPageIndex (section index —
	 * leaveReader's generic current_page persist stays correct for free) and
	 * a debounced updateVolume writes book_locator (CFI) + fraction; resume
	 * tries CFI → section index → start.
	 *
	 * Host data attributes (data-book-ready/-section/-fraction) are the
	 * primary automated observability — iframe internals are best-effort.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { db } from '$lib/db/index.js';
	import { currentPageIndex, currentVolume } from '$lib/stores/reader-state.js';
	import { updateVolume } from '$lib/catalog/catalog-repository.js';
	import { settings } from '$lib/settings/settings.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { currentBookFraction, currentBookHandle, currentBookPages } from '$lib/book/book-state.js';
	import { bookTapZone, isBookInteractiveTarget } from '$lib/book/book-tap-zones.js';
	import { getBookCss } from '$lib/book/book-css.js';
	import { createFoliateView, type FoliateView, type FoliateRelocateDetail } from '$lib/book/foliate-view.js';
	import { openEpubBook, type OpenedEpubBook } from '$lib/book/foliate-loader.js';

	let hostEl = $state<HTMLDivElement | null>(null);
	let ready = $state(false);
	let sectionIndex = $state(0);
	let fraction = $state(0);
	/** Whole-book page counter, mirrored onto the host for automated checks. */
	let pageCounter = $state<{ current: number; total: number } | null>(null);
	let loadError = $state<string | null>(null);

	let view: FoliateView | null = null;
	let opened: OpenedEpubBook | null = null;
	let disposed = false;
	let persistTimer: ReturnType<typeof setTimeout> | undefined;
	let lastLocation: { cfi?: string; fraction: number; index: number } | null = null;

	const PERSIST_DEBOUNCE_MS = 1500;

	function schedulePersist(): void {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => void persistLocation(), PERSIST_DEBOUNCE_MS);
	}

	/** The volume this instance opened — persistence is scoped to it. */
	let openedVolumeUuid: string | null = null;

	async function persistLocation(): Promise<void> {
		const volume = get(currentVolume);
		const location = lastLocation;
		if (!volume || !location) return;
		// Never write another volume's progress: by persist time the user may
		// have moved on (teardown flush races navigation).
		if (openedVolumeUuid && volume.volume_uuid !== openedVolumeUuid) return;
		try {
			await updateVolume(volume.volume_uuid, {
				current_page: location.index,
				book_locator: location.cfi ?? volume.book_locator,
				book_progress_fraction: location.fraction,
				last_read_at: new Date().toISOString()
			});
		} catch (err) {
			console.warn('Book progress persist failed:', err);
		}
	}

	function handleVisibility(): void {
		if (document.visibilityState === 'hidden') {
			clearTimeout(persistTimer);
			void persistLocation();
		}
	}

	/**
	 * Flow + content theme from settings; safe to re-apply live (foliate
	 * keeps the reading position across style/flow changes — device-verified).
	 * The `animated` page-turn slide honors prefers-reduced-motion.
	 */
	function applyDisplaySettings(): void {
		if (!view) return;
		const current = get(settings);
		const renderer = view.renderer;
		renderer?.setAttribute('flow', current.bookFlow);
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
			renderer?.removeAttribute('animated');
		} else {
			renderer?.setAttribute('animated', '');
		}
		renderer?.setStyles?.(
			getBookCss({
				theme: current.bookTheme,
				fontScalePercent: current.bookFontScalePercent,
				lineHeight: current.bookLineHeight
			})
		);
	}

	// Live re-application when the display settings change.
	$effect(() => {
		void $settings.bookFlow;
		void $settings.bookTheme;
		void $settings.bookFontScalePercent;
		void $settings.bookLineHeight;
		if (ready) applyDisplaySettings();
	});

	onMount(() => {
		void openBook();
		document.addEventListener('visibilitychange', handleVisibility);
		return () => document.removeEventListener('visibilitychange', handleVisibility);
	});

	async function openBook(): Promise<void> {
		const volume = get(currentVolume);
		if (!volume || !hostEl) return;
		openedVolumeUuid = volume.volume_uuid;
		try {
			// `disposed` must be re-checked after EVERY await: onDestroy runs
			// synchronously mid-sequence, and anything not yet assigned to the
			// component fields at that moment is THIS continuation's to clean
			// up (review finding: backing out before the open finished leaked
			// the zip reader for good).
			const record = await db.book_files.get(volume.volume_uuid);
			if (disposed) return;
			if (!record) throw new Error('The book file is missing from the library.');
			const openedBook = await openEpubBook(record.file);
			if (disposed) {
				await openedBook.close();
				return;
			}
			opened = openedBook;

			view = await createFoliateView();
			if (disposed) {
				// Never attached; discarding the element is enough, but the
				// book handle is ours to release.
				view = null;
				await openedBook.close();
				opened = null;
				return;
			}
			view.style.width = '100%';
			view.style.height = '100%';
			view.addEventListener('relocate', ((event: CustomEvent<FoliateRelocateDetail>) => {
				if (disposed) return;
				const detail = event.detail;
				sectionIndex = detail.section?.current ?? 0;
				fraction = typeof detail.fraction === 'number' ? detail.fraction : 0;
				lastLocation = { cfi: detail.cfi, fraction, index: sectionIndex };
				currentPageIndex.set(sectionIndex);
				currentBookFraction.set(fraction);
				// Whole-book page counter for the chrome, scrubber and jump
				// dialog. Sections stay the persistence unit; pages are display
				// and navigation only.
				if (detail.location && detail.location.total > 0) {
					currentBookPages.set({
						current: detail.location.current,
						total: detail.location.total
					});
					pageCounter = detail.location;
				}
				schedulePersist();
			}) as EventListener);
			// Tap zones attach per section document (content lives in the
			// iframe; host listeners never see those taps). Anchor/control
			// targets navigate normally instead of turning pages.
			view.addEventListener('load', ((event: CustomEvent<{ doc: Document }>) => {
				if (disposed) return;
				const doc = event.detail?.doc;
				if (!doc) return;
				doc.addEventListener('click', (ev: MouseEvent) => {
					if (disposed || isBookInteractiveTarget(ev.target)) return;
					// ev.clientX is useless here: foliate sizes the content
					// iframe to the WHOLE column strip (tens of thousands of px)
					// and translates it, so client coords are strip coords
					// (device-verified: innerWidth 71704 for one section).
					// ev.screenX is the true screen position in CSS px on
					// Chromium/WebView — map it into the host's screen span.
					const rect = hostEl?.getBoundingClientRect();
					if (!rect || rect.width <= 0) return;
					const hostScreenLeft = (window.screenX ?? 0) + rect.left;
					const zone = bookTapZone((ev.screenX - hostScreenLeft) / rect.width);
					if (zone === 'toggle-chrome') {
						mobileReaderUi.toggleChrome();
						return;
					}
					// The paginator snaps to the nearest page on EVERY touch
					// release via rAF (#onTouchEnd → snap) — navigating from the
					// click directly starts an animation the late snap then
					// cancels back (device-observed: right taps no-oped). Two
					// frames later the tap's snap has settled as a no-op and the
					// turn animates cleanly; both rAFs share the top window's
					// frame queue, so the ordering is guaranteed.
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							if (zone === 'left') void view?.goLeft();
							else void view?.goRight();
						})
					);
				});
			}) as EventListener);

			hostEl.appendChild(view);
			await view.open(openedBook.book);
			// From here on, view/opened are component fields — a teardown that
			// lands mid-await has already closed them in onDestroy, so early
			// exits only need to stop touching anything.
			if (disposed) return;
			applyDisplaySettings();

			// ALWAYS navigate after open — foliate renders nothing until the
			// first goTo (a fresh book at position 0 was a black screen).
			// Resume order: CFI → clamped section index (0 included). Pass the
			// RAW CFI string: view.goTo resolves internally, and it swallows
			// failures (logs + returns undefined), so its return value — the
			// resolved target on success — is the success signal.
			const fallbackSection = Math.min(
				volume.current_page ?? 0,
				Math.max(0, (volume.page_count ?? 1) - 1)
			);
			const locator = volume.book_locator;
			let navigated = false;
			if (locator) {
				navigated = (await view.goTo(locator)) != null;
			}
			if (!navigated) {
				await view.goTo(fallbackSection);
			}
			if (disposed) return;
			currentBookHandle.set({ view, book: openedBook.book });
			ready = true;
		} catch (err) {
			console.error('Failed to open book:', err);
			loadError = err instanceof Error ? err.message : m.reader_failed_to_open_this();
		}
	}

	onDestroy(() => {
		disposed = true;
		currentBookHandle.set(null);
		currentBookFraction.set(0);
		currentBookPages.set({ current: 0, total: 0 });
		clearTimeout(persistTimer);
		void persistLocation();
		try {
			view?.close?.();
			view?.remove();
		} catch {
			// element teardown is best-effort
		}
		void opened?.close();
	});
</script>

<div
	bind:this={hostEl}
	class="absolute inset-0 bg-surface-950"
	data-book-reader
	data-book-ready={ready || undefined}
	data-book-section={sectionIndex}
	data-book-fraction={fraction.toFixed(4)}
	data-book-page={pageCounter?.current}
	data-book-page-total={pageCounter?.total}
>
	{#if loadError}
		<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
			<span class="text-sm text-surface-400">{m.reader_couldn_t_open_this()}</span>
			<span class="max-w-sm text-xs text-surface-500">{loadError}</span>
		</div>
	{/if}
</div>

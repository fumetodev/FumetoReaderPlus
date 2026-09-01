<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * Book table of contents — a chrome-anchored disclosure surface. Entries
	 * come from the live foliate book handle; taps jump via view.goTo(href)
	 * (foliate resolves hrefs, including fragment anchors inside chunked
	 * sections) and close the panel. The current section is highlighted from
	 * the shared currentPageIndex (section index for books).
	 */
	import { fade, fly } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { currentBookHandle, currentBookPages, goToBookPage } from '$lib/book/book-state.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { currentPageIndex } from '$lib/stores/reader-state.js';
	import type { FoliateTocItem } from '$lib/book/foliate-loader.js';

	interface TocRow {
		label: string;
		href?: string;
		depth: number;
		section?: number;
	}

	let rows = $derived.by((): TocRow[] => {
		const handle = $currentBookHandle;
		if (!handle) return [];
		const out: TocRow[] = [];
		const walk = (items: FoliateTocItem[] | null | undefined, depth: number) => {
			for (const item of items ?? []) {
				let section: number | undefined;
				if (item.href) {
					try {
						section = handle.book.resolveHref?.(item.href)?.index;
					} catch {
						section = undefined;
					}
				}
				out.push({ label: item.label?.trim() || 'Untitled', href: item.href, depth, section });
				walk(item.subitems, depth + 1);
			}
		};
		walk(handle.book.toc, 0);
		return out;
	});

	function jump(row: TocRow): void {
		const handle = $currentBookHandle;
		if (!handle || !row.href) return;
		void handle.view.goTo(row.href);
		mobileReaderUi.closeDisclosure();
	}

	// ── Page scrubber ───────────────────────────────────────────────────
	// The TOC only reaches sections a chapter entry points at; the scrubber
	// walks the whole book a page at a time, which is what makes long unlisted
	// front/back matter navigable at all. Pages are foliate's content-size
	// units, so they hold still when the font size or window changes.

	let lastPage = $state($currentBookPages.current);
	let scrubbing = $state(false);
	let scrubPage = $state($currentBookPages.current);
	let totalBookPages = $derived($currentBookPages.total);
	let maxPage = $derived(Math.max(0, totalBookPages - 1));

	// Follow the book while idle, but never yank the thumb out from under a
	// drag — relocate fires continuously as the jump lands.
	$effect(() => {
		const page = $currentBookPages.current;
		if (page === lastPage) return;
		lastPage = page;
		if (!scrubbing) scrubPage = page;
	});

	/**
	 * Which section the target page falls in. Pages and sections ride the same
	 * content-size axis, so the book fraction bridges them. Estimate only — it
	 * labels the page number with its chapter and never drives navigation.
	 */
	let scrubSection = $derived.by(() => {
		const fractions = $currentBookHandle?.view.getSectionFractions?.() ?? [];
		if (fractions.length === 0 || totalBookPages <= 0) return $currentPageIndex;
		const fraction = (scrubPage + 0.5) / totalBookPages;
		let index = 0;
		for (let i = 0; i < fractions.length; i += 1) {
			if (fractions[i] <= fraction) index = i;
			else break;
		}
		return index;
	});

	/**
	 * The chapter containing that page. Sections no entry names (front matter,
	 * mid-chapter chunks) carry the chapter still in progress forward.
	 */
	let scrubLabel = $derived.by(() => {
		const opensSection = rows.find((row) => row.section === scrubSection);
		if (opensSection) return opensSection.label;
		let carried = '';
		for (const row of rows) {
			if (row.section == null || row.section > scrubSection) continue;
			carried = row.label;
		}
		return carried;
	});

	function commitScrub(): void {
		scrubbing = false;
		if (scrubPage === $currentBookPages.current) return;
		playReaderHaptic('control');
		goToBookPage(scrubPage);
	}
</script>

<button
	type="button"
	aria-label={m.reader_close_table_of_contents()}
	class="fixed inset-0 z-[35]"
	onclick={() => mobileReaderUi.closeDisclosure()}
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
	data-book-toc-scrim
></button>
<div
	class="fixed z-[45] flex max-h-[60dvh] flex-col rounded-[var(--radius-card)] bg-surface-container-high shadow-2xl"
	style="bottom: calc(var(--reader-bottom-clearance) + 8px); left: calc(0.5rem + var(--sal, 0px)); right: calc(0.5rem + var(--sar, 0px));"
	in:fly={{ y: 10, duration: motionDuration(140) }}
	out:fly={{ y: 10, duration: motionDuration(exitDuration(140)) }}
	role="menu"
	aria-label={m.reader_table_of_contents()}
	data-book-toc-panel
>
	<div class="border-b border-surface-700/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-surface-400">
		{m.reader_contents()}
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto p-2" data-book-toc-list>
		{#if rows.length === 0}
			<p class="px-3 py-4 text-sm text-surface-500">{m.reader_this_book_has_no()}</p>
		{/if}
		{#each rows as row, index (index)}
			<button
				type="button"
				class="flex min-h-[44px] w-full items-center rounded-xl px-3 py-2 text-left text-sm transition-[background-color] duration-100 active:bg-surface-800 {row.section != null && row.section === $currentPageIndex ? 'bg-primary-600/15 text-primary-200' : 'text-surface-100'} disabled:text-surface-500"
				style={`padding-left: ${12 + row.depth * 16}px;`}
				onclick={() => jump(row)}
				disabled={!row.href}
				role="menuitem"
				data-book-toc-entry={index}
				data-book-toc-section={row.section}
			>
				<span class="truncate">{row.label}</span>
			</button>
		{/each}
	</div>
	<!-- Page scrubber: seeks the whole book a page at a time, including the
	     stretches no TOC entry points at. Navigation waits for release — a seek
	     can re-render a section, so live seeking would thrash the paginator. -->
	{#if maxPage > 0}
		<div class="shrink-0 border-t border-surface-700/60 px-4 pb-2 pt-2" data-book-scrubber>
			<div class="flex items-baseline gap-2">
				<span class="min-w-0 flex-1 truncate text-[11px] font-medium {scrubbing ? 'text-primary-200' : 'text-surface-400'}">
					{scrubLabel}
				</span>
				<span class="shrink-0 text-[11px] font-semibold tabular-nums text-surface-300" data-book-scrubber-page>
					{scrubPage + 1}/{totalBookPages}
				</span>
			</div>
			<input
				type="range"
				min="0"
				max={maxPage}
				step="1"
				bind:value={scrubPage}
				oninput={() => (scrubbing = true)}
				onpointerdown={() => (scrubbing = true)}
				onchange={commitScrub}
				onpointerup={commitScrub}
				onpointercancel={() => (scrubbing = false)}
				onkeyup={commitScrub}
				class="book-scrubber w-full"
				style={`--book-scrub-pct: ${maxPage > 0 ? (scrubPage / maxPage) * 100 : 0}%`}
				aria-label={m.reader_seek_through_pages()}
				aria-valuetext={m.reader_book_scrub_valuetext({ page: scrubPage + 1, total: totalBookPages, label: scrubLabel ? `, ${scrubLabel}` : '' })}
				data-book-scrubber-input
			/>
		</div>
	{/if}
</div>

<style>
	/* Native range, sized for a thumb rather than a mouse: a 28px handle in a
	   44px row clears the touch-target floor without growing the panel. */
	.book-scrubber {
		-webkit-appearance: none;
		appearance: none;
		height: 44px;
		background: transparent;
		cursor: pointer;
		touch-action: none;
	}
	.book-scrubber::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--color-primary-600) var(--book-scrub-pct, 0%),
			var(--color-surface-700) var(--book-scrub-pct, 0%)
		);
	}
	.book-scrubber::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		height: 28px;
		width: 28px;
		margin-top: -11px;
		border-radius: 999px;
		background: var(--color-primary-500);
		border: 3px solid var(--color-surface-container-high);
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
	}
	.book-scrubber:focus-visible::-webkit-slider-thumb {
		outline: 2px solid var(--color-primary-500);
		outline-offset: 2px;
	}
	.book-scrubber::-moz-range-track {
		height: 6px;
		border-radius: 999px;
		background: var(--color-surface-700);
	}
	.book-scrubber::-moz-range-progress {
		height: 6px;
		border-radius: 999px;
		background: var(--color-primary-600);
	}
	.book-scrubber::-moz-range-thumb {
		height: 28px;
		width: 28px;
		border-radius: 999px;
		background: var(--color-primary-500);
		border: 3px solid var(--color-surface-container-high);
	}
</style>

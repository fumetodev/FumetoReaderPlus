<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * Book display menu (Aa) — flow, font size, line height, theme. Persists
	 * straight through settings.patch (apply-immediately, like the reader's
	 * quick controls); BookReader re-applies live on every change, keeping
	 * the reading position.
	 */
	import { fade, fly } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { settings } from '$lib/settings/settings.js';
	import {
		BOOK_FONT_SCALE_MAX,
		BOOK_FONT_SCALE_MIN,
		BOOK_FONT_SCALE_STEP,
		clampBookFontScale
	} from '$lib/book/book-css.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';

	function setFlow(flow: 'paginated' | 'scrolled'): void {
		if ($settings.bookFlow === flow) return;
		playReaderHaptic('selection');
		settings.patch({ bookFlow: flow });
	}

	function stepFontScale(direction: 1 | -1): void {
		const next = clampBookFontScale($settings.bookFontScalePercent + direction * BOOK_FONT_SCALE_STEP);
		if (next === $settings.bookFontScalePercent) return;
		playReaderHaptic('selection');
		settings.patch({ bookFontScalePercent: next });
	}

	function stepLineHeight(direction: 1 | -1): void {
		const next = Math.round(Math.min(2.4, Math.max(1.1, $settings.bookLineHeight + direction * 0.1)) * 10) / 10;
		if (next === $settings.bookLineHeight) return;
		playReaderHaptic('selection');
		settings.patch({ bookLineHeight: next });
	}

	function setTheme(theme: 'app-dark' | 'light'): void {
		if ($settings.bookTheme === theme) return;
		playReaderHaptic('selection');
		settings.patch({ bookTheme: theme });
	}

	const segmentBase =
		'relative flex h-9 min-w-[96px] items-center justify-center rounded-full px-4 text-xs font-semibold press-morph';
	const stepBase =
		'flex h-9 w-9 items-center justify-center rounded-full text-base font-semibold text-surface-100 transition-[background-color] duration-100 active:bg-surface-700 disabled:text-surface-600';
</script>

<button
	type="button"
	aria-label={m.reader_close_book_display_options()}
	class="fixed inset-0 z-[35]"
	onclick={() => mobileReaderUi.closeDisclosure()}
	in:fade={{ duration: motionDuration(120) }}
	out:fade={{ duration: motionDuration(exitDuration(120)) }}
	data-book-display-scrim
></button>
<div
	class="fixed z-[45] rounded-[var(--radius-card)] bg-surface-container-high p-4 shadow-2xl"
	style="bottom: calc(var(--reader-bottom-clearance) + 8px); left: calc(0.5rem + var(--sal, 0px)); right: calc(0.5rem + var(--sar, 0px));"
	in:fly={{ y: 10, duration: motionDuration(140) }}
	out:fly={{ y: 10, duration: motionDuration(exitDuration(140)) }}
	role="menu"
	aria-label={m.reader_book_display_options()}
	data-book-display-menu
>
	<div class="flex flex-col gap-4">
		<div class="flex items-center justify-between gap-3">
			<span class="text-sm text-surface-200">{m.reader_reading_flow()}</span>
			<div class="relative flex gap-1 rounded-full bg-surface-900/70 p-1" role="radiogroup" aria-label={m.reader_reading_flow()} data-book-flow use:slidingSelection>
				<button
					type="button"
					role="radio"
					aria-checked={$settings.bookFlow === 'paginated'}
					class="{segmentBase} {$settings.bookFlow === 'paginated' ? 'text-white' : 'text-surface-300'}"
					onclick={() => setFlow('paginated')}
				>
					{m.reader_pages()}
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={$settings.bookFlow === 'scrolled'}
					class="{segmentBase} {$settings.bookFlow === 'scrolled' ? 'text-white' : 'text-surface-300'}"
					onclick={() => setFlow('scrolled')}
				>
					{m.reader_scroll()}
				</button>
			</div>
		</div>

		<div class="flex items-center justify-between gap-3">
			<span class="text-sm text-surface-200">{m.reader_text_size()}</span>
			<div class="flex items-center gap-2" data-book-font-scale>
				<button type="button" class={stepBase} aria-label={m.reader_smaller_text()}
					disabled={$settings.bookFontScalePercent <= BOOK_FONT_SCALE_MIN}
					onclick={() => stepFontScale(-1)}>−</button>
				<span class="min-w-[52px] text-center text-sm tabular-nums text-surface-100" data-book-font-scale-value>{$settings.bookFontScalePercent}%</span>
				<button type="button" class={stepBase} aria-label={m.reader_larger_text()}
					disabled={$settings.bookFontScalePercent >= BOOK_FONT_SCALE_MAX}
					onclick={() => stepFontScale(1)}>+</button>
			</div>
		</div>

		<div class="flex items-center justify-between gap-3">
			<span class="text-sm text-surface-200">{m.reader_line_spacing()}</span>
			<div class="flex items-center gap-2" data-book-line-height>
				<button type="button" class={stepBase} aria-label={m.reader_tighter_lines()}
					disabled={$settings.bookLineHeight <= 1.1}
					onclick={() => stepLineHeight(-1)}>−</button>
				<span class="min-w-[52px] text-center text-sm tabular-nums text-surface-100">{$settings.bookLineHeight.toFixed(1)}</span>
				<button type="button" class={stepBase} aria-label={m.reader_looser_lines()}
					disabled={$settings.bookLineHeight >= 2.4}
					onclick={() => stepLineHeight(1)}>+</button>
			</div>
		</div>

		<div class="flex items-center justify-between gap-3">
			<span class="text-sm text-surface-200">{m.reader_page_color()}</span>
			<div class="relative flex gap-1 rounded-full bg-surface-900/70 p-1" role="radiogroup" aria-label={m.reader_page_color()} data-book-theme use:slidingSelection>
				<button
					type="button"
					role="radio"
					aria-checked={$settings.bookTheme === 'app-dark'}
					class="{segmentBase} {$settings.bookTheme === 'app-dark' ? 'text-white' : 'text-surface-300'}"
					onclick={() => setTheme('app-dark')}
				>
					{m.reader_dark()}
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={$settings.bookTheme === 'light'}
					class="{segmentBase} {$settings.bookTheme === 'light' ? 'text-white' : 'text-surface-300'}"
					onclick={() => setTheme('light')}
				>
					{m.reader_paper()}
				</button>
			</div>
		</div>
	</div>
</div>

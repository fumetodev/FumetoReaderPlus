<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { markOnboardingSeen, onboardingTourOpen } from '$lib/onboarding/onboarding.js';
	import { APP_NAME } from '$lib/version.js';
	import { motionDuration } from '$lib/util/motion.js';
	import { openExternal } from '$lib/util/external-links.js';
	import { isMobile } from '$lib/util/platform.js';

	// First-run tour: five swipeable pages. Figures reuse the licensed Help
	// screenshots (Black Jack pages, publisher free-secondary-use terms — the
	// title/author credit is visible inside each frame), so nothing here can
	// ever show a real user's library. Three pages read differently on a
	// desktop, where the mouse and keyboard replace taps and long-presses.
	interface TourPage {
		key: string;
		title: string;
		body?: string;
		figure?: string;
		figureAlt?: string;
		steps?: { text: string; link?: { label: string; url: string } }[];
		footnote?: string;
	}

	const PAGES: TourPage[] = [
		{
			key: 'welcome',
			title: m.onboarding_welcome_to_app_name({ APP_NAME }),
			body: m.onboarding_a_reader_and_translator(),
			footnote: m.onboarding_add_a_folder_of()
		},
		{
			key: 'library',
			title: m.onboarding_your_library_your_files(),
			figure: '/help/library-grid-view.png',
			figureAlt: m.onboarding_library_in_grid_view(),
			body: isMobile ? m.onboarding_import_cbz_files_with() : m.onboarding_import_desktop()
		},
		{
			key: 'reader',
			title: m.onboarding_read_the_way_manga(),
			figure: '/help/reader-single-page.png',
			figureAlt: m.onboarding_reader_showing_a_manga(),
			body: isMobile ? m.onboarding_manga_turns_right_to() : m.onboarding_reader_desktop()
		},
		{
			key: 'translate',
			title: m.onboarding_translate_as_you_read(),
			figure: '/help/translation-page-result.png',
			figureAlt: m.onboarding_a_fully_translated_page(),
			body: isMobile ? m.onboarding_tap_translate_and_the() : m.onboarding_translate_desktop()
		},
		{
			key: 'setup',
			title: m.onboarding_set_up_translation_in(),
			steps: [
				{
					text: m.onboarding_create_a_free_account(),
					link: { label: 'openrouter.ai', url: 'https://openrouter.ai' }
				},
				{ text: m.onboarding_tap_get_api_key() },
				{ text: m.onboarding_paste_the_key_under() }
			],
			footnote: m.onboarding_prefer_that_nothing_ever()
		}
	];
	const count = PAGES.length;

	let index = $state(0);
	let dragPx = $state(0);
	let dragging = $state(false);
	let container = $state<HTMLDivElement | null>(null);
	let track = $state<HTMLDivElement | null>(null);

	// Reset to the first page each time the tour opens (auto-show or replay).
	$effect(() => {
		if ($onboardingTourOpen) {
			index = 0;
			queueMicrotask(() => container?.focus());
		}
	});

	function close(): void {
		markOnboardingSeen();
		onboardingTourOpen.set(false);
	}

	function go(next: number): void {
		index = Math.max(0, Math.min(count - 1, next));
	}

	// ── Swipe ──────────────────────────────────────────────────────────────
	// touch-action: pan-y keeps vertical scrolling native inside a page while
	// horizontal drags belong to the track.
	let pointerId = -1;
	let startX = 0;

	function onPointerDown(event: PointerEvent): void {
		pointerId = event.pointerId;
		startX = event.clientX;
		dragging = true;
		dragPx = 0;
	}
	function onPointerMove(event: PointerEvent): void {
		if (!dragging || event.pointerId !== pointerId) return;
		const raw = event.clientX - startX;
		// Rubber-band at the ends instead of dragging into nothing.
		const atEdge = (raw > 0 && index === 0) || (raw < 0 && index === count - 1);
		dragPx = atEdge ? raw / 3 : raw;
	}
	function onPointerUp(event: PointerEvent): void {
		if (!dragging || event.pointerId !== pointerId) return;
		dragging = false;
		const width = track?.clientWidth ?? 1;
		if (Math.abs(dragPx) > width * 0.18) go(index + (dragPx < 0 ? 1 : -1));
		dragPx = 0;
		pointerId = -1;
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowRight') go(index + 1);
		else if (event.key === 'ArrowLeft') go(index - 1);
		else if (event.key === 'Escape') close();
	}
</script>

{#if $onboardingTourOpen}
	<div
		bind:this={container}
		data-onboarding-tour
		role="dialog"
		aria-modal="true"
		aria-label={m.onboarding_intro_aria({ app: APP_NAME })}
		tabindex="-1"
		onkeydown={onKeydown}
		class="fixed inset-0 z-[130] flex select-none flex-col text-surface-100 outline-none"
		style="background:
			radial-gradient(120% 90% at 85% 8%, rgba(76, 145, 96, 0.20), transparent 60%),
			radial-gradient(110% 85% at 8% 96%, rgba(46, 105, 66, 0.15), transparent 60%),
			linear-gradient(160deg, #131a16 0%, #0f1413 55%, #121a15 100%);"
	>
		<!-- Header: progress dots + skip.
		     Padded with `--sat`, not a bare env(): the Android WebView reports
		     every safe-area-inset as 0 even with viewport-fit=cover, so env()
		     alone draws this row under the status bar — measured 0px against a
		     real 95px cutout on a tested phone, which left Skip untappable.
		     installWindowInsetAdapter() keeps --sat fed from the native inset
		     snapshot; env() remains the fallback for iOS/desktop, where it is
		     the accurate source. -->
		<div
			class="flex items-center justify-between px-5 pb-1"
			style="padding-top: calc(var(--sat, env(safe-area-inset-top, 0px)) + 14px)"
		>
			<div class="flex items-center gap-1.5" data-onboarding-dots>
				{#each PAGES as pageEntry, dotIndex (pageEntry.key)}
					<button
						aria-label={m.onboarding_go_to_step({ step: dotIndex + 1, count })}
						aria-current={dotIndex === index}
						onclick={() => go(dotIndex)}
						class="h-1.5 rounded-full transition-all {dotIndex === index
							? 'w-5 bg-primary-500'
							: 'w-1.5 bg-surface-600 hover:bg-surface-500'}"
						style="transition-duration: {motionDuration(200)}ms"
					></button>
				{/each}
			</div>
			<button
				data-onboarding-skip
				onclick={close}
				class="rounded-md px-2.5 py-1.5 text-xs font-medium text-surface-400 transition-colors hover:text-surface-200"
			>
				{m.onboarding_skip()}
			</button>
		</div>

		<!-- Swipeable track -->
		<div class="min-h-0 flex-1 overflow-hidden" bind:this={track} style="touch-action: pan-y">
			<div
				class="flex h-full"
				role="presentation"
				style="transform: translateX(calc({-index * 100}% + {dragPx}px)); transition: {dragging
					? 'none'
					: `transform ${motionDuration(300)}ms cubic-bezier(0.22, 1, 0.36, 1)`}"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
			>
				{#each PAGES as pageEntry, pageIndex (pageEntry.key)}
					<section
						class="h-full w-full shrink-0 overflow-y-auto"
						aria-hidden={pageIndex !== index}
						data-onboarding-page={pageEntry.key}
					>
						<div class="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-5 px-7 py-4 text-center">
							{#if pageEntry.key === 'welcome'}
								<img
									src="/help/app-icon.png"
									alt=""
									class="h-20 w-20 rounded-[22%] shadow-2xl shadow-black/50"
									draggable="false"
								/>
							{/if}
							{#if pageEntry.figure}
								<img
									src={pageEntry.figure}
									alt={pageEntry.figureAlt}
									draggable="false"
									class="max-h-[38vh] w-auto max-w-full rounded-xl border border-surface-700/70 bg-surface-900 shadow-2xl shadow-black/40"
								/>
							{/if}
							<h2 class="text-xl font-semibold tracking-tight text-surface-100">{pageEntry.title}</h2>
							{#if pageEntry.body}
								<p class="text-sm leading-relaxed text-surface-400">{pageEntry.body}</p>
							{/if}
							{#if pageEntry.steps}
								<ol class="flex w-full flex-col gap-3">
									{#each pageEntry.steps as step, stepIndex}
										<li class="flex items-start gap-3 text-left">
											<span
												class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-600/20 text-xs font-semibold text-primary-400"
											>
												{stepIndex + 1}
											</span>
											<span class="text-sm leading-relaxed text-surface-300">
												{step.text}
												{#if step.link}
													<button
														class="font-medium text-primary-400 underline underline-offset-2 hover:text-primary-300"
														onclick={() => void openExternal(step.link!.url)}
													>
														{step.link.label}
													</button>
												{/if}
											</span>
										</li>
									{/each}
								</ol>
							{/if}
							{#if pageEntry.footnote}
								<p class="rounded-lg border border-primary-600/25 bg-primary-600/10 px-4 py-2.5 text-xs leading-relaxed text-primary-200/90">
									{pageEntry.footnote}
								</p>
							{/if}
						</div>
					</section>
				{/each}
			</div>
		</div>

		<!-- Footer -->
		<div
			class="flex items-center justify-between gap-3 px-5 pt-2"
			style="padding-bottom: calc(var(--sab, env(safe-area-inset-bottom, 0px)) + 16px)"
		>
			<button
				data-onboarding-back
				onclick={() => go(index - 1)}
				disabled={index === 0}
				class="rounded-lg px-4 py-2.5 text-sm font-medium text-surface-400 transition-colors hover:text-surface-200 disabled:invisible"
			>
				{m.common_back()}
			</button>
			{#if index < count - 1}
				<button
					data-onboarding-next
					onclick={() => go(index + 1)}
					class="rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-900/40 transition-colors hover:bg-primary-700"
				>
					{m.onboarding_next()}
				</button>
			{:else}
				<button
					data-onboarding-finish
					onclick={close}
					class="rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-900/40 transition-colors hover:bg-primary-700"
				>
					{m.onboarding_start_reading()}
				</button>
			{/if}
		</div>
	</div>
{/if}

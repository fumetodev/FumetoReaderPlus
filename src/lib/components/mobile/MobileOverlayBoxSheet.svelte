<script lang="ts">
	/**
	 * The page's box list.
	 *
	 * The one surface that lists EVERY item on the record — placed, shrunk,
	 * tap-to-reveal, hidden, deleted, not placed — rather than only what the
	 * planner painted. A hidden or deleted box has no plan item and so no
	 * long-press target; this is where it comes back from. It is also the
	 * editing surface for long-strip mode, where direct manipulation on the
	 * page is off, and where the reader sees the edits a re-translation could
	 * not carry forward.
	 */
	import * as m from '$lib/paraglide/messages.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import { fly } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { scrollEdgeFade } from '$lib/util/scroll-edge-fade.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { currentPageIndex, currentVolume } from '$lib/stores/reader-state.js';
	import { currentPageOverlay, currentPageTranslation } from '$lib/stores/translation-state.js';
	import { readerOverlayPlanningStatus } from '$lib/reader/overlay-planning-status.js';
	import { hasManualEdit } from '$lib/overlay-layout/repository.js';
	import { overlayLayoutReviewRect, regularOverlayLayoutReviews } from '$lib/reader/overlay-layout-review.js';
	import type { OverlayEditorTarget } from '$lib/reader/overlay-editor-draft.js';
	import {
		deleteOverlayBox,
		discardOrphanedOverlayEdit,
		hideOverlayBox,
		overlayUndoLabel,
		resetOverlayBox,
		restoreOverlayBox,
		undoLastOverlayEdit
	} from '$lib/reader/overlay-edits.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import type { OverlayItemV2, OverlayRenderPlanV2, PlannedOverlayItemV2 } from '$lib/types/index.js';

	interface Props {
		/** Open the floating editor on an item; the host owns the editor. */
		onedit: (target: OverlayEditorTarget) => void;
	}
	let { onedit }: Props = $props();

	let open = $derived($mobileReaderUi.disclosure === 'overlay-boxes');
	let busyItemId = $state<string | null>(null);
	let error = $state<string | null>(null);

	// The displayed page's plan, mirrored by the overlay onto the planning
	// status. A hidden or deleted item is simply absent from it.
	let plan = $derived<OverlayRenderPlanV2 | null>($readerOverlayPlanningStatus.plan);

	type Status =
		| { kind: 'placed' }
		| { kind: 'shrunk' }
		| { kind: 'reveal' }
		| { kind: 'hidden' }
		| { kind: 'deleted' }
		| { kind: 'unplaced'; detail: string }
		| { kind: 'pending' };

	interface Row {
		item: OverlayItemV2;
		planned: PlannedOverlayItemV2 | undefined;
		text: string;
		original: string;
		status: Status;
		edited: boolean;
	}

	let rows = $derived.by((): Row[] => {
		const document = $currentPageOverlay;
		const translation = $currentPageTranslation;
		if (!document || !translation) return [];
		const entries = new Map(translation.entries.map((entry) => [entry.id, entry]));
		const plannedById = new Map((plan?.items ?? []).map((planned) => [planned.itemId, planned]));
		const reviews = new Map(regularOverlayLayoutReviews(plan, document).map((review) => [review.itemId, review]));
		return [...document.items]
			.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
			.map((item) => {
				const entry = entries.get(item.translationEntryId);
				const planned = plannedById.get(item.id);
				const { removed, hidden, ...rest } = item.manual;
				let status: Status;
				if (removed) status = { kind: 'deleted' };
				else if (hidden) status = { kind: 'hidden' };
				else if (!plan) status = { kind: 'pending' };
				else if (!planned || planned.status === 'unplaced') status = { kind: 'unplaced', detail: reviews.get(item.id)?.detail ?? 'Could not be placed.' };
				else if (planned.fitMode === 'reveal') status = { kind: 'reveal' };
				else if (planned.fitMode === 'degraded') status = { kind: 'shrunk' };
				else status = { kind: 'placed' };
				return {
					item,
					planned,
					text: item.manual.textOverride ?? entry?.translated_text ?? '',
					original: entry?.original_text ?? '',
					status,
					edited: hasManualEdit(rest)
				};
			});
	});

	let orphans = $derived($currentPageTranslation?.orphaned_edits ?? []);
	let attention = $derived(rows.filter((row) => row.status.kind === 'unplaced' || row.status.kind === 'shrunk' || row.status.kind === 'reveal').length);

	function key() {
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid) return null;
		return { volumeUuid, pageIndex: $currentPageIndex };
	}

	async function run(itemId: string, action: () => Promise<unknown>): Promise<void> {
		if (busyItemId) return;
		busyItemId = itemId;
		error = null;
		playReaderHaptic('control');
		try {
			await action();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		} finally {
			busyItemId = null;
		}
	}

	function close(): void {
		mobileReaderUi.closeDisclosure();
	}

	function edit(row: Row): void {
		const document = $currentPageOverlay;
		if (!document) return;
		const rect = row.planned?.rect ?? overlayLayoutReviewRect(document, row.item.id);
		if (!rect) { error = m.reader_this_box_has_no(); return; }
		playReaderHaptic('control');
		close();
		onedit({ itemId: row.item.id, rect: { ...rect }, planId: plan?.planId ?? '' });
	}

	const chip = (status: Status): { label: string; tone: string } => {
		switch (status.kind) {
			case 'placed': return { label: m.reader_box_status_placed(), tone: 'bg-surface-700 text-surface-200' };
			case 'shrunk': return { label: m.reader_box_status_shrunk(), tone: 'bg-amber-500/20 text-amber-200' };
			case 'reveal': return { label: m.reader_box_status_reveal(), tone: 'bg-teal-500/20 text-teal-200' };
			case 'hidden': return { label: m.reader_box_status_hidden(), tone: 'bg-surface-700 text-surface-300' };
			case 'deleted': return { label: m.reader_box_status_deleted(), tone: 'bg-red-500/20 text-red-200' };
			case 'unplaced': return { label: m.reader_box_status_unplaced(), tone: 'bg-amber-500/25 text-amber-100' };
			case 'pending': return { label: m.reader_box_status_pending(), tone: 'bg-surface-700 text-surface-300' };
		}
	};
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="pointer-events-auto fixed inset-0 z-[95]" onclick={close} onkeydown={(event) => { if (event.key === 'Escape') close(); }} data-overlay-box-sheet-backdrop></div>
	<div
		class="pointer-events-auto fixed left-0 right-0 z-[96] flex max-h-[min(70vh,calc(var(--viewport-height,100dvh)-var(--reader-chrome-top)-16px))] flex-col rounded-t-2xl bg-surface-900 text-surface-100 shadow-2xl"
		style="bottom: calc(var(--sab, 0px) + var(--reader-bottom-inset, 0px) + var(--reader-bottom-height, 56px)); padding-left: var(--sal, 0px); padding-right: var(--sar, 0px);"
		role="dialog"
		aria-label={m.reader_boxes_on_this_page()}
		in:fly={{ y: 24, duration: motionDuration(160) }}
		out:fly={{ y: 24, duration: motionDuration(exitDuration(160)) }}
		data-overlay-box-sheet
	>
		<header class="flex h-12 shrink-0 items-center justify-between px-4">
			<h2 class="text-sm font-semibold">
				{m.reader_boxes_on_this_page_title()}
				{#if rows.length > 0}<span class="ml-2 text-xs font-normal text-surface-400">{rows.length}{attention > 0 ? m.reader_attention_need_attention({ attention }) : ''}</span>{/if}
			</h2>
			<button type="button" class="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-surface-300 active:bg-surface-800" aria-label={m.reader_close_box_list()} onclick={close}>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
			</button>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3" use:scrollEdgeFade>
			{#if $overlayUndoLabel}
				<button type="button" class="mb-2 flex h-11 w-full items-center justify-between rounded-lg bg-surface-800 px-3 text-sm active:bg-surface-700" onclick={() => void run('undo', undoLastOverlayEdit)} data-overlay-box-sheet-undo>
					<span class="truncate text-surface-200">{renderUserMessage({ code: $overlayUndoLabel })}</span><span class="shrink-0 font-medium text-teal-300">{m.common_undo()}</span>
				</button>
			{/if}
			{#if error}<p class="mb-2 rounded-lg bg-red-950/70 px-3 py-2 text-xs text-red-200" role="alert">{error}</p>{/if}
			{#if rows.length === 0}
				<p class="px-1 py-6 text-center text-sm text-surface-400">{m.reader_no_translated_boxes_on()}</p>
			{/if}
			<ul class="space-y-2">
				{#each rows as row (row.item.id)}
					{@const status = chip(row.status)}
					{@const pageKey = key()}
					<li class="rounded-lg bg-surface-800/80 px-3 py-2" data-overlay-box-row={row.item.id} data-overlay-box-status={row.status.kind}>
						<div class="flex items-start gap-2">
							<p class="min-w-0 flex-1 text-sm leading-snug {row.status.kind === 'deleted' || row.status.kind === 'hidden' ? 'text-surface-400' : 'text-surface-100'}">
								<span class="line-clamp-2">{row.text || '(empty)'}</span>
								{#if row.original}<span class="mt-0.5 block truncate text-[11px] text-surface-500">{row.original}</span>{/if}
							</p>
							<span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium {status.tone}">{status.label}</span>
						</div>
						{#if row.status.kind === 'unplaced'}<p class="mt-1 text-[11px] text-amber-200/80">{row.status.detail}</p>{/if}
						{#if row.edited}<p class="mt-1 text-[11px] text-teal-300/80">{m.reader_edited_by_you()}</p>{/if}
						<div class="mt-1.5 flex flex-wrap gap-2">
							{#if row.status.kind !== 'deleted'}
								<button type="button" class="h-11 rounded-md bg-surface-700 px-3 text-xs font-medium active:bg-surface-600 disabled:opacity-50" disabled={busyItemId !== null} onclick={() => edit(row)} data-overlay-box-sheet-action="edit">{m.reader_edit()}</button>
								<button type="button" class="h-11 rounded-md bg-surface-700 px-3 text-xs font-medium active:bg-surface-600 disabled:opacity-50" disabled={busyItemId !== null || !pageKey} onclick={() => pageKey && void run(row.item.id, () => hideOverlayBox(pageKey, row.item.id, row.status.kind !== 'hidden'))} data-overlay-box-sheet-action={row.status.kind === 'hidden' ? 'show' : 'hide'}>{row.status.kind === 'hidden' ? m.reader_show() : m.reader_hide()}</button>
								{#if row.edited}
									<button type="button" class="h-11 rounded-md bg-surface-700 px-3 text-xs font-medium active:bg-surface-600 disabled:opacity-50" disabled={busyItemId !== null || !pageKey} onclick={() => pageKey && void run(row.item.id, () => resetOverlayBox(pageKey, row.item.id, { keepText: true }))} data-overlay-box-sheet-action="reset">{m.reader_reset_to_automatic()}</button>
								{/if}
								<button type="button" class="h-11 rounded-md px-3 text-xs font-medium text-red-300 active:bg-red-900/40 disabled:opacity-50" disabled={busyItemId !== null || !pageKey} onclick={() => pageKey && void run(row.item.id, () => deleteOverlayBox(pageKey, row.item.id))} data-overlay-box-sheet-action="delete">{m.settings_models_delete()}</button>
							{:else}
								<button type="button" class="h-11 rounded-md bg-surface-700 px-3 text-xs font-medium active:bg-surface-600 disabled:opacity-50" disabled={busyItemId !== null || !pageKey} onclick={() => pageKey && void run(row.item.id, () => restoreOverlayBox(pageKey, row.item.id))} data-overlay-box-sheet-action="restore">{m.reader_restore()}</button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
			{#if orphans.length > 0}
				{@const pageKey = key()}
				<h3 class="mb-1 mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-surface-400">{m.reader_edits_that_no_longer()}</h3>
				<p class="mb-2 px-1 text-[11px] text-surface-500">{m.reader_the_page_was_re()}</p>
				<ul class="space-y-2">
					{#each orphans as orphan (orphan.itemId)}
						<li class="rounded-lg bg-surface-800/60 px-3 py-2" data-overlay-orphan-row={orphan.itemId}>
							<p class="line-clamp-2 text-sm text-surface-300">{orphan.translatedText || '(empty)'}</p>
							{#if orphan.originalText}<p class="truncate text-[11px] text-surface-500">{orphan.originalText}</p>{/if}
							<div class="mt-1.5">
								<button type="button" class="h-11 rounded-md px-3 text-xs font-medium text-red-300 active:bg-red-900/40 disabled:opacity-50" disabled={busyItemId !== null || !pageKey} onclick={() => pageKey && void run(orphan.itemId, () => discardOrphanedOverlayEdit(pageKey, orphan.itemId))} data-overlay-box-sheet-action="discard">{m.reader_discard()}</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

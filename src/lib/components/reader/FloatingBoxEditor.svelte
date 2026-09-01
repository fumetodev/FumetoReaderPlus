<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { getTransform, onTransformChange, pausePanzoom, resumePanzoom } from '$lib/panzoom/index.js';
	import { currentPageOverlay, currentPageTranslation } from '$lib/stores/translation-state.js';
	import { commitManualConstraints, deleteOverlayBox } from '$lib/reader/overlay-edits.js';
	import { currentVolume, currentPageIndex, overlayFontScale } from '$lib/stores/reader-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { movingBoxId, resizingBoxId, resizeScaleFont, overlayEditorCloseHandler, overlayEditorDismissHandler } from '$lib/stores/ui-state.js';
	import { validateOverlayManualConstraints } from '$lib/overlay-layout/index.js';
	import type { OverlayItemV2, OverlayManualConstraintsV2, Rect } from '$lib/types/index.js';
	import {
		buildOverlayEditorManualDraft,
		initialOverlayEditorValues,
		overlayManualConstraintsEqual
	} from '$lib/reader/overlay-editor-draft.js';

	interface Props {
		item: OverlayItemV2;
		rect: Rect;
		planId: string;
		text: string;
		viewportEl: HTMLDivElement;
		ondismiss: () => void;
	}

	let { item, rect, planId, text, viewportEl, ondismiss }: Props = $props();
	const initial = untrack(() => ({ item: structuredClone(item), rect: { ...rect }, text }));
	const capturedVolumeUuid = untrack(() => get(currentVolume)?.volume_uuid ?? null);
	const capturedPageIndex = untrack(() => get(currentPageIndex));
	const capturedManual = structuredClone(initial.item.manual);
	const capturedDocument = untrack(() => {
		const document = get(currentPageOverlay);
		return document ? structuredClone(document) : null;
	});
	const capturedTranslation = untrack(() => {
		const translation = get(currentPageTranslation);
		return translation ? structuredClone(translation) : null;
	});
	const initialValues = initialOverlayEditorValues(capturedManual, initial.rect, initial.text);
	let editText = $state(initialValues.text);
	let editFontSize = $state(initialValues.fontSize);
	let editWidth = $state(initialValues.width);
	let editHeight = $state(initialValues.height);
	let editHidden = $state(initialValues.hidden);
	let editWritingMode = $state(initialValues.writingMode);
	let localResizeScaleFont = $state(false);
	let deleting = $state(false);
	let editorTop = $state(0);
	let editorLeft = $state(0);
	let editorEl: HTMLDivElement | undefined = $state();
	let bottomDocked = $state(false);
	let savePromise: Promise<void> | null = null;
	let deleted = false;
	/** Cancel was tapped: nothing previewed here may reach the repository. */
	let discarded = false;
	let editError = $state<string | null>(null);
	const margin = 8;

	function updatePosition(): void {
		if (!viewportEl) return;
		const transform = getTransform();
		const viewport = viewportEl.getBoundingClientRect();
		const source = item.manual.rect ?? rect;
		const leftEdge = source.x * transform.scale + transform.x;
		const topEdge = source.y * transform.scale + transform.y;
		const rightEdge = (source.x + source.width) * transform.scale + transform.x;
		const bottomEdge = (source.y + source.height) * transform.scale + transform.y;
		const width = editorEl?.offsetWidth ?? Math.min(320, viewport.width - margin * 2);
		const height = editorEl?.offsetHeight ?? 380;
		const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab') || '0');
		let left = Math.max(margin, (viewport.width - width) / 2);
		let top = bottomEdge + margin;
		bottomDocked = false;
		if (rightEdge + margin + width <= viewport.width) {
			left = rightEdge + margin;
			top = topEdge;
		} else if (leftEdge - margin - width >= margin) {
			left = leftEdge - margin - width;
			top = topEdge;
		} else if (top + height > viewport.height - safeBottom && topEdge - margin - height >= margin) {
			top = topEdge - margin - height;
		} else if (top + height > viewport.height - safeBottom) {
			top = viewport.height - safeBottom - height - margin;
			bottomDocked = true;
		}
		editorLeft = Math.max(margin, Math.min(left, viewport.width - width - margin));
		editorTop = Math.max(margin, Math.min(top, viewport.height - safeBottom - height - margin));
	}

	function editorValues() {
		return {
			text: editText,
			fontSize: editFontSize,
			width: editWidth,
			height: editHeight,
			hidden: editHidden,
			writingMode: editWritingMode
		};
	}

	function finalManual(): OverlayManualConstraintsV2 {
		return buildOverlayEditorManualDraft({
			original: capturedManual,
			displayedRect: initial.rect,
			baseTranslation: initial.text,
			values: editorValues()
		});
	}

	function previewDraft(): void {
		const document = get(currentPageOverlay);
		if (!document) return;
		const next = structuredClone(document);
		const target = next.items.find((candidate) => candidate.id === item.id);
		if (!target) return;
		target.manual = finalManual();
		currentPageOverlay.set(next);
	}

	async function persistEdits(): Promise<void> {
		if (deleted || discarded || !capturedVolumeUuid) return;
		const manual = finalManual();
		if (overlayManualConstraintsEqual(manual, capturedManual)) return;
		if (!capturedDocument || !capturedTranslation) {
			throw new Error('Wait for the current page translation to finish before editing its overlays.');
		}
		await validateOverlayManualConstraints({
			document: capturedDocument,
			translations: capturedTranslation.entries,
			itemId: item.id,
			manual,
			settings: get(settings),
			fontScale: get(overlayFontScale),
			scopeId: `editor:${capturedVolumeUuid}:${capturedPageIndex}:${item.id}`
		});
		await commitManualConstraints({ volumeUuid: capturedVolumeUuid, pageIndex: capturedPageIndex }, item.id, manual, 'reader_edit_saved');
	}

	async function saveAndDismiss(): Promise<void> {
		if (!savePromise) savePromise = persistEdits();
		try {
			await savePromise;
			editError = null;
			ondismiss();
		} catch (error) {
			savePromise = null;
			editError = error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Leave without keeping anything. The sliders and textarea preview by
	 * writing straight into the live document, so discarding means putting
	 * the captured document back — the page then re-plans from what is
	 * actually saved. Ignored while a save or delete is already in flight:
	 * a commit that has started is not something a second tap can un-start.
	 */
	function cancelAndDismiss(): void {
		if (savePromise || deleting || deleted) return;
		discarded = true;
		editError = null;
		if (
			capturedDocument
			&& get(currentVolume)?.volume_uuid === capturedVolumeUuid
			&& get(currentPageIndex) === capturedPageIndex
		) {
			currentPageOverlay.set(structuredClone(capturedDocument));
		}
		ondismiss();
	}

	async function handleDelete(): Promise<void> {
		if (!capturedVolumeUuid || deleting) return;
		deleting = true;
		try {
			// Undoable from the snackbar, so no confirmation step stands in the way.
			await deleteOverlayBox({ volumeUuid: capturedVolumeUuid, pageIndex: capturedPageIndex }, item.id);
			deleted = true;
			editError = null;
			ondismiss();
		} catch (error) {
			editError = error instanceof Error ? error.message : String(error);
		} finally {
			deleting = false;
		}
	}

	async function beginMove(): Promise<void> {
		if (!savePromise) savePromise = persistEdits();
		try {
			await savePromise;
			editError = null;
			movingBoxId.set(item.id);
			ondismiss();
		} catch (error) {
			savePromise = null;
			editError = error instanceof Error ? error.message : String(error);
		}
	}

	async function beginResize(): Promise<void> {
		if (!savePromise) savePromise = persistEdits();
		try {
			await savePromise;
			editError = null;
			resizeScaleFont.set(localResizeScaleFont);
			resizingBoxId.set(item.id);
			ondismiss();
		} catch (error) {
			savePromise = null;
			editError = error instanceof Error ? error.message : String(error);
		}
	}

	function outside(event: PointerEvent): void {
		if (editorEl?.contains(event.target as Node)) return;
		if ((event.target as HTMLElement).closest('[data-overlay-box]')) return;
		void saveAndDismiss();
	}

	let unsubscribeTransform: (() => void) | undefined;
	onMount(() => {
		// panzoom listens on the PageViewer owner (an ancestor of this sibling
		// editor) and prevents touchstart by default, suppressing the browser's
		// synthesized click for every editor control. Pause it for the dialog.
		pausePanzoom();
		overlayEditorCloseHandler.set(saveAndDismiss);
		overlayEditorDismissHandler.set(cancelAndDismiss);
		requestAnimationFrame(() => document.addEventListener('pointerdown', outside, true));
		unsubscribeTransform = onTransformChange(updatePosition);
		window.visualViewport?.addEventListener('resize', updatePosition);
		window.addEventListener('resize', updatePosition);
		requestAnimationFrame(() => { updatePosition(); editorEl?.focus({ preventScroll: true }); });
	});

	onDestroy(() => {
		resumePanzoom();
		if (get(overlayEditorCloseHandler) === saveAndDismiss) overlayEditorCloseHandler.set(null);
		if (get(overlayEditorDismissHandler) === cancelAndDismiss) overlayEditorDismissHandler.set(null);
		unsubscribeTransform?.();
		document.removeEventListener('pointerdown', outside, true);
		window.visualViewport?.removeEventListener('resize', updatePosition);
		window.removeEventListener('resize', updatePosition);
		if (!savePromise && !deleted && !discarded) void persistEdits().catch((error) => console.error('Failed to auto-save overlay edit', error));
	});

	$effect(() => { if (editorEl) updatePosition(); });
	$effect(() => {
		const page = $currentPageIndex;
		if (page !== capturedPageIndex) void saveAndDismiss();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={editorEl} class="absolute z-[50] w-[min(20rem,calc(100%-16px))] select-none rounded-xl border border-surface-600 bg-surface-900/95 shadow-2xl backdrop-blur-sm" style="top:{editorTop}px; left:{editorLeft}px; max-height:calc(var(--viewport-height,100dvh) - var(--sat,0px) - var(--sab,0px) - 16px);" role="dialog" aria-label={m.reader_edit_overlay()} tabindex="-1" data-floating-box-editor data-overlay-plan-id={planId} data-bottom-docked={bottomDocked ? 'true' : undefined} onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancelAndDismiss(); } }}>
	<div class="flex items-center justify-between border-b border-surface-700 px-3 py-2">
		<span class="text-xs font-medium text-teal-400">{m.reader_overlay_number({ n: item.order + 1 })}</span>
		<!-- Closing commits the edit, so the way out is a labeled Done pill,
		     not a gray × that reads as "discard" and disappears into the
		     header. Cancel sits to its left for the reader who only wanted
		     to look, or changed their mind mid-drag — before it existed the
		     only exits all saved. Hit areas expand past the 36px pills via the
		     pseudo; the gap keeps the two from overlapping. -->
		<div class="flex items-center gap-3">
			<button type="button" aria-label={m.reader_discard_changes_and_close()} onclick={cancelAndDismiss} class="relative flex h-9 items-center justify-center rounded-full bg-surface-700 px-4 text-xs font-semibold text-surface-100 active:bg-surface-600 before:absolute before:-inset-1.5 before:content-['']" data-floating-box-editor-cancel>{m.common_cancel()}</button>
			<button type="button" aria-label={m.reader_save_and_close_overlay()} onclick={saveAndDismiss} class="relative flex h-9 items-center justify-center rounded-full bg-primary-600 px-4 text-xs font-semibold text-white active:bg-primary-700 before:absolute before:-inset-1.5 before:content-['']" data-floating-box-editor-done>{m.common_done()}</button>
		</div>
	</div>
	<div class="max-h-[calc(var(--viewport-height,100dvh)-var(--sat,0px)-var(--sab,0px)-64px)] space-y-3 overflow-y-auto overscroll-contain p-3">
		{#if editError}<p class="rounded bg-red-950 p-2 text-xs text-red-200" role="alert">{editError}</p>{/if}
		<label class="block text-[10px] text-surface-400">{m.reader_translation_label()}
			<textarea value={editText} oninput={(event) => { editText = event.currentTarget.value; previewDraft(); }} rows="2" class="mt-1 w-full resize-y rounded border border-surface-600 bg-surface-800 px-2 py-1 text-xs text-surface-100"></textarea>
		</label>
		<label class="block text-[10px] text-surface-400">{m.reader_font_label({ value: editFontSize === 0 ? m.reader_auto_2() : `${Math.round(editFontSize)}px` })}
			<input type="range" min="0" max="96" step="1" value={editFontSize} oninput={(event) => { editFontSize = +event.currentTarget.value; previewDraft(); }} class="h-6 w-full accent-teal-500" />
		</label>
		<label class="block text-[10px] text-surface-400">{m.reader_width_label({ px: Math.round(editWidth) })}
			<input type="range" min="20" max={Math.max(rect.width * 4, 600)} step="1" value={editWidth} oninput={(event) => { editWidth = +event.currentTarget.value; previewDraft(); }} class="h-6 w-full accent-teal-500" />
		</label>
		<label class="block text-[10px] text-surface-400">{m.reader_height_label({ px: Math.round(editHeight) })}
			<input type="range" min="10" max={Math.max(rect.height * 4, 400)} step="1" value={editHeight} oninput={(event) => { editHeight = +event.currentTarget.value; previewDraft(); }} class="h-6 w-full accent-teal-500" />
		</label>
		<div class="flex items-center justify-between gap-2">
			<label class="flex items-center gap-2 text-[10px] text-surface-300"><input type="checkbox" checked={editHidden} onchange={(event) => { editHidden = event.currentTarget.checked; previewDraft(); }} />{m.reader_hide()}</label>
			<div class="grid grid-cols-3 gap-1" role="group" aria-label={m.reader_writing_mode()}>
				<button type="button" aria-pressed={editWritingMode === 'auto'} onclick={() => { editWritingMode = 'auto'; previewDraft(); }} class="rounded bg-surface-800 px-2 py-1 text-[10px] {editWritingMode === 'auto' ? 'text-teal-300' : 'text-surface-400'}">{m.reader_auto_2()}</button>
				<button type="button" aria-pressed={editWritingMode === 'horizontal-tb'} onclick={() => { editWritingMode = 'horizontal-tb'; previewDraft(); }} class="rounded bg-surface-800 px-2 py-1 text-[10px] {editWritingMode === 'horizontal-tb' ? 'text-teal-300' : 'text-surface-400'}">{m.reader_horizontal()}</button>
				<button type="button" aria-pressed={editWritingMode === 'vertical-rl'} disabled={!$settings.overlayVerticalText} onclick={() => { editWritingMode = 'vertical-rl'; previewDraft(); }} class="rounded bg-surface-800 px-2 py-1 text-[10px] {editWritingMode === 'vertical-rl' ? 'text-teal-300' : 'text-surface-400'} disabled:cursor-not-allowed disabled:opacity-40">{m.reader_vertical()}</button>
			</div>
		</div>
		{#if editWritingMode === 'vertical-rl' && !$settings.overlayVerticalText}
			<p class="rounded bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">{m.reader_saved_vertical_override_is()}</p>
		{:else if editWritingMode === 'auto'}
			<p class="text-[10px] text-surface-500">{m.reader_auto_follows_the_source()}</p>
		{/if}
		<button onclick={() => void beginMove()} class="w-full rounded bg-surface-700 px-2 py-2 text-xs">{m.reader_move_overlay()}</button>
		<label class="flex items-center gap-2 text-[10px] text-surface-300"><input type="checkbox" bind:checked={localResizeScaleFont} />{m.reader_scale_font_when_resizing()}</label>
		<button onclick={() => void beginResize()} class="w-full rounded bg-surface-700 px-2 py-2 text-xs">{m.reader_resize_overlay()}</button>
		<div class="border-t border-surface-700 pt-2">
			<button type="button" onclick={() => void handleDelete()} disabled={deleting} class="text-[10px] text-red-400 disabled:opacity-50" data-floating-box-editor-delete>{m.reader_delete_overlay()}</button>
		</div>
	</div>
</div>

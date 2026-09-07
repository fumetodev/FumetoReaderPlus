<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { randomUUID } from '$lib/util/uuid.js';
	import { get } from 'svelte/store';
	import { sidebarOpen, hoveredRegionId, editOverlayBoxId, movingBoxId, resizingBoxId, resizeScaleFont, overlayEditorCloseHandler, readerTransientCloseHandler } from '$lib/stores/ui-state.js';
	import {
		currentPageRegions,
		currentPageTranslations,
		regionTranslationMap,
		translatingRegionIds,
		beginRegionTranslation,
		endRegionTranslation,
		currentPageTranslation,
		currentPageOverlay,
		setCurrentPageTranslationPayload
	} from '$lib/stores/translation-state.js';
	import { currentVolume, currentPageIndex, isOverlayMode, overlayFontScale, readerSessionId, readerTargetEpoch as readerPageTargetEpoch } from '$lib/stores/reader-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { runRegionTranslation } from '$lib/regions/region-translation-run.js';
	import { translateFullPage, translateFullPageWithOverlay, convertRegionsToOverlay } from '$lib/translation/full-page-service.js';
	import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
	import {
		cancelPageTranslationActivities,
		inspectPageTranslationActivitySnapshots,
		pageTranslationActivities
	} from '$lib/translation/page-translation-activity.js';
	import { reviseBox, revisePage } from '$lib/translation/revision-service.js';
	import { deleteDrawnRegionsOnPage, deleteRegion } from '$lib/regions/region-manager.js';
	import { createPageSource } from '$lib/reader/page-source-factory.js';
	import RevisionDialog from '$lib/components/reader/RevisionDialog.svelte';
	import { getNoTextMessage, getPageTranslationStatusMessage } from './sidebar-messages.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import {
		isReaderOverlayPlanningTarget,
		readerOverlayPlanningStatus
	} from '$lib/reader/overlay-planning-status.js';
	import type { OverlayItemV2, OverlayManualConstraintsV2, PageTranslationEntry, TranslationRegion, Translation } from '$lib/types/index.js';
	import { overlayItemBaseRect, pageOverlayRepository, validateOverlayManualConstraints } from '$lib/overlay-layout/index.js';
	import { areOcrModelsReady } from '$lib/detection/ocr-model-manager.js';
	import { openOcrModelPrompt } from '$lib/detection/ocr-model-gate.js';

	interface Props {
	}
	let {}: Props = $props();

	let translationError = $state<string | null>(null);
	let sidebarTab = $state<'regions' | 'page'>('page');
	let pageTranslationSnapshot = $state(readerPageTranslationController.inspect());
	const unsubscribePageTranslation = readerPageTranslationController.subscribe((snapshot) => {
		pageTranslationSnapshot = snapshot;
	});
	let currentTargetActivities = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		const pageIndex = $currentPageIndex;
		if (!volumeUuid) return [];
		return $pageTranslationActivities.filter((activity) =>
			activity.target.volumeUuid === volumeUuid && activity.target.pageIndex === pageIndex
		);
	});
	let pageCancellationRequested = $derived(
		currentTargetActivities.some((activity) => activity.cancelRequested)
	);
	let pageRunPending = $derived(currentTargetActivities.length > 0);
	let pageRunCancellable = $derived(
		currentTargetActivities.some((activity) => activity.cancellable && !activity.cancelRequested)
	);
	let manualPageRunPending = $derived([
		'acquiring-page', 'detecting', 'translating', 'repairing', 'persisting', 'post-processing', 'cancelling'
	].includes(pageTranslationSnapshot.phase));
	let currentOverlayPlanningStatus = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid || !isReaderOverlayPlanningTarget($readerOverlayPlanningStatus, {
			volumeUuid,
			pageIndex: $currentPageIndex
		})) return null;
		return $readerOverlayPlanningStatus;
	});
	let readerTargetEpoch = 0;

	let observedVolumeUuid = get(currentVolume)?.volume_uuid ?? null;
	let observedPageIndex = get(currentPageIndex);
	function handleReaderTargetChange(volumeUuid: string | null, pageIndex: number): void {
		if (volumeUuid === observedVolumeUuid && pageIndex === observedPageIndex) return;
		observedVolumeUuid = volumeUuid;
		observedPageIndex = pageIndex;
		// The epoch records the navigation history, not only the final target.
		// This keeps a detached A → B → A async result permanently stale.
		readerTargetEpoch += 1;
		translationError = null;
	}
	const unsubscribeCurrentVolume = currentVolume.subscribe((volume) => {
		handleReaderTargetChange(volume?.volume_uuid ?? null, observedPageIndex);
	});
	const unsubscribeCurrentPage = currentPageIndex.subscribe((pageIndex) => {
		handleReaderTargetChange(observedVolumeUuid, pageIndex);
	});

	onDestroy(() => {
		if (get(overlayEditorCloseHandler) === closeInlineEditor) overlayEditorCloseHandler.set(null);
		if (get(readerTransientCloseHandler) === closeRevisionDialog) readerTransientCloseHandler.set(null);
		// Invalidate detached async work even if this Sidebar disappears while
		// the user remains on the same page (for example, collapsing the sheet).
		readerTargetEpoch += 1;
		unsubscribeCurrentVolume();
		unsubscribeCurrentPage();
		unsubscribePageTranslation();
	});

	// --- Revision state ---
	let revisionDialogOpen = $state(false);
	let revisionScope = $state<'box' | 'page'>('box');
	let revisionTargetOrder = $state<number | null>(null);
	let isRevising = $state(false);
	let revisionRunCounter = 0;
	function closeRevisionDialog(): void { revisionDialogOpen = false; }

	// --- Overlay conversion state ---
	let isConverting = $state(false);

	// Count user-drawn regions for the clear button
	let drawnRegionCount = $derived(
		$currentPageRegions.filter((r) => r.source === 'user-drawn').length
	);

	// Count regions that have translations (for "Add all to overlay" button)
	let translatedRegionCount = $derived(
		$currentPageRegions.filter((r) => $regionTranslationMap.has(r.id)).length
	);

	// --- Per-entry edit state ---
	let editingBoxId = $state<string | null>(null);
	let editText = $state('');
	let editFontSize = $state(0);
	let editWidth = $state(0);
	let editHeight = $state(0);
	let editHidden = $state(false);
	let editWritingMode = $state<'auto' | 'horizontal-tb' | 'vertical-rl'>('auto');
	let editResizeScaleFont = $state(false);
	let editFormEl = $state<HTMLDivElement | null>(null);
	/** Snapshot of original values for cancel/restore */
	let editOriginal = $state<OverlayManualConstraintsV2 | null>(null);

	// React to overlay box clicks from the page
	$effect(() => {
		const boxId = $editOverlayBoxId;
		if (boxId != null && $currentPageOverlay) {
			sidebarTab = 'page';

			// Auto-save any in-progress edit before switching to new box
			if (editingBoxId != null) {
				saveEditing();
			}

			const entry = $currentPageTranslation?.entries.find((candidate) => candidate.overlayItemId === boxId);
			if (entry) {
				startEditing(entry);
				// Scroll to the edit form after render
				requestAnimationFrame(() => {
					editFormEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
				});
			}
			editOverlayBoxId.set(null);
		}
	});

	// Auto-save in-progress edits when the user changes pages
	$effect(() => {
		const _page = $currentPageIndex;
		untrack(() => {
			if (editingBoxId != null) {
				saveEditing();
			}
		});
	});

	/** Whether any entries have per-box customizations */
	let hasCustomizations = $derived(
		$currentPageOverlay?.items.some((item) => Object.keys(item.manual).length > 0) ?? false
	);

	function startEditing(entry: PageTranslationEntry) {
		if (!entry.overlayItemId || !$currentPageOverlay) return;
		const overlayEntry = $currentPageOverlay.items.find((item) => item.id === entry.overlayItemId);
		if (!overlayEntry) return;
		const rect = overlayItemBaseRect($currentPageOverlay, overlayEntry);
		if (!rect) return;
		editingBoxId = overlayEntry.id;
		editText = overlayEntry.manual.textOverride ?? entry.translated_text;
		editFontSize = overlayEntry.manual.referenceFontSize ?? 0;
		editWidth = overlayEntry.manual.rect?.width ?? rect.width;
		editHeight = overlayEntry.manual.rect?.height ?? rect.height;
		editHidden = overlayEntry.manual.hidden ?? false;
		editWritingMode = overlayEntry.manual.writingMode ?? 'auto';
		editOriginal = structuredClone(overlayEntry.manual);
	}

	async function closeInlineEditor(): Promise<void> { await saveEditing(); }

	function cancelEditing() {
		if (editingBoxId != null && $currentPageOverlay && editOriginal) {
			const overlay = structuredClone($currentPageOverlay);
			const item = overlay.items.find((candidate) => candidate.id === editingBoxId);
			if (item) item.manual = structuredClone(editOriginal);
			currentPageOverlay.set(overlay);
		}
		editingBoxId = null;
		editOriginal = null;
	}

	async function saveEditing() {
		if (editingBoxId == null || !$currentPageOverlay || !$currentVolume) return;
		const item = $currentPageOverlay.items.find((candidate) => candidate.id === editingBoxId);
		const translation = $currentPageTranslation?.entries.find((entry) => entry.id === item?.translationEntryId);
		const baseRect = item ? overlayItemBaseRect($currentPageOverlay, item) : null;
		if (!item || !baseRect) return;
		const manual: OverlayManualConstraintsV2 = {
			...item.manual,
			rect: { ...(item.manual.rect ?? baseRect), width: editWidth, height: editHeight },
			pinGeometry: true,
			referenceFontSize: editFontSize > 0 ? editFontSize : undefined,
			pinTypography: editFontSize > 0 || undefined,
			textOverride: editText.trim() !== translation?.translated_text ? editText.trim() : undefined,
			hidden: editHidden || undefined
		};
		if (editWritingMode === 'auto') delete manual.writingMode;
		else manual.writingMode = editWritingMode;
		try {
			await validateOverlayManualConstraints({
				document: $currentPageOverlay,
				translations: $currentPageTranslation?.entries ?? [],
				itemId: editingBoxId,
				manual,
				settings: $settings,
				fontScale: $overlayFontScale,
				scopeId: `sidebar-editor:${$currentVolume.volume_uuid}:${$currentPageIndex}:${editingBoxId}`
			});
		} catch (error) {
			translationError = error instanceof Error ? error.message : String(error);
			return;
		}
		const updated = await pageOverlayRepository.updateManualConstraints($currentVolume.volume_uuid, $currentPageIndex, editingBoxId, manual);
		setCurrentPageTranslationPayload(updated, updated.overlay_data!);

		editingBoxId = null;
		editOriginal = null;
	}

	/** Live-update the overlay store as sliders move (without persisting) */
	function livePreview(field: 'customFontSize' | 'customWidth' | 'customHeight', value: number) {
		if (editingBoxId == null || !$currentPageOverlay) return;
		const overlay = structuredClone($currentPageOverlay);
		const item = overlay.items.find((candidate) => candidate.id === editingBoxId);
		if (!item) return;
		const baseRect = overlayItemBaseRect(overlay, item);
		if (!baseRect) return;
		if (field === 'customFontSize') {
			item.manual.referenceFontSize = value > 0 ? value : undefined;
			item.manual.pinTypography = value > 0 || undefined;
		} else {
			item.manual.rect = { ...(item.manual.rect ?? baseRect), [field === 'customWidth' ? 'width' : 'height']: value };
			item.manual.pinGeometry = true;
		}
		currentPageOverlay.set(overlay);
	}

	async function resetAllCustomizations() {
		if (!$currentPageOverlay || !$currentVolume) return;

		const newOverlay = structuredClone($currentPageOverlay);
		for (const item of newOverlay.items) item.manual = {};
		currentPageOverlay.set(newOverlay);
		const updated = await pageOverlayRepository.replaceDocument($currentVolume.volume_uuid, $currentPageIndex, newOverlay);
		setCurrentPageTranslationPayload(updated, updated.overlay_data!);
	}

	/** Delete an overlay box and its associated translation entry */
	async function handleDeleteOverlayBox(boxId: string) {
		const vol = $currentVolume;
		if (!vol) return;

		// Close any in-progress edit for this box
		if (editingBoxId === boxId) {
			editingBoxId = null;
			editOriginal = null;
		}

		const updated = await pageOverlayRepository.deleteItem(vol.volume_uuid, $currentPageIndex, boxId);
		setCurrentPageTranslationPayload(updated, updated.overlay_data!);
	}

	function getOverlayEntry(boxId: string | undefined): OverlayItemV2 | undefined {
		if (boxId == null || !$currentPageOverlay) return undefined;
		return $currentPageOverlay.items.find((item) => item.id === boxId);
	}

	async function handleTranslateRegion(region: TranslationRegion) {
		if (!(await areOcrModelsReady())) {
			openOcrModelPrompt(() => {
				void handleTranslateRegion(region);
			});
			return;
		}
		const vol = $currentVolume;
		if (!vol) return;
		const targetEpoch = readerTargetEpoch;
		const targetVolumeUuid = vol.volume_uuid;
		const targetPageIndex = region.page_index;
		const isTargetCurrent = () =>
			readerTargetEpoch === targetEpoch &&
			$currentVolume?.volume_uuid === targetVolumeUuid &&
			$currentPageIndex === targetPageIndex;

		translationError = null;

		// Shared with the mobile guided flow, which is what publishes the
		// activity token the Cancel button above is rendered from.
		const result = await runRegionTranslation(region);
		if (!result.ok && !result.cancelled && isTargetCurrent()) {
			translationError = result.error ?? m.sidebar_failed_to_load_page();
		}
	}

	async function handleClearDrawnRegions() {
		const vol = $currentVolume;
		if (!vol) return;
		await deleteDrawnRegionsOnPage(vol.volume_uuid, $currentPageIndex);
	}

	/** Remove converted regions from in-memory stores after promotion to overlay */
	function removeConvertedRegions(removedRegionIds: string[]) {
		const idSet = new Set(removedRegionIds);
		currentPageRegions.update((regions) => regions.filter((r) => !idSet.has(r.id)));
		currentPageTranslations.update((translations) =>
			translations.filter((t) => !idSet.has(t.region_id))
		);
	}

	async function handleConvertRegionToOverlay(region: TranslationRegion, translation: Translation) {
		const vol = $currentVolume;
		if (!vol || isConverting) return;

		isConverting = true;
		try {
			const { overlayData, pageTranslation, removedRegionIds } = await convertRegionsToOverlay(
				vol.volume_uuid,
				$currentPageIndex,
				[{ region, translation }]
			);
			setCurrentPageTranslationPayload(pageTranslation, overlayData);
			removeConvertedRegions(removedRegionIds);

			// Auto-enable overlay mode so the user sees the result
			if (!$isOverlayMode) {
				isOverlayMode.set(true);
			}
		} catch (err) {
			translationError = err instanceof Error
				? err.message
				: m.sidebar_failed_to_convert_region();
		} finally {
			isConverting = false;
		}
	}

	async function handleConvertAllRegionsToOverlay() {
		const vol = $currentVolume;
		if (!vol || isConverting) return;

		const pairs = $currentPageRegions
			.map(region => {
				const translation = $regionTranslationMap.get(region.id);
				return translation ? { region, translation } : null;
			})
			.filter((pair): pair is { region: TranslationRegion; translation: Translation } =>
				pair !== null
			);

		if (pairs.length === 0) return;

		isConverting = true;
		try {
			const { overlayData, pageTranslation, removedRegionIds } = await convertRegionsToOverlay(
				vol.volume_uuid,
				$currentPageIndex,
				pairs
			);
			setCurrentPageTranslationPayload(pageTranslation, overlayData);
			removeConvertedRegions(removedRegionIds);

			if (!$isOverlayMode) {
				isOverlayMode.set(true);
			}
		} catch (err) {
			translationError = err instanceof Error
				? err.message
				: m.sidebar_failed_to_convert_regions();
		} finally {
			isConverting = false;
		}
	}

	async function handleTranslateFullPage() {
		const vol = $currentVolume;
		if (!vol) return;
		// Same gate as the mobile bar: the vision models download on first use
		// here too, and a page run that starts without them fails deep inside
		// the detector instead of asking. The sheet resumes this action.
		if (!(await areOcrModelsReady())) {
			openOcrModelPrompt(() => {
				void handleTranslateFullPage();
			});
			return;
		}
		translationError = null;
		if ($settings.overlayEnabled && !$isOverlayMode) isOverlayMode.set(true);
		const target = {
			readerSessionId: $readerSessionId,
			targetEpoch: $readerPageTargetEpoch,
			volumeUuid: vol.volume_uuid,
			pageIndex: $currentPageIndex
		};

		try {
			const outcomePromise = readerPageTranslationController.requestManual(target);
			const started = readerPageTranslationController.inspect();
			const acquired = [
				'acquiring-page', 'detecting', 'translating', 'repairing', 'persisting', 'post-processing', 'cancelling'
			].includes(started.phase)
				&& started.runId !== null
				&& started.target?.volumeUuid === target.volumeUuid
				&& started.target.pageIndex === target.pageIndex
				&& started.target.readerSessionId === target.readerSessionId
				&& started.target.targetEpoch === target.targetEpoch
				&& inspectPageTranslationActivitySnapshots().some((activity) =>
					activity.owner === 'manual'
					&& activity.target.volumeUuid === target.volumeUuid
					&& activity.target.pageIndex === target.pageIndex
				);

			// Keep startup failures in view. Once the controller has actually
			// acquired this page, the compact action becomes its progress/Cancel UI.
			const outcome = await outcomePromise;
			if (outcome.status === 'failed') {
				translationError = outcome.error ?? m.reader_full_page_translation_failed();
			}
		} catch (error) {
			// The controller normally converts startup failures to a typed outcome,
			// but this boundary must never turn a Translate tap into an unhandled
			// promise rejection with no visible response.
			translationError = error instanceof Error
				? error.message
				: m.sidebar_full_page_translation_could();
		}
	}

	function dismissTranslationError(): void {
		translationError = null;
		readerPageTranslationController.acknowledgeTerminalState(pageTranslationSnapshot.target ?? undefined);
	}

	function handleCancelPageTranslation(): void {
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid || pageCancellationRequested) return;
		cancelPageTranslationActivities({ volumeUuid, pageIndex: $currentPageIndex });
	}

	function openRevisionDialog(scope: 'box' | 'page', targetOrder?: number) {
		revisionScope = scope;
		revisionTargetOrder = targetOrder ?? null;
		revisionDialogOpen = true;
	}

	async function handleRevisionSubmit(instructions: string) {
		revisionDialogOpen = false;

		const vol = $currentVolume;
		if (!vol) return;

		const targetPageIndex = $currentPageIndex;
		const targetVolumeUuid = vol.volume_uuid;
		const targetEpoch = readerTargetEpoch;
		const revisionRunId = ++revisionRunCounter;
		const isRevisionTargetCurrent = () =>
			revisionRunId === revisionRunCounter &&
			readerTargetEpoch === targetEpoch &&
			$currentVolume?.volume_uuid === targetVolumeUuid &&
			$currentPageIndex === targetPageIndex;
		isRevising = true;
		translationError = null;

		try {
			const source = await createPageSource(vol);
			const imageFile = await source.getPageAsFile(targetPageIndex);
			source.dispose();

			if (revisionScope === 'box' && revisionTargetOrder !== null) {
				const result = await reviseBox(
					vol.volume_uuid,
					targetPageIndex,
					revisionTargetOrder,
					instructions,
					imageFile
				);
				if (isRevisionTargetCurrent()) {
					currentPageTranslation.set(result);
					if (result.overlay_data) {
						currentPageOverlay.set(result.overlay_data);
					}
				}
			} else {
				const result = await revisePage(
					vol.volume_uuid,
					targetPageIndex,
					instructions,
					imageFile
				);
				if (isRevisionTargetCurrent()) {
					currentPageTranslation.set(result);
					if (result.overlay_data) {
						currentPageOverlay.set(result.overlay_data);
					}
				}
			}
		} catch (err) {
			if (isRevisionTargetCurrent()) {
				translationError = err instanceof Error ? err.message : m.reader_revision_failed();
			}
		} finally {
			if (revisionRunId === revisionRunCounter) isRevising = false;
		}
	}

	/** Quick re-translate a single box without showing the instructions dialog */
	async function handleQuickReviseBox(entryOrder: number) {
		const vol = $currentVolume;
		if (!vol) return;

		isRevising = true;
		translationError = null;
		const targetPageIndex = $currentPageIndex;
		try {
			const source = await createPageSource(vol);
			const imageFile = await source.getPageAsFile(targetPageIndex);
			source.dispose();

			const result = await reviseBox(
				vol.volume_uuid,
				targetPageIndex,
				entryOrder,
				m.sidebar_re_translate_this_entry_2(),
				imageFile
			);

			if ($currentPageIndex === targetPageIndex) {
				currentPageTranslation.set(result);
				if (result.overlay_data) {
					currentPageOverlay.set(result.overlay_data);
				}
			}
		} catch (err) {
			if ($currentPageIndex === targetPageIndex) {
				translationError = err instanceof Error ? err.message : m.sidebar_re_translation_failed();
			}
		} finally {
			isRevising = false;
		}
	}

	/** Live preview for the explicit/automatic writing-mode choice. */
	function livePreviewWritingMode(mode: 'auto' | 'horizontal-tb' | 'vertical-rl') {
		if (editingBoxId == null || !$currentPageOverlay) return;
		const overlay = structuredClone($currentPageOverlay);
		const item = overlay.items.find((candidate) => candidate.id === editingBoxId);
		if (!item) return;
		if (mode === 'auto') delete item.manual.writingMode;
		else item.manual.writingMode = mode;
		currentPageOverlay.set(overlay);
	}
</script>

		{#if $sidebarOpen}
	<aside
		class="flex h-full shrink-0 flex-col overflow-hidden border-l border-surface-800 bg-surface-900"
		style={`width: ${$settings.sidebarWidth}px`}
	>
		<!-- Panel header -->
		<div class="flex items-center justify-between border-b border-surface-800 px-4 py-3">
			<h2 class="text-sm font-semibold text-surface-200">{m.sidebar_translations()}</h2>
			<span class="text-xs text-surface-500">
				{m.sidebar_page_n({ page: $currentPageIndex + 1 })}
			</span>
		</div>

		<!-- Tab switcher -->
		<div class="flex border-b border-surface-800">
			<button
				class="flex-1 px-3 py-2 text-xs font-medium transition-colors
					{sidebarTab === 'page'
						? 'border-b-2 border-primary-500 text-primary-400'
						: 'text-surface-500 hover:text-surface-300'}"
				onclick={() => (sidebarTab = 'page')}
			>
				{m.sidebar_tab_page()}
				{#if $currentPageTranslation}
					<span class="ml-1 rounded-full bg-primary-600/30 px-1.5 text-[10px] text-primary-400">
						{$currentPageTranslation.entries.length}
					</span>
				{/if}
			</button>
			<button
				class="flex-1 px-3 py-2 text-xs font-medium transition-colors
					{sidebarTab === 'regions'
						? 'border-b-2 border-primary-500 text-primary-400'
						: 'text-surface-500 hover:text-surface-300'}"
				onclick={() => (sidebarTab = 'regions')}
			>
				{m.sidebar_tab_regions()}
				{#if $currentPageRegions.length > 0}
					<span class="ml-1 rounded-full bg-surface-700 px-1.5 text-[10px]">
						{$currentPageRegions.length}
					</span>
				{/if}
			</button>
		</div>

		<!-- Error banner -->
		{#if translationError || pageTranslationSnapshot.error}
			<div class="border-b border-red-500/30 bg-red-500/10 px-4 py-2" role="alert">
				{#if pageTranslationSnapshot.coverageFailure}
					<p class="text-xs text-red-300">
						{m.sidebar_coverage_failure({ translated: pageTranslationSnapshot.coverageFailure.translated, recognized: pageTranslationSnapshot.coverageFailure.recognized })}
					</p>
				{:else}
					<p class="text-xs text-red-400">{translationError ?? pageTranslationSnapshot.error}</p>
				{/if}
				<div class="mt-1 flex gap-3">
					{#if pageTranslationSnapshot.coverageFailure?.retryable}
						<button
							class="text-[10px] font-medium text-red-200 underline"
							onclick={handleTranslateFullPage}
						>
							{m.sidebar_retry_page()}
						</button>
					{/if}
					<button
						class="text-[10px] text-red-300 underline"
						onclick={dismissTranslationError}
					>
						{m.common_dismiss()}
					</button>
				</div>
			</div>
		{/if}
		{#if currentOverlayPlanningStatus?.phase === 'loading-fonts' || currentOverlayPlanningStatus?.phase === 'planning'}
			<div class="border-b border-purple-500/30 bg-purple-500/10 px-4 py-2" role="status" aria-live="polite">
				<p class="text-xs text-purple-300">
					{currentOverlayPlanningStatus.phase === 'loading-fonts'
						? m.sidebar_loading_the_exact_fonts()
						: m.sidebar_laying_out_the_translated()}
				</p>
			</div>
		{:else if currentOverlayPlanningStatus?.phase === 'failed'}
			<div class="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2" role="alert">
				<p class="text-xs text-amber-300">{m.sidebar_the_translation_was_saved()}</p>
				{#if currentOverlayPlanningStatus.error}
					<p class="mt-1 text-[10px] text-amber-400">{currentOverlayPlanningStatus.error}</p>
				{/if}
			</div>
		{/if}

		<!-- Tab content -->
		{#if sidebarTab === 'regions'}
			<!-- Regions tab -->
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					{#if $currentPageRegions.length === 0}
					<div class="px-4 py-8 text-center text-sm text-surface-500">
						<p class="mb-2">{m.sidebar_no_regions_yet()}</p>
						<p class="text-xs text-surface-600">
							<RichMessage message={m.sidebar_draw_mode_hint()} />
						</p>
					</div>
				{:else}
					<!-- Region actions bar -->
					{#if drawnRegionCount > 0 || (translatedRegionCount > 0 && $settings.overlayEnabled)}
						<div class="flex items-center justify-end gap-3 border-b border-surface-800/50 px-3 py-1.5">
							{#if translatedRegionCount > 0 && $settings.overlayEnabled}
								<button
									class="text-[10px] text-surface-500 transition-colors hover:text-teal-400 disabled:opacity-50 disabled:pointer-events-none"
									onclick={handleConvertAllRegionsToOverlay}
									disabled={isConverting}
									title={m.sidebar_convert_all_translated_regions()}
								>
									{m.sidebar_add_all_to_overlay({ count: translatedRegionCount })}
								</button>
							{/if}
							{#if drawnRegionCount > 0}
								<button
									class="text-[10px] text-surface-500 transition-colors hover:text-red-400"
									onclick={handleClearDrawnRegions}
									title={m.sidebar_clear_all_drawn_regions()}
								>
									{m.sidebar_clear_drawn({ count: drawnRegionCount })}
								</button>
							{/if}
						</div>
					{/if}

					<div class="space-y-1 p-2">
						{#each $currentPageRegions as region, i (region.id)}
							{@const translation = $regionTranslationMap.get(region.id)}
							{@const isTranslating = $translatingRegionIds.has(region.id)}
							<div
								class="rounded-lg border px-3 py-2.5 transition-colors {$hoveredRegionId === region.id
									? 'border-primary-500 bg-primary-500/10'
									: translation
										? 'border-surface-700 bg-surface-800/50'
										: 'border-dashed border-surface-700 bg-surface-800/20'}"
								role="button"
								tabindex="0"
								onmouseenter={() => hoveredRegionId.set(region.id)}
								onmouseleave={() => hoveredRegionId.set(null)}
							>
								<div class="mb-1 flex items-center justify-between">
									<span class="text-xs font-medium text-surface-400">{m.sidebar_region_n({ n: i + 1 })}</span>
									<div class="flex items-center gap-1">
										{#if translation}
											<span class="rounded bg-primary-600/20 px-1.5 py-0.5 text-[10px] text-primary-400">
												{m.sidebar_mode_n({ mode: translation.mode })}
											</span>
										{/if}
										{#if isTranslating}
											<span class="inline-block h-3 w-3 animate-spin rounded-full border border-purple-400 border-t-transparent"></span>
										{/if}
										<button
											onclick={(e) => { e.stopPropagation(); deleteRegion(region.id); }}
											class="text-[10px] text-surface-600 transition-colors hover:text-red-400"
											title={m.sidebar_delete_this_region()}
											disabled={isTranslating}
										>✕</button>
									</div>
								</div>

								{#if translation}
									<!-- Show original Japanese text -->
									{#if translation.original_text}
										<p class="mb-1.5 text-xs leading-relaxed text-surface-400" lang={$settings.sourceLanguage}>
											{translation.original_text}
										</p>
									{/if}
									<!-- Show English translation -->
									<p class="text-sm leading-relaxed text-surface-100">
										{translation.translated_text}
									</p>
									<!-- Re-translate / Add to overlay -->
									<div class="mt-1.5 flex items-center gap-3">
										<button
											class="text-[10px] text-surface-500 transition-colors hover:text-primary-400"
											onclick={() => handleTranslateRegion(region)}
											disabled={isTranslating}
										>
											{m.reader_re_translate()}
										</button>
										{#if $settings.overlayEnabled}
											<button
												class="text-[10px] text-surface-500 transition-colors hover:text-teal-400 disabled:opacity-50 disabled:pointer-events-none"
												onclick={() => handleConvertRegionToOverlay(region, translation)}
												disabled={isTranslating || isConverting}
											>
												{m.sidebar_add_to_overlay()}
											</button>
										{/if}
									</div>
								{:else if isTranslating}
									<p class="text-xs italic text-purple-400">{m.sidebar_translating()}</p>
								{:else}
									<button
										class="mt-1 rounded bg-primary-600/80 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-600"
										onclick={() => handleTranslateRegion(region)}
									>
										{m.reader_translate()}
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{:else if sidebarTab === 'page'}
			<!-- Page translation tab -->
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					{#if pageRunPending}
					<div class="space-y-2 p-2">
						{#each Array(4) as _}
							<div class="animate-pulse rounded-lg border border-surface-700 bg-surface-800/50 px-3 py-2.5">
								<div class="mb-2 flex items-center gap-2">
									<div class="h-3 w-6 rounded bg-surface-700"></div>
									<div class="h-3 w-12 rounded bg-surface-700"></div>
								</div>
								<div class="h-3 w-3/4 rounded bg-surface-700"></div>
								<div class="mt-1.5 h-3 w-1/2 rounded bg-surface-700"></div>
							</div>
						{/each}
						{#if manualPageRunPending}
							<p class="text-center text-xs text-purple-400" role="status" aria-live="polite" data-page-translation-status>
								{renderUserMessage(getPageTranslationStatusMessage(
									pageTranslationSnapshot.phase,
									pageTranslationSnapshot.progress,
									$settings.onDeviceOCRProvider
								))}
							</p>
					{:else}
						<p class="text-center text-xs text-purple-400" role="status" aria-live="polite" data-page-translation-status>{m.sidebar_translating_full_page()}</p>
					{/if}
					{#if pageRunCancellable || pageCancellationRequested}
						<button
							type="button"
							onclick={handleCancelPageTranslation}
							disabled={pageCancellationRequested}
							class="mx-auto block rounded px-3 py-1 text-[10px] font-medium {pageCancellationRequested ? 'bg-surface-700 text-surface-500' : 'bg-red-500/15 text-red-300 hover:bg-red-500/25'}"
						>
							{pageCancellationRequested ? m.reader_cancelling() : m.common_cancel()}
						</button>
					{/if}
				</div>
				{:else if $currentPageTranslation}
					<!-- Action buttons -->
					<div class="flex items-center justify-between border-b border-surface-800/50 px-3 py-1.5">
						{#if hasCustomizations}
							<button
								class="text-[10px] text-surface-500 transition-colors hover:text-red-400"
								onclick={resetAllCustomizations}
								title={m.sidebar_remove_all_per_box()}
							>
								{m.sidebar_reset_customizations()}
							</button>
						{:else}
							<span></span>
						{/if}
						<div class="flex items-center gap-3">
							<button
								disabled={pageRunPending || isRevising}
								class="text-[10px] text-surface-500 transition-colors hover:text-primary-400 disabled:opacity-50 disabled:pointer-events-none"
								onclick={() => openRevisionDialog('page')}
							>
								{isRevising ? m.sidebar_revising() : m.sidebar_revise_page()}
							</button>
							<button
								disabled={pageRunPending || isRevising}
								class="text-[10px] text-surface-500 transition-colors hover:text-primary-400 disabled:opacity-50 disabled:pointer-events-none"
								onclick={handleTranslateFullPage}
							>
								{pageRunPending ? m.sidebar_translating() : m.reader_re_translate_page()}
							</button>
						</div>
					</div>

					<div class="space-y-2 p-2">
						{#if $currentPageTranslation.no_text_detected}
							<div class="rounded-lg border border-surface-700 bg-surface-800/40 px-3 py-2 text-xs text-surface-300">
								{renderUserMessage(getNoTextMessage($currentPageTranslation.model))}
							</div>
						{:else}
							{#each $currentPageTranslation.entries as entry (entry.order)}
							{@const overlayEntry = getOverlayEntry(entry.overlayItemId)}
							{@const overlayRect = overlayEntry && $currentPageOverlay ? overlayItemBaseRect($currentPageOverlay, overlayEntry) : null}
							{@const isEditing = editingBoxId === entry.overlayItemId}
							{@const isHiddenEntry = overlayEntry?.manual.hidden}
							{@const hasOverride = overlayEntry && Object.keys(overlayEntry.manual).length > 0}

							<div class="rounded-lg border bg-surface-800/50 px-3 py-2.5
								{isHiddenEntry ? 'border-surface-700/50 opacity-50' : 'border-surface-700'}
								{hasOverride && !isHiddenEntry ? 'border-l-2 border-l-teal-500' : ''}">

								{#if isEditing && overlayEntry}
									<!-- Inline edit form -->
									<div bind:this={editFormEl} class="space-y-2" role="group" aria-label={m.sidebar_edit_overlay_order({ order: entry.order + 1 })} data-sidebar-box-editor>
										<div class="flex items-center justify-between">
											<span class="text-[10px] font-medium text-teal-400">{m.sidebar_editing_n({ n: entry.order + 1 })}</span>
											<button
												class="text-[10px] text-surface-500 hover:text-surface-300"
												onclick={cancelEditing}
											>✕</button>
										</div>

										<!-- Text -->
										<div>
											<label for={`sidebar-translation-${entry.overlayItemId}`} class="mb-0.5 block text-[10px] text-surface-400">{m.reader_translation_label()}</label>
											<textarea
												id={`sidebar-translation-${entry.overlayItemId}`}
												bind:value={editText}
												rows="3"
												class="w-full resize-y rounded border border-surface-600 bg-surface-800 px-2 py-1 text-xs text-surface-100 focus:border-teal-500 focus:outline-none"
											></textarea>
										</div>

										<!-- Font Size slider -->
										<div>
											<div class="mb-0.5 flex items-center justify-between">
												<label for={`sidebar-font-size-${entry.overlayItemId}`} class="text-[10px] text-surface-400">{m.sidebar_font_size()}</label>
												<span class="text-[10px] text-surface-500">{editFontSize === 0 ? m.reader_auto_2() : `${Math.round(editFontSize)}px`}</span>
											</div>
											<input
												id={`sidebar-font-size-${entry.overlayItemId}`}
												type="range"
												min="0"
												max="96"
												step="1"
												value={editFontSize}
												oninput={(e) => {
													editFontSize = parseFloat(e.currentTarget.value);
													livePreview('customFontSize', editFontSize);
												}}
												class="w-full accent-teal-500"
											/>
										</div>

										<!-- Width slider -->
										<div>
											<div class="mb-0.5 flex items-center justify-between">
												<label for={`sidebar-width-${entry.overlayItemId}`} class="text-[10px] text-surface-400">{m.header_width()}</label>
												<span class="text-[10px] text-surface-500">{Math.round(editWidth)}px</span>
											</div>
											<input
												id={`sidebar-width-${entry.overlayItemId}`}
												type="range"
												min="20"
												max={Math.max((overlayRect?.width ?? editWidth) * 4, 600)}
												step="1"
												value={editWidth}
												oninput={(e) => {
													editWidth = parseFloat(e.currentTarget.value);
													livePreview('customWidth', editWidth);
												}}
												class="w-full accent-teal-500"
											/>
										</div>

										<!-- Height slider -->
										<div>
											<div class="mb-0.5 flex items-center justify-between">
												<label for={`sidebar-height-${entry.overlayItemId}`} class="text-[10px] text-surface-400">{m.header_height()}</label>
												<span class="text-[10px] text-surface-500">{Math.round(editHeight)}px</span>
											</div>
											<input
												id={`sidebar-height-${entry.overlayItemId}`}
												type="range"
												min="10"
												max={Math.max((overlayRect?.height ?? editHeight) * 4, 400)}
												step="1"
												value={editHeight}
												oninput={(e) => {
													editHeight = parseFloat(e.currentTarget.value);
													livePreview('customHeight', editHeight);
												}}
												class="w-full accent-teal-500"
											/>
										</div>

										<!-- Hidden toggle + writing-mode policy -->
										<div class="flex items-center justify-between gap-2">
											<label class="flex items-center gap-2 text-[10px] text-surface-300">
												<input type="checkbox" bind:checked={editHidden} class="rounded" />
												{m.sidebar_hide_this_overlay_box()}
											</label>
											<div class="grid grid-cols-3 gap-1" role="group" aria-label={m.reader_writing_mode()}>
												{#each [
													{ value: 'auto' as const, label: m.reader_auto_2() },
													{ value: 'horizontal-tb' as const, label: m.reader_horizontal() },
													{ value: 'vertical-rl' as const, label: m.reader_vertical() }
												] as option (option.value)}
													<button
														type="button"
														aria-pressed={editWritingMode === option.value}
														disabled={option.value === 'vertical-rl' && !$settings.overlayVerticalText}
														onclick={() => {
															editWritingMode = option.value;
															livePreviewWritingMode(option.value);
														}}
														class="rounded bg-surface-800 px-1.5 py-1 text-[9px] font-medium transition-colors hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-40 {editWritingMode === option.value ? 'text-teal-400' : 'text-surface-300'}"
													>{option.label}</button>
												{/each}
											</div>
										</div>
										{#if editWritingMode === 'vertical-rl' && !$settings.overlayVerticalText}
											<p class="rounded bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">{m.reader_saved_vertical_override_is()}</p>
										{:else if editWritingMode === 'auto'}
											<p class="text-[10px] text-surface-500">{m.reader_auto_follows_the_source()}</p>
										{/if}

										<!-- Move button -->
										<button
											onclick={() => {
												if (editingBoxId != null) {
													movingBoxId.set(editingBoxId);
													editingBoxId = null;
												}
											}}
											class="w-full rounded bg-surface-700 px-2 py-1.5 text-[10px] font-medium text-surface-300 transition-colors hover:bg-surface-600 hover:text-surface-100"
										>{m.sidebar_move_box()}</button>

										<!-- Resize: scale font toggle + button -->
										<label class="flex items-center gap-2 text-[10px] text-surface-300">
											<input type="checkbox" bind:checked={editResizeScaleFont} class="rounded border-surface-600" />
											{m.reader_scale_font_when_resizing()}
										</label>
										<button
											onclick={() => {
												if (editingBoxId != null) {
													resizeScaleFont.set(editResizeScaleFont);
													resizingBoxId.set(editingBoxId);
													editingBoxId = null;
												}
											}}
											class="w-full rounded bg-surface-700 px-2 py-1.5 text-[10px] font-medium text-surface-300 transition-colors hover:bg-surface-600 hover:text-surface-100"
										>{m.sidebar_resize_box()}</button>

										<!-- Save/Cancel/Delete -->
										<div class="flex items-center justify-between">
											<button
												onclick={() => { if (editingBoxId != null) handleDeleteOverlayBox(editingBoxId); }}
												class="rounded px-2 py-1 text-[10px] text-red-400 transition-colors hover:text-red-300"
												title={m.sidebar_delete_this_overlay_box()}
											>{m.settings_models_delete()}</button>
											<div class="flex gap-2">
												<button
													onclick={cancelEditing}
													class="rounded px-2 py-1 text-[10px] text-surface-400 hover:text-surface-200"
												>{m.common_cancel()}</button>
												<button
													onclick={saveEditing}
													class="rounded bg-teal-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-teal-500"
												>{m.catalog_save()}</button>
											</div>
										</div>
									</div>
								{:else}
									<!-- Read-only entry card -->
									<div class="mb-1 flex items-center gap-2">
										<span class="text-[10px] font-medium text-surface-400">
											#{entry.order + 1}
										</span>
										{#if entry.type && entry.type !== 'unknown'}
											<span class="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-400">
												{entry.type}
											</span>
										{/if}
										{#if entry.speaker}
											<span class="text-[10px] text-primary-400">{entry.speaker}</span>
										{/if}
										{#if isHiddenEntry}
											<span class="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-400">hidden</span>
										{/if}
										<!-- Re-translate / Edit buttons -->
										<div class="ml-auto flex items-center gap-2">
											<button
												onclick={() => handleQuickReviseBox(entry.order)}
											disabled={pageRunPending || isRevising}
												class="text-[10px] text-surface-500 transition-colors hover:text-primary-400 disabled:opacity-50 disabled:pointer-events-none"
												title={m.sidebar_re_translate_this_entry()}
											>
												{isRevising ? m.sidebar_re_translating() : m.reader_re_translate()}
											</button>
											{#if overlayEntry}
												<button
													onclick={() => startEditing(entry)}
													disabled={isRevising}
													class="text-[10px] text-surface-500 transition-colors hover:text-teal-400 disabled:opacity-50 disabled:pointer-events-none"
													title={m.sidebar_edit_overlay_box()}
												>
													{m.reader_edit()}
												</button>
											{/if}
										</div>
									</div>
									{#if entry.original_text}
										<p class="mb-1 text-xs text-surface-400" lang={$settings.sourceLanguage}>{entry.original_text}</p>
									{/if}
									{#if overlayEntry?.manual.textOverride}
										<p class="text-sm leading-relaxed text-teal-200">{overlayEntry.manual.textOverride}</p>
										<p class="mt-0.5 text-[10px] text-surface-500 line-through">{entry.translated_text}</p>
									{:else if entry.translated_text}
										<p class="text-sm leading-relaxed text-surface-100">{entry.translated_text}</p>
									{:else}
										<p class="text-xs italic text-surface-500">{m.sidebar_no_translation_text()}</p>
									{/if}
								{/if}
							</div>
							{/each}
						{/if}
					</div>
				{:else}
					<div class="px-4 py-8 text-center text-sm text-surface-500">
						<p class="mb-3">{m.sidebar_no_page_translation_yet()}</p>
						<button
							disabled={pageRunPending}
							class="rounded bg-primary-600/80 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
							onclick={handleTranslateFullPage}
						>
							{pageRunPending ? m.sidebar_translating() : m.sidebar_translate_full_page()}
						</button>
						<p class="mt-2 text-[10px] text-surface-600">
							<RichMessage message={m.sidebar_full_page_hint()} />
						</p>
					</div>
				{/if}
			</div>
		{/if}
	</aside>

	{#if revisionDialogOpen}
		<RevisionDialog
			scope={revisionScope}
			targetOrder={revisionTargetOrder}
			onsubmit={handleRevisionSubmit}
			onclose={() => (revisionDialogOpen = false)}
		/>
	{/if}
{/if}

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { readerBottomReservePx, safeAreaBottomPx } from '$lib/ui/chrome-geometry.js';
	import { get } from 'svelte/store';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { isOverlayMode, overlayFontScale, currentVolume, currentPageIndex } from '$lib/stores/reader-state.js';
	import { currentPageOverlay, currentPageTranslation } from '$lib/stores/translation-state.js';
	import { commitManualConstraints, deleteOverlayBox } from '$lib/reader/overlay-edits.js';
	import { pageTranslationActivities } from '$lib/translation/page-translation-activity.js';
	import { isOverlayEditMode, movingBoxId, resizingBoxId, selectedOverlayBoxId, resizeScaleFont, overlayConfirmHandler, overlayCancelHandler } from '$lib/stores/ui-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { generateOverlayForCurrentPage } from '$lib/translation/full-page-service.js';
	import { isPageBenchmarkOverlayRenderingForced } from '$lib/benchmark/page-benchmark-mode.js';
	import { OverlayBoxLongPressRecognizer } from '$lib/reader/overlay-box-long-press.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { isMobile } from '$lib/util/platform.js';
	import { scaledOverlayFontSize, type OverlayEditorTarget } from '$lib/reader/overlay-editor-draft.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { portal } from '$lib/utils/portal.js';
	import { recordError } from '$lib/diagnostics/error-ring.js';
	import { getTransform, onTransformChange } from '$lib/panzoom/index.js';
	import { degradedOverlayLayoutReviews, overlayLayoutReviewRect, regularOverlayLayoutReviews } from '$lib/reader/overlay-layout-review.js';
	import {
		beginReaderOverlayPlanning,
		clearReaderOverlayPlanning,
		inspectReaderOverlayPlanningStatus,
		publishReaderOverlayControllerSnapshot,
		publishReaderOverlayPlanning,
		type ReaderOverlayPlanningLease
	} from '$lib/reader/overlay-planning-status.js';
	import type { OverlayManualConstraintsV2, OverlayRenderPlanV2, PageOverlayDataV2, PlannedOverlayItemV2, Point, Rect } from '$lib/types/index.js';
	import { PageOverlayPlanController, fontFamilyForKey, overlayBackgroundShapes, overlayLayoutSettingsFromApp } from '$lib/overlay-layout/index.js';

	interface Props {
		imageWidth: number;
		imageHeight: number;
		onboxclick?: (target: OverlayEditorTarget) => void;
		onboxlongpress?: (target: OverlayEditorTarget) => void;
		onboxreview?: (target: OverlayEditorTarget) => void;
	}

	let { imageWidth, imageHeight, onboxclick, onboxlongpress, onboxreview }: Props = $props();
	const controller = new PageOverlayPlanController();
	let plan = $state<OverlayRenderPlanV2 | null>(null);
	let overlayError = $state<string | null>(null);
	let planningGeneration = 0;
	let observedScope = '';
	let planningStatusLease: ReaderOverlayPlanningLease | null = null;
	let activeGeneration: AbortController | null = null;
	let dragOffset = $state({ x: 0, y: 0 });
	let resizeDelta = $state({ x: 0, y: 0, width: 0, height: 0 });
	let viewScale = $state(1);
	let directSavingItemId = $state<string | null>(null);
	let lastDragHapticStep = 0;
	let pointerState: {
		pointerId: number;
		startX: number;
		startY: number;
		base: Rect;
		handle?: string;
		target: HTMLElement;
		direct?: boolean;
		kind?: 'move' | 'resize';
		moved?: boolean;
	} | null = null;
	let previousOverlayDiagnostics: unknown;
	let overlayDiagnosticsApi: { inspect: () => unknown } | null = null;
	let unsubscribeTransform: (() => void) | null = null;

	const longPress = new OverlayBoxLongPressRecognizer<string>({ onRecognized: emitLongPressTarget });
	const observePointerDown = (event: PointerEvent) => {
		longPress.pointerContactDown(event.pointerId);
		const selected = get(selectedOverlayBoxId);
		if (!selected || get(movingBoxId) || get(resizingBoxId)) return;
		const target = event.target instanceof Element ? event.target : null;
		const selectedBox = target?.closest('[data-overlay-box]')?.getAttribute('data-overlay-box');
		if (selectedBox === selected || target?.closest('[data-overlay-manipulation]')) return;
		clearDirectSelection(false);
	};
	const observePointerUp = (event: PointerEvent) => longPress.pointerContactUp(event.pointerId);
	const observePointerCancel = (event: PointerEvent) => longPress.pointerCancel(event.pointerId);

	function clearPlanningStatus(): void {
		if (!planningStatusLease) return;
		clearReaderOverlayPlanning(planningStatusLease);
		planningStatusLease = null;
	}

	onMount(() => {
		const diagnosticsWindow = window as unknown as Record<string, unknown>;
		const androidBridge = diagnosticsWindow.__fumeto_android as { isDebugBuild?: () => boolean } | undefined;
		if (androidBridge?.isDebugBuild?.() === true) {
			previousOverlayDiagnostics = diagnosticsWindow.__fumeto_overlay_diagnostics;
			overlayDiagnosticsApi = {
				inspect: () => plan == null ? null : {
					planId: plan.planId,
					algorithmVersion: plan.algorithmVersion,
					documentRevision: plan.documentRevision,
					sourceImage: { ...plan.sourceImage },
					diagnostics: {
						...plan.diagnostics,
						warnings: [...plan.diagnostics.warnings]
					},
					items: plan.items.map((item) => ({
						itemId: item.itemId,
						status: item.status,
						unplacedReason: item.unplacedReason ?? null,
						fitMode: item.fitMode ?? null,
						rect: item.rect ? { ...item.rect } : null,
						writingMode: item.writingMode ?? null,
						rotationDegrees: item.rotationDegrees ?? null,
						fontSize: item.font?.size ?? null,
						winningCandidateId: item.winningCandidateId ?? null,
						score: item.score ? { ...item.score } : null
					}))
				}
			};
			diagnosticsWindow.__fumeto_overlay_diagnostics = overlayDiagnosticsApi;
		}
		if (!isMobile) return;
		window.addEventListener('pointerdown', observePointerDown);
		window.addEventListener('pointerup', observePointerUp);
		window.addEventListener('pointercancel', observePointerCancel);
		requestAnimationFrame(() => {
			const updateScale = () => { viewScale = Math.max(.05, getTransform().scale || 1); };
			updateScale();
			unsubscribeTransform = onTransformChange(updateScale);
		});
	});

	onDestroy(() => {
		const diagnosticsWindow = window as unknown as Record<string, unknown>;
		if (diagnosticsWindow.__fumeto_overlay_diagnostics === overlayDiagnosticsApi) {
			if (previousOverlayDiagnostics === undefined) delete diagnosticsWindow.__fumeto_overlay_diagnostics;
			else diagnosticsWindow.__fumeto_overlay_diagnostics = previousOverlayDiagnostics;
		}
		overlayDiagnosticsApi = null;
		window.removeEventListener('pointerdown', observePointerDown);
		window.removeEventListener('pointerup', observePointerUp);
		window.removeEventListener('pointercancel', observePointerCancel);
		// Release the disclosure slot if this overlay unmounts mid-reveal, so a
		// stale 'overlay-reveal' can't swallow the next reader tap.
		if (isMobile && revealOpenItemId !== null && mobileReaderUi.inspect().disclosure === 'overlay-reveal') {
			mobileReaderUi.closeDisclosure();
		}
		unsubscribeTransform?.();
		unsubscribeTransform = null;
		detachPointerListeners();
		longPress.dispose();
		activeGeneration?.abort();
		activeGeneration = null;
		planningGeneration += 1;
		clearPlanningStatus();
		if (observedScope) controller.invalidate(observedScope);
	});

	let visible = $derived(($settings.overlayEnabled || isPageBenchmarkOverlayRenderingForced()) && $isOverlayMode);
	let regularUnplacedReviews = $derived(regularOverlayLayoutReviews(plan, $currentPageOverlay));
	let degradedReviews = $derived(degradedOverlayLayoutReviews(plan, $currentPageOverlay));
	let degradedReviewByItem = $derived(new Map(degradedReviews.map((review) => [review.itemId, review])));
	/** Reveal placements paint no inline text; a tap shows this popover. */
	let revealOpenItemId = $state<string | null>(null);

	// Which item is revealed stays local; the disclosure coordinator only
	// tracks THAT a reveal popover is open, so competing reader popovers
	// (⋮ menu, translate options, filmstrip) dismiss it and vice versa.
	// Desktop keeps today's purely-local behavior. The same popover doubles
	// as the per-box "Show original" surface (showOriginal = true).
	let revealShowsOriginal = $state(false);

	function setRevealOpen(itemId: string | null, showOriginal = false): void {
		revealShowsOriginal = itemId != null && showOriginal;
		revealOpenItemId = itemId;
		if (!isMobile) return;
		if (itemId != null) mobileReaderUi.openDisclosure('overlay-reveal');
		else if (mobileReaderUi.inspect().disclosure === 'overlay-reveal') mobileReaderUi.closeDisclosure();
	}

	$effect(() => {
		if (!isMobile) return;
		if ($mobileReaderUi.disclosure !== 'overlay-reveal' && revealOpenItemId !== null) {
			revealOpenItemId = null;
			revealShowsOriginal = false;
		}
	});

	// ── Per-box action stack (mobile, shown with the selection handles) ──
	let deletingActionItemId = $state<string | null>(null);

	function originalTextFor(itemId: string): string {
		const item = $currentPageOverlay?.items.find((candidate) => candidate.id === itemId);
		if (!item) return '';
		return $currentPageTranslation?.entries.find((entry) => entry.id === item.translationEntryId)?.original_text ?? '';
	}

	function editSelectedItem(itemId: string): void {
		const target = editorTarget(itemId);
		if (!target) return;
		playReaderHaptic('control');
		clearDirectSelection(false);
		onboxreview?.(target);
	}

	async function deleteSelectedItem(itemId: string): Promise<void> {
		const volumeUuid = $currentVolume?.volume_uuid;
		const pageIndex = $currentPageIndex;
		if (!volumeUuid || deletingActionItemId !== null) return;
		playReaderHaptic('control');
		deletingActionItemId = itemId;
		try {
			// A flag on the item, with Undo in the snackbar — not a removal.
			await deleteOverlayBox({ volumeUuid, pageIndex }, itemId);
			clearDirectSelection(false);
		} catch (error) {
			overlayError = error instanceof Error ? error.message : m.reader_unable_to_delete_the();
		} finally {
			deletingActionItemId = null;
		}
	}

	function showOriginalForItem(itemId: string): void {
		playReaderHaptic('control');
		setRevealOpen(itemId, true);
	}

	/**
	 * Whether the action stack fits BELOW the move handle on screen. Image-
	 * space math alone is not enough: a box low in the viewport would put the
	 * stack under the fixed bottom bar, which swallows real taps.
	 */
	function actionStackFitsBelow(moveY: number, controlSize: number, controlGap: number): boolean {
		const stackBottomImageY = moveY + (controlSize + controlGap) * 3 + controlSize;
		if (stackBottomImageY > imageHeight) return false;
		if (typeof document === 'undefined') return true;
		const container = document.querySelector('[data-overlay-container]');
		if (!container) return true;
		const containerTop = container.getBoundingClientRect().top;
		// Keep the whole stack above the reader's bottom chrome — including
		// the safe-area inset the floating pill now rides on (+ 40px slack).
		return containerTop + stackBottomImageY * viewScale <= window.innerHeight - (readerBottomReservePx() + safeAreaBottomPx() + 40);
	}
	let currentPageTranslationBusy = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		return Boolean(volumeUuid && $pageTranslationActivities.some((activity) =>
			activity.target.volumeUuid === volumeUuid && activity.target.pageIndex === $currentPageIndex
		));
	});
	let showGeneratePrompt = $derived(
		visible
		&& $currentPageTranslation
		&& !$currentPageTranslation.no_text_detected
		&& (!$currentPageOverlay || $currentPageOverlay.items.length === 0)
		&& !currentPageTranslationBusy
	);

	function textFor(itemId: string): string {
		const item = $currentPageOverlay?.items.find((candidate) => candidate.id === itemId);
		if (!item) return '';
		return item.manual.textOverride
			?? $currentPageTranslation?.entries.find((entry) => entry.id === item.translationEntryId)?.translated_text
			?? '';
	}

	/**
	 * An item under direct manipulation keeps painting its own whitewash, so a
	 * drag still carries the balloon with the finger and the selection glow
	 * still has a filled surface to cast from. Everything else is painted once
	 * by the page-level layer below, which is what closes the strips of
	 * untranslated source left between stacked bands.
	 */
	function paintsOwnBackground(itemId: string): boolean {
		return $movingBoxId === itemId || $resizingBoxId === itemId || $selectedOverlayBoxId === itemId;
	}

	function polygonPoints(polygon: Point[]): string {
		return polygon.map((point) => `${point.x},${point.y}`).join(' ');
	}

	function rotationTransform(rect: Rect, degrees: number): string | undefined {
		if (!degrees) return undefined;
		return `rotate(${degrees} ${rect.x + rect.width / 2} ${rect.y + rect.height / 2})`;
	}

	function polygonClip(item: PlannedOverlayItemV2): string {
		if (!item.rect || !item.clipPolygon?.length) return '';
		const points = item.clipPolygon.map((point) => {
			const x = (point.x - item.rect!.x) / item.rect!.width * 100;
			const y = (point.y - item.rect!.y) / item.rect!.height * 100;
			return `${x}% ${y}%`;
		});
		return `polygon(${points.join(',')})`;
	}

	async function requestPlan(document: PageOverlayDataV2, persist: boolean, signal?: AbortSignal): Promise<OverlayRenderPlanV2> {
		const translation = get(currentPageTranslation);
		const volume = get(currentVolume);
		if (!translation || !volume) throw new Error('Overlay translation target is unavailable');
		const pageIndex = get(currentPageIndex);
		const scopeId = `reader:${volume.volume_uuid}:${pageIndex}`;
		if (scopeId !== observedScope) {
			clearPlanningStatus();
			if (observedScope) controller.invalidate(observedScope);
			observedScope = scopeId;
		}
		const lease = beginReaderOverlayPlanning({ volumeUuid: volume.volume_uuid, pageIndex });
		planningStatusLease = lease;
		try {
			return await controller.request({
				scopeId,
				document: structuredClone(document),
				translations: translation.entries,
				settings: overlayLayoutSettingsFromApp(get(settings), get(overlayFontScale))
			}, {
				volumeUuid: volume.volume_uuid,
				pageIndex,
				persist,
				signal,
				onStatus: (snapshot) => publishReaderOverlayControllerSnapshot(lease, snapshot)
			});
		} catch (error) {
			if (planningStatusLease === lease) {
				if (error instanceof Error && error.name === 'AbortError') {
					clearPlanningStatus();
				} else {
					// The controller normally publishes a keyed failure itself. Cover
					// errors raised before that boundary (for example input hashing)
					// without replacing its more useful keyed diagnostics.
					if (inspectReaderOverlayPlanningStatus().phase !== 'failed') {
						publishReaderOverlayPlanning(lease, {
							phase: 'failed',
							error: error instanceof Error ? error.message : String(error)
						});
					}
				}
			}
			throw error;
		}
	}

	$effect(() => {
		const abort = new AbortController();
		const document = $currentPageOverlay;
		const translation = $currentPageTranslation;
		const enabled = visible;
		const settingsSnapshot = overlayLayoutSettingsFromApp($settings, $overlayFontScale);
		const volumeUuid = $currentVolume?.volume_uuid;
		const pageIndex = $currentPageIndex;
		const generation = ++planningGeneration;
		if (!document || !translation || !enabled || !volumeUuid) {
			plan = null;
			clearPlanningStatus();
			return () => abort.abort();
		}
		// Make every planning input a tracked dependency before entering async work.
		JSON.stringify([document, translation.entries, settingsSnapshot, volumeUuid, pageIndex]);
		void requestPlan(document, false, abort.signal).then((next) => {
			if (generation === planningGeneration) {
				plan = next;
				overlayError = null;
			}
		}).catch((error) => {
			if (generation === planningGeneration && !(error instanceof Error && error.name === 'AbortError')) {
				plan = null;
				overlayError = error instanceof Error ? error.message : String(error);
				// The planner's rejection is handled here, so neither global
				// handler ever sees it: without this the diagnostics report
				// carried only the one-line message the banner shows ("Cannot
				// read properties of undefined (reading 'map')") and no stack.
				recordError('error', error, 'overlay-planning');
				console.error('Overlay planning failed', error);
			}
		});
		return () => abort.abort();
	});

	$effect(() => {
		// TranslationOverlay stays mounted while the reader changes pages. A pending
		// gesture or generation must never resolve against a later page that happens
		// to reuse an item ID.
		JSON.stringify([$currentVolume?.volume_uuid ?? null, $currentPageIndex]);
		longPress.navigationChanged();
		activeGeneration?.abort();
		activeGeneration = null;
		if (get(movingBoxId) || get(resizingBoxId) || get(selectedOverlayBoxId)) cancelGeometry();
		// A reveal left open on the previous page must release the disclosure
		// slot NOW: with no popover rendering, a lingering 'overlay-reveal'
		// silently absorbs the next reader tap. Untracked read — this effect
		// keys on navigation only; tracking revealOpenItemId here would re-run
		// it on every reveal open and close the popover it just opened.
		if (untrack(() => revealOpenItemId) !== null) setRevealOpen(null);
	});

	$effect(() => {
		// The reveal popover only renders while overlays are visible and its
		// item is still placed in the current plan. If a re-plan (translation
		// re-run, item deletion) drops the item, or the overlay layer is
		// toggled off, close the reveal instead of leaving the disclosure slot
		// claimed by an invisible popover — a lingering 'overlay-reveal'
		// silently absorbs the next reader tap.
		if (
			revealOpenItemId !== null
			&& (!visible || !plan?.items.some((item) => item.itemId === revealOpenItemId && item.status === 'placed' && item.rect))
		) {
			setRevealOpen(null);
		}
	});

	async function handleGenerateOverlay(): Promise<void> {
		activeGeneration?.abort();
		const abort = new AbortController();
		activeGeneration = abort;
		overlayError = null;
		try {
			await generateOverlayForCurrentPage({ signal: abort.signal });
		} catch (error) {
			if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
			overlayError = error instanceof Error ? error.message : m.reader_failed_to_generate_overlay();
		} finally {
			if (activeGeneration === abort) activeGeneration = null;
		}
	}

	function planned(itemId: string): PlannedOverlayItemV2 | undefined {
		return plan?.items.find((item) => item.itemId === itemId && item.status === 'placed');
	}

	function imageDelta(event: PointerEvent): { x: number; y: number } {
		const container = document.querySelector('[data-overlay-container]') as HTMLElement | null;
		const bounds = container?.getBoundingClientRect();
		if (!bounds) return { x: 0, y: 0 };
		return {
			x: (event.clientX - pointerState!.startX) * imageWidth / bounds.width,
			y: (event.clientY - pointerState!.startY) * imageHeight / bounds.height
		};
	}

	function constrainedMoveDelta(base: Rect, delta: { x: number; y: number }): { x: number; y: number } {
		return {
			x: Math.max(-base.x, Math.min(imageWidth - base.x - base.width, delta.x)),
			y: Math.max(-base.y, Math.min(imageHeight - base.y - base.height, delta.y))
		};
	}

	function constrainedResizeDelta(base: Rect, handle: string, delta: { x: number; y: number }) {
		const minimumWidth = Math.min(24, base.width);
		const minimumHeight = Math.min(18, base.height);
		let left = base.x;
		let top = base.y;
		let right = base.x + base.width;
		let bottom = base.y + base.height;
		if (handle.includes('left')) left = Math.max(0, Math.min(right - minimumWidth, base.x + delta.x));
		if (handle.includes('right')) right = Math.min(imageWidth, Math.max(left + minimumWidth, base.x + base.width + delta.x));
		if (handle.includes('top')) top = Math.max(0, Math.min(bottom - minimumHeight, base.y + delta.y));
		if (handle.includes('bottom')) bottom = Math.min(imageHeight, Math.max(top + minimumHeight, base.y + base.height + delta.y));
		return { x: left - base.x, y: top - base.y, width: right - left - base.width, height: bottom - top - base.height };
	}

	function beginPointer(
		event: PointerEvent,
		itemId: string,
		handle?: string,
		direct = false,
		kind?: 'move' | 'resize'
	): void {
		const item = planned(itemId);
		if (!item?.rect || directSavingItemId) return;
		const moving = $movingBoxId === itemId;
		const resizing = $resizingBoxId === itemId;
		if (!moving && !resizing) {
			if (isMobile) longPress.pointerDown({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, boxId: itemId });
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget as HTMLElement;
		// Pointer capture is unavailable for synthetic/accessibility-dispatched
		// events and can be rejected by a few WebView builds. Document listeners
		// still preserve the drag, so capture is an enhancement rather than a gate.
		try { target.setPointerCapture(event.pointerId); } catch { /* best effort */ }
		pointerState = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			base: item.rect,
			handle,
			target,
			direct,
			kind,
			moved: false
		};
		lastDragHapticStep = 0;
		if (direct) playReaderHaptic('drag-start');
		attachPointerListeners();
	}

	function beginDirectMove(event: PointerEvent, itemId: string): void {
		if ($selectedOverlayBoxId !== itemId || directSavingItemId !== null) return;
		movingBoxId.set(itemId);
		beginPointer(event, itemId, undefined, true, 'move');
	}

	function beginDirectResize(event: PointerEvent, itemId: string, handle: string): void {
		if ($selectedOverlayBoxId !== itemId || directSavingItemId !== null) return;
		resizingBoxId.set(itemId);
		beginPointer(event, itemId, handle, true, 'resize');
	}

	function pointerMove(event: PointerEvent): void {
		if (!pointerState || event.pointerId !== pointerState.pointerId) return;
		const delta = imageDelta(event);
		if ($movingBoxId) dragOffset = constrainedMoveDelta(pointerState.base, delta);
		else if ($resizingBoxId) {
			const handle = pointerState.handle ?? 'bottom-right';
			resizeDelta = constrainedResizeDelta(pointerState.base, handle, delta);
		}
		const screenDistance = Math.hypot(delta.x, delta.y) * viewScale;
		pointerState.moved ||= screenDistance >= 2;
		const hapticStep = Math.floor(screenDistance / 36);
		if (pointerState.direct && hapticStep > lastDragHapticStep) {
			lastDragHapticStep = hapticStep;
			playReaderHaptic('drag-step');
		}
	}

	function pointerEnd(event: PointerEvent): void {
		if (!pointerState || event.pointerId !== pointerState.pointerId) return;
		const completed = pointerState;
		if (completed.target.hasPointerCapture(event.pointerId)) completed.target.releasePointerCapture(event.pointerId);
		pointerState = null;
		detachPointerListeners();
		if (!completed.direct) return;
		const itemId = completed.kind === 'move' ? get(movingBoxId) : get(resizingBoxId);
		const nextRect = completed.kind === 'move'
			? { ...completed.base, x: completed.base.x + dragOffset.x, y: completed.base.y + dragOffset.y }
			: {
				x: completed.base.x + resizeDelta.x,
				y: completed.base.y + resizeDelta.y,
				width: Math.max(24, completed.base.width + resizeDelta.width),
				height: Math.max(18, completed.base.height + resizeDelta.height)
			};
		dragOffset = { x: 0, y: 0 };
		resizeDelta = { x: 0, y: 0, width: 0, height: 0 };
		movingBoxId.set(null);
		resizingBoxId.set(null);
		if (!itemId || !completed.moved) return;
		directSavingItemId = itemId;
		void commitGeometry(itemId, nextRect).then((saved) => {
			playReaderHaptic(saved ? 'commit' : 'error');
		}).catch(() => playReaderHaptic('error')).finally(() => {
			if (directSavingItemId === itemId) directSavingItemId = null;
		});
	}

	function pointerCancel(event: PointerEvent): void {
		if (!pointerState || event.pointerId !== pointerState.pointerId) return;
		if (pointerState.target.hasPointerCapture(event.pointerId)) pointerState.target.releasePointerCapture(event.pointerId);
		const direct = pointerState.direct;
		pointerState = null;
		detachPointerListeners();
		dragOffset = { x: 0, y: 0 };
		resizeDelta = { x: 0, y: 0, width: 0, height: 0 };
		movingBoxId.set(null);
		resizingBoxId.set(null);
		if (direct) playReaderHaptic('cancel');
	}

	function attachPointerListeners(): void {
		document.addEventListener('pointermove', pointerMove);
		document.addEventListener('pointerup', pointerEnd);
		document.addEventListener('pointercancel', pointerCancel);
	}

	function detachPointerListeners(): void {
		document.removeEventListener('pointermove', pointerMove);
		document.removeEventListener('pointerup', pointerEnd);
		document.removeEventListener('pointercancel', pointerCancel);
	}

	async function commitGeometry(itemId: string, rect: Rect, scaleFont = false): Promise<boolean> {
		const volume = get(currentVolume);
		const document = get(currentPageOverlay);
		if (!volume || !document) return false;
		const volumeUuid = volume.volume_uuid;
		const pageIndex = get(currentPageIndex);
		const next = structuredClone(document);
		const item = next.items.find((candidate) => candidate.id === itemId);
		if (!item) return false;
		const manual: OverlayManualConstraintsV2 = { ...item.manual, rect, pinGeometry: true };
		const displayed = planned(itemId);
		if (scaleFont && displayed?.rect && displayed.font) {
			manual.referenceFontSize = scaledOverlayFontSize({
				fontSize: displayed.font.size,
				before: displayed.rect,
				after: rect,
				writingMode: displayed.writingMode ?? 'horizontal-tb'
			});
			manual.pinTypography = true;
		}
		item.manual = manual;
		const preview = await requestPlan(next, false);
		if (get(currentVolume)?.volume_uuid !== volumeUuid || get(currentPageIndex) !== pageIndex) return false;
		const outcome = preview.items.find((candidate) => candidate.itemId === itemId);
		if (!outcome || outcome.status !== 'placed') {
			const reason = outcome?.unplacedReason ? ` (${outcome.unplacedReason})` : '';
			overlayError = m.reader_the_pinned_geometry_cannot({ reason });
			return false;
		}
		const displayedRect = planned(itemId)?.rect;
		const resized = !displayedRect
			|| Math.abs(displayedRect.width - rect.width) > 1 / 64
			|| Math.abs(displayedRect.height - rect.height) > 1 / 64;
		await commitManualConstraints({ volumeUuid, pageIndex }, itemId, manual, resized ? 'reader_edit_box_resized' : 'reader_edit_box_moved');
		overlayError = null;
		return true;
	}

	async function confirmMove(): Promise<void> {
		const itemId = get(movingBoxId);
		const item = itemId ? planned(itemId) : undefined;
		if (itemId && item?.rect) await commitGeometry(itemId, { ...item.rect, x: item.rect.x + dragOffset.x, y: item.rect.y + dragOffset.y });
		dragOffset = { x: 0, y: 0 };
		movingBoxId.set(null);
	}

	async function confirmResize(): Promise<void> {
		const itemId = get(resizingBoxId);
		const item = itemId ? planned(itemId) : undefined;
		if (itemId && item?.rect) await commitGeometry(itemId, {
			x: item.rect.x + resizeDelta.x,
			y: item.rect.y + resizeDelta.y,
			width: Math.max(24, item.rect.width + resizeDelta.width),
			height: Math.max(18, item.rect.height + resizeDelta.height)
		}, get(resizeScaleFont));
		resizeDelta = { x: 0, y: 0, width: 0, height: 0 };
		resizeScaleFont.set(false);
		resizingBoxId.set(null);
	}

	function cancelGeometry(): void {
		if (pointerState?.target.hasPointerCapture(pointerState.pointerId)) {
			pointerState.target.releasePointerCapture(pointerState.pointerId);
		}
		pointerState = null;
		detachPointerListeners();
		dragOffset = { x: 0, y: 0 };
		resizeDelta = { x: 0, y: 0, width: 0, height: 0 };
		movingBoxId.set(null);
		resizingBoxId.set(null);
		selectedOverlayBoxId.set(null);
		resizeScaleFont.set(false);
	}

	function clearDirectSelection(feedback = true): void {
		if (!get(selectedOverlayBoxId)) return;
		cancelGeometry();
		if (feedback) playReaderHaptic('cancel');
	}

	$effect(() => {
		if ($selectedOverlayBoxId) {
			overlayConfirmHandler.set(null);
			overlayCancelHandler.set(clearDirectSelection);
		} else if ($movingBoxId) {
			overlayConfirmHandler.set(() => { void confirmMove(); });
			overlayCancelHandler.set(cancelGeometry);
		} else if ($resizingBoxId) {
			overlayConfirmHandler.set(() => { void confirmResize(); });
			overlayCancelHandler.set(cancelGeometry);
		} else {
			overlayConfirmHandler.set(null);
			overlayCancelHandler.set(null);
		}
	});

	function effectiveRect(item: PlannedOverlayItemV2): Rect {
		const rect = item.rect!;
		if ($movingBoxId === item.itemId) return { ...rect, x: rect.x + dragOffset.x, y: rect.y + dragOffset.y };
		if ($resizingBoxId === item.itemId) return {
			x: rect.x + resizeDelta.x,
			y: rect.y + resizeDelta.y,
			width: Math.max(24, rect.width + resizeDelta.width),
			height: Math.max(18, rect.height + resizeDelta.height)
		};
		return rect;
	}

	function editorTarget(itemId: string): OverlayEditorTarget | null {
		if (!plan || !$currentPageOverlay) return null;
		const item = plan.items.find((candidate) => candidate.itemId === itemId);
		const rect = item?.rect ?? overlayLayoutReviewRect($currentPageOverlay, itemId);
		if (!item || !rect) return null;
		return { itemId, rect: { ...rect }, planId: plan.planId };
	}

	function reviewUnplaced(itemId: string): void {
		const target = editorTarget(itemId);
		if (!target) return;
		if (isMobile) onboxreview?.(target);
		else onboxclick?.(target);
	}

	function emitLongPressTarget(itemId: string): void {
		const target = editorTarget(itemId);
		if (target) onboxlongpress?.(target);
	}

	function handleClick(itemId: string): void {
		if (longPress.consumeSyntheticClick()) return;
		// Reveal placements: outside edit mode, a tap shows the translation
		// popover instead of (and with precedence over) editor entry.
		if (!$isOverlayEditMode && degradedReviewByItem.get(itemId)?.fitMode === 'reveal') {
			setRevealOpen(revealOpenItemId === itemId ? null : itemId);
			return;
		}
		const target = editorTarget(itemId);
		if ($isOverlayEditMode && target) onboxclick?.(target);
	}

	const resizeHandles = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left'];
</script>

{#if visible && plan}
	{#if regularUnplacedReviews.length > 0 || degradedReviews.length > 0}
		<!-- The old page banner is replaced by per-bubble affordances; screen
		     readers still get a page-level summary. -->
		<!-- "text block", not "dialogue": these reviews now include unenclosed
		     narration, which the detector classifies as `borderless` and the
		     adapter types `'unknown'`. Calling those dialogue would misdescribe
		     the very items this list exists to surface. -->
		<p role="status" class="sr-only" data-overlay-review-summary>
			{regularUnplacedReviews.length > 0
				? m.reader_unplaced_blocks_count({ n: regularUnplacedReviews.length })
				: ''}{degradedReviews.length > 0
				? m.reader_degradedreviews_translated_text_block({ degradedReviews: degradedReviews.length, were: degradedReviews.length === 1 ? ' was' : 's were' })
				: ''}
		</p>
	{/if}
	{#each regularUnplacedReviews as review (review.itemId)}
		{@const anchor = $currentPageOverlay ? overlayLayoutReviewRect($currentPageOverlay, review.itemId) : null}
		{#if anchor}
			<div
				aria-hidden="true"
				data-overlay-unplaced-outline={review.itemId}
				class="absolute rounded border-2 border-dashed border-amber-400/90"
				style="left:{anchor.x}px; top:{anchor.y}px; width:{anchor.width}px; height:{anchor.height}px; pointer-events:none; z-index:18;"
			></div>
			<button
				type="button"
				data-overlay-review-badge={review.itemId}
				data-overlay-review-kind="unplaced"
				data-overlay-review-uncertain={review.uncertainType ? 'true' : undefined}
				aria-label={review.detail}
				class="pointer-events-auto absolute z-20 flex items-center justify-center rounded-full font-bold shadow {review.uncertainType ? 'bg-sky-500 text-sky-950' : 'bg-amber-500 text-amber-950'}"
				style="left:{anchor.x + anchor.width - 22 / viewScale}px; top:{anchor.y - 22 / viewScale}px; width:{44 / viewScale}px; height:{44 / viewScale}px; font-size:{22 / viewScale}px;"
				onclick={() => reviewUnplaced(review.itemId)}
			>{review.uncertainType ? '?' : '!'}</button>
		{/if}
	{/each}
	<div data-overlay-container data-render-plan-id={plan.planId} data-overlay-error={overlayError ?? undefined} class="absolute inset-0" style="z-index: {$isOverlayEditMode || $selectedOverlayBoxId || $movingBoxId || $resizingBoxId ? 15 : 5}; pointer-events:none; width:{imageWidth}px; height:{imageHeight}px;">
		<!--
			The page's whitewash pass. Painting each item's background on its own
			box left the gaps between stacked bands unpainted, so strips of the
			original Japanese showed through between the translated lines. Here
			every background is one shape in page space, drawn beneath all text.
		-->
		<svg
			data-overlay-background-layer
			aria-hidden="true"
			class="absolute left-0 top-0"
			width={imageWidth}
			height={imageHeight}
			viewBox={`0 0 ${imageWidth} ${imageHeight}`}
			style="z-index:0; pointer-events:none;"
		>
			{#each overlayBackgroundShapes(plan) as shape (shape.itemId)}
				{#if !paintsOwnBackground(shape.itemId)}
					<g transform={rotationTransform(shape.rect, shape.rotationDegrees)}>
						{#if shape.layers?.length}
							<!-- Soft-edged unbounded whitewash: concentric fills with explicit
							     alphas. `fill-opacity` composites source-over exactly as the Canvas
							     exporter's globalAlpha does, which a blur filter would not — all
							     three surfaces paint the same plan. -->
							{#each shape.layers as layer, layerIndex (layerIndex)}
								{#if layer.rect.width > 0 && layer.rect.height > 0}
									<rect
										x={layer.rect.x}
										y={layer.rect.y}
										width={layer.rect.width}
										height={layer.rect.height}
										rx={layer.radius || undefined}
										fill={shape.fill}
										fill-opacity={layer.alpha}
									/>
								{/if}
							{/each}
						{:else if shape.polygon?.length}
							<polygon points={polygonPoints(shape.polygon)} fill={shape.fill} />
						{:else}
							<rect x={shape.rect.x} y={shape.rect.y} width={shape.rect.width} height={shape.rect.height} fill={shape.fill} />
						{/if}
					</g>
				{/if}
			{/each}
		</svg>
		{#each plan.items.filter((item) => item.status === 'placed' && item.rect && (item.fitMode === 'reveal' || (item.font && item.lines))) as item (item.itemId)}
			{@const rect = effectiveRect(item)}
			{@const clip = polygonClip(item)}
			{@const moving = $movingBoxId === item.itemId}
			{@const resizing = $resizingBoxId === item.itemId}
			{@const selected = $selectedOverlayBoxId === item.itemId}
			{@const controlSize = 48 / viewScale}
			{@const controlGap = 10 / viewScale}
			{@const markerSize = 13 / viewScale}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				data-overlay-box={item.itemId}
				data-overlay-plan-id={plan.planId}
				data-overlay-writing-mode={item.writingMode}
				data-overlay-rotation-degrees={item.rotationDegrees ?? 0}
				data-overlay-fit-mode={item.fitMode ?? 'standard'}
				data-overlay-direct-selected={selected ? 'true' : undefined}
				data-overlay-transform-saving={selected ? (directSavingItemId === item.itemId ? 'true' : 'false') : undefined}
				role="img"
				aria-label={textFor(item.itemId)}
				class="absolute {selected ? 'overlay-selected-surface' : ''}"
				style="left:{rect.x}px; top:{rect.y}px; width:{rect.width}px; height:{rect.height}px; background:{paintsOwnBackground(item.itemId) ? (item.background?.fill ?? 'transparent') : 'transparent'}; clip-path:{clip || 'none'}; transform:{item.rotationDegrees ? `rotate(${item.rotationDegrees}deg)` : 'none'}; transform-origin:center; z-index:{item.fitMode === 'reveal' ? 1 : 2}; pointer-events:{item.fitMode === 'reveal' || (isMobile && !currentPageTranslationBusy) || $isOverlayEditMode || moving || resizing ? 'auto' : 'none'}; touch-action:{moving || resizing ? 'none' : 'auto'}; overflow:hidden;"
				onclick={() => handleClick(item.itemId)}
				onpointerdown={(event) => beginPointer(event, item.itemId)}
				onpointermove={(event) => isMobile && !moving && !resizing && longPress.pointerMove(event.pointerId, event.clientX, event.clientY)}
				onpointerup={(event) => isMobile && !moving && !resizing && longPress.pointerUp(event.pointerId)}
				onpointercancel={(event) => isMobile && !moving && !resizing && longPress.pointerCancel(event.pointerId)}
			>
				{#if item.fitMode === 'reveal'}
					<!-- Whitewashed balloon with an accent tint; text lives in the
					     tap popover. The tint inherits the parent clip-path. -->
					<div
						aria-hidden="true"
						data-overlay-reveal-highlight={item.itemId}
						class="absolute inset-0"
						style="background:rgba(45, 212, 191, 0.28); border:{2 / viewScale}px solid rgba(20, 184, 166, 0.85);"
					></div>
				{/if}
				<svg aria-hidden="true" width={rect.width} height={rect.height} viewBox={`0 0 ${rect.width} ${rect.height}`} style="position:absolute;inset:0;overflow:visible;white-space:pre;word-break:normal;overflow-wrap:normal;">
					{#each item.lines ?? [] as line, lineIndex (`${line.sourceRange.startUtf16}:${lineIndex}`)}
						{#each line.runs as run, runIndex (`${run.sourceRange.startUtf16}:${runIndex}`)}
							<!-- Canonical origins are physical left edges for LTR and physical
							     right edges for RTL. SVG's logical `start` anchor has exactly
							     those semantics once `direction` is applied. -->
							<text
								data-overlay-line={lineIndex}
								data-overlay-run={runIndex}
								data-overlay-origin-x={run.origin.x}
								data-overlay-origin-y={run.origin.y}
								x={run.origin.x - item.rect!.x}
								y={run.origin.y - item.rect!.y}
								text-anchor="start"
								direction={run.direction}
								unicode-bidi="plaintext"
								font-family={fontFamilyForKey(run.fontKey)}
								font-weight={item.font!.weight}
								font-size={item.font!.size}
								fill="#111"
								transform={run.rotationDegrees ? `rotate(${run.rotationDegrees} ${run.origin.x - item.rect!.x} ${run.origin.y - item.rect!.y})` : undefined}
							>{run.text}</text>
						{/each}
					{/each}
				</svg>
			</div>
			<!-- Degraded (placed-but-compressed) items intentionally carry no
			     badge: the text is readable and the editor stays reachable via
			     long-press, so a floating marker is pure noise (user decision
			     2026-07-22). Only unplaced/reveal items keep affordances. -->
			{#if selected || resizing}
				<div
					aria-hidden="true"
					data-overlay-resize-outline={item.itemId}
					data-overlay-manipulation
					class="overlay-resize-outline absolute rounded-sm border-teal-300"
					class:overlay-transform-active={moving || resizing}
					style="left:{rect.x}px; top:{rect.y}px; width:{rect.width}px; height:{rect.height}px; border-width:{2 / viewScale}px; box-shadow:0 0 {10 / viewScale}px rgba(45,212,191,.7); pointer-events:none;"
				></div>
				{#each resizeHandles as handle}
					{@const x = handle.includes('left') ? rect.x - controlSize / 2 : handle.includes('right') ? rect.x + rect.width - controlSize / 2 : rect.x + rect.width / 2 - controlSize / 2}
					{@const y = handle.includes('top') ? rect.y - controlSize / 2 : handle.includes('bottom') ? rect.y + rect.height - controlSize / 2 : rect.y + rect.height / 2 - controlSize / 2}
					<button
						type="button"
						aria-label={m.reader_resize_translated_text_from({ replace: handle.replace('-', ' ') })}
						aria-busy={directSavingItemId === item.itemId}
						data-overlay-resize-handle={handle}
						data-overlay-manipulation
						class="overlay-transform-handle absolute flex items-center justify-center rounded-full"
						disabled={directSavingItemId !== null}
						style="left:{x}px; top:{y}px; width:{controlSize}px; height:{controlSize}px; pointer-events:auto; touch-action:none;"
						onpointerdown={(event) => selected ? beginDirectResize(event, item.itemId, handle) : beginPointer(event, item.itemId, handle)}
					>
						<span class="rounded-sm border-2 border-white bg-teal-500 shadow" style="width:{markerSize}px; height:{markerSize}px; border-width:{2 / viewScale}px;"></span>
					</button>
				{/each}
				{#if selected}
					{@const placeRight = rect.x + rect.width + controlGap + controlSize <= imageWidth}
					{@const moveX = placeRight ? rect.x + rect.width + controlGap : Math.max(0, rect.x - controlGap - controlSize)}
					{@const moveY = Math.max(0, Math.min(imageHeight - controlSize, rect.y + rect.height / 2 - controlSize / 2))}
					<button
						type="button"
						aria-label={m.reader_move_translated_text()}
						aria-busy={directSavingItemId === item.itemId}
						data-overlay-move-handle={item.itemId}
						data-overlay-manipulation
						class="overlay-move-handle absolute flex items-center justify-center rounded-full border border-teal-200 bg-teal-600 text-white shadow-xl"
						class:overlay-transform-active={moving}
						disabled={directSavingItemId !== null}
						style="left:{moveX}px; top:{moveY}px; width:{controlSize}px; height:{controlSize}px; border-width:{1 / viewScale}px; pointer-events:auto; touch-action:none;"
						onpointerdown={(event) => beginDirectMove(event, item.itemId)}
					>
						{#if directSavingItemId === item.itemId}
							<span class="animate-spin rounded-full border-2 border-white border-t-transparent motion-reduce:animate-none" style="width:{20 / viewScale}px; height:{20 / viewScale}px; border-width:{2 / viewScale}px;"></span>
						{:else}
							<svg aria-hidden="true" style="width:{23 / viewScale}px; height:{23 / viewScale}px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/><path d="m8 6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"/></svg>
						{/if}
					</button>
					{#if isMobile}
						<!-- Per-box actions stacked with the move handle; the stack
						     flips above it when it would run off the page bottom or
						     under the fixed bottom bar. -->
						{@const stackBelow = actionStackFitsBelow(moveY, controlSize, controlGap)}
						{#each [
							{ id: 'edit', label: m.reader_edit_translated_text() },
							{ id: 'delete', label: m.reader_delete_translated_text() },
							{ id: 'original', label: m.reader_show_original_text() }
						] as boxAction, actionIndex (boxAction.id)}
							{@const actionY = stackBelow
								? moveY + (controlSize + controlGap) * (actionIndex + 1)
								: moveY - (controlSize + controlGap) * (actionIndex + 1)}
							<button
								type="button"
								aria-label={boxAction.label}
								aria-busy={boxAction.id === 'delete' && deletingActionItemId === item.itemId}
								data-overlay-box-actions={item.itemId}
								data-overlay-box-action={boxAction.id}
								data-overlay-manipulation
								class="overlay-box-action absolute flex items-center justify-center rounded-full border border-surface-500 bg-surface-800 text-surface-100 shadow-xl"
								disabled={directSavingItemId !== null || deletingActionItemId !== null}
								style="left:{moveX}px; top:{actionY}px; width:{controlSize}px; height:{controlSize}px; border-width:{1 / viewScale}px; pointer-events:auto; touch-action:manipulation;"
								onclick={(event) => {
									event.stopPropagation();
									if (boxAction.id === 'edit') editSelectedItem(item.itemId);
									else if (boxAction.id === 'delete') void deleteSelectedItem(item.itemId);
									else showOriginalForItem(item.itemId);
								}}
								onpointerdown={(event) => event.stopPropagation()}
							>
								{#if boxAction.id === 'edit'}
									<svg aria-hidden="true" style="width:{20 / viewScale}px; height:{20 / viewScale}px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
								{:else if boxAction.id === 'delete'}
									{#if deletingActionItemId === item.itemId}
										<span class="animate-spin rounded-full border-2 border-surface-100 border-t-transparent motion-reduce:animate-none" style="width:{18 / viewScale}px; height:{18 / viewScale}px; border-width:{2 / viewScale}px;"></span>
									{:else}
										<svg aria-hidden="true" style="width:{20 / viewScale}px; height:{20 / viewScale}px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>
									{/if}
								{:else}
									<svg aria-hidden="true" style="width:{20 / viewScale}px; height:{20 / viewScale}px;" viewBox="0 0 24 24"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">あ</text></svg>
								{/if}
							</button>
						{/each}
					{/if}
				{/if}
			{/if}
		{/each}
		{#if revealOpenItemId}
			{@const revealItem = plan.items.find((planned) => planned.itemId === revealOpenItemId)}
			{#if revealItem?.rect}
				<!-- Tap-away backdrop, then the translation popover above all overlays. -->
				<button
					type="button"
					aria-label={m.reader_dismiss_translation_popover()}
					data-overlay-reveal-backdrop
					class="absolute inset-0"
					style="z-index:28; pointer-events:auto; background:transparent; border:none;"
					onclick={() => setRevealOpen(null)}
				></button>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					role="dialog"
					aria-label={revealShowsOriginal ? m.reader_original_text() : m.reader_translated_text()}
					tabindex="-1"
					data-overlay-reveal-popover={revealOpenItemId}
					data-overlay-reveal-original={revealShowsOriginal ? 'true' : undefined}
					lang={revealShowsOriginal ? 'ja' : undefined}
					onclick={() => setRevealOpen(null)}
					class="absolute rounded-lg bg-surface-900/95 text-surface-100 shadow-xl"
					style="z-index:30; pointer-events:auto; left:{Math.max(4, Math.min(revealItem.rect.x, imageWidth - Math.min(imageWidth * 0.8, 340 / viewScale) - 4))}px; top:{Math.min(revealItem.rect.y + revealItem.rect.height + 8 / viewScale, imageHeight - 40 / viewScale)}px; max-width:{Math.min(imageWidth * 0.8, 340 / viewScale)}px; padding:{12 / viewScale}px; font-size:{15 / viewScale}px; line-height:1.35;"
				>
					{revealShowsOriginal ? originalTextFor(revealOpenItemId) : textFor(revealOpenItemId)}
				</div>
			{/if}
		{/if}
	</div>
{:else if showGeneratePrompt}
	<div class="absolute inset-0 flex items-center justify-center" style="z-index:20; width:{imageWidth}px; height:{imageHeight}px; pointer-events:none;">
		<div class="flex flex-col items-center gap-3 rounded-lg bg-surface-900/90 p-5 shadow-lg" style="pointer-events:auto;">
			<p class="text-sm text-surface-400">{m.reader_overlay_data_must_be()}</p>
			<button onclick={handleGenerateOverlay} class="rounded bg-teal-600 px-4 py-2 font-medium text-white">{m.reader_generate_overlay()}</button>
			{#if overlayError}<p class="text-sm text-red-400">{overlayError}</p>{/if}
		</div>
	</div>
{:else if overlayError && visible}
	<!-- Portaled to <body>: this component lives inside the panzoom-scaled page
	     container, so an in-tree banner is scaled down with the page — a
	     1600px-wide page fitted to a phone shrank the old one to ~half size.
	     Viewport-fixed above the dock, where the eye already is after tapping
	     Translate, and dismissible with a full 44px target. -->
	<div
		use:portal
		class="pointer-events-auto fixed z-[87] mx-auto flex max-w-[32rem] items-start gap-3 rounded-xl border border-red-400/30 bg-red-950/95 py-3 pl-4 pr-2 text-sm leading-snug text-red-100 shadow-2xl backdrop-blur-sm"
		style="left: calc(12px + var(--sal, 0px)); right: calc(12px + var(--sar, 0px)); bottom: calc(var(--sab, 0px) + var(--reader-bottom-inset, 0px) + var(--reader-bottom-height, 56px) + 12px);"
		role="alert"
		data-reader-overlay-error
	>
		<svg class="mt-0.5 h-5 w-5 shrink-0 text-red-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.6 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>
		<div class="min-w-0 flex-1 py-0.5">
			<p class="font-semibold">{m.reader_overlay_layout_failed()}</p>
			<p class="mt-0.5 break-words text-red-200/90">{overlayError}</p>
		</div>
		<button
			type="button"
			aria-label={m.reader_dismiss_layout_error()}
			onclick={() => { playReaderHaptic('control'); overlayError = null; }}
			class="-my-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-red-200 active:bg-red-900/70"
			data-reader-overlay-error-dismiss
		>
			<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
		</button>
	</div>
{/if}

<style>
	.overlay-selected-surface {
		filter: drop-shadow(0 0 3px rgba(45, 212, 191, .42));
	}

	.overlay-resize-outline {
		animation: overlay-selection-arrive 180ms cubic-bezier(.2, .8, .2, 1) both;
	}

	/* Manipulation controls must beat every overlay box (z 1-2) and review
	   badge (z-20) but stay under the reveal backdrop (28) and popover (30). */
	.overlay-resize-outline,
	.overlay-transform-handle,
	.overlay-move-handle,
	.overlay-box-action {
		z-index: 26;
	}

	.overlay-box-action {
		-webkit-tap-highlight-color: transparent;
	}

	.overlay-box-action:active {
		filter: brightness(1.18);
	}

	.overlay-box-action:disabled {
		opacity: .58;
	}

	.overlay-transform-handle,
	.overlay-move-handle {
		-webkit-tap-highlight-color: transparent;
		transition: filter 120ms ease, opacity 120ms ease, background-color 120ms ease;
	}

	.overlay-transform-handle:active,
	.overlay-move-handle:active,
	.overlay-transform-active {
		filter: brightness(1.18) drop-shadow(0 0 5px rgba(45, 212, 191, .72));
	}

	.overlay-move-handle:disabled {
		opacity: .82;
	}

	.overlay-transform-handle:disabled {
		opacity: .58;
	}

	@keyframes overlay-selection-arrive {
		from { opacity: 0; transform: scale(.975); }
		to { opacity: 1; transform: scale(1); }
	}

	@media (prefers-reduced-motion: reduce) {
		.overlay-resize-outline { animation: none; }
		.overlay-transform-handle,
		.overlay-move-handle { transition: none; }
	}
</style>

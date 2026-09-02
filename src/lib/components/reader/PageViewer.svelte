<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Panzoom, handleWheel, zoomFitToScreen, isAtFitScreenScale, setViewport, setContentDimensions, pausePanzoom, resumePanzoom, panzoomStore } from '$lib/panzoom/index.js';
	import { ImageCache } from '$lib/reader/image-cache.js';
	import { isVideoPageFilename } from '$lib/import/types.js';
	import { describeErrorForUser } from '$lib/util/friendly-errors.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import { createPageSource } from '$lib/reader/page-source-factory.js';
	import type { PageSource } from '$lib/reader/page-source.js';
	import RegionOverlay from './RegionOverlay.svelte';
	import TranslationOverlay from './TranslationOverlay.svelte';
	import FloatingBoxEditor from './FloatingBoxEditor.svelte';
	import MobileOverlayBoxSheet from '$lib/components/mobile/MobileOverlayBoxSheet.svelte';
	import LongStripViewer from './LongStripViewer.svelte';
	import ReaderActionRow from './ReaderActionRow.svelte';
	import ReaderIconButton from './ReaderIconButton.svelte';
	import { currentPageIndex, pageDimensions, currentVolume, currentPageInfo, isDrawingMode, isOverlayMode, readingDirection, nextPage, prevPage, overlayFontScale, pageRotation, readerSessionId, readerTargetEpoch, readerBoundaryBump, rotateCurrentPage, recordCommittedPage, resetRotationForReaderMode } from '$lib/stores/reader-state.js';
	import { clearPageData, loadPageData, currentPageOverlay, currentPageTranslation, setCurrentPageTranslationPayload, readCurrentPageTranslationPayload, compareAndSetCurrentPageTranslationPayload, isPageTranslating } from '$lib/stores/translation-state.js';
	import { sidebarOpen, editOverlayBoxId, isOverlayEditMode, movingBoxId, resizingBoxId, selectedOverlayBoxId, overlayConfirmHandler, overlayCancelHandler, readerBarsVisible, pageThumbnailScrubberOpen } from '$lib/stores/ui-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { db } from '$lib/db/index.js';
	import { updateVolume } from '$lib/catalog/catalog-repository.js';
	import { isMobile } from '$lib/util/platform.js';
	import type { PageOverlayData, VolumeMetadata } from '$lib/types/index.js';
	import type { OverlayEditorTarget } from '$lib/reader/overlay-editor-draft.js';
	import { getOrCreateClient } from '$lib/yacreader/yac-client-manager.js';
	import type {
		OcrBenchmarkCapabilities,
		OcrBenchmarkRequest,
		OcrBenchmarkRunResult
	} from '$lib/benchmark/ocr-benchmark-api.js';
	import {
		disablePageBenchmarkMode,
		enablePageBenchmarkMode,
		consumePageBenchmarkNavigationTransfer,
		isPageBenchmarkPersistenceSuppressed
	} from '$lib/benchmark/page-benchmark-mode.js';
	import { decideReaderTouch, READER_TAP_MAX_AXIS_DELTA_PX, READER_TAP_MAX_DURATION_MS, type ReaderTouchDecision } from '$lib/reader/reader-touch-decision.js';
	import { claimReaderTapGesture, consumeReaderTapClaim, resetReaderTapClaim } from '$lib/reader/reader-gesture-claim.js';
	import { resetReaderInteractionState } from '$lib/reader/reader-interaction-reset.js';
	import {
		createReaderAutoTranslationScheduler,
		readerPageTranslationOutcomeIsUsable,
		type ReaderAutoTranslationRunContext,
		type ReaderAutoTranslationTarget
	} from '$lib/translation/reader-auto-translation-scheduler.js';
	import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
	import { queueTabPreview } from '$lib/tabs/tab-preview-queue.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { activeRegionDrawSession, finishRegionDrawSession, highlightedDrawRegionIds, undoNewestDrawnRegion } from '$lib/regions/region-draw-session.js';
	import {
		acquirePageTranslationActivity,
		releasePageTranslationActivity,
		registerAutomaticPageTranslationOwner,
		inspectPageTranslationActivities,
		pageTranslationActivities,
		type PageTranslationActivityToken
	} from '$lib/translation/page-translation-activity.js';
	import {
		progressivePageTranslationPreview,
		sameProgressivePageTranslationTarget,
		type ProgressivePageTranslationSnapshot,
		type ProgressivePageTranslationTarget
	} from '$lib/translation/progressive-page-translation-preview.js';

	/** Currently editing overlay entry for the mobile floating editor */
	let floatingEditTarget = $state<(OverlayEditorTarget & { volumeUuid: string; pageIndex: number }) | null>(null);
	let currentPageTranslationBusy = $derived.by(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		return Boolean(volumeUuid && $pageTranslationActivities.some((activity) =>
			activity.target.volumeUuid === volumeUuid && activity.target.pageIndex === $currentPageIndex
		));
	});
	let floatingEditItem = $derived(
		floatingEditTarget == null
			|| floatingEditTarget.volumeUuid !== $currentVolume?.volume_uuid
			|| floatingEditTarget.pageIndex !== $currentPageIndex
			? null
			: ($currentPageOverlay?.items.find((item) => item.id === floatingEditTarget?.itemId) ?? null)
	);
	let floatingBaseTranslation = $derived(
		floatingEditItem
			? ($currentPageTranslation?.entries.find((entry) => entry.id === floatingEditItem?.translationEntryId)?.translated_text ?? '')
			: ''
	);

	type OnDeviceBenchmarkResult = {
		volumeUuid: string;
		sourceType: string;
		pageIndex: number;
		imageBytes: number;
		pageAcquireMs: number;
		firstOverlayPaintMs: number | null;
		totalWallMs: number;
		overlayEntries: number;
		visibleOverlayEntries: number;
		hiddenOverlayEntries: number;
		renderedOverlayBoxes: number;
		metrics: Record<string, unknown>;
		nativeRuntimeInfo: Record<string, unknown> | null;
		nativeOcrRuntimeInfo: Record<string, unknown> | null;
	};

	type OnDeviceBenchmarkRunOptions = {
		/** Abort immediately after publishing the first visible progressive box. */
		cancelAfterFirstOverlay?: boolean;
	};

	type OnDeviceBenchmarkContext = {
		volumeUuid: string | null;
		volumeTitle: string | null;
		sourceType: string | null;
		pageIndex: number;
		sourceReady: boolean;
		imageReady: boolean;
		pageDataReady: boolean;
	};

	type OnDeviceBenchmarkRestoreResult = {
		restored: boolean;
		storeRestored: boolean;
		modeRestored: boolean;
		pageUnchanged: boolean;
		overlayEntries: number;
		renderedOverlayBoxes: number;
	};

	type OnDeviceBenchmarkFixture = {
		id: string;
		mimeType: string;
		sha256: string;
		bytes: number;
		volumeUuid: string;
		pageIndex: number;
	};
	type OnDevicePageSourceIdentity = {
		pageIndex: number;
		bytes: number;
		sha256: string;
	};

	type OnDeviceBenchmarkApi = {
		beginEvidenceSession(): OnDeviceBenchmarkContext;
		endEvidenceSession(): void;
		inspectCurrentPage(): OnDeviceBenchmarkContext;
		inspectCurrentPageSourceIdentity(): Promise<OnDevicePageSourceIdentity>;
		getOcrCapabilities(): Promise<OcrBenchmarkCapabilities>;
		releaseOcrBackends(): Promise<void>;
		loadCurrentPageOcrFixture(): Promise<OnDeviceBenchmarkFixture>;
		runOcrCurrentPage(request: OcrBenchmarkRequest): Promise<OcrBenchmarkRunResult & {
			volumeUuid: string;
			sourceType: string;
			pageIndex: number;
			imageBytes: number;
			pageAcquireMs: number;
		}>;
		runCurrentPage(options?: OnDeviceBenchmarkRunOptions): Promise<OnDeviceBenchmarkResult>;
		cancelCurrentPage(reason?: string): Promise<boolean>;
		restore(): Promise<OnDeviceBenchmarkRestoreResult>;
	};

	let benchmarkApi: OnDeviceBenchmarkApi | null = null;
	let benchmarkRestore: (() => Promise<OnDeviceBenchmarkRestoreResult>) | null = null;
	let benchmarkInFlight = false;
	let benchmarkPageController: AbortController | null = null;
	let benchmarkTranslationActivity: PageTranslationActivityToken | null = null;
	let benchmarkOwnerTarget: ProgressivePageTranslationTarget | null = null;
	const benchmarkIdleWaiters = new Set<() => void>();
	let benchmarkPriorReaderBars: boolean | null = null;
	let autoTranslationSuspendedForBenchmark = $state(false);
	type PageDataLoadTicket = {
		volumeUuid: string;
		pageIndex: number;
		generation: number;
		promise: Promise<void>;
		ready: boolean;
		error: string | null;
	};
	let pageDataLoadGeneration = 0;
	let pageDataLoadTicket: PageDataLoadTicket | null = null;
	let readerUiTestApi: Record<string, unknown> | null = null;
	let previousReaderUiTestApi: unknown;

	function waitForBenchmarkTranslationIdle(): Promise<void> {
		if (benchmarkPageController === null) return Promise.resolve();
		return new Promise<void>((resolve) => benchmarkIdleWaiters.add(resolve));
	}

	function releaseBenchmarkTranslationLease(controller: AbortController): boolean {
		if (benchmarkPageController !== controller) return false;
		benchmarkPageController = null;
		releasePageTranslationActivity(benchmarkTranslationActivity);
		benchmarkTranslationActivity = null;
		benchmarkOwnerTarget = null;
		const waiters = [...benchmarkIdleWaiters];
		benchmarkIdleWaiters.clear();
		for (const resolve of waiters) resolve();
		return true;
	}

	function installReaderUiTestApi(): void {
		const testWindow = window as unknown as Record<string, unknown>;
		const benchmarkBridge = testWindow.__fumeto_llama as { isBenchmarkBuild?: () => boolean } | undefined;
		if (benchmarkBridge?.isBenchmarkBuild?.() !== true) return;
		previousReaderUiTestApi = testWindow.__fumeto_reader_test;
		readerUiTestApi = {
			inspect: () => ({
				volumeUuid: get(currentVolume)?.volume_uuid ?? null,
				pageIndex: get(currentPageIndex),
				totalPages: get(pageDimensions).length,
				pageTurnMode: get(settings).pageTurnMode,
				readingDirection: get(readingDirection),
				controlsVisible: isMobile
					? mobileReaderUi.inspect().chrome === 'visible'
					: get(readerBarsVisible),
				mobileUi: mobileReaderUi.inspect(),
				translationActivities: inspectPageTranslationActivities(),
				renderedPageCards: document.querySelectorAll('[data-reader-pages-panel] [data-page]').length,
				liveThumbnailUrls: document.querySelector('[data-live-thumbnail-urls]')?.getAttribute('data-live-thumbnail-urls') ?? '0',
				drawingMode: get(isDrawingMode),
				overlayEditMode: get(isOverlayEditMode),
				pageGridOpen: get(pageThumbnailScrubberOpen),
				autoTranslateEnabled: get(settings).readerAutoTranslateOverlays,
				autoTranslation: autoTranslationScheduler.inspect()
			}),
			prepareGestureScenario: (input: {
				pageTurnMode?: 'swipe' | 'tap' | 'both';
				readingDirection?: 'rtl' | 'ltr';
				pageIndex?: number;
			} = {}) => {
				resetReaderInteractionState();
				if (input.pageTurnMode) settings.patch({ pageTurnMode: input.pageTurnMode });
				if (input.readingDirection) readingDirection.set(input.readingDirection);
				if (Number.isInteger(input.pageIndex)) {
					const count = get(pageDimensions).length;
					currentPageIndex.set(Math.max(0, Math.min(count - 1, input.pageIndex!)));
				}
				return true;
			},
			setInteractionModes: (input: { drawing?: boolean; overlayEdit?: boolean }) => {
				if (typeof input.drawing === 'boolean') isDrawingMode.set(input.drawing);
				if (typeof input.overlayEdit === 'boolean') isOverlayEditMode.set(input.overlayEdit);
			},
			setControlsVisible: (visible: boolean) => {
				if (isMobile) {
					const currentlyVisible = mobileReaderUi.inspect().chrome === 'visible';
					if (currentlyVisible !== Boolean(visible)) mobileReaderUi.toggleChrome();
				} else readerBarsVisible.set(Boolean(visible));
			},
			openPageGrid: () => {
				if (isMobile) mobileReaderUi.openDisclosure('filmstrip');
				else pageThumbnailScrubberOpen.set(true);
			},
			setAutoTranslationEnabled: (enabled: boolean) => {
				settings.patch({ readerAutoTranslateOverlays: Boolean(enabled) });
			},
			requestAutoTranslationCurrent: () => {
				const volume = get(currentVolume);
				const sessionId = get(readerSessionId);
				if (!volume || !sessionId) throw new Error('No reader volume is open');
				return autoTranslationScheduler.request({
					readerSessionId: sessionId,
					targetEpoch: get(readerTargetEpoch),
					volumeUuid: volume.volume_uuid,
					pageIndex: get(currentPageIndex)
				});
			}
		};
		testWindow.__fumeto_reader_test = readerUiTestApi;
	}

	function benchmarkPersistenceSuppressed(): boolean {
		return isPageBenchmarkPersistenceSuppressed();
	}

	function benchmarkContext(): OnDeviceBenchmarkContext {
		const vol = get(currentVolume);
		const pageIndex = get(currentPageIndex);
		const ticket = pageDataLoadTicket;
		return {
			volumeUuid: vol?.volume_uuid ?? null,
			volumeTitle: vol?.title ?? null,
			sourceType: vol ? (vol.source?.type ?? 'local') : null,
			pageIndex,
			sourceReady: pageSource !== null,
			imageReady: imageUrl !== null,
			pageDataReady: Boolean(
				ticket?.ready
				&& ticket.error === null
				&& ticket.volumeUuid === vol?.volume_uuid
				&& ticket.pageIndex === pageIndex
			)
		};
	}

	async function awaitExactPageData(volumeUuid: string, pageIndex: number): Promise<void> {
		const ticket = pageDataLoadTicket;
		if (!ticket || ticket.volumeUuid !== volumeUuid || ticket.pageIndex !== pageIndex) {
			throw new Error('The exact reader page data load is not registered');
		}
		await ticket.promise;
		if (pageDataLoadTicket !== ticket || !ticket.ready || ticket.error) {
			throw new Error(ticket.error ?? 'Reader page data changed while the benchmark was waiting');
		}
	}

	function readNativeRuntimeInfo(): Record<string, unknown> | null {
		const nativeBridge = (window as unknown as Record<string, unknown>).__fumeto_llama as {
			getRuntimeInfo?: () => string;
		} | undefined;
		const raw = nativeBridge?.getRuntimeInfo?.();
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return { parseError: raw };
		}
	}

	function readNativeOcrRuntimeInfo(): Record<string, unknown> | null {
		const nativeBridge = (window as unknown as Record<string, unknown>).__fumeto_ppocr_native as {
			getRuntimeInfo?: () => string;
		} | undefined;
		const raw = nativeBridge?.getRuntimeInfo?.();
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return { parseError: raw };
		}
	}

	async function afterTwoAnimationFrames(): Promise<void> {
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	}

	function bytesToBase64(bytes: Uint8Array): string {
		let binary = '';
		for (let offset = 0; offset < bytes.length; offset += 32_768) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
		}
		return btoa(binary);
	}

	async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', buffer);
		return Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0')).join('');
	}

	function benchmarkOverlayBoxIsVisible(element: HTMLElement): boolean {
		const style = getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		const viewportRect = viewportEl?.getBoundingClientRect();
		if (!viewportRect) return false;
		const intersectionWidth = Math.max(0, Math.min(rect.right, viewportRect.right) - Math.max(rect.left, viewportRect.left));
		const intersectionHeight = Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top));
		return Boolean(element.textContent?.trim())
			&& rect.width > 0
			&& rect.height > 0
			&& intersectionWidth > 0
			&& intersectionHeight > 0
			&& style.display !== 'none'
			&& style.visibility === 'visible'
			&& Number.parseFloat(style.opacity || '1') > 0
			&& Number.parseFloat(style.fontSize || '0') > 0
			&& style.backgroundColor !== 'rgba(0, 0, 0, 0)'
			&& style.color !== 'rgba(0, 0, 0, 0)';
	}

	function installOnDeviceBenchmarkApi() {
		const nativeBridge = (window as unknown as Record<string, unknown>).__fumeto_llama as {
			isBenchmarkBuild?: () => boolean;
		} | undefined;
		if (!nativeBridge?.isBenchmarkBuild?.()) return;

		benchmarkApi = {
			beginEvidenceSession: () => {
				if (!enablePageBenchmarkMode()) throw new Error('Benchmark mode is unavailable');
				autoTranslationSuspendedForBenchmark = true;
				autoTranslationScheduleGeneration += 1;
				autoTranslationScheduler.cancel();
				if (benchmarkPriorReaderBars === null) benchmarkPriorReaderBars = get(readerBarsVisible);
				readerBarsVisible.set(true);
				clearTimeout(saveProgressTimer);
				saveProgressTimer = undefined;
				pendingProgressSave = undefined;
				return benchmarkContext();
			},
			endEvidenceSession: () => {
				if (benchmarkPriorReaderBars !== null) readerBarsVisible.set(benchmarkPriorReaderBars);
				benchmarkPriorReaderBars = null;
				disablePageBenchmarkMode();
				autoTranslationSuspendedForBenchmark = false;
				const overlay = get(currentPageOverlay);
				if (overlay) currentPageOverlay.set(structuredClone(overlay));
			},
			inspectCurrentPage: benchmarkContext,
			inspectCurrentPageSourceIdentity: async () => {
				const vol = get(currentVolume);
				const source = pageSource;
				const pageIndex = get(currentPageIndex);
				const sourceGeneration = pageSourceGeneration;
				if (!vol || (vol.source?.type ?? 'local') !== 'local' || !source || imageUrl === null) {
					throw new Error('Open a ready Local Comics page before inspecting its source identity');
				}
				await awaitExactPageData(vol.volume_uuid, pageIndex);
				const imageFile = await source.getPageAsFile(pageIndex);
				const buffer = await imageFile.arrayBuffer();
				if (
					sourceGeneration !== pageSourceGeneration
					|| pageSource !== source
					|| get(currentVolume)?.volume_uuid !== vol.volume_uuid
					|| get(currentPageIndex) !== pageIndex
				) throw new Error('Reader page changed while inspecting its source identity');
				return { pageIndex, bytes: imageFile.size, sha256: await sha256Hex(buffer) };
			},
			getOcrCapabilities: async () => {
				const { getOcrBenchmarkCapabilities } = await import('$lib/benchmark/ocr-benchmark-api.js');
				return getOcrBenchmarkCapabilities();
			},
			releaseOcrBackends: async () => {
				if (benchmarkInFlight) throw new Error('Cannot release OCR backends during a benchmark');
				await waitForReaderTranslationIdleForBenchmark();
				const { releaseOcrBenchmarkBackends } = await import('$lib/benchmark/ocr-benchmark-api.js');
				await releaseOcrBenchmarkBackends();
			},
			loadCurrentPageOcrFixture: async () => {
				if (benchmarkInFlight) throw new Error('A page benchmark is already running');
				if (benchmarkRestore) throw new Error('Restore the translated overlay before profiling OCR');
				if (!benchmarkPersistenceSuppressed()) {
					throw new Error('Begin a debug evidence session before loading the OCR fixture');
				}
				const vol = get(currentVolume);
				const source = pageSource;
				const pageIndex = get(currentPageIndex);
				const sourceGeneration = pageSourceGeneration;
				if (!vol || (vol.source?.type ?? 'local') !== 'local' || !source || imageUrl === null) {
					throw new Error('Open a ready Local Comics page before loading the OCR fixture');
				}
				benchmarkInFlight = true;
				let loadedFixtureHost: { clearFixture(): Promise<void> } | null = null;
				try {
					await awaitExactPageData(vol.volume_uuid, pageIndex);
					const imageFile = await source.getPageAsFile(pageIndex);
					if (
						sourceGeneration !== pageSourceGeneration
						|| pageSource !== source
						|| get(currentVolume)?.volume_uuid !== vol.volume_uuid
						|| get(currentPageIndex) !== pageIndex
					) throw new Error('Reader page changed while loading the OCR fixture');
					const buffer = await imageFile.arrayBuffer();
					const sha256 = await sha256Hex(buffer);
					const descriptor = {
						id: `hymt2-reader-page-${pageIndex}-${sha256.slice(0, 16)}`,
						base64: bytesToBase64(new Uint8Array(buffer)),
						mimeType: imageFile.type || 'image/jpeg',
						sha256
					};
					const host = (window as unknown as Record<string, unknown>).__fumeto_ocr_benchmark as {
						loadFixture(value: typeof descriptor): Promise<Omit<OnDeviceBenchmarkFixture, 'volumeUuid' | 'pageIndex'>>;
						clearFixture(): Promise<void>;
					} | undefined;
					if (!host?.loadFixture) throw new Error('Debug OCR fixture host is unavailable');
					const loaded = await host.loadFixture(descriptor);
					loadedFixtureHost = host;
					if (
						sourceGeneration !== pageSourceGeneration
						|| pageSource !== source
						|| get(currentVolume)?.volume_uuid !== vol.volume_uuid
						|| get(currentPageIndex) !== pageIndex
					) throw new Error('Reader page changed after loading the OCR fixture');
					return { ...loaded, volumeUuid: vol.volume_uuid, pageIndex };
				} catch (error) {
					if (loadedFixtureHost) {
						try { await loadedFixtureHost.clearFixture(); } catch { /* best effort before rethrow */ }
					}
					throw error;
				} finally {
					benchmarkInFlight = false;
				}
			},
			runOcrCurrentPage: async (request) => {
				if (benchmarkInFlight) throw new Error('A page benchmark is already running');
				if (benchmarkRestore) throw new Error('Restore the translated overlay benchmark before running OCR');
				if (!benchmarkPersistenceSuppressed()) {
					throw new Error('Begin a debug evidence session before running the OCR benchmark');
				}
				await waitForReaderTranslationIdleForBenchmark();
				const vol = get(currentVolume);
				const source = pageSource;
				const pageIndex = get(currentPageIndex);
				const sourceGeneration = pageSourceGeneration;
				const sourceType = vol?.source?.type ?? 'local';
				if (!vol || sourceType !== 'local') {
					throw new Error('Open an exact Local Comics page before benchmarking OCR');
				}
				if (!source || imageUrl === null) {
					throw new Error('The Local Comics page source is not ready for OCR benchmarking');
				}
				benchmarkInFlight = true;
				try {
					const acquireStarted = performance.now();
					const imageFile = await source.getPageAsFile(pageIndex);
					const pageAcquireMs = performance.now() - acquireStarted;
					if (
						sourceGeneration !== pageSourceGeneration ||
						pageSource !== source ||
						get(currentVolume)?.volume_uuid !== vol.volume_uuid ||
						get(currentPageIndex) !== pageIndex
					) throw new Error('Reader page changed during OCR benchmark acquisition');

					const { runOcrBenchmark } = await import('$lib/benchmark/ocr-benchmark-api.js');
					const result = await runOcrBenchmark(imageFile, {
						...request,
						referenceIdentity: `${vol.volume_uuid}:${pageIndex}:${imageFile.size}:${imageFile.lastModified}`
					});
					if (
						sourceGeneration !== pageSourceGeneration ||
						pageSource !== source ||
						get(currentVolume)?.volume_uuid !== vol.volume_uuid ||
						get(currentPageIndex) !== pageIndex
					) throw new Error('Reader page changed while OCR benchmark inference was running');
					return {
						...result,
						volumeUuid: vol.volume_uuid,
						sourceType,
						pageIndex,
						imageBytes: imageFile.size,
						pageAcquireMs
					};
				} finally {
					benchmarkInFlight = false;
				}
			},
			runCurrentPage: async (options = {}) => {
				if (benchmarkInFlight) throw new Error('A page benchmark is already running');
				if (benchmarkRestore) throw new Error('Restore the previous benchmark overlay before starting another run');
				if (!benchmarkPersistenceSuppressed()) {
					throw new Error('Begin a debug evidence session before running the translated-page benchmark');
				}
				await waitForReaderTranslationIdleForBenchmark();
				const vol = get(currentVolume);
				const source = pageSource;
				const pageIndex = get(currentPageIndex);
				const sourceGeneration = pageSourceGeneration;
				const sourceType = vol?.source?.type ?? 'local';
				if (!vol || sourceType !== 'local') {
					throw new Error('Open an exact Local Comics page before benchmarking');
				}
				if (!source || imageUrl === null) {
					throw new Error('The Local Comics page source is not ready for benchmarking');
				}
				const targetVolumeUuid = vol.volume_uuid;
				const benchmarkTarget = currentProgressiveTarget();
				if (
					!benchmarkTarget
					|| benchmarkTarget.volumeUuid !== targetVolumeUuid
					|| benchmarkTarget.pageIndex !== pageIndex
				) throw new Error('Reader target changed before benchmark translation began');

				// Own the benchmark before its first asynchronous page-data operation so
				// manual translation can cancel and await this exact reader target.
				const pageController = new AbortController();
				benchmarkPageController = pageController;
				benchmarkOwnerTarget = benchmarkTarget;
				benchmarkTranslationActivity = acquirePageTranslationActivity(
					'automatic',
					benchmarkTarget,
					{ cancel: () => pageController.abort() }
				);
				benchmarkInFlight = true;
				try {
					await awaitExactPageData(targetVolumeUuid, pageIndex);
					if (
						pageController.signal.aborted
						|| sourceGeneration !== pageSourceGeneration
						|| pageSource !== source
						|| !sameProgressivePageTranslationTarget(benchmarkTarget, currentProgressiveTarget())
						|| imageUrl === null
						|| !benchmarkPersistenceSuppressed()
					) throw new Error('Reader page changed while benchmark page data was loading');
				} catch (error) {
					benchmarkInFlight = false;
					releaseBenchmarkTranslationLease(pageController);
					throw error;
				}

				const priorPayload = readCurrentPageTranslationPayload();
				const priorTranslation = priorPayload.pageTranslation;
				const priorOverlay = priorPayload.overlayData;
				const priorOverlayMode = get(isOverlayMode);
				const priorTranslationJson = JSON.stringify(priorTranslation ?? null);
				const priorOverlayJson = JSON.stringify(priorOverlay ?? null);
				let benchmarkOwnedTranslation = priorTranslation;
				let benchmarkOwnedOverlay = priorOverlay;
				let benchmarkOwnedPayloadVersion = priorPayload.version;
				benchmarkRestore = async () => {
					const pageUnchanged = sameProgressivePageTranslationTarget(
						benchmarkTarget,
						currentProgressiveTarget()
					);
					const storeStillBenchmarkOwned = pageUnchanged
						&& readCurrentPageTranslationPayload().version === benchmarkOwnedPayloadVersion
						&& get(currentPageTranslation) === benchmarkOwnedTranslation
						&& get(currentPageOverlay) === benchmarkOwnedOverlay;
					const restoredPayloadVersion = storeStillBenchmarkOwned
						? compareAndSetCurrentPageTranslationPayload(
							benchmarkOwnedPayloadVersion,
							priorTranslation,
							priorOverlay
						)
						: null;
					const restoreOwnedPayload = restoredPayloadVersion !== null;
					if (restoreOwnedPayload) {
						isOverlayMode.set(priorOverlayMode);
						await tick();
						await afterTwoAnimationFrames();
					}
					const restoredTranslation = get(currentPageTranslation);
					const restoredOverlay = get(currentPageOverlay);
					const storeRestored = restoreOwnedPayload
						&& JSON.stringify(restoredTranslation ?? null) === priorTranslationJson
						&& JSON.stringify(restoredOverlay ?? null) === priorOverlayJson;
					const modeRestored = restoreOwnedPayload && get(isOverlayMode) === priorOverlayMode;
					return {
						restored: storeRestored && modeRestored,
						storeRestored,
						modeRestored,
						pageUnchanged,
					overlayEntries: restoredOverlay?.items.length ?? 0,
						renderedOverlayBoxes: viewportEl?.querySelectorAll('[data-overlay-box]').length ?? 0
					};
				};

				const runStarted = performance.now();
				const acquireStarted = performance.now();
				let imageFile: File;
				let pageAcquireMs: number;
				try {
					imageFile = await source.getPageAsFile(pageIndex, { signal: pageController.signal });
					pageAcquireMs = performance.now() - acquireStarted;
					if (
						pageController.signal.aborted ||
						sourceGeneration !== pageSourceGeneration ||
						pageSource !== source ||
						!sameProgressivePageTranslationTarget(benchmarkTarget, currentProgressiveTarget())
					) throw new Error('Reader page changed during benchmark acquisition');
				} catch (error) {
					benchmarkInFlight = false;
					releaseBenchmarkTranslationLease(pageController);
					throw error;
				}

				let firstOverlayPaintMs: number | null = null;
				let firstPaintSettled = false;
				let paintScheduled = false;
				let progressiveCancellationRequested = false;
				let resolveFirstPaint: (value: number | null) => void = () => {};
				const firstPaint = new Promise<number | null>((resolve) => { resolveFirstPaint = resolve; });
				const handleProgressiveOverlay = (overlay: PageOverlayData): void => {
					if (
						paintScheduled
						|| firstPaintSettled
						|| benchmarkPageController !== pageController
						|| !sameProgressivePageTranslationTarget(benchmarkTarget, currentProgressiveTarget())
						|| overlay.items.length === 0
					) return;
					const firstVisibleEntry = overlay.items.find((entry) => !entry.manual.hidden);
					if (!firstVisibleEntry) return;
					if (options.cancelAfterFirstOverlay && !progressiveCancellationRequested) {
						progressiveCancellationRequested = true;
						pageController.abort();
					}
					paintScheduled = true;
					const firstBoxId = firstVisibleEntry.id;
					void (async () => {
						await tick();
						await afterTwoAnimationFrames();
						if (firstPaintSettled) return;
						const pageStillCurrent = sameProgressivePageTranslationTarget(
							benchmarkTarget,
							currentProgressiveTarget()
						);
						const paintedBox = Array.from(
							viewportEl?.querySelectorAll<HTMLElement>('[data-overlay-container] [data-overlay-box]') ?? []
						).some((element) =>
							element.dataset.overlayBox === String(firstBoxId)
							&& benchmarkOverlayBoxIsVisible(element)
						);
						if (!pageStillCurrent || !paintedBox) {
							paintScheduled = false;
							return;
						}
						firstOverlayPaintMs = performance.now() - runStarted;
						firstPaintSettled = true;
						resolveFirstPaint(firstOverlayPaintMs);
					})();
				};

				const previewToken = progressivePageTranslationPreview.begin(
					benchmarkTarget,
					currentProgressiveTarget()
				);
				try {
					isOverlayMode.set(true);
					const { translatePageOnDevice } = await import('$lib/translation/on-device-service.js');
					const result = await translatePageOnDevice(targetVolumeUuid, pageIndex, imageFile, {
						skipPersist: true,
						suppressProgressiveUpdates: false,
						signal: pageController.signal,
						onProgressiveSnapshot: (snapshot) => {
							if (progressivePageTranslationPreview.publish(
								previewToken,
								snapshot,
								currentProgressiveTarget()
							)) {
								benchmarkOwnedTranslation = snapshot.pageTranslation;
								benchmarkOwnedOverlay = snapshot.overlayData;
								benchmarkOwnedPayloadVersion = readCurrentPageTranslationPayload().version;
								handleProgressiveOverlay(snapshot.overlayData);
							}
						},
						shouldPublishProgressiveUpdate: () => (
							!pageController.signal.aborted
							&& sourceGeneration === pageSourceGeneration
							&& pageSource === source
							&& sameProgressivePageTranslationTarget(
								benchmarkTarget,
								currentProgressiveTarget()
							)
						),
						runtimeOverrides: {
							sourceLang: 'ja',
							targetLang: 'en',
							ocrProvider: 'ppocr',
							translationBackend: 'translategemma'
						}
					});
					if (!progressivePageTranslationPreview.commit(
						previewToken,
						{
							target: { volumeUuid: targetVolumeUuid, pageIndex },
							pageTranslation: result.pageTranslation,
							overlayData: result.overlayData
						},
						currentProgressiveTarget()
					)) throw new Error('Reader page changed during benchmark translation');
					benchmarkOwnedTranslation = result.pageTranslation;
					benchmarkOwnedOverlay = result.overlayData;
					benchmarkOwnedPayloadVersion = readCurrentPageTranslationPayload().version;
					const visibleOverlayEntries = result.overlayData.items.filter(
						(entry) => !entry.manual.hidden
					).length;
					const hiddenOverlayEntries = result.overlayData.items.length - visibleOverlayEntries;
					if (visibleOverlayEntries > 0 && firstOverlayPaintMs === null) {
						firstOverlayPaintMs = await Promise.race([
							firstPaint,
							new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))
						]);
					}
					await afterTwoAnimationFrames();
					const diagnosticsWindow = window as unknown as Record<string, unknown>;
					return {
						volumeUuid: targetVolumeUuid,
						sourceType,
						pageIndex,
						imageBytes: imageFile.size,
						pageAcquireMs,
						firstOverlayPaintMs,
						totalWallMs: performance.now() - runStarted,
						overlayEntries: result.overlayData.items.length,
						visibleOverlayEntries,
						hiddenOverlayEntries,
						renderedOverlayBoxes: Array.from(
							viewportEl?.querySelectorAll<HTMLElement>('[data-overlay-box]') ?? []
						).filter(benchmarkOverlayBoxIsVisible).length,
						metrics: {
							...result.metrics,
							ppocrDetector: diagnosticsWindow.__fumeto_last_ppocr_detector_metrics ?? null,
							ppocrRecognizer: diagnosticsWindow.__fumeto_last_ppocr_recognizer_metrics ?? null
						},
						nativeRuntimeInfo: readNativeRuntimeInfo(),
						nativeOcrRuntimeInfo: readNativeOcrRuntimeInfo()
					};
				} catch (error) {
					const rollback = progressivePageTranslationPreview.rollback(
						previewToken,
						currentProgressiveTarget()
					);
					if (rollback === 'restored') {
						benchmarkOwnedTranslation = priorTranslation;
						benchmarkOwnedOverlay = priorOverlay;
						benchmarkOwnedPayloadVersion = readCurrentPageTranslationPayload().version;
					}
					throw error;
				} finally {
					benchmarkInFlight = false;
					releaseBenchmarkTranslationLease(pageController);
					if (!firstPaintSettled) {
						firstPaintSettled = true;
						resolveFirstPaint(null);
					}
				}
			},
			cancelCurrentPage: async () => {
				const controller = benchmarkPageController;
				if (!controller || controller.signal.aborted) return false;
				controller.abort();
				return true;
			},
			restore: async () => {
				if (benchmarkInFlight) throw new Error('Cannot restore while the page benchmark is still running');
				const result = benchmarkRestore
					? await benchmarkRestore()
					: {
						restored: true,
						storeRestored: true,
						modeRestored: true,
						pageUnchanged: true,
						overlayEntries: get(currentPageOverlay)?.items.length ?? 0,
						renderedOverlayBoxes: viewportEl?.querySelectorAll('[data-overlay-box]').length ?? 0
					};
				benchmarkRestore = null;
				return result;
			}
		};
		(window as unknown as Record<string, unknown>).__fumeto_on_device_benchmark = benchmarkApi;
	}

	function handleOverlayBoxClick(target: OverlayEditorTarget) {
		if (!isMobile) {
			sidebarOpen.set(true);
			editOverlayBoxId.set(target.itemId);
		}
	}

	function handleOverlayBoxLongPress(target: OverlayEditorTarget): void {
		if (!isMobile || $isDrawingMode || currentPageTranslationBusy) return;
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid || !$currentPageTranslation) return;
		const item = $currentPageOverlay?.items.find((entry) => entry.id === target.itemId);
		if (!item || !$currentPageTranslation.entries.some((entry) => entry.id === item.translationEntryId)) return;
		floatingEditTarget = null;
		selectedOverlayBoxId.set(target.itemId);
		claimReaderTapGesture();
		mobileReaderUi.setToolMode('transform-box');
		playReaderHaptic('selection');
	}

	function handleOverlayBoxReview(target: OverlayEditorTarget): void {
		if (!isMobile || $isDrawingMode || currentPageTranslationBusy) return;
		const volumeUuid = $currentVolume?.volume_uuid;
		if (!volumeUuid || !$currentPageTranslation) return;
		const item = $currentPageOverlay?.items.find((entry) => entry.id === target.itemId);
		if (!item || !$currentPageTranslation.entries.some((entry) => entry.id === item.translationEntryId)) return;
		selectedOverlayBoxId.set(null);
		floatingEditTarget = {
			...target,
			rect: { ...target.rect },
			volumeUuid,
			pageIndex: $currentPageIndex
		};
		mobileReaderUi.setToolMode('box-editor');
	}

	function handleFloatingEditorDismiss() {
		floatingEditTarget = null;
		if (mobileReaderUi.inspect().toolMode === 'box-editor') mobileReaderUi.setToolMode('navigate');
	}

	$effect(() => {
		if (floatingEditTarget != null && $mobileReaderUi.toolMode !== 'box-editor') floatingEditTarget = null;
	});

	// Hardening: the editor's {#if} keys on floatingEditItem, so it can
	// unmount without any dismiss path firing (page change while a save
	// rejects). A stale non-null target would then swallow every re-fit via
	// the ResizeObserver guard below — clear it whenever its item is gone.
	$effect(() => {
		if (floatingEditTarget != null && floatingEditItem == null) handleFloatingEditorDismiss();
	});

	// A viewport resize skipped while the box editor was open (see the
	// ResizeObserver) is applied once the editor closes, whichever path
	// closed it.
	let pendingEditorRefit = false;
	$effect(() => {
		if (floatingEditTarget == null && pendingEditorRefit) {
			pendingEditorRefit = false;
			if (!longStripActive) zoomFitToScreen();
		}
	});

	$effect(() => {
		if ($selectedOverlayBoxId != null) mobileReaderUi.setToolMode('transform-box');
		else if ($movingBoxId != null) mobileReaderUi.setToolMode('move-box');
		else if ($resizingBoxId != null) mobileReaderUi.setToolMode('resize-box');
		else if (['transform-box', 'move-box', 'resize-box'].includes($mobileReaderUi.toolMode)) mobileReaderUi.setToolMode('navigate');
	});

	$effect(() => {
		if ($selectedOverlayBoxId != null && $mobileReaderUi.toolMode !== 'transform-box') {
			selectedOverlayBoxId.set(null);
		}
	});


	let viewportEl: HTMLDivElement | undefined = $state();
	let imageUrl = $state<string | null>(null);
	let pageWidth = $state(0);
	let pageHeight = $state(0);
	let pageSource = $state<PageSource | null>(null);
	/**
	 * Long-strip mode swaps the paged panzoom surface for LongStripViewer.
	 * Page-scoped translation machinery (loadPageData, auto-translate, manual
	 * translate targets) keeps running against the tracked current page; only
	 * the paged image/panzoom pipeline is gated off.
	 */
	let longStripActive = $derived($settings.readerMode === 'long-strip');
	// The strip renders no rotation frame and offers no rotate control, so a
	// quarter turn taken in paged mode would otherwise sit in the store —
	// invisible, un-clearable from the strip, and re-applied on the way back.
	let lastReaderMode = $settings.readerMode;
	$effect(() => {
		const mode = $settings.readerMode;
		untrack(() => {
			if (mode === lastReaderMode) return;
			lastReaderMode = mode;
			resetRotationForReaderMode();
		});
	});
	/**
	 * Current page is a stored video (mp4/m4v/webm) — keys the <video> surface
	 * swap and, downstream, the translate-affordance gating. Filename-based by
	 * contract: remote sources synthesize .jpg names, so remote is never video.
	 */
	let currentPageIsVideo = $derived(
		!!$currentPageInfo && isVideoPageFilename($currentPageInfo.filename)
	);
	let isInitialLoad = $state(true);
	let pageLoadError = $state<string | null>(null);
	let lastScheduledFitIdentity = '';
	// The fit identity has to name the Panzoom INSTANCE, not just the page. The
	// template's if-chain destroys and rebuilds Panzoom whenever the reader
	// switches to long-strip, to the error card, or to the skeleton, and a fresh
	// instance starts at scale 1 / top-left. Returning to a cached page then
	// produced a byte-identical identity, the effect deduped, and the page sat
	// unfitted at 100% until the user double-tapped.
	let panzoomEpoch = $state(0);
	let pageFitRafId: number | undefined;
	let pageFitSecondRafId: number | undefined;

	// Volume-boundary feedback: edge glow + haptic when paging past either end.
	let boundaryFlash = $state<{ side: 'left' | 'right'; seq: number } | null>(null);
	let boundaryFlashTimer: ReturnType<typeof setTimeout> | null = null;
	const unsubscribeBoundaryBump = readerBoundaryBump.subscribe((bump) => {
		if (!bump) return;
		// 'end' = no next page; the next-page edge is left in RTL, right in LTR.
		const side =
			bump.direction === 'end'
				? get(readingDirection) === 'rtl' ? 'left' : 'right'
				: get(readingDirection) === 'rtl' ? 'right' : 'left';
		boundaryFlash = { side, seq: bump.seq };
		playReaderHaptic('boundary');
		if (boundaryFlashTimer) clearTimeout(boundaryFlashTimer);
		boundaryFlashTimer = setTimeout(() => { boundaryFlash = null; }, 550);
	});
	/** Monotonic counter to discard stale createPageSource results */
	let pageSourceGeneration = 0;
	/** Monotonic counter to discard stale page image completions and retries */
	let pageLoadGeneration = 0;
	let activeAutoTranslationRunId: number | null = null;
	let activeAutoTranslationActivity: PageTranslationActivityToken | null = null;
	let autoTranslationScheduleGeneration = 0;

	function currentProgressiveTarget(): ProgressivePageTranslationTarget | null {
		const sessionId = get(readerSessionId);
		const volume = get(currentVolume);
		return sessionId && volume ? {
			readerSessionId: sessionId,
			targetEpoch: get(readerTargetEpoch),
			volumeUuid: volume.volume_uuid,
			pageIndex: get(currentPageIndex)
		} : null;
	}

	function autoTranslationAbortError(): DOMException {
		return new DOMException(m.reader_reader_auto_translation_cancelled(), 'AbortError');
	}

	function autoTranslationTargetIsCurrent(target: ReaderAutoTranslationTarget): boolean {
		return get(readerSessionId) === target.readerSessionId
			&& get(readerTargetEpoch) === target.targetEpoch
			&& get(currentVolume)?.volume_uuid === target.volumeUuid
			&& get(currentPageIndex) === target.pageIndex
			&& get(settings).readerAutoTranslateOverlays
			&& get(settings).overlayEnabled
			&& !autoTranslationSuspendedForBenchmark;
	}

	function targetHasPageTranslationActivity(target: Readonly<ReaderAutoTranslationTarget>): boolean {
		return get(pageTranslationActivities).some((activity) =>
			activity.target.volumeUuid === target.volumeUuid
			&& activity.target.pageIndex === target.pageIndex
		);
	}

	async function waitForPageTranslationIdle(
		target: Readonly<ReaderAutoTranslationTarget>,
		signal: AbortSignal
	): Promise<void> {
		if (signal.aborted) throw autoTranslationAbortError();
		if (!targetHasPageTranslationActivity(target)) return;
		await new Promise<void>((resolve, reject) => {
			let unsubscribe: (() => void) | null = null;
			let settled = false;
			const cleanup = () => {
				unsubscribe?.();
				signal.removeEventListener('abort', onAbort);
			};
			const onAbort = () => {
				cleanup();
				reject(autoTranslationAbortError());
			};
			unsubscribe = pageTranslationActivities.subscribe((activities) => {
				if (activities.some((activity) =>
					activity.target.volumeUuid === target.volumeUuid
					&& activity.target.pageIndex === target.pageIndex
				)) return;
				settled = true;
				cleanup();
				resolve();
			});
			if (settled) unsubscribe();
			signal.addEventListener('abort', onAbort, { once: true });
			if (settled) signal.removeEventListener('abort', onAbort);
		});
	}

	// A manual attempt that failed leaves its chip up until the reader dismisses
	// it. An automatic run that then supplies the page makes that chip a lie —
	// "failed", with the translation on screen — so the success retires it.
	function retireSupersededManualFailure(target: Readonly<ReaderAutoTranslationTarget>): void {
		if (readerPageTranslationController.inspect().phase !== 'failed') return;
		readerPageTranslationController.acknowledgeTerminalState(target);
	}

	async function runAutomaticPageTranslation(
		target: Readonly<ReaderAutoTranslationTarget>,
		context: ReaderAutoTranslationRunContext
	): Promise<void> {
		const { signal, runId } = context;
		if (!autoTranslationTargetIsCurrent(target)) return;

		const ticket = pageDataLoadTicket;
		if (ticket?.volumeUuid === target.volumeUuid && ticket.pageIndex === target.pageIndex) {
			await ticket.promise;
		}
		if (signal.aborted) throw autoTranslationAbortError();
		if (!autoTranslationTargetIsCurrent(target)) return;

		// Persisted overlay/no-text data is authoritative. Do not spend battery or
		// provider tokens revisiting a page that already has a usable outcome.
		if (readerPageTranslationOutcomeIsUsable(
			get(currentPageOverlay),
			get(currentPageTranslation)
		)) return;

		// Manual page translation owns the same global activity flag. Wait for it to
		// settle after page-change cancellation before starting the latest auto target.
		await waitForPageTranslationIdle(target, signal);
		if (!autoTranslationTargetIsCurrent(target)) return;
		// The manual owner we just awaited may have supplied the page outcome.
		// Re-probe before acquiring activity or invoking OCR/provider work.
		if (readerPageTranslationOutcomeIsUsable(
			get(currentPageOverlay),
			get(currentPageTranslation)
		)) return;

		const volume = get(currentVolume);
		if (!volume || volume.volume_uuid !== target.volumeUuid) return;
		activeAutoTranslationRunId = runId;
		activeAutoTranslationActivity = acquirePageTranslationActivity('automatic', target, {
			cancel: () => autoTranslationScheduler.cancel()
		});
		isOverlayMode.set(true);

		let source: PageSource | null = null;
		try {
			source = await createPageSource(volume, { signal });
			const imageFile = await source.getPageAsFile(target.pageIndex, { signal });
			if (signal.aborted || !autoTranslationTargetIsCurrent(target)) {
				throw autoTranslationAbortError();
			}

			const currentSettings = get(settings);
			if (currentSettings.translationPipeline === 'on-device') {
				const { translatePageOnDevice } = await import('$lib/translation/on-device-service.js');
				const previewTarget = currentProgressiveTarget();
				if (
					!previewTarget
					|| previewTarget.readerSessionId !== target.readerSessionId
					|| previewTarget.targetEpoch !== target.targetEpoch
					|| previewTarget.volumeUuid !== target.volumeUuid
					|| previewTarget.pageIndex !== target.pageIndex
				) throw autoTranslationAbortError();
				const previewToken = progressivePageTranslationPreview.begin(previewTarget, previewTarget);
				try {
					const result = await translatePageOnDevice(target.volumeUuid, target.pageIndex, imageFile, {
						signal,
						shouldPublishProgressiveUpdate: () => (
							activeAutoTranslationRunId === runId
							&& autoTranslationTargetIsCurrent(target)
						),
						onProgressiveSnapshot: (snapshot) => {
							progressivePageTranslationPreview.publish(
								previewToken,
								snapshot,
								currentProgressiveTarget()
							);
						}
					});
					if (activeAutoTranslationRunId === runId && autoTranslationTargetIsCurrent(target)) {
						const finalSnapshot: ProgressivePageTranslationSnapshot = {
							target: { volumeUuid: target.volumeUuid, pageIndex: target.pageIndex },
							pageTranslation: result.pageTranslation,
							overlayData: result.overlayData
						};
						const committed = progressivePageTranslationPreview.commit(
							previewToken,
							finalSnapshot,
							currentProgressiveTarget()
						);
						if (!committed) throw autoTranslationAbortError();
						if (!result.partialFailure) retireSupersededManualFailure(target);
						if (result.partialFailure) {
							// Committed above: the rollback in the catch is a no-op, so
							// the translated overlays stay while the failure surfaces.
							const { TranslationCoverageError } = await import('$lib/translation/translation-coverage.js');
							throw new TranslationCoverageError(
								'invalid-output',
								result.partialFailure.requiredCount,
								result.partialFailure.translatedRequiredCount,
								result.partialFailure.failedBlockIndexes
							);
						}
					} else {
						progressivePageTranslationPreview.abandon(previewToken);
					}
				} catch (error) {
					progressivePageTranslationPreview.rollback(previewToken, currentProgressiveTarget());
					throw error;
				}
			} else {
				const { translateFullPageWithOverlay } = await import('$lib/translation/full-page-service.js');
				const result = await translateFullPageWithOverlay(
					target.volumeUuid,
					target.pageIndex,
					imageFile,
					undefined,
					{
						signal,
						shouldPublishAsyncResult: () => (
							activeAutoTranslationRunId === runId
							&& autoTranslationTargetIsCurrent(target)
						),
						onPersisted: (persisted) => {
							if (
								activeAutoTranslationRunId === runId
								&& autoTranslationTargetIsCurrent(target)
							) {
								setCurrentPageTranslationPayload(
									persisted.pageTranslation,
									persisted.overlayData
								);
							}
						}
					}
				);
				if (activeAutoTranslationRunId === runId && autoTranslationTargetIsCurrent(target)) {
					setCurrentPageTranslationPayload(result.pageTranslation, result.overlayData);
					retireSupersededManualFailure(target);
				}
			}
		} finally {
			source?.dispose();
			if (activeAutoTranslationRunId === runId) {
				activeAutoTranslationRunId = null;
				releasePageTranslationActivity(activeAutoTranslationActivity);
				activeAutoTranslationActivity = null;
			}
		}
	}

	const autoTranslationScheduler = createReaderAutoTranslationScheduler(runAutomaticPageTranslation);
	let autoTranslationSchedulerState = $state(autoTranslationScheduler.inspect());
	const unsubscribeAutoTranslationScheduler = autoTranslationScheduler.subscribe((state) => {
		autoTranslationSchedulerState = state;
	});
	const unregisterAutomaticTranslationOwner = registerAutomaticPageTranslationOwner({
		inspectTarget: () => benchmarkOwnerTarget ?? autoTranslationScheduler.inspect().active?.target ?? null,
		cancel: () => {
			benchmarkPageController?.abort();
			autoTranslationScheduler.cancel();
		},
		waitForIdle: async () => {
			await Promise.all([
				waitForAutoTranslationSchedulerIdle(),
				waitForBenchmarkTranslationIdle()
			]);
		}
	});

	async function waitForAutoTranslationSchedulerIdle(): Promise<void> {
		if (!autoTranslationScheduler.inspect().active) return;
		await new Promise<void>((resolve) => {
			let unsubscribe: (() => void) | null = null;
			let settled = false;
			unsubscribe = autoTranslationScheduler.subscribe((state) => {
				if (state.active) return;
				settled = true;
				unsubscribe?.();
				resolve();
			});
			if (settled) unsubscribe();
		});
	}

	async function waitForReaderTranslationIdleForBenchmark(): Promise<void> {
		await waitForAutoTranslationSchedulerIdle();
		if (!get(isPageTranslating)) return;
		await new Promise<void>((resolve) => {
			let unsubscribe: (() => void) | null = null;
			let settled = false;
			unsubscribe = isPageTranslating.subscribe((busy) => {
				if (busy) return;
				settled = true;
				unsubscribe?.();
				resolve();
			});
			if (settled) unsubscribe();
		});
	}

	const imageCache = new ImageCache();

	// Set up dimensions callback for lazy measurement (remote pages)
	imageCache.setDimensionsCallback(async (index, width, height, measuredSource) => {
		const vol = get(currentVolume);
		const volumeUuid = vol?.volume_uuid;
		const sourceGen = pageSourceGeneration;
		if (!volumeUuid || pageSource !== measuredSource) return;

		// Update in-memory store
		pageDimensions.update((pages) =>
			pages.map((p) =>
				p.index === index && p.width === 0 ? { ...p, width, height } : p
			)
		);
		if (benchmarkPersistenceSuppressed()) return;

		// Persist to DB for future reads
		const dims = await db.page_dimensions.get(volumeUuid);
		const currentVol = get(currentVolume);
		if (
			benchmarkPersistenceSuppressed() ||
			pageSourceGeneration !== sourceGen ||
			pageSource !== measuredSource ||
			currentVol?.volume_uuid !== volumeUuid
		) return;

		if (dims) {
			const page = dims.pages[index];
			if (page && page.width === 0) {
				page.width = width;
				page.height = height;
				await db.page_dimensions.put(dims);
			}
		}
	});

	/**
	 * What the page source is actually built from. Anything else on the volume —
	 * `current_page`, `last_read_at`, a title edit, a reading-direction toggle —
	 * changes the object without changing the source.
	 */
	function pageSourceIdentity(volume: typeof $currentVolume): string | null {
		if (!volume?.volume_uuid) return null;
		return JSON.stringify([volume.volume_uuid, volume.source ?? null, volume.page_count]);
	}
	let activePageSourceIdentity: string | null = null;

	// Load page source when the volume's SOURCE changes.
	//
	// A store subscription fires on every set, not on the properties read, so
	// this effect used to tear down and rebuild the whole pipeline on any
	// in-place volume write — and the reader writes `current_page` as you turn
	// pages. For YACReader that meant releasing and re-acquiring the session
	// lease, which is single-flight transport against a server that crashes on
	// concurrent connections, on every page turn.
	$effect(() => {
		const identity = pageSourceIdentity($currentVolume);
		if (identity === untrack(() => activePageSourceIdentity)) return;
		activePageSourceIdentity = identity;
		const vol = untrack(() => $currentVolume);
		const volumeUuid = vol?.volume_uuid;

		// Invalidate image work and clear the displayed page before disposing the
		// previous source (untrack avoids a self-triggering effect loop).
		const prevSource = untrack(() => pageSource);
		const gen = ++pageSourceGeneration;
		pageLoadGeneration += 1;
		imageUrl = null;
		pageLoadError = null;
		pageSource = null;
		imageCache.clearPageSource();
		prevSource?.dispose();

		if (!vol || !volumeUuid) return;

		createPageSource(vol, { purpose: 'reader' }).then((source) => {
			if (
				gen !== pageSourceGeneration ||
				get(currentVolume)?.volume_uuid !== volumeUuid
			) {
				// A newer volume change occurred — discard this stale result
				source.dispose();
				return;
			}
			pageSource = source;
			imageCache.setPageSource(source);

			// If a source resolves its page count after the volume metadata was loaded,
			// populate placeholders so the reader counter and navigation stay usable.
			if (source.pageCount > 0 && get(pageDimensions).length === 0) {
				pageDimensions.set(
					Array.from({ length: source.pageCount }, (_, i) => ({
						index: i,
						width: 0,
						height: 0,
						filename: `page_${i + 1}`,
					}))
				);
			}
		}).catch((err) => {
			if (
				gen !== pageSourceGeneration ||
				get(currentVolume)?.volume_uuid !== volumeUuid
			) return;
			console.error('Failed to create page source:', err);
			pageLoadError = err instanceof Error ? err.message : m.reader_failed_to_load_volume();
		});
	});

	// Update image cache when page changes (paged mode only — the long strip
	// loads its own page window and must not fight this pipeline for URLs).
	$effect(() => {
		const idx = $currentPageIndex;
		const vol = $currentVolume;
		const source = pageSource;
		const sourceGen = pageSourceGeneration;
		const requestGen = ++pageLoadGeneration;

		// Never leave the prior page visible while the next page/source is loading.
		imageUrl = null;
		pageLoadError = null;
		if (longStripActive) return;
		if (!vol || !source) return;

		const volumeUuid = vol.volume_uuid;
		const isCurrentRequest = () => (
			requestGen === pageLoadGeneration &&
			sourceGen === pageSourceGeneration &&
			pageSource === source &&
			get(currentVolume)?.volume_uuid === volumeUuid &&
			get(currentPageIndex) === idx
		);

		imageCache.updateWindow(idx);

		// Try synchronous first, then async fallback
		const syncUrl = imageCache.getImageSync(idx);
		if (syncUrl && isCurrentRequest()) {
			imageUrl = syncUrl;
			scheduleSuccessfulPageProgress(vol, idx, source, sourceGen);
		} else {
			imageCache.getImage(idx).then((url) => {
				if (isCurrentRequest()) {
					imageUrl = url;
					scheduleSuccessfulPageProgress(vol, idx, source, sourceGen);
				}
			}).catch((err) => {
				if (isCurrentRequest()) {
					pageLoadError = err instanceof Error ? err.message : m.reader_failed_to_load_page();
				}
			});
		}
	});

	// Load translation regions/data when page changes
	// (loadPageData also restores persisted overlay data from IndexedDB)
	$effect(() => {
		const vol = $currentVolume;
		const idx = $currentPageIndex;
		if (!vol) {
			pageDataLoadGeneration += 1;
			pageDataLoadTicket = null;
			clearPageData();
			return;
		}
		const ticket: PageDataLoadTicket = {
			volumeUuid: vol.volume_uuid,
			pageIndex: idx,
			generation: ++pageDataLoadGeneration,
			promise: Promise.resolve(),
			ready: false,
			error: null
		};
		pageDataLoadTicket = ticket;
		ticket.promise = loadPageData(vol.volume_uuid, idx).then(
			() => {
				if (pageDataLoadTicket === ticket) ticket.ready = true;
			},
			(error) => {
				if (pageDataLoadTicket === ticket) {
					ticket.error = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		);
		// The benchmark awaits the exact ticket. Normal reader loads remain
		// fire-and-forget without producing an unhandled rejection.
		void ticket.promise.catch(() => {});
	});

	// Latest-page-wins automatic overlay translation. The scheduler aborts an old
	// page immediately, but does not begin the newest callback until the old one has
	// fully settled, guaranteeing a single OCR/translation job at a time.
	$effect(() => {
		const generation = ++autoTranslationScheduleGeneration;
		const enabled = $settings.readerAutoTranslateOverlays ?? false;
		const overlaysEnabled = $settings.overlayEnabled;
		const suspended = autoTranslationSuspendedForBenchmark;
		const volume = $currentVolume;
		const pageIndex = $currentPageIndex;
		const sessionId = $readerSessionId;
		const targetEpoch = $readerTargetEpoch;
		// Video pages are never scheduled: nothing to OCR, and the detector
		// must not receive a video blob. Reactive, so leaving the video page
		// resumes normal scheduling.
		const pageIsVideo = currentPageIsVideo;
		if (!enabled || !overlaysEnabled || suspended || !volume || !sessionId || pageIsVideo) {
			autoTranslationScheduler.cancel();
			return;
		}
		const target = {
			readerSessionId: sessionId,
			targetEpoch,
			volumeUuid: volume.volume_uuid,
			pageIndex
		};
		void tick().then(() => {
			if (generation !== autoTranslationScheduleGeneration) return;
			return autoTranslationScheduler.request(target);
		});
	});

	// Save reading progress only after the requested page image has committed.
	// This prevents failed and stale page requests from advancing local or server
	// progress. Opening at a saved page is harmless to persist again and ensures
	// the YACReader server is reconciled even when local and remote progress had
	// previously diverged.
	let saveProgressTimer: ReturnType<typeof setTimeout> | undefined;
	type ScheduledProgressSave = { persist: (force?: boolean) => Promise<void> };
	let pendingProgressSave: ScheduledProgressSave | undefined;
	function scheduleSuccessfulPageProgress(
		vol: VolumeMetadata,
		idx: number,
		source: PageSource,
		sourceGen: number
	) {
		clearTimeout(saveProgressTimer);
		if (benchmarkPersistenceSuppressed()) {
			saveProgressTimer = undefined;
			pendingProgressSave = undefined;
			return;
		}
		const volumeUuid = vol.volume_uuid;
		// This function is only reached once the requested page image has
		// committed, which makes it the authority on what the reader actually
		// showed. leaveReader persists from here rather than from
		// currentPageIndex, which moves as soon as navigation is requested.
		recordCommittedPage(volumeUuid, idx);
		const isStillCurrent = () => (
			sourceGen === pageSourceGeneration &&
			pageSource === source &&
			get(currentVolume)?.volume_uuid === volumeUuid &&
			get(currentPageIndex) === idx
		);

		const scheduled: ScheduledProgressSave = {
			persist: async (force = false) => {
				// The normal debounce must reject stale page/source work. A forced
				// flush is used only during component teardown for the last page that
				// already committed successfully.
				if (!force && !isStillCurrent()) return;
				// Start the local save and enqueue the remote write in the same turn.
				// Awaiting IndexedDB first lets catalog refreshes and stale page
				// prefetches get ahead of the teardown progress write.
					const localProgressSave = updateVolume(volumeUuid, {
							current_page: idx,
							last_read_at: new Date().toISOString()
						}).then(() => {
							queueTabPreview({ ...vol, current_page: idx }, idx, 10);
						}).catch((err) => {
					console.debug('[PageViewer] Local progress persistence failed:', err);
				});

				// Once a valid persistence operation has started, finish its remote
				// write even if the reader closes while the IndexedDB update awaits.
				let remoteProgressSave: Promise<void> = Promise.resolve();
				if (vol.source?.type === 'yacreader') {
					const client = getOrCreateClient(vol.source.serverUrl);
					remoteProgressSave = client.updateProgress(
							vol.source.remoteLibraryId,
							vol.source.remoteComicId,
							idx
						).catch((err) => {
						// Server progress is best-effort and must never interrupt reading.
						console.debug('[PageViewer] YACReader progress update failed:', err);
						});
				}
				await Promise.all([localProgressSave, remoteProgressSave]);
			}
		};
		pendingProgressSave = scheduled;
		saveProgressTimer = setTimeout(() => {
			if (pendingProgressSave === scheduled) pendingProgressSave = undefined;
			void scheduled.persist();
		}, 500);
	}

	// Update page dimensions for display. A quarter-turn view rotation swaps
	// the dimensions panzoom fits against; the stored page geometry (and every
	// overlay coordinate) stays in the image's own pixel space.
	$effect(() => {
		const info = $currentPageInfo;
		if (info) {
			pageWidth = info.width;
			pageHeight = info.height;
			if (!longStripActive) {
				const quarterTurn = $pageRotation % 180 !== 0;
				setContentDimensions(quarterTurn ? info.height : info.width, quarterTurn ? info.width : info.height);
			}
		}
	});

	// Screen-space interactions (drawing, box move/resize, the floating box
	// editor) map client coordinates assuming panzoom's translate+scale is the
	// only transform — so the view rotation clears as soon as one is on the
	// horizon. Box SELECTION is the trigger for move/resize (the chips appear
	// before any handle drag), which guarantees the gesture that follows
	// captures its geometry against an already-upright page.
	$effect(() => {
		if ($pageRotation === 0) return;
		if (
			$isDrawingMode
			|| $selectedOverlayBoxId != null
			|| $movingBoxId != null
			|| $resizingBoxId != null
			|| floatingEditTarget != null
			// Guided-region review resolves taps by scaling client coordinates
			// through the canvas's bounding box, which is the AXIS-ALIGNED box of
			// a rotated canvas — under a quarter turn screen-x maps to image-y and
			// the tap lands on the wrong region. Review popovers (and the reveal
			// popover) also live inside the rotated surface, so their text would
			// render sideways at 90/270 and upside-down at 180. Snapping upright
			// here is what the floating box editor already relies on.
			|| $highlightedDrawRegionIds.size > 0
		) {
			pageRotation.set(0);
		}
	});

	// Long-strip mode: the paged image-commit path is gated off, so persist
	// reading progress when the tracked (majority-visible) page settles.
	$effect(() => {
		if (!longStripActive) return;
		const vol = $currentVolume;
		const idx = $currentPageIndex;
		const source = pageSource;
		if (!vol || !source) return;
		scheduleSuccessfulPageProgress(vol, idx, source, pageSourceGeneration);
	});

	// Reset initial load flag when volume changes
	$effect(() => {
		$currentVolume;
		isInitialLoad = true;
		lastScheduledFitIdentity = '';
	});

	// Load per-volume overlay font scale when volume changes; volumes without
	// their own scale use the global default (Settings → Overlay → Text Size).
	$effect(() => {
		const vol = $currentVolume;
		if (!vol) return;
		const saved = (vol as any).overlay_font_scale;
		overlayFontScale.set(
			typeof saved === 'number' ? saved : ($settings.overlayFontScaleDefault ?? 1.0)
		);
	});

	// Fit only after the exact page image has committed and its keyed Panzoom DOM is
	// mounted. A page-index-only tick can run while the old Panzoom is already
	// disposed and the new async image is not mounted yet, silently losing the fit.
	$effect(() => {
		const volumeUuid = $currentVolume?.volume_uuid;
		const pageIndex = $currentPageIndex;
		const committedImageUrl = imageUrl;
		const width = pageWidth;
		const height = pageHeight;
		if (!volumeUuid || !committedImageUrl || width <= 0 || height <= 0 || !viewportEl) return;
		const identity = `${volumeUuid}:${pageIndex}:${committedImageUrl}:${width}x${height}:r${$pageRotation}:p${panzoomEpoch}`;
		if (identity === lastScheduledFitIdentity) return;
		lastScheduledFitIdentity = identity;
		isInitialLoad = false;
		void tick().then(() => {
			if (identity !== lastScheduledFitIdentity || imageUrl !== committedImageUrl) return;
			if (pageFitRafId !== undefined) cancelAnimationFrame(pageFitRafId);
			if (pageFitSecondRafId !== undefined) cancelAnimationFrame(pageFitSecondRafId);
			pageFitRafId = requestAnimationFrame(() => {
				pageFitRafId = undefined;
				pageFitSecondRafId = requestAnimationFrame(() => {
					pageFitSecondRafId = undefined;
					if (
						identity === lastScheduledFitIdentity
						&& imageUrl === committedImageUrl
						&& get(currentVolume)?.volume_uuid === volumeUuid
						&& get(currentPageIndex) === pageIndex
					) {
						// Same never-refit-under-the-editor rule as the
						// ResizeObserver: a rotation cleared BY opening the
						// editor must not yank the page beneath the dialog.
						if (floatingEditTarget != null) {
							pendingEditorRefit = true;
							return;
						}
						zoomFitToScreen();
					}
				});
			});
		});
	});

	// Retry loading current page
	function retryPageLoad() {
		pageLoadError = null;
		imageUrl = null;
		const idx = $currentPageIndex;
		const vol = $currentVolume;
		const source = pageSource;
		if (!vol || !source) return;

		const volumeUuid = vol.volume_uuid;
		const sourceGen = pageSourceGeneration;
		const requestGen = ++pageLoadGeneration;
		const isCurrentRequest = () => (
			requestGen === pageLoadGeneration &&
			sourceGen === pageSourceGeneration &&
			pageSource === source &&
			get(currentVolume)?.volume_uuid === volumeUuid &&
			get(currentPageIndex) === idx
		);

		imageCache.updateWindow(idx);
		imageCache.getImage(idx).then((url) => {
			if (isCurrentRequest()) {
				imageUrl = url;
				scheduleSuccessfulPageProgress(vol, idx, source, sourceGen);
			}
		}).catch((err) => {
			if (isCurrentRequest()) {
				pageLoadError = err instanceof Error ? err.message : m.reader_failed_to_load_page();
			}
		});
	}

	// Lock panzoom when drawing mode is active so the page cannot be panned/zoomed
	$effect(() => {
		if (longStripActive) return;
		if ($isDrawingMode) {
			pausePanzoom();
		} else {
			resumePanzoom();
		}
	});

	// Keyboard navigation
	function handleKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
		// The scrubber owns keyboard input while its modal overlay is visible.
		// In particular, ArrowLeft/ArrowRight must not turn the page underneath it.
		if ($pageThumbnailScrubberOpen) return;

		const rtl = $readingDirection === 'rtl';

		switch (e.key) {
			case 'ArrowLeft':
				if ($isDrawingMode) break;
				rtl ? nextPage() : prevPage();
				e.preventDefault();
				break;
			case 'ArrowRight':
				if ($isDrawingMode) break;
				rtl ? prevPage() : nextPage();
				e.preventDefault();
				break;
			case 'Escape':
				if ($isDrawingMode) {
					isDrawingMode.set(false);
					e.preventDefault();
				}
				break;
			case 'd':
			case 'D':
				// Region drawing needs the paged surface; unavailable in long-strip.
				if (!e.ctrlKey && !e.metaKey && !longStripActive) {
					isDrawingMode.update((v) => !v);
					e.preventDefault();
				}
				break;
			case 't':
			case 'T':
				if (!e.ctrlKey && !e.metaKey && $settings.overlayEnabled) {
					isOverlayMode.update((v) => !v);
					e.preventDefault();
				}
				break;
			case 'r':
			case 'R':
				// View-only quarter-turn; the paged surface owns the rotation frame.
				if (!e.ctrlKey && !e.metaKey && !longStripActive) {
					rotateCurrentPage();
					e.preventDefault();
				}
				break;
		}
	}

	// Click-to-navigate: clicking empty areas beside the manga page turns pages
	function handleViewportClick(e: MouseEvent) {
		// Only handle clicks on the viewport background itself, not on children (image, overlays)
		if (e.target !== viewportEl) return;
		// Don't navigate in drawing mode
		if ($isDrawingMode) return;

		const rect = viewportEl!.getBoundingClientRect();
		const relativeX = (e.clientX - rect.left) / rect.width;
		const rtl = $readingDirection === 'rtl';

		if (relativeX < 0.33) {
			// Left third
			rtl ? nextPage() : prevPage();
		} else if (relativeX > 0.67) {
			// Right third
			rtl ? prevPage() : nextPage();
		}
		// Middle third: do nothing (allow panzoom interaction)
	}

	// Dynamic cursor for gutter zones
	function handleViewportMouseMove(e: MouseEvent) {
		if (!viewportEl || e.target !== viewportEl || $isDrawingMode) {
			if (viewportEl) viewportEl.style.cursor = '';
			return;
		}

		const rect = viewportEl.getBoundingClientRect();
		const relativeX = (e.clientX - rect.left) / rect.width;

		if (relativeX < 0.33) {
			viewportEl.style.cursor = 'w-resize';
		} else if (relativeX > 0.67) {
			viewportEl.style.cursor = 'e-resize';
		} else {
			viewportEl.style.cursor = '';
		}
	}

	// ── Swipe navigation & double-tap (mobile) ──
	// Panzoom calls stopPropagation() in its onTouch handler, so Svelte event
	// handlers on the viewport div never fire.  We work around this by attaching
	// *capturing* listeners directly on the viewport element so we see every
	// touch before panzoom consumes it.

	let swipeStartX = 0;
	let swipeStartY = 0;
	let swipeStartTime = 0;
	let wasMultiTouch = false;
	let touchGestureRecorded = false;
	let touchStartedOnInteractiveControl = false;
	let touchStartedOnOverlayTapSurface = false;

	// Double-tap detection state
	let lastTapTime = 0;
	let lastTapX = 0;
	let lastTapY = 0;

	// Pending tap timer for tap-to-navigate (delayed to avoid conflict with double-tap zoom)
	let pendingTapTimer: ReturnType<typeof setTimeout> | null = null;

	function isInteractiveReaderTouchTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Element)) return false;
		return Boolean(target.closest(
			'button, input, select, textarea, a, [contenteditable="true"], '
				+ '[data-floating-box-editor], [data-dialog]'
		));
	}

	/**
	 * Surfaces whose taps are fully handled by their own click handlers
	 * (mirrors the panzoom touch-exemption list). A tap that BEGINS on one of
	 * these must never also drive chrome/page decisions — the two handlers
	 * would fight over the same contact: chrome toggling under the popover
	 * while the disclosure guard closes what the click was about to open.
	 * Swipes that merely start on them still turn pages.
	 */
	function isOverlayOwnedTapTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Element)) return false;
		return Boolean(target.closest(
			'[data-overlay-fit-mode="reveal"], [data-overlay-reveal-backdrop], '
				+ '[data-overlay-reveal-popover], [data-region-review-backdrop], '
				+ '[data-region-review-popover]'
		));
	}

	/** Disclosure state when the in-flight gesture began (null = none open). */
	let disclosureAtGestureStart: ReturnType<typeof mobileReaderUi.inspect>['disclosure'] = null;

	function handleSwipeStartCapture(e: TouchEvent) {
		// Every new contact starts with a clean tap-ownership slate: a claim
		// leaked by a gesture that ended in an unobserved touchcancel must
		// never eat this one.
		resetReaderTapClaim();
		// Long-strip scrolls natively; LongStripViewer owns its own tap
		// detection, so the paged swipe/tap machinery must stand down.
		if (longStripActive || $isDrawingMode) {
			touchGestureRecorded = false;
			return;
		}
		if (e.touches.length > 1) {
			wasMultiTouch = true;
			touchGestureRecorded = false;
			return;
		}
		wasMultiTouch = false;
		touchGestureRecorded = true;
		touchStartedOnInteractiveControl = isInteractiveReaderTouchTarget(e.target);
		touchStartedOnOverlayTapSurface = isOverlayOwnedTapTarget(e.target);
		disclosureAtGestureStart = mobileReaderUi.inspect().disclosure;
		swipeStartX = e.touches[0].clientX;
		swipeStartY = e.touches[0].clientY;
		// Input-time clock: Date.now() here measures event DELIVERY, which
		// main-thread jank (overlay planning, on-device inference callbacks)
		// pushes hundreds of ms past the physical contact — silently turning
		// real taps into rejected gestures. Event timeStamps carry input time.
		swipeStartTime = e.timeStamp;
	}

	function handleSwipeCancelCapture() {
		// The system stole the contact (notification shade, edge gesture, app
		// switch): drop every per-gesture flag so nothing leaks into — and
		// silently eats — the user's next tap.
		resetReaderTapClaim();
		touchGestureRecorded = false;
		wasMultiTouch = false;
	}

	function applyReaderTouchDecision(
		decision: ReaderTouchDecision,
		openDisclosureBeforeGesture: ReturnType<typeof mobileReaderUi.inspect>['disclosure'] | undefined = undefined
	): void {
		const openDisclosure = mobileReaderUi.inspect().disclosure;
		if (openDisclosure !== null) {
			// While a reader popover is open, the first tap or swipe outside it
			// only dismisses — it never turns pages or toggles chrome (strict
			// popover exclusivity). That rule applies to popovers that PRE-DATE
			// the gesture. A disclosure opened mid-gesture belongs to whatever
			// pointer/click handler opened it: dismissing it here would close a
			// popover in the same contact that requested it.
			if (openDisclosureBeforeGesture === undefined || openDisclosureBeforeGesture !== null) {
				mobileReaderUi.closeDisclosure();
			}
			return;
		}
		switch (decision) {
			case 'toggle-controls':
				mobileReaderUi.toggleChrome();
				break;
			case 'previous-page':
				prevPage();
				break;
			case 'next-page':
				nextPage();
				break;
		}
	}

	function handleSwipeEndCapture(e: TouchEvent) {
		if (longStripActive || $isDrawingMode) {
			touchGestureRecorded = false;
			return;
		}
		// An overlay pointer handler (long-press selection, region-review tap)
		// already owns this contact; pointer events precede the paired
		// touchend, so its claim is visible here. Stand down entirely.
		if (consumeReaderTapClaim()) {
			touchGestureRecorded = false;
			return;
		}
		// If this gesture involved multiple fingers (pinch/zoom), skip swipe/tap detection
		if (e.touches.length > 0) { wasMultiTouch = true; touchGestureRecorded = false; return; }
		if (wasMultiTouch) { wasMultiTouch = false; touchGestureRecorded = false; return; }
		if (!touchGestureRecorded || touchStartedOnInteractiveControl || $pageThumbnailScrubberOpen) {
			touchGestureRecorded = false;
			return;
		}
		touchGestureRecorded = false;
		const touch = e.changedTouches[0];
		const dx = touch.clientX - swipeStartX;
		const dy = touch.clientY - swipeStartY;
		// Same input-time clock as swipeStartTime (see handleSwipeStartCapture).
		const dt = e.timeStamp - swipeStartTime;
		const turnMode = $settings.pageTurnMode ?? 'swipe';
		if (!viewportEl) return;
		const rect = viewportEl.getBoundingClientRect();
		const decision = decideReaderTouch({
			startX: swipeStartX,
			startY: swipeStartY,
			endX: touch.clientX,
			endY: touch.clientY,
			durationMs: dt,
			viewportLeft: rect.left,
			viewportWidth: rect.width,
			pageTurnMode: turnMode,
			readingDirection: $readingDirection
		});
		const gestureWasTap = Math.abs(dx) < READER_TAP_MAX_AXIS_DELTA_PX
			&& Math.abs(dy) < READER_TAP_MAX_AXIS_DELTA_PX
			&& dt < READER_TAP_MAX_DURATION_MS;

		// Taps that began on a self-handling overlay surface (reveal balloons,
		// reveal/region popovers and their backdrops) belong to that surface's
		// own click handler. Swipes that merely start there still turn pages.
		if (gestureWasTap && touchStartedOnOverlayTapSurface) return;

		// A stationary center tap must always expose a way out of drawing mode.
		// Drawing drags and page turns remain mutually exclusive.
		if ($isDrawingMode && decision !== 'toggle-controls') return;

		if (decision === 'previous-page' || decision === 'next-page') {
			// Side thirds never participate in center double-tap zoom, so both taps and
			// swipes can navigate immediately without a perceptible 300 ms delay. A
			// still-pending center-tap toggle must not fire after the user has
			// already moved on to turning pages.
			if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
			applyReaderTouchDecision(decision, disclosureAtGestureStart);
			if (gestureWasTap) lastTapTime = 0;
			return;
		}

		// Double-tap detection: two taps within 300ms and 40px of each other,
		// near the center third of the viewport. Only meaningful while zoomed
		// away from fit — at fit scale the fit gesture is a no-op, and treating
		// quick repeated center taps as double-taps silently ate every other
		// chrome toggle.
		if (gestureWasTap) {
			const now = e.timeStamp;
			const tapDx = Math.abs(touch.clientX - lastTapX);
			const tapDy = Math.abs(touch.clientY - lastTapY);

			if (!$isDrawingMode && !isAtFitScreenScale() && now - lastTapTime < 300 && tapDx < 40 && tapDy < 40) {
				// Double-tap detected — cancel any pending tap navigation
				if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
				const relX = (touch.clientX - rect.left) / rect.width;
				if (relX >= 1 / 3 && relX <= 2 / 3) {
					zoomFitToScreen();
					lastTapTime = 0; // Reset so triple-tap doesn't re-trigger
					return;
				}
			}

			lastTapTime = now;
			lastTapX = touch.clientX;
			lastTapY = touch.clientY;
		}

		if (decision !== 'none') {
			if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
			// At fit scale double-tap-to-fit is a no-op, so the center tap does not
			// need to wait out the 300 ms double-tap window (UX report U4).
			if (isAtFitScreenScale()) {
				applyReaderTouchDecision(decision, disclosureAtGestureStart);
				return;
			}
			const disclosureSnapshot = disclosureAtGestureStart;
			pendingTapTimer = setTimeout(() => {
				pendingTapTimer = null;
				applyReaderTouchDecision(decision, disclosureSnapshot);
			}, 300);
		}
	}

	// Wheel handler (capture, passive: false to prevent browser zoom)
	function wheelHandler(e: WheelEvent) {
		// Long-strip scrolls natively; the panzoom wheel handler would
		// preventDefault and freeze the strip on desktop.
		if (longStripActive || $isDrawingMode) return;
		handleWheel(e);
	}

	// ResizeObserver for re-centering when sidebar toggles or window resizes
	let resizeObserver: ResizeObserver | undefined;
	let resizeRafId: number | undefined;

	// Every new Panzoom instance invalidates the fit identity, so the page is
	// fitted again after any arm swap in the template's if-chain.
	const unsubscribePanzoomEpoch = panzoomStore.subscribe((instance) => {
		if (instance) panzoomEpoch += 1;
	});

	onMount(() => {
		installOnDeviceBenchmarkApi();
		installReaderUiTestApi();
		if (viewportEl) {
			setViewport(viewportEl);

			resizeObserver = new ResizeObserver(() => {
				// Debounce with rAF to avoid excessive re-fits
				if (resizeRafId) cancelAnimationFrame(resizeRafId);
				resizeRafId = requestAnimationFrame(() => {
					if (!isInitialLoad && !longStripActive) {
						// Never re-fit under an open box editor: the zoom yanks
						// while typing (the soft keyboard resizes the viewport),
						// and the page geometry shifting under the dialog helps
						// nobody. Do it once when the editor closes instead.
						if (floatingEditTarget != null) {
							pendingEditorRefit = true;
							return;
						}
						zoomFitToScreen();
					}
				});
			});
			resizeObserver.observe(viewportEl);

			// Mobile: attach swipe listeners in capture phase so they fire
			// before panzoom's bubbling handler calls stopPropagation()
			if (isMobile) {
				viewportEl.addEventListener('touchstart', handleSwipeStartCapture, { capture: true, passive: true });
				viewportEl.addEventListener('touchend', handleSwipeEndCapture, { capture: true, passive: true });
				viewportEl.addEventListener('touchcancel', handleSwipeCancelCapture, { capture: true, passive: true });
			}
		}
		if (!isMobile) {
			window.addEventListener('keydown', handleKeydown);
			window.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
		}
	});

	onDestroy(() => {
		autoTranslationScheduleGeneration += 1;
		unsubscribeAutoTranslationScheduler();
		const autoTranslationDisposal = autoTranslationScheduler.dispose();
		const testWindow = window as unknown as Record<string, unknown>;
		if (testWindow.__fumeto_reader_test === readerUiTestApi) {
			if (previousReaderUiTestApi === undefined) delete testWindow.__fumeto_reader_test;
			else testWindow.__fumeto_reader_test = previousReaderUiTestApi;
		}
		readerUiTestApi = null;
		previousReaderUiTestApi = undefined;
		benchmarkPageController?.abort();
		const pendingBenchmarkRestore = benchmarkRestore;
		benchmarkRestore = null;
		// Keep the automatic owner registered until both scheduler and benchmark
		// callbacks have actually released their leases. Otherwise a manual run
		// mounted during teardown could overlap lingering native work.
		void Promise.all([
			autoTranslationDisposal,
			waitForBenchmarkTranslationIdle()
		]).then(async () => {
			if (pendingBenchmarkRestore) await pendingBenchmarkRestore();
		}).finally(() => unregisterAutomaticTranslationOwner());
		const benchmarkWindow = window as unknown as Record<string, unknown>;
		if (benchmarkWindow.__fumeto_on_device_benchmark === benchmarkApi) {
			delete benchmarkWindow.__fumeto_on_device_benchmark;
		}
		benchmarkApi = null;
		if (!consumePageBenchmarkNavigationTransfer()) disablePageBenchmarkMode();
		clearTimeout(saveProgressTimer);
		const finalProgressSave = pendingProgressSave;
		pendingProgressSave = undefined;
		if (finalProgressSave) void finalProgressSave.persist(true);
		pageSourceGeneration += 1;
		pageLoadGeneration += 1;
		if (isMobile && viewportEl) {
			viewportEl.removeEventListener('touchstart', handleSwipeStartCapture, { capture: true });
			viewportEl.removeEventListener('touchend', handleSwipeEndCapture, { capture: true });
			viewportEl.removeEventListener('touchcancel', handleSwipeCancelCapture, { capture: true });
		}
		if (!isMobile) {
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('wheel', wheelHandler, { capture: true });
		}
		if (pendingTapTimer) clearTimeout(pendingTapTimer);
		if (pageFitRafId !== undefined) cancelAnimationFrame(pageFitRafId);
		if (pageFitSecondRafId !== undefined) cancelAnimationFrame(pageFitSecondRafId);
		resizeObserver?.disconnect();
		if (resizeRafId) cancelAnimationFrame(resizeRafId);
		imageCache.clearPageSource();
		pageSource?.dispose();
		unsubscribeBoundaryBump();
		unsubscribePanzoomEpoch();
		if (boundaryFlashTimer) clearTimeout(boundaryFlashTimer);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions (The page viewport is a mouse/touch gesture surface; reader navigation has separate keyboard controls.) -->
<div
	bind:this={viewportEl}
	class="relative w-full overflow-hidden bg-surface-950"
	style="height: 100%;"
	role="presentation"
		aria-label={m.reader_manga_page_viewer()}
		data-reader-page-viewer
		data-auto-translation-phase={autoTranslationSchedulerState.phase}
		data-auto-translation-active-page={autoTranslationSchedulerState.active?.target.pageIndex ?? undefined}
		data-auto-translation-pending-page={autoTranslationSchedulerState.pending?.pageIndex ?? undefined}
		data-auto-translation-last-status={autoTranslationSchedulerState.lastOutcome?.status ?? undefined}
		onclick={isMobile ? undefined : handleViewportClick}
	onmousemove={isMobile ? undefined : handleViewportMouseMove}
>
	{#if longStripActive}
		<LongStripViewer
			{pageSource}
			ontap={() => { if (isMobile) applyReaderTouchDecision('toggle-controls'); }}
		/>
	{:else if pageLoadError}
		{@const friendlyPageError = describeErrorForUser(pageLoadError)}
		<div class="flex h-full flex-col items-center justify-center gap-3">
			<svg class="h-8 w-8 text-surface-600" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
			</svg>
			<span class="text-sm text-surface-400">{m.reader_couldn_t_load_this()}</span>
			<span class="max-w-sm text-center text-xs text-surface-500">{renderUserMessage(friendlyPageError.message)}</span>
			{#if friendlyPageError.detail && friendlyPageError.detail !== renderUserMessage(friendlyPageError.message)}
				<span class="allow-select max-w-sm break-words text-center text-[10px] text-surface-600">{friendlyPageError.detail}</span>
			{/if}
			<button
				onclick={retryPageLoad}
				class="rounded-md bg-primary-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-500"
			>
				{m.reader_retry()}
			</button>
		</div>
	{:else if imageUrl && pageWidth > 0}
		{@const quarterTurn = $pageRotation % 180 !== 0}
		<Panzoom>
			<!-- Rotation frame: its layout box is the rotated footprint panzoom
			     fits against; the surface keeps its intrinsic page-pixel size and
			     rotates about the frame's center, carrying the overlays with it
			     so every image-space coordinate stays valid. -->
			<div
				class="relative"
				style={`width: ${quarterTurn ? pageHeight : pageWidth}px; height: ${quarterTurn ? pageWidth : pageHeight}px;`}
				data-reader-rotation-frame={$pageRotation}
			>
			<div
				style={`width: ${pageWidth}px; height: ${pageHeight}px;` +
					($pageRotation !== 0
						? ` position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(${$pageRotation}deg);`
						: '') +
					(currentPageIsVideo
						? ''
						: ` background-image: url(${imageUrl}); background-size: contain; background-repeat: no-repeat; background-position: center;`)}
				class="reader-page-surface relative"
				data-reader-page-surface
			>
				{#if currentPageIsVideo}
					<!-- Muted looping playback = exact GIF parity. pointer-events:none
					     keeps taps landing on the same chrome-toggle/page-turn surfaces
					     as an image page; panzoom transforms the sized div either way. -->
					<video
						src={imageUrl}
						muted
						loop
						autoplay
						playsinline
						class="absolute inset-0 h-full w-full"
						style="object-fit: contain; pointer-events: none;"
						data-reader-video-page
					></video>
				{/if}
					<TranslationOverlay imageWidth={pageWidth} imageHeight={pageHeight} onboxclick={handleOverlayBoxClick} onboxlongpress={handleOverlayBoxLongPress} onboxreview={handleOverlayBoxReview} />
				<RegionOverlay imageWidth={pageWidth} imageHeight={pageHeight} />
			</div>
			</div>
		</Panzoom>
	{:else}
		<!-- Page-shaped shimmer instead of a text flash. The 150 ms appear delay
		     keeps cached/fast page turns free of any placeholder blink. -->
		<div class="flex h-full w-full items-center justify-center p-4" role="status" aria-label={m.reader_loading_page()}>
			<div
				class="reader-page-skeleton"
				style="aspect-ratio: {$currentPageInfo && $currentPageInfo.width > 0 && $currentPageInfo.height > 0
					? `${$currentPageInfo.width} / ${$currentPageInfo.height}`
					: '2 / 3'};"
			></div>
		</div>
	{/if}
	{#if boundaryFlash}
		{#key boundaryFlash.seq}
			<div class="reader-boundary-glow reader-boundary-glow-{boundaryFlash.side}" aria-hidden="true"></div>
		{/key}
	{/if}

	<!-- The page's box list (mobile only): every item on the record, with a way to edit, hide, reset, restore or undo -->
	{#if isMobile}
		<MobileOverlayBoxSheet onedit={handleOverlayBoxReview} />
	{/if}

	<!-- Floating box editor (mobile only, outside panzoom) -->
	{#if isMobile && floatingEditItem && floatingEditTarget && viewportEl}
		<FloatingBoxEditor
			item={floatingEditItem}
			rect={floatingEditTarget.rect}
			planId={floatingEditTarget.planId}
			text={floatingBaseTranslation}
			{viewportEl}
			ondismiss={handleFloatingEditorDismiss}
		/>
	{/if}
</div>

{#if isMobile && $activeRegionDrawSession}
	<div class="fixed inset-x-0 top-0 z-[89] grid h-[calc(56px+var(--sat,0px))] grid-cols-[48px_minmax(0,1fr)_48px] items-end gap-2 px-2 pb-1" style="padding-top: var(--sat, 0px); padding-left: calc(8px + var(--sal,0px)); padding-right: calc(8px + var(--sar,0px));" data-region-draw-controls>
		<ReaderIconButton label={m.reader_undo_newest_region()} class="bg-surface-900/90 text-surface-100 shadow-lg disabled:opacity-40" disabled={$activeRegionDrawSession.createdRegionIds.length === 0} onclick={() => void undoNewestDrawnRegion()}>
			<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v1"/></svg>
		</ReaderIconButton>
		<div class="min-w-0 justify-self-center rounded-full bg-surface-900/85 px-3 py-1 text-center text-xs font-medium text-surface-100 shadow" role="status">
			{m.reader_draw_regions_saved({ n: $activeRegionDrawSession.createdRegionIds.length })}
		</div>
		<ReaderIconButton label={m.reader_done_selecting_regions()} class="bg-teal-600 text-white shadow-lg" onclick={() => void finishRegionDrawSession({ enterReview: true })}>
			<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 12 4 4L19 6"/></svg>
		</ReaderIconButton>
	</div>
{/if}

<!-- Move/Resize confirm bar (viewport-fixed, outside panzoom) -->
{#if ($movingBoxId != null || $resizingBoxId != null) && $selectedOverlayBoxId == null}
	<ReaderActionRow
		columns={2}
		label={m.reader_confirm_box_change()}
		class="fixed left-0 right-0 z-[88] border-b border-surface-700 bg-surface-800/95 p-2 backdrop-blur-sm"
		style="top: var(--sat, 0px); padding-right: calc(8px + var(--sar, 0px)); padding-left: calc(8px + var(--sal, 0px));"
	>
		<button
			onclick={() => $overlayCancelHandler?.()}
			class="h-[48px] min-w-0 rounded-lg bg-surface-700 px-2 text-sm font-medium text-surface-200 shadow transition-colors hover:bg-surface-600 active:bg-surface-500"
		>
			{m.reader_cancel()}
		</button>
		<button
			onclick={() => $overlayConfirmHandler?.()}
			class="h-[48px] min-w-0 rounded-lg bg-teal-600 px-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-500 active:bg-teal-400"
		>
			✓ {$movingBoxId != null ? m.reader_confirm_move() : m.reader_confirm_resize()}
		</button>
	</ReaderActionRow>
{/if}

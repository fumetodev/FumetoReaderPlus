<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade } from 'svelte/transition';
	import { motionDuration } from '$lib/util/motion.js';
	import { INCLUDES_DEBUG_UI_FIXTURES } from '$lib/build-info.js';
	import { onMount, onDestroy } from 'svelte';
	import { randomUUID } from '$lib/util/uuid.js';
	import { get } from 'svelte/store';
	import Header from '$lib/components/layout/Header.svelte';
	import Sidebar from '$lib/components/layout/Sidebar.svelte';
	import CatalogView from '$lib/components/reader/CatalogView.svelte';
	import TabsView from '$lib/components/tabs/TabsView.svelte';
	import MobileBottomBar from '$lib/components/mobile/MobileBottomBar.svelte';
	import ToastHost from '$lib/components/ui/ToastHost.svelte';
	import PageViewer from '$lib/components/reader/PageViewer.svelte';
	import BookReader from '$lib/components/reader/BookReader.svelte';
	import MobileBookTocPanel from '$lib/components/mobile/MobileBookTocPanel.svelte';
	import MobileBookDisplayMenu from '$lib/components/mobile/MobileBookDisplayMenu.svelte';
	import { isBookVolume } from '$lib/book/media-kind.js';
	import PageThumbnailScrubber from '$lib/components/reader/PageThumbnailScrubber.svelte';
	import ImportDialog from '$lib/components/import/ImportDialog.svelte';
	import SettingsDialog from '$lib/components/settings/SettingsDialog.svelte';
	import SettingsView from '$lib/components/settings/SettingsView.svelte';
	import OnboardingTour from '$lib/components/onboarding/OnboardingTour.svelte';
	import { onboardingTourOpen, shouldAutoShowOnboarding } from '$lib/onboarding/onboarding.js';
	import CatalogSidebar from '$lib/components/catalog/CatalogSidebar.svelte';
	import MobileReaderBottomBar from '$lib/components/mobile/MobileReaderBottomBar.svelte';
	import MobileRegionReviewStrip from '$lib/components/mobile/MobileRegionReviewStrip.svelte';
	import MobileFilmstrip from '$lib/components/mobile/MobileFilmstrip.svelte';
	import MobilePageJumpDialog from '$lib/components/mobile/MobilePageJumpDialog.svelte';
	import MobileTranslateStatusDialog from '$lib/components/mobile/MobileTranslateStatusDialog.svelte';
	import { isMobile, isTauriHost } from '$lib/util/platform.js';
	import { appView, currentPageIndex, currentVolume, isDrawingMode, leaveReader, overlayFontScale, readerSessionId, readerTargetEpoch } from '$lib/stores/reader-state.js';
	import { toggleFullScreen } from '$lib/panzoom/util.js';
	import { settingsDialogOpen, settingsLoading, settingsReturnView, settingsCommitHandler, settingsNavigationBusy, settingsViewMounted, importDialogOpen, catalogContextMenuOpen, readerBarsVisible, pageThumbnailScrubberOpen, movingBoxId, resizingBoxId, overlayCancelHandler, overlayEditorCloseHandler, overlayEditorDismissHandler, readerTransientCloseHandler, catalogTransientCloseHandler } from '$lib/stores/ui-state.js';
	import {
		currentSubfolder,
		selectedLibraryId,
		currentRemoteFolderId,
	} from '$lib/stores/catalog-state.js';
	import { settings, isLocalLibrary, isYACReaderLibrary, isKomgaLibrary, isKavitaLibrary, initSecureSettings } from '$lib/settings/settings.js';
	import { scanLibrary } from '$lib/library/library-scanner.js';
	import { stopAllWatching } from '$lib/library/library-watcher.js';
	import { syncLibraryWatchers } from '$lib/library/library-watch-sync.js';
	import { getOrCreateClient } from '$lib/yacreader/yac-client-manager.js';
	import { fullSyncLibrary, getLastSyncDiagnostics, remoteStartupSyncPlan, fetchRemoteFolderContents } from '$lib/yacreader/yac-sync-service.js';
	import { getOrCreateKomgaClient } from '$lib/komga/komga-client-manager.js';
	import { fullSyncKomgaLibrary } from '$lib/komga/komga-sync-service.js';
	import { loadKomgaCredentials } from '$lib/komga/komga-credentials.js';
	import { getOrCreateKavitaClient } from '$lib/kavita/kavita-client-manager.js';
	import { fullSyncKavitaLibrary } from '$lib/kavita/kavita-sync-service.js';
	import { loadKavitaApiKey } from '$lib/kavita/kavita-credentials.js';
	import { db } from '$lib/db/index.js';
	import { applyColorScheme } from '$lib/settings/color-schemes.js';
	import { setUiLocale } from '$lib/i18n/locale.js';
	import { mkdir, exists as fsExists } from '@tauri-apps/plugin-fs';
	import { appDataDir, join } from '@tauri-apps/api/path';
	import {
		disablePageBenchmarkMode,
		markPageBenchmarkNavigationTransfer
	} from '$lib/benchmark/page-benchmark-mode.js';
	import { resetReaderInteractionState } from '$lib/reader/reader-interaction-reset.js';
	import { cleanupRetiredProviderStorage } from '$lib/migrations/retired-provider-storage.js';
	import { ensureStoragePersistence } from '$lib/storage/durability.js';
	import { reportRemoteSyncFailure, reportRemoteSyncOutcome } from '$lib/stores/remote-sync-status.js';
	import { installWindowInsetAdapter } from '$lib/insets/window-insets.js';
	import { installReaderOrientationPolicy } from '$lib/reader/reader-orientation.js';
	import { installTranslationConfigGuard } from '$lib/translation/translation-config-guard.js';
	import type { MobileDestination } from '$lib/navigation/mobile-navigation.js';
	import { catalogController } from '$lib/controllers/catalog-controller.js';
	import { tabsController } from '$lib/controllers/tabs-controller.js';
	import { scheduleCatalogV16Migration } from '$lib/db/catalog-migration.js';
	import { scheduleVolumePagesMigration } from '$lib/db/volume-pages-migration.js';
	import OcrModelSheet from '$lib/components/detection/OcrModelSheet.svelte';
	import { dismissOcrModelPrompt, ocrModelPromptOpen } from '$lib/detection/ocr-model-gate.js';
	import { dismissReaderDisclosure, readerDisclosure } from '$lib/reader/reader-disclosure.js';
	import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
	import { readerPageJump } from '$lib/reader/reader-page-jump.js';
	import { activeRegionDrawSession, finishRegionDrawSession, highlightedDrawRegionIds, syncRegionDrawTarget } from '$lib/regions/region-draw-session.js';
	import { announceDesktopUpdateIfAvailable } from '$lib/update/update-check.js';
	import { primeDesktopSystemInfo } from '$lib/device/desktop-system-info.js';

	let uninstallOcrBenchmarkHost: (() => void) | null = null;
	let uninstallModelCandidateEvalApi: (() => void) | null = null;
	let uninstallPageBenchmarkNavigation: (() => void) | null = null;
	let previousAppView: import('$lib/types/index.js').AppView = 'catalog';
	let uninstallInsetAdapter: (() => void) | null = null;
	let uninstallOrientationPolicy: (() => void) | null = null;
	let uninstallTranslationConfigGuard: (() => void) | null = null;
	let uninstallMobileUiFixtureHost: (() => void) | null = null;
	let stopCatalogMigration: (() => void) | null = null;
	let stopVolumePagesMigration: (() => void) | null = null;
	let stopWaitingForCatalogMigration: (() => void) | null = null;
	let visualViewportResizeHandler: (() => void) | null = null;
	let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
	const appMaintenanceController = new AbortController();
	let observedReaderSessionId = '';
	// Debug fixture code is a build-time opt-in. Runtime BuildConfig.DEBUG alone
	// is intentionally insufficient: otherwise Rollup must ship the entire host
	// in release bytes even though MainActivity never installs it there. The
	// check lives in build-info.ts so Settings → About reports the same answer.
	const includesDebugMobileUiFixtures = INCLUDES_DEBUG_UI_FIXTURES;

	/** Thin wrapper: the policy lives in remote-sync-status, this just logs. */
	function reportStartupSyncOutcome(library: { id: string; name: string }, failures: number): void {
		reportRemoteSyncOutcome(library.id, failures);
		if (failures > 0) {
			console.warn(`Startup sync for "${library.name}" finished with ${failures} failure(s)`);
		}
	}

	function submitMaintenance<T>(input: {
		kind: string;
		key: string;
		priority?: 2 | 3;
		operation: () => Promise<T>;
		onError: (error: unknown) => void;
	}): void {
		void appWorkCoordinator.submit({
			kind: input.kind,
			owner: 'app-maintenance',
			lane: 'catalog-maintenance',
			priority: input.priority ?? 3,
			coalescingKey: input.key,
			signal: appMaintenanceController.signal,
			operation: input.operation,
		}).promise.catch((error) => {
			if ((error as Error)?.name !== 'AbortError') input.onError(error);
		});
	}

	// Controllers are app-scoped and begin loading before destination components
	// mount, so cold views are honest and warm returns publish synchronously.
	catalogController.start();
	tabsController.start();

	function startCatalogMigrationAfterFirstUsablePaint(): void {
		let waiting = true;
		const unsubscribe = catalogController.subscribe((snapshot) => {
			if (!waiting || (snapshot.phase !== 'ready' && snapshot.phase !== 'error')) return;
			waiting = false;
			requestAnimationFrame(() => {
				unsubscribe();
				stopWaitingForCatalogMigration = null;
				stopCatalogMigration = scheduleCatalogV16Migration();
				// v17 page split runs on the same maintenance lane, after v16.
				stopVolumePagesMigration = scheduleVolumePagesMigration();
			});
		});
		stopWaitingForCatalogMigration = () => {
			waiting = false;
			unsubscribe();
		};
	}

	// Latch: once Settings has been entered, its view stays mounted (keep-alive).
	let settingsViewEverOpened = $state(false);
	$effect(() => {
		if (isMobile && $appView === 'settings') settingsViewEverOpened = true;
	});

	function navigateMobile(destination: MobileDestination): void {
		const current = get(appView);
		// Same-destination taps are universally a no-op (re-tapping Settings
		// used to strand a blank sentinel view; now nothing moves at all).
		if (destination === current) return;
		// Leaving Settings goes through the flush port so the pending
		// auto-apply lands before the view switches.
		if (current === 'settings') {
			const commit = get(settingsCommitHandler);
			if (commit) {
				void commit(destination);
				return;
			}
		}
		if (destination === 'settings') {
			settingsReturnView.set(current === 'tabs' || current === 'catalog' ? current : 'catalog');
			// The loading overlay only exists for the first, expensive mount of
			// the keep-alive SettingsView; later entries are a visibility flip.
			if (!get(settingsViewMounted)) settingsLoading.set(true);
			appView.set('settings');
			return;
		}
		appView.set(destination);
	}

	/**
	 * Closes the topmost transient reader surface — a popover, the box editor,
	 * a move/resize, a region draw — and reports whether there was one. Shared
	 * by Android Back and the desktop Escape key, so both platforms unwind the
	 * reader in the same order.
	 */
	function closeReaderTransient(): boolean {
		const closeTransient = get(readerTransientCloseHandler);
		if (closeTransient) {
			closeTransient();
			return true;
		}
		// Back is "leave", not "commit". The floating editor's Done saves and
		// its Cancel discards; the gesture the reader reaches for to back out
		// must land on the second one, the way move/resize already do below.
		// Editors with no discard port (the desktop inline one) still commit.
		const dismissEditor = get(overlayEditorDismissHandler);
		if (dismissEditor) {
			dismissEditor();
			return true;
		}
		const closeEditor = get(overlayEditorCloseHandler);
		if (closeEditor) {
			void closeEditor();
			return true;
		}
		if (get(movingBoxId) != null || get(resizingBoxId) != null) {
			get(overlayCancelHandler)?.();
			return true;
		}
		if (get(activeRegionDrawSession)) {
			void finishRegionDrawSession({ enterReview: true });
			return true;
		}
		return false;
	}

	function handleReaderBack(): boolean {
		if (closeReaderTransient()) return true;
		const outcome = mobileReaderUi.handleBack();
		if (outcome === 'leave-reader') leaveReader();
		return true;
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!isMobile || event.key !== 'Escape' || get(appView) !== 'reader') return;
		event.preventDefault();
		event.stopPropagation();
		handleReaderBack();
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
	}

	/**
	 * Desktop keyboard: F11 toggles fullscreen in every view; Escape unwinds
	 * the reader the way Android Back does, one layer per press, and finally
	 * leaves it. Registered in the bubbling phase, so a dialog that handled
	 * Escape on its own element has already marked the event; the surfaces
	 * that listen on the window after this handler are checked by store.
	 * The mobile chrome's own Back ladder is deliberately not consulted here —
	 * it would swallow the first Escape to hide bars a desktop reader never
	 * sees.
	 */
	function handleDesktopWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'F11') {
			event.preventDefault();
			void toggleFullScreen();
			return;
		}
		if (event.key !== 'Escape' || event.defaultPrevented || isEditableTarget(event.target)) return;
		if (get(appView) !== 'reader') {
			if (get(ocrModelPromptOpen)) {
				event.preventDefault();
				dismissOcrModelPrompt();
			}
			return;
		}
		// The page viewer's own handler turns drawing mode off on Escape.
		if (get(isDrawingMode)) return;
		if (get(settingsDialogOpen) || get(pageThumbnailScrubberOpen) || get(importDialogOpen) || get(onboardingTourOpen)) return;
		event.preventDefault();
		if (dismissOcrModelPrompt()) return;
		if (closeReaderTransient()) return;
		leaveReader();
	}

	// Apply color scheme reactively (also handles initial mount)
	$effect(() => {
		applyColorScheme($settings.colorScheme ?? 'synthesis');
	});

	// The UI language follows the setting the same way: at boot, after a
	// settings-file restore or import, and on every change. `setUiLocale`
	// is idempotent, so the eager call from the language picker is harmless.
	$effect(() => {
		setUiLocale($settings.uiLocale ?? 'system');
	});

	$effect(() => {
		const sessionId = $readerSessionId;
		const volume = $currentVolume;
		const targetEpoch = $readerTargetEpoch;
		const pageIndex = $currentPageIndex;
		if (!sessionId || !volume) return;
		const target = { readerSessionId: sessionId, targetEpoch, volumeUuid: volume.volume_uuid, pageIndex };
		readerPageTranslationController.setTarget(target);
		readerPageJump.setVolume(volume.volume_uuid);
		syncRegionDrawTarget(target);
		if (sessionId !== observedReaderSessionId) {
			observedReaderSessionId = sessionId;
			mobileReaderUi.resetForReaderSession();
		}
	});

	// Mobile: enter fullscreen (immersive) in reader, exit in catalog
	$effect(() => {
		const nextView = $appView;
		if (nextView !== previousAppView) {
			dismissReaderDisclosure(get(readerDisclosure), { restoreFocus: false });
			// Draw/edit/move/resize state belongs to one reader session only. Clear it
			// both when leaving and on entry as a fail-safe for every open/exit path.
			resetReaderInteractionState();
			previousAppView = nextView;
		}
		if (!isMobile) return;
		if (nextView === 'reader') {
			if (!document.fullscreenElement) {
				document.documentElement.requestFullscreen?.().catch(() => {});
			}
		} else {
			if (document.fullscreenElement) {
				document.exitFullscreen?.().catch(() => {});
			}
		}
	});

	onMount(async () => {
		startCatalogMigrationAfterFirstUsablePaint();
		// Volume translations hold a provider snapshot; if the user changes that
		// choice mid-run the affected jobs stop instead of quietly carrying on.
		uninstallTranslationConfigGuard = installTranslationConfigGuard();
		if (isMobile) uninstallInsetAdapter = installWindowInsetAdapter();
		// The reader may rotate with the device; every other view stays portrait.
		if (isMobile) uninstallOrientationPolicy = installReaderOrientationPolicy();
		if (includesDebugMobileUiFixtures && isMobile && window.__fumeto_android?.isDebugBuild?.() === true) {
			const { installMobileUiFixtureHost } = await import('$lib/debug/mobile-ui-fixture-host.js');
			uninstallMobileUiFixtureHost = installMobileUiFixtureHost();
		}
		const benchmarkBridge = (window as unknown as Record<string, unknown>).__fumeto_llama as {
			isBenchmarkBuild?: () => boolean;
		} | undefined;
		if (benchmarkBridge?.isBenchmarkBuild?.() === true) {
			const { installOcrBenchmarkHost } = await import('$lib/benchmark/ocr-benchmark-host.js');
			uninstallOcrBenchmarkHost = installOcrBenchmarkHost();
			const { installModelCandidateEvalApi } = await import('$lib/benchmark/model-candidate-eval-api.js');
			uninstallModelCandidateEvalApi = installModelCandidateEvalApi();
			const benchmarkWindow = window as unknown as Record<string, unknown>;
			const previousNavigation = benchmarkWindow.__fumeto_page_benchmark_navigation;
			const navigationApi = {
				openLocalCatalogRoot(libraryId: string): boolean {
					const library = get(settings).libraries.find((candidate) =>
						candidate.id === libraryId && isLocalLibrary(candidate)
					);
					if (!library) return false;
					if (!markPageBenchmarkNavigationTransfer()) return false;
					pageThumbnailScrubberOpen.set(false);
					settingsDialogOpen.set(false);
					importDialogOpen.set(false);
					catalogContextMenuOpen.set(false);
					readerBarsVisible.set(false);
					currentRemoteFolderId.set(null);
					currentSubfolder.set('');
					selectedLibraryId.set(libraryId);
					appView.set('catalog');
					return true;
				}
			};
			benchmarkWindow.__fumeto_page_benchmark_navigation = navigationApi;
			uninstallPageBenchmarkNavigation = () => {
				if (benchmarkWindow.__fumeto_page_benchmark_navigation !== navigationApi) return;
				if (previousNavigation === undefined) delete benchmarkWindow.__fumeto_page_benchmark_navigation;
				else benchmarkWindow.__fumeto_page_benchmark_navigation = previousNavigation;
			};
		}
		if (!isMobile) {
			window.addEventListener('keydown', handleDesktopWindowKeydown);
			// The passive new-version check waits for the first paint to settle.
			// The runner itself only ever talks to the network on the Linux
			// desktop shell, and only while the Help → About switch is on.
			updateCheckTimer = setTimeout(() => {
				updateCheckTimer = null;
				void announceDesktopUpdateIfAvailable();
			}, 5000);
		}
		// Android back button handling via native bridge
		// MainActivity.kt calls window.__fumeto_back_handler() on back press.
		// Return false to consume the event, true to let the app close.
		if (isMobile) {
			window.addEventListener('keydown', handleWindowKeydown, true);
			(window as any).__fumeto_back_handler = (): boolean => {
				// A root-level modal takes Back ahead of every view branch:
				// otherwise the press switches the view underneath the open
				// dialog, and from the catalog root it would exit the app.
				if (dismissOcrModelPrompt()) return false;
				// Close overlays in priority order
				if (get(appView) === 'reader') {
					handleReaderBack();
					return false;
				}
				if (dismissReaderDisclosure(get(readerDisclosure))) return false;
				if (get(pageThumbnailScrubberOpen)) {
					pageThumbnailScrubberOpen.set(false);
					return false;
				}
				if (get(appView) === 'settings') {
					const commit = get(settingsCommitHandler);
					if (commit) void commit(get(settingsReturnView));
					else appView.set(get(settingsReturnView));
					return false;
				}
				if (get(importDialogOpen)) {
					importDialogOpen.set(false);
					return false;
				}
				if (get(catalogContextMenuOpen)) {
					catalogContextMenuOpen.set(false);
					return false;
				}
				// Catalog-scoped dialogs (details/revise/rename/move/…) take Back
				// priority over view navigation, mirroring the reader's port.
				if (get(catalogTransientCloseHandler)?.()) return false;
				if (get(appView) === 'tabs') {
					appView.set('catalog');
					return false;
				}
				// Navigate up remote folder hierarchy
				const remoteFolderId = get(currentRemoteFolderId);
				if (remoteFolderId !== null) {
					db.remote_folders
						.where('id')
						.equals(`${get(selectedLibraryId)}:${remoteFolderId}`)
						.first()
						.then((folder) => {
							currentRemoteFolderId.set(folder?.parentFolderId ?? null);
						});
					return false;
				}
				// Navigate up local folder hierarchy
				const sub = get(currentSubfolder);
				if (sub !== '') {
					const parts = sub.replace(/\\/g, '/').split('/');
					parts.pop();
					currentSubfolder.set(parts.join('/'));
					return false;
				}
				// At library root with a library selected — go back to All Libraries
				if (get(selectedLibraryId)) {
					currentRemoteFolderId.set(null);
					selectedLibraryId.set(null);
					return false;
				}
				// At All Libraries level — let the app close
				return true;
			};

			// Soft keyboard handling: update CSS variable when keyboard appears
			if (window.visualViewport) {
				const onViewportResize = () => {
					document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport!.height}px`);
				};
				visualViewportResizeHandler = onViewportResize;
				window.visualViewport.addEventListener('resize', onViewportResize);
				onViewportResize();
			}
			// Note: --sat and --sab are injected by MainActivity.kt via WindowInsetsCompat
		}

		// The desktop shell answers memory and CPU facts the page cannot read
		// itself; ask once, before anything that gives RAM advice can run.
		if (!isMobile) await primeDesktopSystemInfo();
		// Load API key from encrypted storage (+ migrate from plaintext if needed)
		await initSecureSettings();
		// Do not delay the first frame while the one-time provider download cache
		// cleanup runs; the helper first waits for the v12 DB migration to commit.
		void cleanupRetiredProviderStorage();
		// Ask the platform to protect IndexedDB (the whole local library) from
		// storage-pressure eviction; Settings → Libraries surfaces the outcome.
		void ensureStoragePersistence();

		// On a Tauri host, phone or desktop, ensure the app's own "Local Comics"
		// library exists in app-specific storage: it is where the import dialog
		// and the desktop's drag-and-drop put archives, so without it a desktop
		// import would belong to no library and never appear in the catalog.
		if (isTauriHost) {
			try {
				const dataDir = await appDataDir();
				const comicsDir = await join(dataDir, 'Comics');
				const dirExists = await fsExists(comicsDir);
				if (!dirExists) {
					await mkdir(comicsDir, { recursive: true });
				}
				// Ensure the local library entry exists in settings
				const currentSettings = get(settings);
				const hasLocal = currentSettings.libraries.some(
					(l) => isLocalLibrary(l) && l.path === comicsDir
				);
				if (!hasLocal) {
					settings.update((s) => ({
						...s,
						libraries: [
							...s.libraries,
							{
								id: randomUUID(),
								type: 'local' as const,
								name: 'Local Comics',
								path: comicsDir,
								autoScan: true,
								watchEnabled: false
							}
						]
					}));
				}
			} catch (err) {
				console.warn('Failed to create local library:', err);
			}

		}

		// First-run intro tour.
		if (shouldAutoShowOnboarding()) onboardingTourOpen.set(true);

		const initSettings = get(settings);

		// Overlay font scale: outside a volume, the live store shows the global
		// default (per-volume overrides are applied by PageViewer on open —
		// the reader slider writes those, NOT this setting).
		overlayFontScale.set(initSettings.overlayFontScaleDefault ?? 1);

		// Folder watchers follow the library list from here on (a no-op on mobile).
		void syncLibraryWatchers(initSettings.libraries);

		// Auto-scan all configured libraries
		for (const lib of initSettings.libraries) {
			if (isLocalLibrary(lib)) {
				if (lib.autoScan) {
					submitMaintenance({
						kind: 'local-library-auto-scan', key: `scan:${lib.id}`,
						operation: () => scanLibrary(lib.path, undefined, lib.id),
						onError: (error) => console.error(`Library auto-scan failed for "${lib.name}":`, error),
					});
				}

			}
			// YACReader libraries: startup sync
			if (isYACReaderLibrary(lib)) {
				const client = getOrCreateClient(lib.serverUrl);
				if (lib.syncMode === 'full') {
					submitMaintenance({
						kind: 'yac-startup-index', key: `sync:${lib.id}`,
						operation: async () => {
							// Once the initial index is complete, launch does NOT re-crawl
							// (user decision): folder browsing hydrates whatever is
							// visited and manual Scan is the explicit re-index. The old
							// behaviour re-walked every folder on every launch, asked the
							// single-threaded server to rescan its disk, and — on a 13k
							// library — followed up with thousands of cover fetches at
							// navigation priority.
							const plan = remoteStartupSyncPlan(await db.catalog_index_state.get(lib.id));
							if (!plan.run) return 0;
							const result = await fullSyncLibrary(
								client, lib.id, lib.remoteLibraryId, lib.serverUrl, undefined,
								plan.options,
							);
							reportStartupSyncOutcome(lib, getLastSyncDiagnostics(lib.id)?.failures.length ?? 0);
							return result;
						},
						onError: (error) => {
							reportRemoteSyncFailure(lib.id, error);
							console.warn(`YACReader sync failed for "${lib.name}":`, error instanceof Error ? error.message : error);
						},
					});
				} else {
					// Browse mode: root folder fetch is handled by CatalogSidebar $effect
				}
			}
			// Komga libraries: startup sync
			if (isKomgaLibrary(lib)) {
				if (lib.syncMode === 'full') submitMaintenance({
					kind: 'komga-startup-sync', key: `sync:${lib.id}`,
					operation: async () => {
						// Komga and Kavita had no startup gate at all, so they
						// re-crawled the whole library on every launch — against the
						// project's own "manual Scan is the only refresh" contract,
						// which YACReader has honoured since its gate landed. For a
						// 500-series library that is one series list plus 500
						// sequential book requests on every cold start.
						if (!remoteStartupSyncPlan(await db.catalog_index_state.get(lib.id)).run) return 0;
						const creds = await loadKomgaCredentials(lib.serverUrl);
						const result = await fullSyncKomgaLibrary(
							getOrCreateKomgaClient(lib.serverUrl, creds.username, creds.password),
							lib.id, lib.komgaLibraryId, lib.serverUrl,
						);
						reportStartupSyncOutcome(lib, result.failures);
						return result;
					},
					onError: (error) => {
						reportRemoteSyncFailure(lib.id, error);
						console.warn(`Komga sync failed for "${lib.name}":`, error instanceof Error ? error.message : error);
					},
				});
			}
			// Kavita libraries: startup sync
			if (isKavitaLibrary(lib)) {
				if (lib.syncMode === 'full') submitMaintenance({
					kind: 'kavita-startup-sync', key: `sync:${lib.id}`,
					operation: async () => {
						// See the Komga branch: same missing gate, same contract.
						if (!remoteStartupSyncPlan(await db.catalog_index_state.get(lib.id)).run) return 0;
						const result = await fullSyncKavitaLibrary(
							getOrCreateKavitaClient(lib.serverUrl, await loadKavitaApiKey(lib.serverUrl)),
							lib.id, lib.kavitaLibraryId, lib.serverUrl,
						);
						reportStartupSyncOutcome(lib, result.failures);
						return result;
					},
					onError: (error) => {
						reportRemoteSyncFailure(lib.id, error);
						console.warn(`Kavita sync failed for "${lib.name}":`, error instanceof Error ? error.message : error);
					},
				});
			}
		}

	});

	onDestroy(() => {
		appMaintenanceController.abort('app destroyed');
		stopWaitingForCatalogMigration?.();
		stopWaitingForCatalogMigration = null;
		stopCatalogMigration?.();
		stopCatalogMigration = null;
		stopVolumePagesMigration?.();
		stopVolumePagesMigration = null;
		catalogController.destroy();
		tabsController.destroy();
		uninstallInsetAdapter?.();
		uninstallInsetAdapter = null;
		uninstallOrientationPolicy?.();
		uninstallOrientationPolicy = null;
		uninstallMobileUiFixtureHost?.();
		uninstallMobileUiFixtureHost = null;
		uninstallOcrBenchmarkHost?.();
		uninstallModelCandidateEvalApi?.();
		uninstallModelCandidateEvalApi = null;
		uninstallOcrBenchmarkHost = null;
		uninstallPageBenchmarkNavigation?.();
		uninstallPageBenchmarkNavigation = null;
		if (isMobile) window.removeEventListener('keydown', handleWindowKeydown, true);
		else window.removeEventListener('keydown', handleDesktopWindowKeydown);
		if (updateCheckTimer) clearTimeout(updateCheckTimer);
		updateCheckTimer = null;
		if (window.visualViewport && visualViewportResizeHandler) {
			window.visualViewport.removeEventListener('resize', visualViewportResizeHandler);
		}
		visualViewportResizeHandler = null;
		uninstallTranslationConfigGuard?.();
		delete (window as any).__fumeto_back_handler;
		void readerPageTranslationController.dispose();
		disablePageBenchmarkMode();
		stopAllWatching();
	});

</script>

<div
	class="flex min-h-0 flex-col"
	style="height: var(--viewport-height, 100dvh);"
	data-app-shell
	inert={!isMobile && $pageThumbnailScrubberOpen}
	aria-hidden={!isMobile && $pageThumbnailScrubberOpen ? 'true' : undefined}
>
	{#if isMobile && $appView === 'reader'}
		<!-- Fixed overlay header for mobile reader — slides in/out. The wrapper
		     is permanently tap-transparent (the pill inside re-enables hits);
		     interactivity when hidden is cut by inert. The 8px slack in the
		     hidden offset keeps the pill strictly outside the viewport, which
		     the toBeInViewport / rect.bottom<=0 chrome probes rely on since
		     they cannot see opacity. -->
		<div
			class="pointer-events-none fixed inset-x-0 top-0 z-50"
			style="transform: translateY({$mobileReaderUi.chrome === 'visible' ? '0' : 'calc(-100% - 8px)'}); opacity: {$mobileReaderUi.chrome === 'visible' ? '1' : '0'}; transition: transform 220ms var(--ease-standard), opacity 180ms var(--ease-standard);"
			aria-hidden={$mobileReaderUi.chrome === 'hidden' ? 'true' : undefined}
			inert={$mobileReaderUi.chrome === 'hidden'}
		>
			<Header />
		</div>
	{:else if !isMobile}
		<Header />
	{/if}

	<div class="flex flex-1 overflow-hidden">
		<!-- Catalog sidebar (catalog view only, desktop) -->
		{#if !isMobile && $appView === 'catalog'}
			<CatalogSidebar />
		{/if}

		<!--
			Main content area. Catalog and Tabs stay MOUNTED and are hidden with
			visibility, rather than being torn down on every view switch.

			Unmounting made re-entry pay for everything again: the catalog remounted
			with placeholder geometry and restored scroll only inside its first
			ResizeObserver callback (so the visible window churned two or three
			times), it cleared its published thumbnail URLs on the first effect run,
			and every <img> was a fresh element that had to re-fetch and re-decode —
			after the reader, Chromium has usually dropped those decoded covers.
			TabsView was worse still: it revoked every preview object URL on destroy
			and discarded the in-flight IndexedDB waves that mount-settling produced.

			`visibility: hidden` (not `display: none`) preserves layout, so the
			ResizeObserver does not fire and scroll position survives; `inert` plus
			pointer-events keeps the hidden layer out of interaction and the
			accessibility tree. The reader stays conditional — it holds full-size
			page bitmaps that should be released on exit — and is last in DOM order
			so it paints above the hidden layers.
		-->
		<main class="relative flex-1 overflow-hidden">
			<div
				class="absolute inset-0"
				class:invisible={$appView !== 'catalog'}
				class:pointer-events-none={$appView !== 'catalog'}
				inert={$appView !== 'catalog'}
			>
				<CatalogView active={$appView === 'catalog'} />
			</div>
			<div
				class="absolute inset-0"
				class:invisible={$appView !== 'tabs'}
				class:pointer-events-none={$appView !== 'tabs'}
				inert={$appView !== 'tabs'}
			>
				<TabsView active={$appView === 'tabs'} />
			</div>
			{#if isMobile && settingsViewEverOpened}
				<!-- Settings is a real destination: lazily mounted on first entry
				     (the settingsLoading overlay covers that one build), then kept
				     alive like catalog/tabs so re-entry is a visibility flip. -->
				<div
					class="absolute inset-0"
					class:invisible={$appView !== 'settings'}
					class:pointer-events-none={$appView !== 'settings'}
					inert={$appView !== 'settings'}
				>
					<SettingsView />
				</div>
			{/if}
			{#if $appView === 'reader'}
				<div class="absolute inset-0">
					{#if isBookVolume($currentVolume)}
						<!-- Books: foliate engine behind the same chrome shell.
						     PageViewer (and its whole page-image pipeline) never
						     mounts for a book. Keyed by volume so a book→book
						     switch always tears down and reopens one instance
						     (defense-in-depth for the disposed lifecycle). -->
						{#key $currentVolume?.volume_uuid}
							<BookReader />
						{/key}
					{:else}
						<PageViewer />
					{/if}
				</div>
			{/if}
		</main>

		<!-- Translation side panel (reader only, desktop; comics only) -->
		{#if !isMobile && $appView === 'reader' && !isBookVolume($currentVolume)}
			<Sidebar />
		{/if}
	</div>

	<!-- One toast stack for every platform: the desktop needs it for the
	     new-version notice, and gains the edit/undo and scan toasts that
	     were pushed but never rendered there. -->
	<ToastHost />
	<OcrModelSheet />
	{#if isMobile && ($appView === 'catalog' || $appView === 'tabs' || $appView === 'settings')}
		<!-- One dock, three destinations. Settings is a peer view now — the
		     dialog-era second bar instance is gone. -->
		<MobileBottomBar active={$appView} onnavigate={navigateMobile} disabled={$appView === 'settings' && $settingsNavigationBusy} />
	{/if}

	<!-- Mobile bottom bar (reader only; slides away with the chrome). The
	     region review strip replaces it while a post-draw review is active. -->
	{#if isMobile && $appView === 'reader'}
		<!-- Dock-format frame: same tap-transparent frame + inset padding as the
		     app dock, so the pill inside lands on the exact dock geometry. The
		     hidden offset carries the same 8px slack as the header wrapper. -->
		<section
			class="pointer-events-none fixed inset-x-0 bottom-0 z-40"
			style="padding: 0 calc(var(--dock-inset-x) + var(--sar, 0px)) calc(var(--dock-inset-bottom) + var(--sab, 0px)) calc(var(--dock-inset-x) + var(--sal, 0px)); transform: translateY({$mobileReaderUi.chrome === 'hidden' ? 'calc(100% + 8px)' : '0'}); opacity: {$mobileReaderUi.chrome === 'hidden' ? '0' : '1'}; transition: transform 220ms var(--ease-standard), opacity 180ms var(--ease-standard);"
			aria-label={m.shell_reader_tools()}
			aria-hidden={$mobileReaderUi.chrome === 'hidden' ? 'true' : undefined}
			inert={$mobileReaderUi.chrome === 'hidden'}
			data-mobile-reader-tools
		>
			{#if $highlightedDrawRegionIds.size > 0}
				<MobileRegionReviewStrip />
			{:else}
				<MobileReaderBottomBar />
			{/if}
		</section>
	{/if}
	{#if isMobile && $appView === 'reader' && $mobileReaderUi.disclosure === 'filmstrip'}
		<MobileFilmstrip />
	{/if}
	{#if isMobile && $appView === 'reader' && $mobileReaderUi.disclosure === 'page-jump'}
		<MobilePageJumpDialog />
	{/if}
	{#if isMobile && $appView === 'reader' && $mobileReaderUi.disclosure === 'translate-status'}
		<MobileTranslateStatusDialog />
	{/if}
	{#if isMobile && $appView === 'reader' && $mobileReaderUi.disclosure === 'book-toc'}
		<MobileBookTocPanel />
	{/if}
	{#if isMobile && $appView === 'reader' && $mobileReaderUi.disclosure === 'book-display'}
		<MobileBookDisplayMenu />
	{/if}
	<!-- Return chip: fixed above the collapsed bar (rides above the filmstrip
	     when it is open); hidden while the sheet is expanded (removed with the
	     sheet in P3). -->
	{#if isMobile && $appView === 'reader' && $readerPageJump.returnIndex != null}
		<button
			type="button"
			transition:fade={{ duration: motionDuration(120) }}
			class="fixed left-1/2 z-[46] min-h-[48px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border border-surface-600 bg-surface-900 px-4 text-sm font-medium text-surface-100 shadow-xl"
			style={`bottom: calc(var(--reader-bottom-clearance) + ${$mobileReaderUi.disclosure === 'filmstrip' ? '130px' : '8px'})`}
			onclick={() => {
				const index = readerPageJump.consume();
				if (index != null) currentPageIndex.set(index);
			}}
			data-reader-return-page
		>{m.reader_return_to_page({ page: $readerPageJump.returnIndex + 1 })}</button>
	{/if}
</div>

<!-- Keep the fixed selector outside the mobile header's transformed stacking
	context. Android WebView otherwise composites it into the same layer while
	the independently transformed manga page is still being repainted. -->
{#if !isMobile && $pageThumbnailScrubberOpen && $appView === 'reader'}
	<PageThumbnailScrubber onClose={() => { pageThumbnailScrubberOpen.set(false); }} />
{/if}

<!-- Mobile settings first-mount overlay: covers the one expensive DOM build
     of the keep-alive SettingsView (later entries are visibility flips). -->
{#if isMobile && $settingsLoading}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-surface-900"
		style="padding-top: var(--sat, 0px); padding-bottom: var(--sab, 0px);"
	>
		<div class="flex flex-col items-center gap-3">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent motion-reduce:animate-none"></div>
			<span class="text-sm text-surface-400">{m.reader_loading()}</span>
		</div>
	</div>
{/if}

<!-- Modal dialogs -->
<ImportDialog />
{#if !isMobile}
	<SettingsDialog />
{/if}
<OnboardingTour />

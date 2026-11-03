<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade, scale } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { scrollEdgeFade } from '$lib/util/scroll-edge-fade.js';
	import { get } from 'svelte/store';
	import RevisionDialog from '$lib/components/reader/RevisionDialog.svelte';
	import {
		appView,
		currentPageIndex,
		currentVolume,
		isOverlayMode,
		readerSessionId,
		readerTargetEpoch
	} from '$lib/stores/reader-state.js';
	import { currentPageOverlay, currentPageTranslation } from '$lib/stores/translation-state.js';
	import { settingsLoading, settingsReturnView, settingsInitialTab, settingsViewMounted, helpInitialSection, readerTransientCloseHandler } from '$lib/stores/ui-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { mobileReaderUi } from '$lib/reader/mobile-reader-ui.js';
	import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
	import { beginRegionDrawSession } from '$lib/regions/region-draw-session.js';
	import { revisePage } from '$lib/translation/revision-service.js';
	import { createPageSource } from '$lib/reader/page-source-factory.js';
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import { isWebChapter, prefetchWebChapter } from '$lib/web-browser/web-chapter.js';
	import { activeTranslationJobs } from '$lib/stores/volume-translation-state.js';
	import { isJobActive, startVolumeTranslation } from '$lib/translation/volume-translation-service.js';
	import { areOcrModelsReady } from '$lib/detection/ocr-model-manager.js';
	import { openOcrModelPrompt } from '$lib/detection/ocr-model-gate.js';
	import { pushToast } from '$lib/stores/toasts.js';
	import Icon from '$lib/components/ui/Icon.svelte';
	import SaveChapterDialog from '$lib/components/web-browser/SaveChapterDialog.svelte';
	import { saveDefaults } from '$lib/web-browser/browser-controller.js';
	import { isSavedWebChapter, saveWebChapter } from '$lib/web-browser/web-chapter-store.js';

	let open = $derived($mobileReaderUi.disclosure === 'translate-options');
	let revisionDialogOpen = $state(false);
	let revising = $state(false);
	let actionError = $state<string | null>(null);

	function closeRevisionDialog(): void {
		revisionDialogOpen = false;
	}

	// Android back must dismiss the dialog before the reader ladder runs
	// (handleReaderBack consults readerTransientCloseHandler first).
	$effect(() => {
		if (!revisionDialogOpen) return;
		readerTransientCloseHandler.set(closeRevisionDialog);
		return () => {
			if (get(readerTransientCloseHandler) === closeRevisionDialog) {
				readerTransientCloseHandler.set(null);
			}
		};
	});

	function toggle(key: 'readerAutoTranslateOverlays' | 'overlayVerticalText' | 'overlaySfx'): void {
		playReaderHaptic('control');
		settings.patch({ [key]: !get(settings)[key] });
	}

	/** Same lean start path the compact bar action will use (P3-2): startup
	 *  failures surface through the bar's failed state. */
	function retranslatePage(): void {
		const volume = get(currentVolume);
		if (!volume) return;
		playReaderHaptic('control');
		actionError = null;
		mobileReaderUi.closeDisclosure();
		if (get(settings).overlayEnabled && !get(isOverlayMode)) isOverlayMode.set(true);
		void readerPageTranslationController.requestManual({
			readerSessionId: get(readerSessionId),
			targetEpoch: get(readerTargetEpoch),
			volumeUuid: volume.volume_uuid,
			pageIndex: get(currentPageIndex)
		}).catch(() => {
			// The controller reports failures via its snapshot; never let a
			// menu tap become an unhandled rejection.
		});
	}

	// A web chapter is never in the Library, whose menu starts a whole-volume translation; the reader offers it.
	const chapterJob = $derived($currentVolume ? $activeTranslationJobs.get($currentVolume.volume_uuid) : undefined);
	const chapterTranslating = $derived(!!chapterJob && (chapterJob.status === 'translating' || chapterJob.status === 'reviewing') && !chapterJob.paused);

	// Saving a web chapter keeps its translations for when it is read on the site again.
	let chapterSaved = $state(false);
	let saveDialog = $state<{ chapterTitle: string; seriesTitle: string } | null>(null);
	$effect(() => {
		const volume = $currentVolume;
		if (!open || !volume || !isWebChapter(volume)) return;
		void isSavedWebChapter(volume.volume_uuid).then((saved) => (chapterSaved = saved));
	});

	function openSaveDialog(): void {
		const volume = get(currentVolume);
		const defaults = volume ? saveDefaults(volume) : null;
		if (!defaults) return;
		playReaderHaptic('control');
		mobileReaderUi.closeDisclosure();
		saveDialog = { chapterTitle: defaults.chapterTitle, seriesTitle: defaults.seriesTitle };
	}

	async function saveChapter(chapterTitle: string, seriesTitle: string): Promise<void> {
		const volume = get(currentVolume);
		const defaults = volume ? saveDefaults(volume) : null;
		saveDialog = null;
		if (!volume || !defaults) return;
		await saveWebChapter(volume, { ...defaults, chapterTitle, seriesTitle });
		chapterSaved = true;
		pushToast({ message: { code: 'browser_chapter_saved' } });
	}

	$effect(() => {
		if (!saveDialog) return;
		const close = () => (saveDialog = null);
		readerTransientCloseHandler.set(close);
		return () => {
			if (get(readerTransientCloseHandler) === close) readerTransientCloseHandler.set(null);
		};
	});

	async function translateChapter(): Promise<void> {
		const volume = get(currentVolume);
		if (!volume || isJobActive(volume.volume_uuid)) return;
		playReaderHaptic('control');
		actionError = null;
		mobileReaderUi.closeDisclosure();
		if (!(await areOcrModelsReady())) {
			openOcrModelPrompt(() => void translateChapter());
			return;
		}
		if (get(settings).overlayEnabled && !get(isOverlayMode)) isOverlayMode.set(true);
		try {
			await prefetchWebChapter(volume);
			const job = await startVolumeTranslation(volume.volume_uuid);
			const leftover = job.failed_pages?.length ?? 0;
			pushToast({
				message: leftover > 0
					? m.catalog_translation_complete_leftover_page({ leftover, s: leftover === 1 ? '' : 's' })
					: m.catalog_translation_complete()
			});
		} catch (error) {
			const cancelled = error instanceof Error && (error.name === 'AbortError' || /cancel/i.test(error.message));
			pushToast({
				message: cancelled ? m.catalog_translation_cancelled() : error instanceof Error ? error.message : m.job_failed_title(),
				tone: cancelled ? 'info' : 'error'
			});
		}
	}

	function openRevisionDialog(): void {
		playReaderHaptic('control');
		actionError = null;
		mobileReaderUi.closeDisclosure();
		revisionDialogOpen = true;
	}

	async function submitRevision(instructions: string): Promise<void> {
		revisionDialogOpen = false;
		const volume = get(currentVolume);
		if (!volume) return;
		const targetVolumeUuid = volume.volume_uuid;
		const targetPageIndex = get(currentPageIndex);
		revising = true;
		try {
			const source = await createPageSource(volume);
			const imageFile = await source.getPageAsFile(targetPageIndex);
			source.dispose();
			const result = await revisePage(targetVolumeUuid, targetPageIndex, instructions, imageFile);
			if (get(currentVolume)?.volume_uuid === targetVolumeUuid && get(currentPageIndex) === targetPageIndex) {
				currentPageTranslation.set(result);
				if (result.overlay_data) currentPageOverlay.set(result.overlay_data);
			}
		} catch (error) {
			actionError = error instanceof Error ? error.message : m.reader_revision_failed();
			mobileReaderUi.openDisclosure('translate-options');
		} finally {
			revising = false;
		}
	}

	function startRegionSelection(): void {
		const volume = get(currentVolume);
		if (!volume) return;
		playReaderHaptic('control');
		mobileReaderUi.closeDisclosure();
		beginRegionDrawSession({
			readerSessionId: get(readerSessionId),
			targetEpoch: get(readerTargetEpoch),
			volumeUuid: volume.volume_uuid,
			pageIndex: get(currentPageIndex)
		});
	}

	/** Deep link into Settings → Help → Translations (a dock destination). */
	function openTranslationHelp(): void {
		playReaderHaptic('control');
		mobileReaderUi.closeDisclosure();
		settingsReturnView.set(get(appView));
		settingsInitialTab.set('help');
		helpInitialSection.set('translations');
		if (!get(settingsViewMounted)) settingsLoading.set(true);
		appView.set('settings');
	}
</script>

{#if open}
	<button
		type="button"
		aria-label={m.reader_close_translate_options()}
		class="pointer-events-auto fixed inset-0 z-[90] bg-[var(--color-scrim-menu)]"
		onclick={() => mobileReaderUi.closeDisclosure()}
		in:fade={{ duration: motionDuration(120) }}
		out:fade={{ duration: motionDuration(exitDuration(120)) }}
	></button>
	<div
		id="reader-translate-options-menu"
		role="dialog"
		aria-label={m.reader_translate_options()}
		class="pointer-events-auto fixed z-[100] max-h-[calc(var(--viewport-height,100dvh)-var(--reader-chrome-top)-24px)] w-[min(20rem,calc(100vw-16px-var(--sal,0px)-var(--sar,0px)))] min-w-0 origin-top-right overflow-y-auto rounded-[var(--radius-card)] bg-surface-container-high p-2 shadow-2xl"
		style="top: calc(var(--reader-chrome-top) + 8px); right: calc(8px + var(--sar, 0px));"
		in:scale={{ start: 0.96, duration: motionDuration(120) }}
		out:scale={{ start: 0.96, duration: motionDuration(exitDuration(120)) }}
		use:scrollEdgeFade
		data-reader-translate-options-menu
	>
		<button
			type="button"
			class="flex h-[48px] w-full min-w-0 items-center justify-between rounded-lg bg-surface-800 px-3 text-sm text-surface-100 active:bg-surface-700 disabled:opacity-50"
			aria-pressed={$settings.readerAutoTranslateOverlays}
			disabled={!$settings.overlayEnabled}
			onclick={() => toggle('readerAutoTranslateOverlays')}
			data-translate-option="auto-translate"
		>
			<span class="truncate">{m.reader_auto_translate_pages()}</span><span class="shrink-0 text-teal-300">{$settings.readerAutoTranslateOverlays ? m.settings_server_on() : m.settings_server_off()}</span>
		</button>
		<button
			type="button"
			class="mt-2 flex h-[48px] w-full min-w-0 items-center justify-between rounded-lg bg-surface-800 px-3 text-sm text-surface-100 active:bg-surface-700"
			aria-pressed={$settings.overlayVerticalText}
			onclick={() => toggle('overlayVerticalText')}
			data-translate-option="vertical-text"
		>
			<span class="truncate">{m.settings_search_vertical_text_label()}</span><span class="shrink-0 text-teal-300">{$settings.overlayVerticalText ? m.settings_server_on() : m.settings_server_off()}</span>
		</button>
		<button
			type="button"
			class="mt-2 flex h-[48px] w-full min-w-0 items-center justify-between rounded-lg bg-surface-800 px-3 text-sm text-surface-100 active:bg-surface-700"
			aria-pressed={$settings.overlaySfx}
			onclick={() => toggle('overlaySfx')}
			data-translate-option="sfx-overlays"
		>
			<span class="truncate">{m.reader_sound_effect_overlays()}</span><span class="shrink-0 text-teal-300">{$settings.overlaySfx ? m.settings_server_on() : m.settings_server_off()}</span>
		</button>
		<div class="mt-2 border-t border-surface-700 pt-2">
			<button
				type="button"
				class="flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm text-surface-100 active:bg-surface-800 disabled:opacity-50"
				disabled={!$currentPageOverlay}
				onclick={() => { playReaderHaptic('control'); mobileReaderUi.openDisclosure('overlay-boxes'); }}
				data-translate-option="overlay-boxes"
			>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg>
				{m.reader_boxes_on_this_page_menu()}
			</button>
			<button
				type="button"
				class="mt-1 flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm text-surface-100 active:bg-surface-800 disabled:opacity-50"
				onclick={retranslatePage}
				data-translate-option="retranslate-page"
			>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
				<span class="flex min-w-0 flex-col items-start leading-tight"><span>{m.reader_re_translate_page()}</span><span class="text-[11px] text-surface-400">{m.reader_keeps_the_boxes_you()}</span></span>
			</button>
			<button
				type="button"
				class="mt-1 flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm text-surface-100 active:bg-surface-800 disabled:opacity-50"
				disabled={!$currentPageTranslation || revising}
				onclick={openRevisionDialog}
				data-translate-option="revise-page"
			>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
				{revising ? m.reader_revising() : m.reader_revise_page()}
			</button>
			<button
				type="button"
				class="mt-1 flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm active:bg-surface-800 disabled:cursor-not-allowed {$settings.readerMode === 'long-strip' ? 'text-surface-500 opacity-50' : 'text-surface-100'}"
				disabled={$settings.readerMode === 'long-strip'}
				title={$settings.readerMode === 'long-strip' ? m.reader_region_drawing_needs_paged() : undefined}
				onclick={startRegionSelection}
				data-translate-option="select-regions"
			>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><rect x="8" y="9" width="8" height="6" rx="1"/></svg>
				{m.reader_select_regions()}
			</button>
			{#if isWebChapter($currentVolume)}
				<button
					type="button"
					class="mt-1 flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm text-surface-100 active:bg-surface-800 disabled:opacity-50"
					disabled={chapterTranslating}
					onclick={() => void translateChapter()}
					data-translate-option="translate-chapter"
				>
					<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="11" height="15" rx="2"/><path d="M9 21h9a2 2 0 0 0 2-2V8"/></svg>
					<span class="flex min-w-0 flex-col items-start leading-tight">
						{#if chapterTranslating && chapterJob}
							<span>{m.reader_translating_chapter({ done: chapterJob.current_page, total: chapterJob.total_pages })}</span>
						{:else}
							<span>{m.reader_translate_chapter()}</span><span class="text-[11px] text-surface-400">{m.reader_translate_chapter_hint()}</span>
						{/if}
					</span>
				</button>
				<button
					type="button"
					class="mt-1 flex h-[48px] w-full items-center gap-3 rounded-lg px-3 text-sm text-surface-100 active:bg-surface-800 disabled:opacity-60"
					disabled={chapterSaved}
					onclick={openSaveDialog}
					data-translate-option="save-chapter"
				>
					{#if chapterSaved}
						<span class="text-primary-300" aria-hidden="true"><Icon name="check" size={20} /></span>
						<span>{m.reader_chapter_saved()}</span>
					{:else}
						<span aria-hidden="true"><Icon name="download" size={20} /></span>
						<span class="flex min-w-0 flex-col items-start leading-tight"><span>{m.reader_save_chapter()}</span><span class="text-[11px] text-surface-400">{m.reader_save_chapter_hint()}</span></span>
					{/if}
				</button>
			{/if}
		</div>

		{#if actionError}
			<p class="mt-2 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-300" role="alert">{actionError}</p>
		{/if}

		<button
			type="button"
			class="mt-2 flex h-[48px] w-full items-center gap-3 rounded-lg border-t border-surface-800 px-3 text-sm text-surface-400 active:bg-surface-800"
			onclick={openTranslationHelp}
			data-translate-option="help"
		>
			<span class="flex h-6 w-6 items-center justify-center rounded-full border border-surface-700 text-sm font-semibold">?</span>
			{m.reader_translation_help()}
		</button>
	</div>
{/if}

{#if saveDialog}
	<SaveChapterDialog
		chapterTitle={saveDialog.chapterTitle}
		seriesTitle={saveDialog.seriesTitle}
		onsave={(chapter, series) => void saveChapter(chapter, series)}
		onclose={() => (saveDialog = null)}
	/>
{/if}

{#if revisionDialogOpen}
	<RevisionDialog
		scope="page"
		targetOrder={null}
		onsubmit={submitRevision}
		onclose={() => (revisionDialogOpen = false)}
	/>
{/if}

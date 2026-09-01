import { derived, get } from 'svelte/store';
import { db } from '$lib/db/index.js';
import { createPageSource } from '$lib/reader/page-source-factory.js';
import {
	currentPageIndex,
	currentVolume,
	readerSessionId,
	readerTargetEpoch,
	readingDirection
} from '$lib/stores/reader-state.js';
import { setCurrentPageTranslationPayload } from '$lib/stores/translation-state.js';
import { settings, snapshotFumetoSettings } from '$lib/settings/settings.js';
import { resolveActiveProvider } from './llm-client.js';
import { TranslationCoverageError } from './translation-coverage.js';
import { supersedeAutomaticPageTranslation } from './page-translation-activity.js';
import {
	createReaderPageTranslationController,
	type ReaderPageTranslationRunContext
} from './reader-page-translation-controller.js';
import {
	progressivePageTranslationPreview,
	type ProgressivePageTranslationSnapshot,
	type ProgressivePageTranslationTarget
} from './progressive-page-translation-preview.js';

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

async function executePageTranslation(context: ReaderPageTranslationRunContext) {
	await supersedeAutomaticPageTranslation({
		volumeUuid: context.target.volumeUuid,
		pageIndex: context.target.pageIndex
	}, context.signal);
	const volume = await db.volumes.get(context.target.volumeUuid);
	if (!volume) throw new Error('The selected volume no longer exists');
	const source = await createPageSource(volume, { purpose: 'background', signal: context.signal });
	try {
		const imageFile = await source.getPageAsFile(context.target.pageIndex, { signal: context.signal });
		// Video pages carry no translatable text; the detector/providers must
		// never see a video blob. (The reader hides translate affordances on
		// video pages — this is the backstop.)
		if (imageFile.type.startsWith('video/')) {
			throw new Error('Video pages have no text to translate.');
		}
		if (context.settings.translationPipeline === 'on-device') {
			context.setPhase('detecting');
			const { translatePageOnDevice } = await import('./on-device-service.js');
			const previewTarget: ProgressivePageTranslationTarget = { ...context.target };
			const previewToken = progressivePageTranslationPreview.begin(
				previewTarget,
				currentProgressiveTarget()
			);
			try {
				const result = await translatePageOnDevice(
					context.target.volumeUuid,
					context.target.pageIndex,
					imageFile,
					{
						signal: context.signal,
						// Frozen with the rest of this run's choices, like the
						// off-device branch's `runtime` below.
						readingDirection: get(readingDirection),
						runtimeOverrides: {
							sourceLang: context.settings.onDeviceSourceLang,
							targetLang: context.settings.onDeviceTargetLang,
							ocrProvider: context.settings.onDeviceOCRProvider,
							translationBackend: context.settings.onDeviceTranslationBackend,
							overlayMode: context.settings.overlayMode
						},
						shouldPublishProgressiveUpdate: context.shouldPublish,
						onProgressiveSnapshot: (snapshot) => {
							progressivePageTranslationPreview.publish(
								previewToken,
								snapshot,
								currentProgressiveTarget()
							);
						},
						onProgress: (progress) => {
							context.setPhase(
								progress.phase === 'detecting'
									? 'detecting'
									: progress.phase === 'persisting'
										? 'persisting'
										: progress.phase === 'done'
											? 'post-processing'
											: 'translating'
							);
							context.setProgress({
								completed: progress.completed,
								total: progress.total,
								currentBoxId: progress.currentBoxId
							}, progress.phase === 'done');
						}
					}
				);
				context.setPhase('post-processing');
				const finalSnapshot: ProgressivePageTranslationSnapshot = {
					target: {
						volumeUuid: context.target.volumeUuid,
						pageIndex: context.target.pageIndex
					},
					pageTranslation: result.pageTranslation,
					overlayData: result.overlayData
				};
				if (context.shouldPublish()) {
					const committed = progressivePageTranslationPreview.commit(
						previewToken,
						finalSnapshot,
						currentProgressiveTarget()
					);
					if (!committed) {
						throw new Error('A newer page update superseded the completed translation preview');
					}
				} else {
					progressivePageTranslationPreview.abandon(previewToken);
				}
				if (result.partialFailure) {
					// The partial page is persisted and committed (the rollback in
					// the catch below is a no-op once commit ran) — surface the
					// failure without hiding the overlays that DID translate.
					context.publishCommitted({
						pageTranslation: result.pageTranslation,
						overlayData: result.overlayData
					});
					throw new TranslationCoverageError(
						'invalid-output',
						result.partialFailure.requiredCount,
						result.partialFailure.translatedRequiredCount,
						result.partialFailure.failedBlockIndexes
					);
				}
				return { pageTranslation: result.pageTranslation, overlayData: result.overlayData };
			} catch (error) {
				progressivePageTranslationPreview.rollback(previewToken, currentProgressiveTarget());
				throw error;
			}
		}

		context.setPhase('detecting');
		const provider = await resolveActiveProvider(context.settings);
		const runtime = {
			settings: context.settings,
			provider,
			readingDirection: get(readingDirection)
		} as const;
		if (context.settings.overlayEnabled) {
			const { translateFullPageWithOverlay } = await import('./full-page-service.js');
			const result = await translateFullPageWithOverlay(
				context.target.volumeUuid,
				context.target.pageIndex,
				imageFile,
				undefined,
				{
					signal: context.signal,
					shouldPublishAsyncResult: context.shouldPublish,
					runtime,
					onPhase: (phase) => context.setPhase(phase),
					onPersisted: (persisted) => context.publishCommitted(persisted)
				}
			);
			return { pageTranslation: result.pageTranslation, overlayData: result.overlayData };
		}
		const { translateFullPage } = await import('./full-page-service.js');
		const pageTranslation = await translateFullPage(
			context.target.volumeUuid,
			context.target.pageIndex,
			imageFile,
			undefined,
			{
				signal: context.signal,
				runtime,
				onPhase: (phase) => context.setPhase(phase),
				onPersisted: (persisted) => context.publishCommitted(persisted)
			}
		);
		return { pageTranslation, overlayData: null };
	} finally {
		source.dispose();
	}
}

export const readerPageTranslationController = createReaderPageTranslationController({
	snapshotSettings: () => snapshotFumetoSettings(get(settings)),
	execute: executePageTranslation,
	publish(result) {
		// Exact-target and cancellation-reason gating is owned by publishCommitted.
		// Re-checking AbortSignal here would hide a transaction that committed just
		// before an explicit user cancellation.
		setCurrentPageTranslationPayload(result.pageTranslation, result.overlayData);
	}
});

// The controller is app-scoped, so its target binding must be app-scoped too.
// Sidebar/panel lifetimes are presentation details and cannot safely own this
// subscription. A real page/session change advances readerTargetEpoch and aborts
// the exact old manual run before it can publish into the new page's stores.
derived(
	[readerSessionId, readerTargetEpoch, currentVolume, currentPageIndex],
	([$readerSessionId, $readerTargetEpoch, $currentVolume, $currentPageIndex]) => (
		$readerSessionId && $currentVolume
			? {
				readerSessionId: $readerSessionId,
				targetEpoch: $readerTargetEpoch,
				volumeUuid: $currentVolume.volume_uuid,
				pageIndex: $currentPageIndex
			}
			: null
	)
).subscribe((target) => {
	if (target) readerPageTranslationController.setTarget(target);
});

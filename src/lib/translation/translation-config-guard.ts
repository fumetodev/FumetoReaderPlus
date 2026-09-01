/**
 * Stops volume translations that their settings no longer describe.
 *
 * A running job resolves its provider once and keeps that snapshot, which is
 * what makes a long run deterministic. The cost is that switching pipeline or
 * provider mid-run leaves jobs quietly working against the configuration the
 * user just moved away from — still spending on a cloud key they switched off.
 * This guard closes that gap: jobs whose configuration changed underneath them
 * are cancelled, keeping every page translated so far and staying resumable.
 */

import type { UserMessage } from '$lib/i18n/user-messages.js';
import { get } from 'svelte/store';
import type { FumetoSettings } from '$lib/settings/settings.js';
import { settings } from '$lib/settings/settings.js';
import { activeRunDescriptors, cancelVolumeTranslation, type ActiveRunDescriptor } from './volume-translation-service.js';

export interface TranslationConfigSnapshot {
	pipeline: 'off-device' | 'on-device';
	activeProviderId: string | null;
	providerIds: readonly string[];
}

export function snapshotTranslationConfig($settings: FumetoSettings): TranslationConfigSnapshot {
	return {
		pipeline: $settings.translationPipeline === 'on-device' ? 'on-device' : 'off-device',
		activeProviderId: $settings.activeProviderId ?? null,
		providerIds: ($settings.providers ?? []).map((provider) => provider.id)
	};
}

/**
 * Why this run can no longer continue, or null when it is still valid.
 *
 * On-device runs do not care which cloud provider is selected, so only a
 * pipeline switch touches them.
 */
export function invalidationReason(
	run: ActiveRunDescriptor,
	next: TranslationConfigSnapshot
): UserMessage | null {
	if (run.pipeline !== next.pipeline) {
		return next.pipeline === 'on-device'
			? { code: 'job_cancelled_pipeline_on_device' }
			: { code: 'job_cancelled_pipeline_off_device' };
	}
	if (run.pipeline === 'on-device') return null;
	if (run.providerId && !next.providerIds.includes(run.providerId)) {
		return { code: 'job_cancelled_provider_removed' };
	}
	if (run.providerId && next.activeProviderId && run.providerId !== next.activeProviderId) {
		return { code: 'job_cancelled_provider_changed' };
	}
	return null;
}

/** Runs to stop, with the reason each one is stopping. */
export function runsInvalidatedBy(
	next: TranslationConfigSnapshot,
	runs: readonly ActiveRunDescriptor[] = activeRunDescriptors()
): { volumeUuid: string; reason: UserMessage }[] {
	return runs
		.map((run) => ({ volumeUuid: run.volumeUuid, reason: invalidationReason(run, next) }))
		.filter((entry): entry is { volumeUuid: string; reason: UserMessage } => entry.reason !== null);
}

let uninstall: (() => void) | null = null;

/**
 * Watch settings for changes that invalidate running translations.
 * Returns an uninstall function; calling install twice is a no-op.
 */
export function installTranslationConfigGuard(
	onCancelled?: (volumeUuid: string, reason: UserMessage) => void
): () => void {
	if (uninstall) return uninstall;
	let previous = snapshotTranslationConfig(get(settings));
	const unsubscribe = settings.subscribe(($settings) => {
		const next = snapshotTranslationConfig($settings);
		const changed = next.pipeline !== previous.pipeline
			|| next.activeProviderId !== previous.activeProviderId
			|| next.providerIds.join(',') !== previous.providerIds.join(',');
		previous = next;
		if (!changed) return;
		for (const { volumeUuid, reason } of runsInvalidatedBy(next)) {
			void cancelVolumeTranslation(volumeUuid, reason);
			onCancelled?.(volumeUuid, reason);
		}
	});
	uninstall = () => {
		unsubscribe();
		uninstall = null;
	};
	return uninstall;
}

/**
 * Shared working state for the Settings surface (apply-immediately model).
 *
 * The dialog hydrates this draft from the settings store when it opens; every
 * control binds to it; an effect in SettingsDialog schedules a debounced
 * apply that patches the store. There is no Save/Cancel pair anymore — every
 * exit path flushes the same pending apply (review finding B5: hardware back
 * and bottom-bar navigation already saved, while Cancel silently discarded).
 *
 * Provider API keys keep their transactional draft treatment: keys are staged
 * (stageProviderKeyDraft) when a provider editor collapses and committed with
 * the next apply via planProviderKeyCommit, so a key write/delete can never
 * outlive or precede its provider entry.
 */
import { get } from 'svelte/store';
import type { UiLocaleSetting } from '$lib/i18n/locales.js';
import {
	settings,
	saveApiKeySecurely,
	saveProviderApiKey,
	ON_DEVICE_TEMPERATURE_DEFAULT,
	type FumetoSettings,
	type Library
} from '$lib/settings/settings.js';
import type { ProviderConfig } from '$lib/translation/llm-types.js';
import { clearProviderKey } from '$lib/settings/secure-storage.js';
import { DEFAULT_HYMT2_VARIANT } from '$lib/settings/settings.js';
import { planProviderKeyCommit } from '$lib/settings/provider-key-drafts.js';
import { syncLibraryWatchers } from '$lib/library/library-watch-sync.js';

const APPLY_DEBOUNCE_MS = 250;

export class SettingsDraft {
	/** True while hydrate() populates fields — the watch effect skips applies. */
	hydrating = false;

	// Translation (off-device)
	apiKey = $state('');
	model = $state('');
	temperature = $state(1.0);
	maxContextTokens = $state(10000);
	skipReviewPass = $state(true);
	translationMode = $state<number>(2);
	sourceLanguage = $state('ja');
	targetLanguage = $state('en');
	providers = $state<ProviderConfig[]>([]);
	activeProviderId = $state<string | null>(null);
	/** Draft API-key changes. Empty strings are deletion tombstones. */
	pendingApiKeys = $state<Map<string, string>>(new Map());

	// Translation (on-device)
	translationPipeline = $state<'off-device' | 'on-device'>('off-device');
	onDeviceSourceLang = $state('auto');
	onDeviceTargetLang = $state('en');
	onDeviceOCRProvider = $state<'ppocr'>('ppocr');
	onDeviceTranslationBackend = $state<'translategemma'>('translategemma');
	hyMT2Variant = $state<FumetoSettings['hyMT2Variant']>(DEFAULT_HYMT2_VARIANT);
	onDeviceTemperature = $state(ON_DEVICE_TEMPERATURE_DEFAULT);
	backgroundTranslation = $state(false);
	desktopUpdateCheck = $state(true);
	localProviderConcurrency = $state(1);
	debugLogging = $state(false);

	// Display / overlay
	uiLocale = $state<UiLocaleSetting>('system');
	colorScheme = $state('dark-grey');
	resumeLastPage = $state(true);
	continueToNextVolume = $state(false);
	restartFinishedVolumes = $state(false);
	switchToNewTabsImmediately = $state(false);
	showLibraryAccessWarnings = $state(true);
	showLibraryScanProgress = $state(true);
	overlayEnabled = $state(true);
	overlayMode = $state<'bubble-segmentation' | 'auto-fit' | 'text-replacement'>('bubble-segmentation');
	overlayAutoGenerate = $state(true);
	overlayVerticalText = $state(false);
	overlayMinFontSize = $state(18);
	variableFontSizing = $state(false);
	overlayDetectionMethod = $state<'ppocr'>('ppocr');
	overlayFontScaleDefault = $state(1.0);
	overlaySfx = $state(false);

	// Reading defaults
	defaultReadingDirection = $state<'rtl' | 'ltr'>('rtl');
	readerMode = $state<'paged' | 'long-strip'>('paged');
	pageTurnMode = $state<'swipe' | 'tap' | 'both'>('swipe');

	// Libraries
	libraries = $state<Library[]>([]);

	/** Non-null when the most recent apply failed; shown inline by the shell. */
	applyError = $state<string | null>(null);

	/**
	 * Populate every field from a settings snapshot. loadSettings() merges
	 * stored values over DEFAULT_SETTINGS, so fields are always present —
	 * no per-field fallbacks (review finding B9: the dialog carried `?? x`
	 * fallbacks that disagreed with DEFAULT_SETTINGS).
	 */
	hydrate(s: Readonly<FumetoSettings>): void {
		this.hydrating = true;
		this.applyError = null;
		this.apiKey = s.openrouterApiKey;
		this.model = s.selectedModel;
		this.temperature = s.temperature;
		this.maxContextTokens = s.maxContextTokens;
		this.skipReviewPass = s.skipReviewPass;
		this.translationMode = s.translationMode;
		this.sourceLanguage = s.sourceLanguage;
		this.targetLanguage = s.targetLanguage;
		this.providers = (s.providers ?? []).map((provider) => ({ ...provider }));
		this.activeProviderId = s.activeProviderId;
		this.pendingApiKeys = new Map();
		this.translationPipeline = s.translationPipeline;
		this.onDeviceSourceLang = s.onDeviceSourceLang;
		this.onDeviceTargetLang = s.onDeviceTargetLang;
		this.onDeviceOCRProvider = s.onDeviceOCRProvider;
		this.onDeviceTranslationBackend = s.onDeviceTranslationBackend;
		// 'manga-v1' can still arrive here from the file-restore path in
		// initSecureSettings(), which merges onto DEFAULT_SETTINGS without
		// running loadSettings()'s migrations.
		//
		// `customModel` is deliberately NOT mirrored into the draft: it is
		// written by the import flow, not edited here, and an open dialog's
		// draft does not re-hydrate from store writes. The custom row reads it
		// straight from the settings store so an import updates the UI live.
		this.hyMT2Variant = (s.hyMT2Variant as string) === 'manga-v1' ? 'manga-v2'
			: (s.hyMT2Variant as string) === 'manga-v4' ? 'manga-v5'
			: (s.hyMT2Variant ?? DEFAULT_HYMT2_VARIANT);
		this.onDeviceTemperature = s.onDeviceTemperature ?? ON_DEVICE_TEMPERATURE_DEFAULT;
		this.backgroundTranslation = s.backgroundTranslation;
		this.desktopUpdateCheck = s.desktopUpdateCheck ?? true;
		this.localProviderConcurrency = s.localProviderConcurrency;
		this.debugLogging = s.debugLogging;
		this.uiLocale = s.uiLocale ?? 'system';
		this.colorScheme = s.colorScheme;
		this.resumeLastPage = s.resumeLastPage;
		this.continueToNextVolume = s.continueToNextVolume ?? false;
		this.restartFinishedVolumes = s.restartFinishedVolumes;
		this.switchToNewTabsImmediately = s.switchToNewTabsImmediately;
		this.showLibraryAccessWarnings = s.showLibraryAccessWarnings;
		this.showLibraryScanProgress = s.showLibraryScanProgress;
		this.overlayEnabled = s.overlayEnabled;
		this.overlayMode = s.overlayMode;
		this.overlayAutoGenerate = s.overlayAutoGenerate;
		this.overlayVerticalText = s.overlayVerticalText;
		this.overlayMinFontSize = s.overlayMinFontSize;
		this.variableFontSizing = s.variableFontSizing;
		this.overlayDetectionMethod = s.overlayDetectionMethod;
		this.overlayFontScaleDefault = s.overlayFontScaleDefault;
		this.overlaySfx = s.overlaySfx;
		this.defaultReadingDirection = s.defaultReadingDirection;
		this.readerMode = s.readerMode;
		this.pageTurnMode = s.pageTurnMode;
		this.libraries = s.libraries.map((library) => ({ ...library }));
	}

	/**
	 * Read every applied field (the watch effect calls this to establish
	 * tracking) and produce the store patch.
	 */
	collectPatch(): Partial<FumetoSettings> {
		// Legacy fallback fields stay in sync with the active OpenRouter
		// provider — llm-client.ts still uses them as its last resort.
		const activeProvider = this.providers.find((p) => p.id === this.activeProviderId);
		const legacyModel = activeProvider?.type === 'openrouter'
			? activeProvider.defaultModel || this.model
			: this.model;

		return {
			openrouterApiKey: this.apiKey,
			selectedModel: legacyModel,
			temperature: this.temperature,
			maxContextTokens: Math.max(1024, this.maxContextTokens || 1024),
			skipReviewPass: this.skipReviewPass,
			translationMode: this.translationMode as FumetoSettings['translationMode'],
			translationPipeline: this.translationPipeline,
			onDeviceOCRProvider: this.onDeviceOCRProvider,
			onDeviceTranslationBackend: this.onDeviceTranslationBackend,
			hyMT2Variant: this.hyMT2Variant,
			onDeviceTemperature: this.onDeviceTemperature,
			onDeviceSourceLang: this.onDeviceSourceLang,
			onDeviceTargetLang: this.onDeviceTargetLang,
			backgroundTranslation: this.backgroundTranslation,
			desktopUpdateCheck: this.desktopUpdateCheck,
			localProviderConcurrency: Math.max(1, Math.min(8, this.localProviderConcurrency || 1)),
			debugLogging: this.debugLogging,
			uiLocale: this.uiLocale,
			colorScheme: this.colorScheme,
			sourceLanguage: this.sourceLanguage,
			targetLanguage: this.targetLanguage,
			resumeLastPage: this.resumeLastPage,
			continueToNextVolume: this.continueToNextVolume,
			restartFinishedVolumes: this.restartFinishedVolumes,
			switchToNewTabsImmediately: this.switchToNewTabsImmediately,
			showLibraryAccessWarnings: this.showLibraryAccessWarnings,
			showLibraryScanProgress: this.showLibraryScanProgress,
			overlayEnabled: this.overlayEnabled,
			overlayMode: this.overlayMode,
			overlayAutoGenerate: this.overlayAutoGenerate,
			overlayVerticalText: this.overlayVerticalText,
			overlayMinFontSize: this.overlayMinFontSize,
			variableFontSizing: this.variableFontSizing,
			overlayDetectionMethod: this.overlayDetectionMethod,
			overlayFontScaleDefault: Math.max(0.5, Math.min(3, this.overlayFontScaleDefault || 1)),
			overlaySfx: this.overlaySfx,
			defaultReadingDirection: this.defaultReadingDirection,
			readerMode: this.readerMode,
			pageTurnMode: this.pageTurnMode,
			libraries: this.libraries.map((library) => ({ ...library })),
			providers: this.providers.map((provider) => ({ ...provider })),
			activeProviderId: this.activeProviderId,
			// Clear legacy single-library fields
			libraryPath: null,
			libraryWatchEnabled: false
		};
	}
}

export const settingsDraft = new SettingsDraft();

let applyTimer: ReturnType<typeof setTimeout> | null = null;
/** Serializes async applies so secure-storage writes never interleave. */
let applyChain: Promise<void> = Promise.resolve();

async function performApply(): Promise<void> {
	const previous = get(settings);
	const patch = settingsDraft.collectPatch();

	// Commit staged provider API keys transactionally with the provider list.
	const keyCommitPlan = planProviderKeyCommit(
		previous.providers ?? [],
		settingsDraft.providers,
		settingsDraft.pendingApiKeys
	);
	for (const [providerId, key] of keyCommitPlan.writes) {
		await saveProviderApiKey(providerId, key);
	}
	for (const providerId of keyCommitPlan.removedProviderIds) {
		clearProviderKey(providerId);
	}
	if (keyCommitPlan.writes.size > 0 || keyCommitPlan.removedProviderIds.length > 0) {
		const remaining = new Map(settingsDraft.pendingApiKeys);
		for (const providerId of keyCommitPlan.writes.keys()) remaining.delete(providerId);
		for (const providerId of keyCommitPlan.removedProviderIds) remaining.delete(providerId);
		settingsDraft.pendingApiKeys = remaining;
	}

	// The legacy key is encrypted at rest — only rewrite it when it changed.
	if (settingsDraft.apiKey !== previous.openrouterApiKey) {
		await saveApiKeySecurely(settingsDraft.apiKey);
	}

	settings.patch(patch);

	// Folder watchers follow the library set as soon as it changes: a switch
	// flipped here starts or stops its watcher now, not on the next launch.
	if (patch.libraries && JSON.stringify(patch.libraries) !== JSON.stringify(previous.libraries)) {
		void syncLibraryWatchers(patch.libraries);
	}
}

/** Apply the draft now (awaits any in-flight apply first). */
export function applyDraftNow(): Promise<void> {
	if (applyTimer !== null) {
		clearTimeout(applyTimer);
		applyTimer = null;
	}
	applyChain = applyChain
		.then(() => performApply())
		.then(() => {
			settingsDraft.applyError = null;
		})
		.catch((error) => {
			console.error('[settings] Failed to apply changes:', error);
			settingsDraft.applyError =
				error instanceof Error ? error.message : 'Failed to save settings';
		});
	return applyChain;
}

/** Debounced apply — called by the shell's watch effect on any draft edit. */
export function scheduleApply(): void {
	if (applyTimer !== null) clearTimeout(applyTimer);
	applyTimer = setTimeout(() => {
		applyTimer = null;
		void applyDraftNow();
	}, APPLY_DEBOUNCE_MS);
}

/**
 * Inline editors that hold edits the draft has not seen yet (the provider row
 * stages its key and model only when it collapses) register here, so leaving
 * Settings stages them before the flush. Returns the unregister function.
 * A hook returns true when it staged something.
 */
const editorCommitHooks = new Set<() => boolean>();

export function registerEditorCommit(hook: () => boolean): () => void {
	editorCommitHooks.add(hook);
	return () => {
		editorCommitHooks.delete(hook);
	};
}

function commitOpenEditors(): boolean {
	let staged = false;
	for (const hook of editorCommitHooks) if (hook()) staged = true;
	return staged;
}

/**
 * Flush a pending debounce and wait for all applies to settle.
 *
 * Open editors are committed first. Every exit path flushed BEFORE the surface
 * tore the tabs down, and the provider row only staged its API key in its own
 * teardown — after the flush, into a panel that was no longer active — so a
 * key typed and never collapsed by hand was applied by nobody.
 */
export function flushPendingApply(): Promise<void> {
	const staged = commitOpenEditors();
	if (staged || applyTimer !== null) return applyDraftNow();
	return applyChain;
}

/** True when an apply is scheduled but not yet flushed (test/debug hook). */
export function hasPendingApply(): boolean {
	return applyTimer !== null;
}

/**
 * User settings, stored in localStorage.
 *
 * The OpenRouter API key is encrypted via Web Crypto AES-256-GCM
 * (see secure-storage.ts) and stored separately from the main settings.
 * All OpenRouter calls go directly from browser to openrouter.ai.
 */

import { defaultTargetForUiLocale, isUiLocaleSetting, type UiLocaleSetting } from '$lib/i18n/locales.js';
import { getUiLocale } from '$lib/i18n/locale.js';
import { get, writable } from 'svelte/store';
import { randomUUID } from '$lib/util/uuid.js';
import type { PageViewMode, TranslationMode } from '$lib/types/index.js';
import type { ProviderConfig } from '$lib/translation/llm-types.js';

import { initFsPersistence, readSettingsFromFile, writeSettingsToFile } from './settings-persistence.js';

/** Preferred OpenRouter vision model for new/default provider configurations. */
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.1-flash-lite';

export { SUPPORTED_LANGUAGES, ON_DEVICE_SOURCE_LANGUAGES, ON_DEVICE_TARGET_LANGUAGES, getLanguagePromptName } from './language-prompt-names.js';
import { ON_DEVICE_TARGET_LANGUAGES, SUPPORTED_LANGUAGES } from './language-prompt-names.js';

/**
 * A GGUF the user imported from device storage, to run instead of one of the
 * bundled Hy-MT2 variants.
 *
 * `templateMode` records how the native bridge resolved the model's prompt
 * format at import time. 'auto' means llama.cpp recognised the model's own
 * embedded chat template; 'manual' means it did not and the user supplied the
 * wrapping below. The manual fields are meaningless in 'auto' mode.
 */
export interface CustomModelRecord {
	/** Original filename from the document picker. Display only — never a path. */
	displayName: string;
	/** Size of the imported file on disk, for the storage and memory advice rows. */
	sizeBytes: number;
	importedAt: number;
	templateMode: 'auto' | 'manual';
	/** Text placed before the user turn, e.g. `<|im_start|>user\n`. */
	promptPrefix?: string;
	/** Text placed after it, ending in the assistant cue. */
	promptSuffix?: string;
	/** Extra strings that terminate generation, beyond the model's own EOG token. */
	stopStrings?: string[];
	/**
	 * True when the model loaded but its translation self-test came back
	 * unusable. The file is kept — the user chose it deliberately and paid the
	 * import cost — but the picker says so.
	 */
	failedSelfTest?: boolean;
	/**
	 * Set when the model will not load at all for a reason no prompt format can
	 * fix — out of memory, a truncated file, an unsupported quant. Kept
	 * separate from `failedSelfTest` so the UI does not offer a chat-format
	 * form to someone whose device simply cannot run the model.
	 */
	loadError?: string;
}

/** A local library folder that Fumeto watches for archives */
export interface LocalLibrary {
	id: string;
	type: 'local';
	name: string;
	path: string;
	autoScan: boolean;
	watchEnabled: boolean;
}

/** A remote library served by a YACReader Library Server */
export interface YACReaderLibrary {
	id: string;
	type: 'yacreader';
	name: string;
	serverUrl: string;
	remoteLibraryId: number;
	remoteLibraryUuid: string;
	syncMode: 'full' | 'browse';
	lastSyncAt?: string;
}

/** A remote library served by a Komga server */
export interface KomgaLibrary {
	id: string;
	type: 'komga';
	name: string;
	serverUrl: string;
	/** Komga library ID (string, unlike YACReader's numeric ID) */
	komgaLibraryId: string;
	syncMode: 'full' | 'browse';
	lastSyncAt?: string;
}

/** A remote library served by a Kavita server */
export interface KavitaLibrary {
	id: string;
	type: 'kavita';
	name: string;
	serverUrl: string;
	/** Kavita library ID (numeric, unlike Komga's string ID) */
	kavitaLibraryId: number;
	syncMode: 'full' | 'browse';
	lastSyncAt?: string;
}

/** A named library — local folder or a user-configured remote library server. */
export type Library = LocalLibrary | YACReaderLibrary | KomgaLibrary | KavitaLibrary;

/** Type guard for local library */
export function isLocalLibrary(lib: Library): lib is LocalLibrary {
	return lib.type === 'local';
}

/** Type guard for YACReader library */
export function isYACReaderLibrary(lib: Library): lib is YACReaderLibrary {
	return lib.type === 'yacreader';
}

/** Type guard for Komga library */
export function isKomgaLibrary(lib: Library): lib is KomgaLibrary {
	return lib.type === 'komga';
}

/** Type guard for Kavita library */
export function isKavitaLibrary(lib: Library): lib is KavitaLibrary {
	return lib.type === 'kavita';
}

/** Type guard for any remote server library (YACReader, Komga, or Kavita) */
export function isRemoteServerLibrary(lib: Library): lib is YACReaderLibrary | KomgaLibrary | KavitaLibrary {
	return lib.type === 'yacreader' || lib.type === 'komga' || lib.type === 'kavita';
}

export interface FumetoSettings {
	// API
	openrouterApiKey: string;
	selectedModel: string;
	translationMode: TranslationMode;

	// Multi-provider support
	/** Configured LLM providers (API keys stored separately in secure-storage) */
	providers: ProviderConfig[];
	/** ID of the currently active provider (null = legacy fallback) */
	activeProviderId: string | null;

	// Reading
	/**
	 * Applies to every volume that carries no per-volume override. Resolve with
	 * `effectiveReadingDirection()` rather than reading either value directly.
	 */
	defaultReadingDirection: 'rtl' | 'ltr';
	/**
	 * Paging past the last page opens the next comic in the same folder instead
	 * of only bouncing at the edge.
	 */
	continueToNextVolume: boolean;
	pageViewMode: PageViewMode;
	/**
	 * Reader layout: 'paged' (one page at a time with pan/zoom) or
	 * 'long-strip' (continuous top-down vertical scroll with no gaps between
	 * pages — webtoon style). In long-strip mode the current page is tracked
	 * from whichever page occupies the most of the viewport, and swipe/tap
	 * page turning does not apply.
	 */
	readerMode: 'paged' | 'long-strip';
	/**
	 * Book (reflowable EPUB) reading flow. Controlled from the in-reader Aa
	 * display menu, not the Settings page — deliberate deviation from the
	 * settings-page recipe (no draft field / anchor / search entry) since the
	 * controls live where reading happens. foliate switches flow live.
	 */
	bookFlow: 'paginated' | 'scrolled';
	/** Book content font size, percent of the publisher size (100 = as-is). */
	bookFontScalePercent: number;
	/** Book content line height. */
	bookLineHeight: number;
	/** Book content theme: app-dark bridge, or the light "paper" page. */
	bookTheme: 'app-dark' | 'light';
	/** Page turn mode on mobile: swipe, tap, or both */
	pageTurnMode: 'swipe' | 'tap' | 'both';
	zoomDefault: 'fitToScreen' | 'fitToWidth' | 'original';
	backgroundColor: string;
	/** When true, open volumes to last read page; when false, always open to first page */
	resumeLastPage: boolean;
	/**
	 * Only meaningful while resumeLastPage is on: a volume whose saved position is
	 * its final page counts as finished, so the next time it is opened it starts
	 * at page one instead of reopening the last page. Nothing moves mid-session —
	 * reaching the end while reading never jumps the reader back.
	 */
	restartFinishedVolumes: boolean;

	// Translation
	temperature: number;
	autoTranslate: boolean;
	mode3TokenBudget: number;
	mode3RecentPages: number;
	/** Maximum tokens for LLM responses in full-page and volume translations */
	maxContextTokens: number;
	/** When true, volume translations skip the review pass by default */
	skipReviewPass: boolean;
	/** Automatically translate the newly opened reader page when it has no overlay data. */
	readerAutoTranslateOverlays: boolean;

	// Language
	sourceLanguage: string;
	targetLanguage: string;

	// UI
	/**
	 * The language the app's own chrome speaks. `'system'` follows the device.
	 * Not `targetLanguage` (what manga is translated into) — the two are seeded
	 * together once on first run and never coupled again.
	 */
	uiLocale: UiLocaleSetting;
	colorScheme: string;
	sidebarWidth: number;
	sidebarPosition: 'left' | 'right';
	regionColor: string;
	/** Open a newly-created comic tab immediately instead of keeping Library active. */
	switchToNewTabsImmediately: boolean;
	/** Show a dismissible banner when one or more configured local-library paths cannot be reached. */
	showLibraryAccessWarnings: boolean;

	// Overlay
	overlayEnabled: boolean;
	/**
	 * Overlay layout mode. The selector UI was removed 2026-07-22 and the
	 * text-replacement/inpainting code was removed 2026-07-24: the app is
	 * built around 'bubble-segmentation' (auto-fit is its built-in fallback
	 * for text outside bubbles). The legacy literals stay in the type only
	 * for old persisted values; loadSettings migrates any stored value back
	 * to 'bubble-segmentation'.
	 */
	overlayMode: 'bubble-segmentation' | 'auto-fit' | 'text-replacement';
	/** Auto-generate overlay data during volume ("Get Full Translation") runs */
	overlayAutoGenerate: boolean;
	/** Render translated text sideways (vertical writing) for tall overlay boxes */
	overlayVerticalText: boolean;
	/** Minimum font size (px) for overlay text — text will never be smaller than this */
	overlayMinFontSize: number;
	/** Variable font sizing: adapts per-box font size based on image content and original text prominence */
	variableFontSizing: boolean;
	/**
	 * Text detection method. Only 'ppocr' (numbered-boxes pipeline) remains —
	 * the 'vlm-native' method was removed 2026-07-22 (see
	 * removed 2026-08; kept in the private history).
	 * The key is kept so stored settings and spec evidence stay stable.
	 */
	overlayDetectionMethod: 'ppocr';
	/** Overlay text-size multiplier (1.0 = layout-chosen size). Persisted twin of the reader's live font-scale slider. */
	overlayFontScaleDefault: number;
	/**
	 * Render free-floating SFX overlays (policy-21). Default OFF: like most
	 * official releases, drawn sound effects stay untranslated art; their
	 * translations are still listed in the panel. Balloon text is unaffected.
	 */
	overlaySfx: boolean;

	// Deprecated overlay fields (kept for deserialization compat; ignored by UI)
	/** @deprecated Use overlayMode instead */
	overlayOpacity?: number;
	/** @deprecated Use overlayMode instead */
	overlayFontScale?: number;
	/** @deprecated Use overlayMode instead */
	overlayBoxScale?: number;
	/** @deprecated Use overlayMode instead */
	overlayHeightScale?: number;
	/** @deprecated Use overlayMode instead */
	overlayOverflowMode?: 'visible' | 'auto-expand' | 'hidden';
	/** @deprecated Use overlayMode instead */
	overlayAutoFit?: boolean;
	/** @deprecated Use overlayMode instead */
	overlayBubbleSegmentation?: boolean;

	// On-device translation
	/** Translation pipeline: 'off-device' uses a cloud LLM; 'on-device' uses local OCR and an offline translation backend. */
	translationPipeline: 'off-device' | 'on-device';
	/** On-device OCR provider: PP-OCRv6 (native ORT on Android, WASM fallback elsewhere). */
	onDeviceOCRProvider: 'ppocr';
	/**
	 * On-device translation backend: local Hy-MT2 1.8B 1.25-bit via llama.cpp
	 * (~440 MiB download). The legacy 'translategemma' literal is kept as-is to
	 * avoid invalidating stored settings and in-flight volume jobs. ML Kit was
	 * the other option until 2026-07-24; see the migration in `load()`.
	 */
	onDeviceTranslationBackend: 'translategemma';
	/**
	 * Which Hy-MT2 GGUF the local llama.cpp backend loads. The legacy
	 * 'manga-v1' literal migrates to 'manga-v2' in `load()` — v2 supersedes it
	 * at an identical file size and speed.
	 *
	 * 'custom' means the user's own imported GGUF and is only honoured while
	 * `customModel` is populated; `activeHyMT2Variant()` degrades it to 'stock'
	 * otherwise, so deleting the file cannot leave the picker unchecked.
	 */
	hyMT2Variant: 'stock' | 'manga-v2' | 'manga-v3' | 'manga-v4' | 'custom';
	/**
	 * The user's imported on-device model, if any. Absent until an import
	 * succeeds; cleared when it is deleted.
	 *
	 * The file itself is always stored under the fixed filename in
	 * `HYMT2_VARIANTS.custom` — `displayName` is untrusted text from the
	 * document picker and is never used to build a path.
	 */
	customModel?: CustomModelRecord;
	/**
	 * Sampler temperature for on-device translation, 0..1. NOT the same knob as
	 * `temperature` above, which only reaches the cloud providers.
	 *
	 * 0 is greedy/deterministic. The default of 0.15 was measured over 25,596
	 * generations on 237 held-out ja->en excerpts plus 714 blinded judge
	 * verdicts; the previous 0.7 was above the optimum for both fine-tunes.
	 * See the fine-tune eval record (temperature sweep).
	 */
	onDeviceTemperature: number;
	/** On-device source language ('auto' = auto-detect) */
	onDeviceSourceLang: string;
	/** On-device target language */
	onDeviceTargetLang: string;

	// Background translation (Android)
	/** Enable Android foreground service for background batch translation */
	backgroundTranslation: boolean;

	// Local provider concurrency
	/** Max concurrent requests to local LLM providers (default 1). LM Studio supports 4+. */
	localProviderConcurrency: number;

	// Debug
	debugLogging: boolean;

	// Library (legacy single-path fields kept for migration)
	libraryPath: string | null;
	libraryAutoScan: boolean;
	libraryWatchEnabled: boolean;

	// Libraries (multi-library support)
	libraries: Library[];
}

/**
 * Detach settings from UI reactivity before they cross into persistence or a
 * long-running translation job. Svelte 5 deep state wraps arrays and records
 * in proxies; those proxies cannot be passed to structuredClone in Android's
 * WebView. Settings are deliberately JSON-shaped, so a shallow record copy
 * plus copies of the two record collections is a complete typed snapshot.
 */
export function snapshotFumetoSettings(value: Readonly<FumetoSettings>): FumetoSettings {
	return {
		...value,
		providers: Array.from(value.providers ?? [], (provider) => ({ ...provider })),
		libraries: Array.from(value.libraries ?? [], (library) => ({ ...library }))
	};
}

/**
 * On-device sampler temperature bounds, mirrored in `jni_bridge.cpp`
 * (DEFAULT/MIN/MAX_TEMPERATURE) and `llama.rs`. The native side clamps
 * independently — these exist so the slider and the stored value agree with it.
 */
export const ON_DEVICE_TEMPERATURE_DEFAULT = 0.15;
export const ON_DEVICE_TEMPERATURE_MIN = 0;
export const ON_DEVICE_TEMPERATURE_MAX = 1;

export const DEFAULT_SETTINGS: FumetoSettings = {
	openrouterApiKey: '',
	selectedModel: DEFAULT_OPENROUTER_MODEL,
	translationMode: 2,

	providers: [],
	activeProviderId: null,

	defaultReadingDirection: 'ltr',
	continueToNextVolume: false,
	pageViewMode: 'single',
	readerMode: 'paged',
	bookFlow: 'paginated',
	bookFontScalePercent: 100,
	bookLineHeight: 1.5,
	bookTheme: 'app-dark',
	pageTurnMode: 'swipe',
	zoomDefault: 'fitToScreen',
	backgroundColor: '#030712',
	resumeLastPage: true,
	restartFinishedVolumes: false,

	temperature: 1.0,
	autoTranslate: true,
	mode3TokenBudget: 4000,
	mode3RecentPages: 3,
	maxContextTokens: 10000,
	skipReviewPass: true,
	readerAutoTranslateOverlays: false,

	sourceLanguage: 'ja',
	targetLanguage: 'en',

	uiLocale: 'system',
	colorScheme: 'synthesis',
	sidebarWidth: 360,
	sidebarPosition: 'right',
	regionColor: '#3b82f6',
	switchToNewTabsImmediately: false,
	showLibraryAccessWarnings: true,

	overlayEnabled: true,
	overlayMode: 'bubble-segmentation',
	overlayAutoGenerate: true,
	overlayVerticalText: false,
	overlayMinFontSize: 18,
	variableFontSizing: false,
	overlayDetectionMethod: 'ppocr',
	overlayFontScaleDefault: 1.0,
	overlaySfx: false,

	translationPipeline: 'off-device',
	onDeviceOCRProvider: 'ppocr',
	onDeviceTranslationBackend: 'translategemma',
	hyMT2Variant: 'stock',
	customModel: undefined,
	onDeviceTemperature: ON_DEVICE_TEMPERATURE_DEFAULT,
	onDeviceSourceLang: 'auto',
	onDeviceTargetLang: 'en',

	backgroundTranslation: false,

	localProviderConcurrency: 1,

	debugLogging: false,

	libraryPath: null,
	libraryAutoScan: true,
	libraryWatchEnabled: false,

	libraries: []
};

// Renamed from the pre-release codename at 0.7.0 (fresh start accepted).
// Mirrored as a literal in src/app.html's inline boot scripts, which run
// before any module and cannot import this constant.
const STORAGE_KEY = 'fumetoreaderplus-settings';
const LEGACY_SOURCE_COOKIE_KEY = 'fumeto-source-cookies';
const LEGACY_MANGADEX_PREFERENCES_PREFIX = 'mangadex-prefs-';
const RETIRED_SOURCE_SETTING_KEYS = [
	'showAdultProviders',
	'adultProvidersAcknowledged',
	'catalogPageSize',
] as const;

const SUPPORTED_LIBRARY_TYPES = new Set<Library['type']>([
	'local',
	'yacreader',
	'komga',
	'kavita',
]);

interface LibrarySanitizationResult {
	libraries: Library[];
	changed: boolean;
}

/**
 * Remove obsolete or malformed library records before they enter the live
 * settings store. Libraries without a type are retained as local libraries for
 * compatibility with the original single-library settings format.
 */
function sanitizePersistedLibraryList(value: unknown): LibrarySanitizationResult {
	if (!Array.isArray(value)) {
		return { libraries: [], changed: value !== undefined };
	}

	const libraries: Library[] = [];
	let changed = false;
	for (const candidate of value) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			changed = true;
			continue;
		}

		const record = candidate as Record<string, unknown>;
		const type = record.type;
		if (type === undefined || type === null || type === '') {
			libraries.push({ ...record, type: 'local' } as unknown as LocalLibrary);
			changed = true;
			continue;
		}

		if (typeof type !== 'string' || !SUPPORTED_LIBRARY_TYPES.has(type as Library['type'])) {
			changed = true;
			continue;
		}

		libraries.push({ ...record } as unknown as Library);
	}

	return { libraries, changed };
}

/** Public pure helper used by migration tests and settings import paths. */
export function sanitizePersistedLibraries(value: unknown): Library[] {
	return sanitizePersistedLibraryList(value).libraries;
}

function removeRetiredSourceLocalStorage(): void {
	localStorage.removeItem(LEGACY_SOURCE_COOKIE_KEY);
	// Iterate backwards because removeItem() compacts Storage's numeric keys.
	for (let index = localStorage.length - 1; index >= 0; index -= 1) {
		const key = localStorage.key(index);
		if (key?.startsWith(LEGACY_MANGADEX_PREFERENCES_PREFIX)) {
			localStorage.removeItem(key);
		}
	}
}

function removeRetiredSourceSettings(record: Record<string, unknown>): boolean {
	let changed = false;
	for (const key of RETIRED_SOURCE_SETTING_KEYS) {
		if (Object.prototype.hasOwnProperty.call(record, key)) {
			delete record[key];
			changed = true;
		}
	}
	return changed;
}

/**
 * Whether this session's settings came from localStorage. The file restore
 * needs to distinguish "storage was evicted" from "the user simply has no
 * libraries yet"; only the presence of a stored record answers that.
 */
let localSettingsWereFound = false;

/** Test seam and restore gate: did localStorage hold a settings record? */
export function hadStoredLocalSettings(): boolean {
	return localSettingsWereFound;
}

export interface SettingsMigrationResult {
	settings: FumetoSettings;
	/** True when the record on disk is out of date and should be rewritten. */
	changed: boolean;
}

/**
 * Bring a persisted settings record up to date: retired-key removal, library
 * sanitization, and every field migration.
 *
 * Pure and synchronous so BOTH persistence paths run exactly the same rules.
 * The settings.json restore used to apply only retired-key removal, so a file
 * snapshot written before a migration could put a retired value back into the
 * live store for a whole session — and that file is precisely what gets read
 * after the WebView storage loss the file layer exists to survive.
 */
export function migratePersistedSettings(rawValue: unknown): SettingsMigrationResult {
	const isRecord = rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue);
	// Copy: removeRetiredSourceSettings mutates, and a caller's object must not
	// change under it.
	const raw: Record<string, unknown> = isRecord ? { ...(rawValue as Record<string, unknown>) } : {};
	let needsSave = !isRecord || removeRetiredSourceSettings(raw);
	const parsed = { ...DEFAULT_SETTINGS, ...raw };
	const sanitizedLibraries = sanitizePersistedLibraryList(parsed.libraries);
	parsed.libraries = sanitizedLibraries.libraries;
	needsSave ||= sanitizedLibraries.changed;

	// Migration: convert single libraryPath to libraries array
	if (parsed.libraryPath && (!parsed.libraries || parsed.libraries.length === 0)) {
		const folderName = parsed.libraryPath.split(/[\\/]/).pop() || 'Library';
		parsed.libraries = [{
			id: randomUUID(),
			type: 'local',
			name: folderName,
			path: parsed.libraryPath,
			autoScan: parsed.libraryAutoScan ?? true,
			watchEnabled: parsed.libraryWatchEnabled ?? false
		}];
		parsed.libraryPath = null;
		needsSave = true;
	}

	// Migration: convert legacy overlay settings to overlayMode
	if (parsed.overlayBubbleSegmentation !== undefined && !raw.overlayMode) {
		parsed.overlayMode = parsed.overlayBubbleSegmentation ? 'bubble-segmentation' : 'auto-fit';
		needsSave = true;
	}

	// Migration: the retired 'vlm-native' detection method maps to 'ppocr'
	// (removed 2026-08).
	if ((parsed.overlayDetectionMethod as string) !== 'ppocr') {
		parsed.overlayDetectionMethod = 'ppocr';
		needsSave = needsSave || raw.overlayDetectionMethod !== undefined;
	}

	// Migration: Google ML Kit was dropped on 2026-07-24 (attribution
	// obligations and SDK telemetry we did not want in a closed-source
	// build). Both on-device slots collapse to their surviving engine.
	if ((parsed.onDeviceOCRProvider as string) !== 'ppocr') {
		parsed.onDeviceOCRProvider = 'ppocr';
		needsSave = needsSave || raw.onDeviceOCRProvider !== undefined;
	}
	if ((parsed.onDeviceTranslationBackend as string) !== 'translategemma') {
		parsed.onDeviceTranslationBackend = 'translategemma';
		needsSave = needsSave || raw.onDeviceTranslationBackend !== undefined;
	}

	// A stored temperature outside the slider's range would be silently clamped
	// by the native side, leaving the UI showing a value the model never used.
	{
		const stored = parsed.onDeviceTemperature;
		const usable =
			typeof stored === 'number' && Number.isFinite(stored)
				? Math.min(ON_DEVICE_TEMPERATURE_MAX, Math.max(ON_DEVICE_TEMPERATURE_MIN, stored))
				: ON_DEVICE_TEMPERATURE_DEFAULT;
		if (usable !== stored) {
			parsed.onDeviceTemperature = usable;
			needsSave = needsSave || raw.onDeviceTemperature !== undefined;
		}
	}

		// Migration: the manga fine-tune moved from v1 to v2 on
		// 2026-07-31. Same filename shape, same 1.13 GB, same speed, but
		// a measurably better model — so a stored 'manga-v1' choice is
		// carried forward rather than dropped back to stock.
		if ((parsed.hyMT2Variant as string) === 'manga-v1') {
			parsed.hyMT2Variant = 'manga-v2';
			needsSave = true;
		}

		// Migration: the overlay-mode selector was removed 2026-07-22 and
	// the text-replacement code was removed 2026-07-24 — bubble
	// segmentation is the app's pipeline (auto-fit lives inside it as
	// the free-text fallback).
	if (parsed.overlayMode !== 'bubble-segmentation') {
		parsed.overlayMode = 'bubble-segmentation';
		needsSave = needsSave || raw.overlayMode !== undefined;
	}

	// Migration: the min-font-size slider and variable-font-sizing
	// toggle were removed from the UI 2026-07-22 — both stay as engine
	// inputs pinned at their defaults so no stored customization can
	// linger without a control to change it.
	if (parsed.overlayMinFontSize !== DEFAULT_SETTINGS.overlayMinFontSize) {
		parsed.overlayMinFontSize = DEFAULT_SETTINGS.overlayMinFontSize;
		needsSave = needsSave || raw.overlayMinFontSize !== undefined;
	}
	if (parsed.variableFontSizing !== DEFAULT_SETTINGS.variableFontSizing) {
		parsed.variableFontSizing = DEFAULT_SETTINGS.variableFontSizing;
		needsSave = needsSave || raw.variableFontSizing !== undefined;
	}

	// A locale this build cannot show (a removed one, or a hand-edited file)
	// falls back to following the device rather than pinning an unknown tag.
	if ('uiLocale' in raw && !isUiLocaleSetting(parsed.uiLocale)) {
		parsed.uiLocale = 'system';
		needsSave = true;
	}
	return { settings: parsed, changed: needsSave };
}

function loadSettings(): FumetoSettings {
	if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };

	try {
		// State from the retired built-in website-source system must not linger.
		removeRetiredSourceLocalStorage();
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const result = migratePersistedSettings(JSON.parse(stored) as unknown);
			// Recorded before any early return so the file-restore path can tell
			// "localStorage was empty" from "localStorage said this".
			localSettingsWereFound = true;
			if (result.changed) saveSettings(result.settings);
			// Note: provider migration from legacy openrouterApiKey is handled
			// in initSecureSettings() after decryption, not here — because the
			// API key is not available in plaintext at this point.
			return result.settings;
		}
	} catch {
		// Ignore parse errors
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: FumetoSettings): void {
	// Never persist the API key in plaintext — it's stored encrypted separately
	let json: string;
	try {
		json = JSON.stringify({ ...s, openrouterApiKey: '' });
	} catch {
		return;
	}
	if (typeof localStorage !== 'undefined') {
		try {
			localStorage.setItem(STORAGE_KEY, json);
		} catch (err) {
			// A quota failure must not take the file write down with it: the file
			// is exactly the layer that survives what quota pressure leads to.
			console.warn('[settings] localStorage write failed:', err);
		}
	}
	// Also write to filesystem for Android reliability
	writeSettingsToFile(json);
}

/** Create a persistent settings store backed by localStorage */
function createSettingsStore() {
	const { subscribe, set: setStore, update: updateStore } = writable<FumetoSettings>(
		snapshotFumetoSettings(loadSettings())
	);

	return {
		subscribe,
		set(value: FumetoSettings) {
			const snapshot = snapshotFumetoSettings(value);
			saveSettings(snapshot);
			setStore(snapshot);
		},
		update(updater: (value: FumetoSettings) => FumetoSettings) {
			updateStore((current) => {
				const next = snapshotFumetoSettings(updater(current));
				saveSettings(next);
				return next;
			});
		},
		/** Update a single setting */
		patch(partial: Partial<FumetoSettings>) {
			updateStore((current) => {
				const next = snapshotFumetoSettings({ ...current, ...partial });
				saveSettings(next);
				return next;
			});
		},
		/** Reset to defaults */
		reset() {
			const defaults = snapshotFumetoSettings(DEFAULT_SETTINGS);
			saveSettings(defaults);
			setStore(defaults);
		}
	};
}

export const settings = createSettingsStore();

/**
 * Initialize secure settings — loads the API key from encrypted storage.
 * Also handles migration from plaintext localStorage on first run after upgrade.
 * Must be called once during app startup (e.g., in onMount of +page.svelte).
 */
/** First-run only (see `initSecureSettings`): pick the translation targets the UI locale implies. */
export function seedTranslationTargetsFromUiLocale(locale: string = getUiLocale()): boolean {
	const target = defaultTargetForUiLocale(locale);
	if (!target) return false;
	const patch: Partial<FumetoSettings> = {};
	if (SUPPORTED_LANGUAGES.some((language) => language.code === target)) patch.targetLanguage = target;
	if (ON_DEVICE_TARGET_LANGUAGES.some((language) => language.code === target)) patch.onDeviceTargetLang = target;
	if (Object.keys(patch).length === 0) return false;
	settings.patch(patch);
	return true;
}

export async function initSecureSettings(): Promise<void> {
	// Initialize file-based persistence and restore settings if localStorage was lost
	await initFsPersistence();
	const fileSettings = await readSettingsFromFile();
	if (fileSettings) {
		try {
			const restored = migratePersistedSettings(JSON.parse(fileSettings) as unknown);
			if (!hadStoredLocalSettings()) {
				// localStorage held nothing: it was evicted (the case this file
				// exists for), so the file is the only surviving copy. Restoring it
				// through the same migration the localStorage path runs is what
				// stops a pre-migration snapshot going live for the session.
				//
				// The old gate asked whether the file had libraries and the store
				// had none, which answered a different question twice over: a user
				// with customized settings but no libraries got no restore at all,
				// and deleting the last library then dying inside the 500 ms write
				// debounce rolled the WHOLE object back to the stale file and
				// resurrected that library.
				settings.set(restored.settings);
			} else {
				// localStorage is authoritative whenever it exists — it is written
				// synchronously while the file trails behind a debounce. Rewrite the
				// file from the live snapshot so a retired or stale record cannot
				// come back on a later storage loss.
				const current = get(settings);
				if (restored.changed || JSON.stringify(restored.settings) !== JSON.stringify(current)) {
					saveSettings(current);
				}
			}
		} catch {
			// Ignore parse errors from file
		}
	}
	// A fresh install — nothing in localStorage and no file to restore — starts
	// translating into the language the device speaks, when the app can. This
	// runs exactly once; a later change of `uiLocale` never touches the targets.
	if (!hadStoredLocalSettings() && fileSettings === null) seedTranslationTargetsFromUiLocale();

	const { initSecureStorage, loadAndDecrypt, encryptAndStore, reconcileSecureStorageMirror } =
		await import('./secure-storage.js');

	// Initialize file-based device key storage before any encrypt/decrypt calls
	await initSecureStorage();

	// Load the app-private mirror and put back anything localStorage lost, before
	// a single decrypt runs. Reading a secret as absent here is not harmless: the
	// settings layer would write that emptiness straight back.
	const { initDurableStore } = await import('./durable-store.js');
	await initDurableStore();
	reconcileSecureStorageMirror();

	// Check for migration: API key still in plaintext localStorage settings
	if (typeof localStorage !== 'undefined') {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (parsed.openrouterApiKey) {
					// Migrate: encrypt the key and clear it from settings JSON
					await encryptAndStore(parsed.openrouterApiKey);
					settings.patch({ openrouterApiKey: parsed.openrouterApiKey });
					return; // patch triggers saveSettings which clears plaintext
				}
			}
		} catch {
			// Ignore parse errors during migration check
		}
	}

	// Normal load: decrypt from secure storage into the store
	const apiKey = await loadAndDecrypt();
	if (apiKey) {
		settings.patch({ openrouterApiKey: apiKey });
	}

	// Migration: auto-create an OpenRouter provider from legacy key
	const current = get(settings);
	if (
		current.openrouterApiKey &&
		(!current.providers || current.providers.length === 0)
	) {
		const legacyProvider: ProviderConfig = {
			id: '__legacy_openrouter__',
			type: 'openrouter',
			name: 'OpenRouter',
			requiresApiKey: true,
			defaultModel: current.selectedModel || DEFAULT_OPENROUTER_MODEL
		};
		settings.patch({
			providers: [legacyProvider],
			activeProviderId: legacyProvider.id
		});
		// The encrypted key stays in the legacy storage key.
		// loadProviderApiKey('__legacy_openrouter__') falls back to loadAndDecrypt().
	}
}

/**
 * Encrypt and persist the API key to secure storage.
 * Call this when the user saves a new API key in Settings.
 */
export async function saveApiKeySecurely(key: string): Promise<void> {
	const { encryptAndStore } = await import('./secure-storage.js');
	await encryptAndStore(key);
}

/**
 * Encrypt and persist an API key for a specific provider.
 * Call this when the user saves provider settings.
 */
export async function saveProviderApiKey(providerId: string, key: string): Promise<void> {
	const { encryptAndStoreForProvider } = await import('./secure-storage.js');
	await encryptAndStoreForProvider(providerId, key);
}

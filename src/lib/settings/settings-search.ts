/**
 * Static index + matcher behind the settings search box (review §3.4).
 * Every entry names a tab and a `data-settings-anchor` present in that tab's
 * markup; selecting a result switches tabs and flash-scrolls to the anchor.
 *
 * Labels and keywords are messages, so the box works in every UI language;
 * the English keyword list is kept as a fallback so product terms ("komga",
 * "api key") and a reader who thinks in English still hit. Matching folds
 * diacritics: "ubersetzung" finds "Übersetzung".
 */
import * as m from '$lib/paraglide/messages.js';
import { createCollator } from '$lib/i18n/format.js';

export type SettingsSearchTab = 'translation' | 'overlay' | 'display' | 'libraries' | 'help';

export interface SettingsSearchEntry {
	tab: SettingsSearchTab;
	anchor: string;
	/** The control's name in the live locale. */
	label: () => string;
	/** Localized search vocabulary, `|`-separated in the catalogue. */
	keywords: () => string;
	/** English vocabulary, always searched too. */
	keywordsEn: string[];
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
	{ tab: 'translation', anchor: 'providers', label: () => m.settings_search_providers_label(), keywords: () => m.settings_search_providers_keywords(), keywordsEn: ['api key', 'openrouter', 'claude', 'ollama', 'lm studio', 'model', 'connect', 'vision'] },
	{ tab: 'translation', anchor: 'pipeline', label: () => m.settings_search_pipeline_label(), keywords: () => m.settings_search_pipeline_keywords(), keywordsEn: ['cloud', 'offline', 'local', 'on device', 'off device'] },
	{ tab: 'translation', anchor: 'language-pair', label: () => m.settings_search_language_pair_label(), keywords: () => m.settings_search_language_pair_keywords(), keywordsEn: ['japanese', 'english', 'source language', 'target language'] },
	{ tab: 'translation', anchor: 'translation-mode', label: () => m.settings_search_translation_mode_label(), keywords: () => m.settings_search_translation_mode_keywords(), keywordsEn: ['context', 'isolated', 'page context', 'full context', 'mode 1', 'mode 2', 'mode 3'] },
	{ tab: 'translation', anchor: 'skip-review', label: () => m.settings_search_skip_review_label(), keywords: () => m.settings_search_skip_review_keywords(), keywordsEn: ['pass 2', 'review pass', 'cost'] },
	{ tab: 'translation', anchor: 'advanced-llm', label: () => m.settings_search_advanced_llm_label(), keywords: () => m.settings_search_advanced_llm_keywords(), keywordsEn: ['temperature', 'max tokens', 'context size', 'advanced'] },
	{ tab: 'translation', anchor: 'on-device-backend', label: () => m.settings_search_on_device_backend_label(), keywords: () => m.settings_search_on_device_backend_keywords(), keywordsEn: ['ml kit', 'hy-mt2', 'llama', 'gguf'] },
	{ tab: 'translation', anchor: 'hymt2-model', label: () => m.settings_search_hymt2_model_label(), keywords: () => m.settings_search_hymt2_model_keywords(), keywordsEn: ['hy-mt2', 'gguf', 'variant', 'standard', 'upgraded', 'v2', 'v3', 'multilingual', 'custom model', 'own model', 'import model'] },
	{ tab: 'translation', anchor: 'on-device-temperature', label: () => m.settings_search_on_device_temperature_label(), keywords: () => m.settings_search_on_device_temperature_keywords(), keywordsEn: ['temperature', 'creativity', 'randomness', 'deterministic', 'greedy', 'sampler', 'on device'] },
	{ tab: 'translation', anchor: 'ocr-provider', label: () => m.settings_search_ocr_provider_label(), keywords: () => m.settings_search_ocr_provider_keywords(), keywordsEn: ['ml kit', 'pp-ocr', 'ppocr', 'text recognition'] },
	{ tab: 'translation', anchor: 'background-translation', label: () => m.settings_search_background_translation_label(), keywords: () => m.settings_search_background_translation_keywords(), keywordsEn: ['notification', 'screen off', 'minimized', 'foreground service'] },
	{ tab: 'overlay', anchor: 'overlay-enabled', label: () => m.settings_search_overlay_enabled_label(), keywords: () => m.settings_search_overlay_enabled_keywords(), keywordsEn: ['translated text', 'toggle overlay'] },
	{ tab: 'overlay', anchor: 'sfx-overlays', label: () => m.settings_search_sfx_overlays_label(), keywords: () => m.settings_search_sfx_overlays_keywords(), keywordsEn: ['sfx', 'sound effects', 'onomatopoeia', 'official style', 'untranslated'] },
	{ tab: 'overlay', anchor: 'overlay-text-size', label: () => m.settings_search_overlay_text_size_label(), keywords: () => m.settings_search_overlay_text_size_keywords(), keywordsEn: ['font scale', 'font size', 'bigger text', 'smaller text'] },
	{ tab: 'overlay', anchor: 'auto-generate', label: () => m.settings_search_auto_generate_label(), keywords: () => m.settings_search_auto_generate_keywords(), keywordsEn: ['get full translation'] },
	{ tab: 'overlay', anchor: 'vertical-text', label: () => m.settings_search_vertical_text_label(), keywords: () => m.settings_search_vertical_text_keywords(), keywordsEn: ['vertical text', 'rotated', 'cjk'] },
	{ tab: 'display', anchor: 'color-scheme', label: () => m.settings_search_color_scheme_label(), keywords: () => m.settings_search_color_scheme_keywords(), keywordsEn: ['theme', 'dark', 'light', 'appearance'] },
	{ tab: 'display', anchor: 'ui-language', label: () => m.settings_search_ui_language_label(), keywords: () => m.settings_search_ui_language_keywords(), keywordsEn: ['language', 'locale', 'english', 'deutsch', 'español', 'français', 'italiano', 'português', 'русский', 'indonesia'] },
	{ tab: 'display', anchor: 'reading-direction', label: () => m.settings_search_reading_direction_label(), keywords: () => m.settings_search_reading_direction_keywords(), keywordsEn: ['rtl', 'ltr', 'manga direction', 'right to left'] },
	{ tab: 'display', anchor: 'page-turning', label: () => m.settings_search_page_turning_label(), keywords: () => m.settings_search_page_turning_keywords(), keywordsEn: ['swipe', 'tap', 'page turn'] },
	{ tab: 'display', anchor: 'switch-new-tabs', label: () => m.settings_search_switch_new_tabs_label(), keywords: () => m.settings_search_switch_new_tabs_keywords(), keywordsEn: ['open in new tab'] },
	{ tab: 'display', anchor: 'library-warnings', label: () => m.settings_search_library_warnings_label(), keywords: () => m.settings_search_library_warnings_keywords(), keywordsEn: ['missing folder', 'warning banner'] },
	{ tab: 'display', anchor: 'resume-last-page', label: () => m.settings_search_resume_last_page_label(), keywords: () => m.settings_search_resume_last_page_keywords(), keywordsEn: ['continue reading', 'progress'] },
	{ tab: 'display', anchor: 'restart-finished-volumes', label: () => m.settings_search_restart_finished_volumes_label(), keywords: () => m.settings_search_restart_finished_volumes_keywords(), keywordsEn: ['restart', 'finished', 'reread', 'progress'] },
	{ tab: 'libraries', anchor: 'libraries-list', label: () => m.settings_search_libraries_list_label(), keywords: () => m.settings_search_libraries_list_keywords(), keywordsEn: ['komga', 'kavita', 'yacreader', 'remote server', 'local folder', 'server address', 'port', 'https'] },
	{ tab: 'libraries', anchor: 'storage', label: () => m.settings_search_storage_label(), keywords: () => m.settings_search_storage_keywords(), keywordsEn: ['space', 'quota', 'protection', 'durability'] },
	{ tab: 'libraries', anchor: 'scan-progress', label: () => m.settings_libraries_scan_progress_label(), keywords: () => m.settings_search_scan_progress_keywords(), keywordsEn: ['scan progress', 'notification', 'popup', 'toast', 'sync status'] },
	{ tab: 'libraries', anchor: 'on-device-models', label: () => m.settings_search_on_device_models_label(), keywords: () => m.settings_search_on_device_models_keywords(), keywordsEn: ['downloads', 'delete model', 'hy-mt2', 'disk space'] },
	{ tab: 'libraries', anchor: 'settings-backup', label: () => m.settings_search_settings_backup_label(), keywords: () => m.settings_search_settings_backup_keywords(), keywordsEn: ['export', 'import', 'reset to defaults', 'transfer', 'json'] },
	{ tab: 'help', anchor: 'help-root', label: () => m.settings_search_help_root_label(), keywords: () => m.settings_search_help_root_keywords(), keywordsEn: ['guide', 'documentation', 'version', 'privacy', 'licenses', 'troubleshooting'] }
];

export interface SettingsSearchMatch extends SettingsSearchEntry {
	score: number;
	/** The rendered label, for sorting and display. */
	labelText: string;
}

/** Lower-case and strip combining marks so accented and plain spellings meet. */
export function foldForSearch(text: string): string {
	return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Rank: label prefix (3) > label substring (2) > keyword substring (1). */
export function searchSettings(
	query: string,
	index: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX
): SettingsSearchMatch[] {
	const q = foldForSearch(query.trim());
	if (q.length < 2) return [];
	const matches: SettingsSearchMatch[] = [];
	for (const entry of index) {
		const labelText = entry.label();
		const label = foldForSearch(labelText);
		let score = 0;
		if (label.startsWith(q)) score = 3;
		else if (label.includes(q)) score = 2;
		else {
			const keywords = [...entry.keywords().split('|'), ...entry.keywordsEn];
			if (keywords.some((keyword) => foldForSearch(keyword).includes(q))) score = 1;
		}
		if (score > 0) matches.push({ ...entry, score, labelText });
	}
	const collator = createCollator({ sensitivity: 'base' });
	return matches.sort((a, b) => b.score - a.score || collator.compare(a.labelText, b.labelText));
}

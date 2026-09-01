/**
 * Messages that outlive the moment they were produced.
 *
 * A toast, a persisted job status, an import result: each used to be an
 * English string built where the event happened, which meant it could never
 * follow a language switch and — worse — code began branching on the prose
 * (`job.error.startsWith('Retry')`). A `UserMessage` is a message KEY plus
 * its parameters; only a component turns it into text, through
 * `renderUserMessage`, which reads the live locale and so re-renders on a
 * switch like any other message.
 *
 * Records written before this existed hold plain strings. They render as they
 * are: no Dexie migration rewrites history for a label.
 */
import * as m from '$lib/paraglide/messages.js';
import type { Locale } from '$lib/paraglide/runtime.js';
import type { UiLocale } from './locales.js';

export type UserMessageParams = Record<string, string | number>;

type Renderer = (params: UserMessageParams, options: { locale?: Locale }) => string;

/**
 * Every code the app can persist, mapped to its message. A code is the
 * message key; the table exists because Paraglide has no `m[key]` — dynamic
 * lookup is explicit so tree-shaking and the i18n gate both see it.
 */
const RENDERERS = {
	op_cancelled: (_p, o) => m.op_cancelled({}, o),
	error_generic: (_p, o) => m.error_generic({}, o),
	error_generic_detail: (p, o) => m.error_generic_detail({ detail: String(p.detail ?? '') }, o),
	reader_no_page_translation: (_p, o) => m.reader_no_page_translation({}, o),
	reader_status_no_regions: (_p, o) => m.reader_status_no_regions({}, o),
	reader_status_no_ocr: (_p, o) => m.reader_status_no_ocr({}, o),
	reader_status_no_text: (_p, o) => m.reader_status_no_text({}, o),
	reader_status_acquiring: (_p, o) => m.reader_status_acquiring({}, o),
	reader_status_detecting: (p, o) => m.reader_status_detecting({ engine: String(p.engine ?? '') }, o),
	reader_status_translating_progress: (p, o) => m.reader_status_translating_progress({ completed: String(p.completed ?? 0), total: String(p.total ?? 0) }, o),
	reader_status_translating: (_p, o) => m.reader_status_translating({}, o),
	reader_status_repairing: (_p, o) => m.reader_status_repairing({}, o),
	reader_status_persisting: (_p, o) => m.reader_status_persisting({}, o),
	reader_status_post_processing: (_p, o) => m.reader_status_post_processing({}, o),
	reader_status_cancelling: (_p, o) => m.reader_status_cancelling({}, o),
	reader_status_completed: (_p, o) => m.reader_status_completed({}, o),
	reader_status_failed: (_p, o) => m.reader_status_failed({}, o),
	reader_status_idle: (_p, o) => m.reader_status_idle({}, o),
	common_undo: (_p, o) => m.common_undo({}, o),
	common_dismiss: (_p, o) => m.common_dismiss({}, o),
	common_retry: (_p, o) => m.common_retry({}, o),
	settings_secure_storage_unreadable: (_p, o) => m.settings_secure_storage_unreadable({}, o),
	translation_background_refused: (_p, o) => m.translation_background_refused({}, o),
	reader_overlay_invalidated_legacy: (_p, o) => m.reader_overlay_invalidated_legacy({}, o),
	reader_overlay_requires_newer_app: (p, o) => m.reader_overlay_requires_newer_app({ version: String(p.version ?? '') }, o),
	reader_overlay_invalid: (p, o) => m.reader_overlay_invalid({ reason: String(p.reason ?? '') }, o),
	reader_edit_box_edited: (_p, o) => m.reader_edit_box_edited({}, o),
	reader_edit_box_deleted: (_p, o) => m.reader_edit_box_deleted({}, o),
	reader_edit_box_restored: (_p, o) => m.reader_edit_box_restored({}, o),
	reader_edit_box_hidden: (_p, o) => m.reader_edit_box_hidden({}, o),
	reader_edit_box_shown: (_p, o) => m.reader_edit_box_shown({}, o),
	reader_edit_box_reset: (_p, o) => m.reader_edit_box_reset({}, o),
	reader_edit_box_resized: (_p, o) => m.reader_edit_box_resized({}, o),
	reader_edit_box_moved: (_p, o) => m.reader_edit_box_moved({}, o),
	reader_edit_saved: (_p, o) => m.reader_edit_saved({}, o),
	reader_undo_done: (_p, o) => m.reader_undo_done({}, o),
	reader_undo_stale: (_p, o) => m.reader_undo_stale({}, o),
	error_timeout: (_p, o) => m.error_timeout({}, o),
	error_unreachable: (_p, o) => m.error_unreachable({}, o),
	error_auth: (_p, o) => m.error_auth({}, o),
	error_not_found: (_p, o) => m.error_not_found({}, o),
	error_server: (_p, o) => m.error_server({}, o),
	error_rejected: (p, o) => m.error_rejected({ status: String(p.status ?? '') }, o),
	conn_unreachable: (p, o) => m.conn_unreachable({ host: String(p.host ?? '') }, o),
	conn_unreachable_hint: (_p, o) => m.conn_unreachable_hint({}, o),
	conn_timeout: (p, o) => m.conn_timeout({ host: String(p.host ?? '') }, o),
	conn_timeout_hint: (_p, o) => m.conn_timeout_hint({}, o),
	conn_dns: (p, o) => m.conn_dns({ host: String(p.host ?? '') }, o),
	conn_dns_hint: (_p, o) => m.conn_dns_hint({}, o),
	conn_tls: (p, o) => m.conn_tls({ host: String(p.host ?? '') }, o),
	conn_tls_hint: (_p, o) => m.conn_tls_hint({}, o),
	conn_credentials: (p, o) => m.conn_credentials({ server: String(p.server ?? '') }, o),
	conn_credentials_hint_yacreader: (_p, o) => m.conn_credentials_hint_yacreader({}, o),
	conn_credentials_hint_komga: (_p, o) => m.conn_credentials_hint_komga({}, o),
	conn_credentials_hint_kavita: (_p, o) => m.conn_credentials_hint_kavita({}, o),
	conn_not_found: (p, o) => m.conn_not_found({ host: String(p.host ?? ''), server: String(p.server ?? '') }, o),
	conn_not_found_hint: (_p, o) => m.conn_not_found_hint({}, o),
	conn_wrong_server: (p, o) => m.conn_wrong_server({ host: String(p.host ?? ''), server: String(p.server ?? '') }, o),
	conn_wrong_server_hint: (_p, o) => m.conn_wrong_server_hint({}, o),
	conn_generic: (p, o) => m.conn_generic({ server: String(p.server ?? '') }, o),
	conn_form_no_address: (_p, o) => m.conn_form_no_address({}, o),
	conn_form_bad_port: (_p, o) => m.conn_form_bad_port({}, o),
	conn_form_kavita_key: (_p, o) => m.conn_form_kavita_key({}, o),
	conn_form_kavita_key_hint: (_p, o) => m.conn_form_kavita_key_hint({}, o),
	conn_form_komga_credentials: (_p, o) => m.conn_form_komga_credentials({}, o),
	conn_form_no_libraries: (_p, o) => m.conn_form_no_libraries({}, o),
	conn_form_save_failed: (_p, o) => m.conn_form_save_failed({}, o),
	conn_form_save_failed_hint: (_p, o) => m.conn_form_save_failed_hint({}, o),
	error_rate_limited: (p, o) => m.error_rate_limited({ minutes: Number(p.minutes ?? 0) }, o),
	error_rate_limited_short: (_p, o) => m.error_rate_limited_short({}, o),
	sync_items_not_indexed: (p, o) => m.sync_items_not_indexed({ n: Number(p.n ?? 0) }, o),
	job_retry: (p, o) => m.job_retry({ attempt: String(p.attempt ?? ''), max: String(p.max ?? ''), seconds: String(p.seconds ?? ''), detail: String(p.detail ?? '') }, o),
	job_activity_waiting_session: (_p, o) => m.job_activity_waiting_session({}, o),
	job_activity_loading_lm_studio: (_p, o) => m.job_activity_loading_lm_studio({}, o),
	job_activity_starting: (_p, o) => m.job_activity_starting({}, o),
	job_activity_review_starting: (_p, o) => m.job_activity_review_starting({}, o),
	job_activity_loading_detector: (_p, o) => m.job_activity_loading_detector({}, o),
	job_activity_loading_page: (p, o) => m.job_activity_loading_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_on_device_page: (p, o) => m.job_activity_on_device_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_on_device_detecting: (p, o) => m.job_activity_on_device_detecting({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_on_device_box: (p, o) => m.job_activity_on_device_box({ page: String(p.page ?? ''), total: String(p.total ?? ''), box: String(p.box ?? ''), boxes: String(p.boxes ?? '') }, o),
	job_activity_on_device_finishing: (p, o) => m.job_activity_on_device_finishing({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_translating_page: (p, o) => m.job_activity_translating_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_translating_page_overlay: (p, o) => m.job_activity_translating_page_overlay({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_repairing_page: (p, o) => m.job_activity_repairing_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_detecting_page: (p, o) => m.job_activity_detecting_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_consolidating: (p, o) => m.job_activity_consolidating({ page: String(p.page ?? '') }, o),
	job_activity_retrying_page: (p, o) => m.job_activity_retrying_page({ page: String(p.page ?? ''), total: String(p.total ?? ''), seconds: String(p.seconds ?? ''), category: String(p.category ?? '') }, o),
	job_activity_reviewing_pages: (p, o) => m.job_activity_reviewing_pages({ from: String(p.from ?? ''), to: String(p.to ?? ''), total: String(p.total ?? '') }, o),
	job_activity_revision_loading_page: (p, o) => m.job_activity_revision_loading_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_revision_revising_page: (p, o) => m.job_activity_revision_revising_page({ page: String(p.page ?? ''), total: String(p.total ?? '') }, o),
	job_activity_interrupted_revise: (_p, o) => m.job_activity_interrupted_revise({}, o),
	job_activity_paused: (_p, o) => m.job_activity_paused({}, o),
	job_paused_resume_hint: (_p, o) => m.job_paused_resume_hint({}, o),
	job_warning_translation_skipped: (p, o) => m.job_warning_translation_skipped({ skipped: Number(p.skipped ?? 0), total: String(p.total ?? '') }, o),
	job_warning_review_failed: (p, o) => m.job_warning_review_failed({ failed: Number(p.failed ?? 0), total: String(p.total ?? '') }, o),
	job_warning_revision_skipped: (p, o) => m.job_warning_revision_skipped({ skipped: Number(p.skipped ?? 0), total: String(p.total ?? '') }, o),
	job_revision_aborted_consecutive: (p, o) => m.job_revision_aborted_consecutive({ count: String(p.count ?? ''), detail: String(p.detail ?? '') }, o),
	job_cancelled_pipeline_on_device: (_p, o) => m.job_cancelled_pipeline_on_device({}, o),
	job_cancelled_pipeline_off_device: (_p, o) => m.job_cancelled_pipeline_off_device({}, o),
	job_cancelled_provider_removed: (_p, o) => m.job_cancelled_provider_removed({}, o),
	job_cancelled_provider_changed: (_p, o) => m.job_cancelled_provider_changed({}, o),
	job_badge_paused: (_p, o) => m.job_badge_paused({}, o),
	job_badge_translated: (_p, o) => m.job_badge_translated({}, o),
	job_badge_failed: (_p, o) => m.job_badge_failed({}, o),
	job_badge_interrupted: (_p, o) => m.job_badge_interrupted({}, o),
	job_badge_cancelled: (_p, o) => m.job_badge_cancelled({}, o),
	job_badge_to_retry: (p, o) => m.job_badge_to_retry({ n: String(p.n ?? '') }, o),
	job_badge_to_retry_title: (p, o) => m.job_badge_to_retry_title({ n: Number(p.n ?? 0) }, o),
	job_progress_pages: (p, o) => m.job_progress_pages({ current: String(p.current ?? ''), total: Number(p.total ?? 0), percent: String(p.percent ?? '') }, o),
	job_failed_title: (_p, o) => m.job_failed_title({}, o),
	import_progress_extracting: (_p, o) => m.import_progress_extracting({}, o),
	import_progress_extracting_count: (p, o) => m.import_progress_extracting_count({ done: String(p.done ?? ''), total: String(p.total ?? '') }, o),
	import_progress_saving: (_p, o) => m.import_progress_saving({}, o),
	import_progress_saved_images: (_p, o) => m.import_progress_saved_images({}, o),
	import_progress_saved_pages: (_p, o) => m.import_progress_saved_pages({}, o),
	import_progress_done: (_p, o) => m.import_progress_done({}, o),
	import_progress_reading_book: (_p, o) => m.import_progress_reading_book({}, o),
	import_progress_saving_book: (_p, o) => m.import_progress_saving_book({}, o),
	sync_yac_requesting_update: (_p, o) => m.sync_yac_requesting_update({}, o),
	sync_scanning_folders: (_p, o) => m.sync_scanning_folders({}, o),
	sync_found_comics: (p, o) => m.sync_found_comics({ n: String(p.n ?? '') }, o),
	sync_hydrating_covers: (p, o) => m.sync_hydrating_covers({ n: String(p.n ?? '') }, o),
	sync_hydrated_covers: (p, o) => m.sync_hydrated_covers({ done: String(p.done ?? ''), total: String(p.total ?? '') }, o),
	sync_incomplete_items: (p, o) => m.sync_incomplete_items({ n: Number(p.n ?? 0) }, o),
	sync_complete_comics: (p, o) => m.sync_complete_comics({ n: Number(p.n ?? 0) }, o),
	sync_fetching_folder: (_p, o) => m.sync_fetching_folder({}, o),
	sync_folder_failed_items: (p, o) => m.sync_folder_failed_items({ n: Number(p.n ?? 0) }, o),
	sync_folder_loaded: (p, o) => m.sync_folder_loaded({ folders: Number(p.folders ?? 0), comics: String(p.comics ?? '') }, o),
	sync_folder_loaded_removed: (p, o) => m.sync_folder_loaded_removed({ folders: Number(p.folders ?? 0), comics: String(p.comics ?? ''), removed: String(p.removed ?? '') }, o),
	sync_fetching_series_list: (_p, o) => m.sync_fetching_series_list({}, o),
	sync_fetch_series_failed: (_p, o) => m.sync_fetch_series_failed({}, o),
	sync_found_series_fetching_books: (p, o) => m.sync_found_series_fetching_books({ n: String(p.n ?? '') }, o),
	sync_found_books: (p, o) => m.sync_found_books({ books: String(p.books ?? ''), series: String(p.series ?? '') }, o),
	sync_no_books: (_p, o) => m.sync_no_books({}, o),
	sync_checking_removed_books: (p, o) => m.sync_checking_removed_books({ checked: String(p.checked ?? ''), total: String(p.total ?? '') }, o),
	sync_complete_books: (p, o) => m.sync_complete_books({ n: Number(p.n ?? 0) }, o),
	sync_fetching_books: (_p, o) => m.sync_fetching_books({}, o),
	sync_fetching_series: (_p, o) => m.sync_fetching_series({}, o),
	sync_found_series: (p, o) => m.sync_found_series({ n: String(p.n ?? '') }, o),
	sync_imported_books: (p, o) => m.sync_imported_books({ n: Number(p.n ?? 0) }, o),
	sync_found_series_fetching_chapters: (p, o) => m.sync_found_series_fetching_chapters({ n: String(p.n ?? '') }, o),
	sync_found_chapters: (p, o) => m.sync_found_chapters({ chapters: String(p.chapters ?? ''), series: String(p.series ?? '') }, o),
	sync_no_chapters: (_p, o) => m.sync_no_chapters({}, o),
	sync_checking_removed_chapters: (p, o) => m.sync_checking_removed_chapters({ checked: String(p.checked ?? ''), total: String(p.total ?? '') }, o),
	sync_complete_chapters: (p, o) => m.sync_complete_chapters({ n: Number(p.n ?? 0) }, o),
	sync_fetching_chapters: (_p, o) => m.sync_fetching_chapters({}, o),
	sync_imported_chapters: (p, o) => m.sync_imported_chapters({ n: Number(p.n ?? 0) }, o),
	scan_erase_waiting: (_p, o) => m.scan_erase_waiting({}, o),
	scan_erase_finding: (_p, o) => m.scan_erase_finding({}, o),
	scan_erase_erasing: (p, o) => m.scan_erase_erasing({ n: String(p.n ?? '') }, o),
	scan_erase_erased_rescanning: (p, o) => m.scan_erase_erased_rescanning({ n: String(p.n ?? '') }, o),
	scan_found_archives: (p, o) => m.scan_found_archives({ n: String(p.n ?? '') }, o),
	scan_importing_file: (p, o) => m.scan_importing_file({ index: String(p.index ?? ''), total: String(p.total ?? ''), name: String(p.name ?? '') }, o),
	authors_reading_imports: (_p, o) => m.authors_reading_imports({}, o),
	authors_found_updating: (p, o) => m.authors_found_updating({ n: String(p.n ?? '') }, o),
	authors_updated_progress: (p, o) => m.authors_updated_progress({ done: String(p.done ?? ''), total: String(p.total ?? '') }, o),
	authors_done: (p, o) => m.authors_done({ updated: String(p.updated ?? ''), root: String(p.root ?? '') }, o),
	authors_loading_hierarchy: (_p, o) => m.authors_loading_hierarchy({}, o),
	authors_computing: (p, o) => m.authors_computing({ n: String(p.n ?? '') }, o),
	authors_updating: (p, o) => m.authors_updating({ n: String(p.n ?? '') }, o),
	sync_importing_item: (p, o) => m.sync_importing_item({ name: String(p.name ?? ''), index: String(p.index ?? ''), total: String(p.total ?? '') }, o),
	sync_updating_item: (p, o) => m.sync_updating_item({ name: String(p.name ?? ''), index: String(p.index ?? ''), total: String(p.total ?? '') }, o),
	sync_reconciling: (p, o) => m.sync_reconciling({ done: String(p.done ?? ''), total: String(p.total ?? '') }, o),
	bridge_model_load_failed: (_p, o) => m.bridge_model_load_failed({}, o),
	bridge_bridge_replaced: (_p, o) => m.bridge_bridge_replaced({}, o),
	bridge_model_not_loaded: (_p, o) => m.bridge_model_not_loaded({}, o),
	bridge_translation_failed: (_p, o) => m.bridge_translation_failed({}, o),
	bridge_unload_failed: (_p, o) => m.bridge_unload_failed({}, o),
	bridge_download_busy: (_p, o) => m.bridge_download_busy({}, o),
	bridge_download_http: (_p, o) => m.bridge_download_http({}, o),
	bridge_download_empty: (_p, o) => m.bridge_download_empty({}, o),
	bridge_download_rename: (_p, o) => m.bridge_download_rename({}, o),
	bridge_download_cancelled: (_p, o) => m.bridge_download_cancelled({}, o),
	bridge_download_failed: (_p, o) => m.bridge_download_failed({}, o),
	bridge_download_no_space: (_p, o) => m.bridge_download_no_space({}, o),
	bridge_import_busy: (_p, o) => m.bridge_import_busy({}, o),
	bridge_import_open_failed: (_p, o) => m.bridge_import_open_failed({}, o),
	bridge_import_not_gguf: (_p, o) => m.bridge_import_not_gguf({}, o),
	bridge_import_cancelled: (_p, o) => m.bridge_import_cancelled({}, o),
	bridge_import_move_failed: (_p, o) => m.bridge_import_move_failed({}, o),
	bridge_import_failed: (_p, o) => m.bridge_import_failed({}, o),
	bridge_notification_permission: (_p, o) => m.bridge_notification_permission({}, o),
	bridge_ppocr_unavailable: (_p, o) => m.bridge_ppocr_unavailable({}, o),
	bridge_ppocr_destroyed: (_p, o) => m.bridge_ppocr_destroyed({}, o),
	bridge_ppocr_failed: (_p, o) => m.bridge_ppocr_failed({}, o),
} satisfies Record<string, Renderer>;

/** The Kotlin bridges reject with `{code, detail}`; these codes have a message a person can act on. */
export const BRIDGE_CODES = new Set<string>(['model_load_failed', 'bridge_replaced', 'model_not_loaded', 'translation_failed', 'unload_failed', 'download_busy', 'download_http', 'download_empty', 'download_rename', 'download_cancelled', 'download_failed', 'download_no_space', 'import_busy', 'import_open_failed', 'import_not_gguf', 'import_cancelled', 'import_move_failed', 'import_failed', 'notification_permission', 'ppocr_unavailable', 'ppocr_destroyed', 'ppocr_failed']);

export type UserMessageCode = keyof typeof RENDERERS;

export interface UserMessage {
	code: UserMessageCode;
	params?: UserMessageParams;
}

export function isUserMessage(value: unknown): value is UserMessage {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as { code?: unknown }).code === 'string' &&
		((value as { params?: unknown }).params === undefined || typeof (value as { params?: unknown }).params === 'object')
	);
}

export function userMessage<C extends UserMessageCode>(code: C, params?: UserMessageParams): UserMessage {
	return params ? { code, params } : { code };
}

/**
 * Text for a message in the live locale (or a given one — diagnostics render
 * in English so the developer can read them). A plain string is a legacy
 * record and is returned as it is; an unknown code renders as the code so a
 * stale bundle never throws inside a template.
 *
 * With no explicit locale the message function reads Paraglide's
 * `getLocale()`, which is the reactive store signal — so a call inside a
 * template re-renders on a language switch like a direct `m.x()` would.
 */
export function renderUserMessage(
	value: UserMessage | string | null | undefined,
	options: { locale?: UiLocale } = {}
): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	const render = (RENDERERS as Record<string, Renderer | undefined>)[value.code];
	if (!render) return value.params ? `${value.code} ${JSON.stringify(value.params)}` : value.code;
	try {
		return render(value.params ?? {}, options.locale ? { locale: options.locale as Locale } : {});
	} catch {
		return value.code;
	}
}

/** The code of a message, or `undefined` for a legacy string — for branching that used to read prose. */
export function userMessageCode(value: UserMessage | string | null | undefined): UserMessageCode | undefined {
	return isUserMessage(value) ? value.code : undefined;
}

/**
 * A message for an arbitrary thrown value. Typed errors from `errors.ts`
 * carry their own code; anything else becomes a generic message with the
 * English detail attached for the reader to quote in a report.
 */
export function describeError(error: unknown): UserMessage {
	if (error !== null && typeof error === 'object') {
		const userMessageCarried = (error as { userMessage?: unknown }).userMessage;
		if (isUserMessage(userMessageCarried)) return userMessageCarried;
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string' && code in RENDERERS) return { code: code as UserMessageCode };
		const name = (error as { name?: unknown }).name;
		if (name === 'AbortError') return { code: 'op_cancelled' };
	}
	const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	return detail ? { code: 'error_generic_detail', params: { detail } } : { code: 'error_generic' };
}

export const USER_MESSAGE_CODES = Object.keys(RENDERERS) as UserMessageCode[];

/** Identity of a message for de-duplication: same code and parameters, or the same legacy string. */
export function userMessageKey(value: UserMessage | string): string {
	if (typeof value === 'string') return value;
	return value.params ? `${value.code}|${JSON.stringify(value.params)}` : value.code;
}

/**
 * UI localization entry point. Importing this installs the locale store into
 * Paraglide's `getLocale()`; `+layout.svelte` imports it before anything that
 * renders a message.
 */
import './locale.js';

export {
	DEFAULT_UI_LOCALE,
	PSEUDOLOCALE_TAG,
	SUPPORTED_UI_LOCALES,
	defaultTargetForUiLocale,
	isUiLocale,
	isUiLocaleSetting,
	resolveUiLocale,
	type UiLocale,
	type UiLocaleInfo,
	type UiLocaleSetting
} from './locales.js';
export { applyHtmlLang, getUiLocale, setUiLocale, uiLocale } from './locale.js';
export {
	createCollator,
	formatBytes,
	formatCurrency,
	formatDate,
	formatDateTime,
	formatList,
	formatNumber,
	formatPercent,
	formatRelativeTime
} from './format.js';
export { getLanguageDisplayName } from './language-names.js';
export {
	USER_MESSAGE_CODES,
	describeError,
	isUserMessage,
	renderUserMessage,
	userMessage,
	userMessageCode,
	type UserMessage,
	type UserMessageCode,
	type UserMessageParams
} from './user-messages.js';
export {
	BridgeError,
	PageTranslationMissingError,
	RequestCancelledError,
	parseBridgeRejection,
	rateLimitedUserMessage,
	withUserMessage
} from './errors.js';
export { parseRichMessage, richMessageText, type RichNode } from './rich-message.js';

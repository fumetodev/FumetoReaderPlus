/**
 * Translate raw connection failures into actionable guidance (settings
 * review B10). The raw message stays available behind a details disclosure.
 *
 * Message and hint are codes rendered by the form in the live locale; the
 * matched substrings are what browsers and servers actually say and stay
 * English.
 */

import type { UserMessage } from '$lib/i18n/user-messages.js';
import { REMOTE_SERVER_TYPE_LABELS, type RemoteServerType } from './server-address.js';

export interface HumanizedConnectionError {
	message: UserMessage;
	hint: UserMessage | null;
	/** The raw underlying error text, for the "Details" disclosure. */
	raw: string;
}

const CREDENTIAL_HINTS: Record<RemoteServerType, UserMessage> = {
	yacreader: { code: 'conn_credentials_hint_yacreader' },
	komga: { code: 'conn_credentials_hint_komga' },
	kavita: { code: 'conn_credentials_hint_kavita' }
};

export function humanizeConnectionError(
	error: unknown,
	serverType: RemoteServerType,
	serverUrl: string
): HumanizedConnectionError {
	const raw = error instanceof Error ? error.message : String(error);
	const lower = raw.toLowerCase();
	// Product names are parameters, never translated.
	const server = REMOTE_SERVER_TYPE_LABELS[serverType];
	let host = serverUrl;
	try {
		host = new URL(serverUrl).host;
	} catch {
		// keep serverUrl as-is
	}

	const unreachable =
		lower.includes('failed to fetch') ||
		lower.includes('networkerror') ||
		lower.includes('load failed') ||
		lower.includes('error sending request') ||
		lower.includes('connection refused') ||
		lower.includes('econnrefused') ||
		lower.includes('network request failed');
	if (unreachable) {
		return { message: { code: 'conn_unreachable', params: { host } }, hint: { code: 'conn_unreachable_hint' }, raw };
	}

	if (lower.includes('timed out') || lower.includes('timeout')) {
		return { message: { code: 'conn_timeout', params: { host } }, hint: { code: 'conn_timeout_hint' }, raw };
	}

	if (lower.includes('name not resolved') || lower.includes('enotfound') || lower.includes('dns')) {
		return { message: { code: 'conn_dns', params: { host } }, hint: { code: 'conn_dns_hint' }, raw };
	}

	if (lower.includes('ssl') || lower.includes('tls') || lower.includes('certificate') || lower.includes('cert')) {
		return { message: { code: 'conn_tls', params: { host } }, hint: { code: 'conn_tls_hint' }, raw };
	}

	if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('403') || lower.includes('forbidden')) {
		return { message: { code: 'conn_credentials', params: { server } }, hint: CREDENTIAL_HINTS[serverType], raw };
	}

	if (lower.includes('404') || lower.includes('not found')) {
		return { message: { code: 'conn_not_found', params: { host, server } }, hint: { code: 'conn_not_found_hint' }, raw };
	}

	if (lower.includes('unexpected token') || lower.includes('json') || lower.includes('parse')) {
		return { message: { code: 'conn_wrong_server', params: { host, server } }, hint: { code: 'conn_wrong_server_hint' }, raw };
	}

	return { message: { code: 'conn_generic', params: { server } }, hint: null, raw };
}

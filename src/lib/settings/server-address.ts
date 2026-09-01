/**
 * Structured remote-server address handling for the Libraries settings.
 *
 * The add/edit-server form collects scheme + host + port + base path as
 * separate fields (settings review §5) and composes the canonical
 * `serverUrl` from them, so server clients keep receiving one URL string.
 */

export type RemoteServerType = 'yacreader' | 'komga' | 'kavita';

export const SERVER_TYPE_DEFAULT_PORTS: Record<RemoteServerType, number> = {
	yacreader: 8080,
	komga: 25600,
	kavita: 5000
};

/** User-facing names — any status line naming a server type must use these. */
export const REMOTE_SERVER_TYPE_LABELS: Record<RemoteServerType, string> = {
	yacreader: 'YACReader',
	komga: 'Komga',
	kavita: 'Kavita'
};

export interface ServerAddressParts {
	scheme: 'http' | 'https';
	host: string;
	/** null = scheme default (80/443) */
	port: number | null;
	/** Normalized to '' or '/segment(/segment)*' — no trailing slash. */
	basePath: string;
}

export function normalizeBasePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === '' || trimmed === '/') return '';
	const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
	return withLeading.replace(/\/+$/u, '').replace(/\/{2,}/gu, '/');
}

/** Compose the canonical server URL from structured parts. */
export function composeServerUrl(parts: ServerAddressParts): string {
	const host = parts.host.trim();
	const portSuffix = parts.port !== null && !isDefaultPortForScheme(parts.scheme, parts.port)
		? `:${parts.port}`
		: '';
	return `${parts.scheme}://${host}${portSuffix}${normalizeBasePath(parts.basePath)}`;
}

function isDefaultPortForScheme(scheme: 'http' | 'https', port: number): boolean {
	return (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
}

const PRIVATE_HOST_SUFFIXES = ['.local', '.lan', '.internal', '.home.arpa'];

/**
 * Pick the scheme a fresh host most likely needs: plain HTTP for loopback,
 * RFC-1918/link-local addresses, single-label hostnames, and mDNS-style
 * suffixes; HTTPS for anything that looks like a public hostname.
 */
export function defaultSchemeForHost(host: string): 'http' | 'https' {
	const value = host.trim().toLowerCase();
	if (value === '') return 'http';
	if (value === 'localhost' || value.endsWith('.localhost')) return 'http';
	if (value.startsWith('[')) {
		// IPv6 literal — loopback/link-local/ULA are LAN-ish.
		const inner = value.slice(1, value.endsWith(']') ? -1 : undefined);
		if (inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
			return 'http';
		}
		return 'https';
	}
	const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
	if (ipv4) {
		const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
		if (a === 10 || a === 127 || a === 0) return 'http';
		if (a === 192 && b === 168) return 'http';
		if (a === 172 && b >= 16 && b <= 31) return 'http';
		if (a === 169 && b === 254) return 'http';
		return 'https';
	}
	if (!value.includes('.')) return 'http'; // single-label LAN hostname
	if (PRIVATE_HOST_SUFFIXES.some((suffix) => value.endsWith(suffix))) return 'http';
	return 'https';
}

export interface ParsedServerAddress {
	parts: ServerAddressParts;
	/** True when the input carried more than a bare host (port/path/scheme). */
	hadStructure: boolean;
}

/**
 * Interpret whatever the user typed or pasted into the host field. Accepts a
 * bare host, `host:port`, `host/base/path`, or a full URL — full inputs are
 * split across the structured fields (paste-friendliness, review §5.1).
 * Returns null when the input cannot be interpreted as a host at all.
 */
export function parseServerAddressInput(
	input: string,
	fallbackScheme: 'http' | 'https' = 'http'
): ParsedServerAddress | null {
	const raw = input.trim();
	if (raw === '') return null;

	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw);
	if (hasScheme && !/^https?:\/\//iu.test(raw)) return null; // unsupported scheme

	const candidate = hasScheme ? raw : `${fallbackScheme}://${raw}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.hostname === '') return null;

	const scheme = url.protocol === 'https:' ? 'https' : 'http';
	// WHATWG URL keeps IPv6 hostnames bracketed; wrap only bare literals.
	const host = url.hostname.includes(':') && !url.hostname.startsWith('[')
		? `[${url.hostname}]`
		: url.hostname;
	const port = url.port === '' ? null : Number(url.port);
	const basePath = normalizeBasePath(url.pathname);
	const hadStructure = hasScheme || port !== null || basePath !== '';
	return { parts: { scheme, host, port, basePath }, hadStructure };
}

/** Decompose a stored serverUrl into structured parts (for edit mode). */
export function decomposeServerUrl(serverUrl: string): ServerAddressParts | null {
	const parsed = parseServerAddressInput(serverUrl, 'http');
	return parsed?.parts ?? null;
}

/**
 * Recognise a pasted Kavita OPDS URL.
 *
 * Kavita's own UI hands users `http://host:5000/api/opds/<api-key>` as "the"
 * connection URL, so that is what gets pasted into the host field. Taken
 * literally it becomes a base path of `/api/opds/<key>`, which 404s every API
 * request — and it also embeds the credential the form asks for separately.
 * Split it: the path prefix (usually empty, or a reverse-proxy base) stays the
 * base path, and the trailing segment is returned as the API key.
 */
export function splitKavitaOpdsPath(basePath: string): { basePath: string; apiKey: string | null } {
	const match = /^(?<prefix>.*)\/api\/opds\/(?<key>[^/]+)$/iu.exec(normalizeBasePath(basePath));
	if (!match?.groups) return { basePath: normalizeBasePath(basePath), apiKey: null };
	return {
		basePath: normalizeBasePath(match.groups.prefix),
		apiKey: decodeURIComponent(match.groups.key)
	};
}

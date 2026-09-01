/**
 * Komga client singleton manager.
 *
 * Ensures one KomgaServerClient instance per server URL. Unlike the YACReader
 * manager (which only needs a URL), Komga requires credentials for each client.
 */

import { KomgaServerClient } from './komga-server-client.js';

/** Active client instances, keyed by normalized URL */
const clients = new Map<string, KomgaServerClient>();

/** Normalize URL for consistent map keys */
function normalizeUrl(serverUrl: string): string {
	return serverUrl.replace(/\/+$/, '').toLowerCase();
}

/**
 * Get or create a KomgaServerClient for the given server URL and credentials.
 *
 * The docstring here used to promise that differing credentials produced a new
 * client; the code keyed on the URL alone and returned the cached one. Komga
 * credentials are frozen into a Basic auth header at construction, so after
 * changing a password in-app every page load, Scan and browse kept sending the
 * old one and failed with "Authentication failed" until the app was restarted —
 * while Test Connection, which builds a fresh client, reported success.
 */
export function getOrCreateKomgaClient(
	serverUrl: string,
	username: string,
	password: string
): KomgaServerClient {
	const key = `${normalizeUrl(serverUrl)}\u0000${username}\u0000${password}`;
	const existing = clients.get(key);
	if (existing) return existing;

	// A credential change strands the previous client; drop every entry for this
	// server so the map cannot grow one entry per password the user has ever
	// typed.
	const prefix = `${normalizeUrl(serverUrl)}\u0000`;
	for (const cached of clients.keys()) {
		if (cached.startsWith(prefix)) clients.delete(cached);
	}

	const client = new KomgaServerClient(serverUrl, username, password);
	clients.set(key, client);
	return client;
}

/** Reset (remove) the client for a specific server URL */
export function resetKomgaClient(serverUrl: string): void {
	const prefix = `${normalizeUrl(serverUrl)}\u0000`;
	for (const cached of clients.keys()) {
		if (cached === normalizeUrl(serverUrl) || cached.startsWith(prefix)) clients.delete(cached);
	}
}

/** Reset all Komga clients */
export function resetAllKomgaClients(): void {
	clients.clear();
}

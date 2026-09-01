/**
 * Kavita client singleton manager.
 *
 * Ensures one KavitaServerClient instance per server URL.
 * Similar to the Komga manager, but Kavita requires an API key instead of username/password.
 */

import { KavitaServerClient } from './kavita-server-client.js';

/** Active client instances, keyed by normalized URL */
const clients = new Map<string, KavitaServerClient>();

/** Normalize URL for consistent map keys */
function normalizeUrl(serverUrl: string): string {
	return serverUrl.replace(/\/+$/, '').toLowerCase();
}

/**
 * Get or create a KavitaServerClient for the given server URL and API key.
 *
 * Keyed on the URL alone, a rotated API key needed an app restart to take
 * effect: the cached client holds the old key and a JWT minted from it, and
 * every image URL embeds the raw key as a query param. See the Komga manager
 * for the same fix and the same reasoning.
 */
export function getOrCreateKavitaClient(
	serverUrl: string,
	apiKey: string
): KavitaServerClient {
	const key = `${normalizeUrl(serverUrl)}\u0000${apiKey}`;
	const existing = clients.get(key);
	if (existing) return existing;

	const prefix = `${normalizeUrl(serverUrl)}\u0000`;
	for (const cached of clients.keys()) {
		if (cached.startsWith(prefix)) clients.delete(cached);
	}

	const client = new KavitaServerClient(serverUrl, apiKey);
	clients.set(key, client);
	return client;
}

/** Reset (remove) the client for a specific server URL */
export function resetKavitaClient(serverUrl: string): void {
	const prefix = `${normalizeUrl(serverUrl)}\u0000`;
	for (const cached of clients.keys()) {
		if (cached === normalizeUrl(serverUrl) || cached.startsWith(prefix)) clients.delete(cached);
	}
}

/** Reset all Kavita clients */
export function resetAllKavitaClients(): void {
	clients.clear();
}

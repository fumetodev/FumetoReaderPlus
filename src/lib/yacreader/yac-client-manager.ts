/**
 * Manages YACServerClient instances — one per server URL.
 *
 * Ensures that all requests to the same server share a single session token,
 * and provides clean lifecycle management (reset on disconnect/reconnect).
 */

import { YACServerClient } from './yac-server-client.js';
import { resetYacSessionPools } from './yac-session-pool.js';

const clients = new Map<string, YACServerClient>();

/** Normalize a server URL for consistent Map key lookup */
function normalizeUrl(serverUrl: string): string {
	return serverUrl.replace(/\/+$/, '').toLowerCase();
}

/**
 * Get or create a YACServerClient for the given server URL.
 * Returns the same instance for the same URL (preserving session token).
 */
export function getOrCreateClient(serverUrl: string): YACServerClient {
	const key = normalizeUrl(serverUrl);
	let client = clients.get(key);
	if (!client) {
		client = new YACServerClient(serverUrl);
		clients.set(key, client);
	}
	return client;
}

/** Reset the client for a specific server URL (creates fresh session on next access) */
export function resetClient(serverUrl: string): void {
	const key = normalizeUrl(serverUrl);
	clients.delete(key);
	resetYacSessionPools();
}

/** Reset all clients (e.g., on app shutdown or settings change) */
export function resetAllClients(): void {
	clients.clear();
	resetYacSessionPools();
}

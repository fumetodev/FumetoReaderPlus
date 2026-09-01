/**
 * Komga credential storage — encrypts username/password using secure-storage.
 *
 * Reuses the per-provider AES-256-GCM encryption from secure-storage.ts.
 * Credentials are stored as encrypted JSON under a komga-specific key.
 */

import { encryptAndStoreForProvider, loadProviderApiKey, clearProviderKey } from '$lib/settings/secure-storage.js';

/** Normalize URL for use as storage key */
function normalizeUrl(serverUrl: string): string {
	return serverUrl.replace(/\/+$/, '').toLowerCase();
}

/** Build a provider-style key for secure storage */
function credentialKey(serverUrl: string): string {
	return `komga:${normalizeUrl(serverUrl)}`;
}

/** Encrypt and store Komga credentials for a server URL. */
export async function saveKomgaCredentials(
	serverUrl: string,
	username: string,
	password: string
): Promise<void> {
	const value = JSON.stringify({ username, password });
	await encryptAndStoreForProvider(credentialKey(serverUrl), value);
}

/** Load and decrypt Komga credentials for a server URL. Throws if not found. */
export async function loadKomgaCredentials(
	serverUrl: string
): Promise<{ username: string; password: string }> {
	const raw = await loadProviderApiKey(credentialKey(serverUrl));
	if (!raw) {
		throw new Error(`No stored credentials for Komga server: ${serverUrl}`);
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed.username || !parsed.password) {
			throw new Error('Invalid credential format');
		}
		return { username: parsed.username, password: parsed.password };
	} catch {
		throw new Error(`Failed to parse Komga credentials for: ${serverUrl}`);
	}
}

/** Remove stored Komga credentials for a server URL. */
export function clearKomgaCredentials(serverUrl: string): void {
	clearProviderKey(credentialKey(serverUrl));
}

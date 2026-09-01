/**
 * Kavita credential storage — encrypts API key using secure-storage.
 *
 * Simpler than Komga (which stores username+password) — Kavita only needs
 * an API key string, which is exchanged for a JWT token at runtime.
 *
 * Reuses the per-provider AES-256-GCM encryption from secure-storage.ts.
 */

import { encryptAndStoreForProvider, loadProviderApiKey, clearProviderKey } from '$lib/settings/secure-storage.js';

/** Normalize URL for use as storage key */
function normalizeUrl(serverUrl: string): string {
	return serverUrl.replace(/\/+$/, '').toLowerCase();
}

/** Build a provider-style key for secure storage */
function credentialKey(serverUrl: string): string {
	return `kavita:${normalizeUrl(serverUrl)}`;
}

/** Encrypt and store a Kavita API key for a server URL. */
export async function saveKavitaApiKey(
	serverUrl: string,
	apiKey: string
): Promise<void> {
	await encryptAndStoreForProvider(credentialKey(serverUrl), apiKey);
}

/** Load and decrypt a Kavita API key for a server URL. Throws if not found. */
export async function loadKavitaApiKey(serverUrl: string): Promise<string> {
	const raw = await loadProviderApiKey(credentialKey(serverUrl));
	if (!raw) {
		throw new Error(`No stored API key for Kavita server: ${serverUrl}`);
	}
	return raw;
}

/** Remove stored Kavita API key for a server URL. */
export function clearKavitaApiKey(serverUrl: string): void {
	clearProviderKey(credentialKey(serverUrl));
}

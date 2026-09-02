/**
 * Secure storage for sensitive values (API keys) using Web Crypto AES-256-GCM.
 *
 * Instead of storing the API key in plaintext localStorage, we:
 * 1. Generate a random 32-byte device key on first run (stored in app-private file)
 * 2. Derive an AES-256 key from it via PBKDF2
 * 3. Encrypt the API key with AES-GCM (random 12-byte IV per encryption)
 * 4. Store the encrypted blob (IV + ciphertext) as base64 in localStorage
 *
 * This means the API key is never stored in plaintext on disk.
 * The device key is stored in $APPDATA/device-key.hex (Tauri) or localStorage (fallback).
 */
import { writable } from 'svelte/store';
import { pushKeyedToast } from '$lib/stores/toasts.js';
import { durableKeys, durableStoreStatus, readDurable, removeDurable, writeDurable } from './durable-store.js';

const DEVICE_KEY_STORAGE = 'fumetoreaderplus-dk';
const ENCRYPTED_KEY_STORAGE = 'fumetoreaderplus-ek';
const SALT = new TextEncoder().encode('FumetoReaderPlus.SecureStorage.v1');
const DEVICE_KEY_FILE = 'device-key.hex';
const DEVICE_KEY_BACKUP_FILE = 'device-key.hex.bak';

// Tauri FS module (lazy-loaded)
let fsReady = false;
let writeTextFile: ((path: string | URL, contents: string, options?: Record<string, unknown>) => Promise<void>) | null = null;
let readTextFile: ((path: string | URL, options?: Record<string, unknown>) => Promise<string>) | null = null;
let mkdirFn: ((path: string | URL, options?: Record<string, unknown>) => Promise<void>) | null = null;
let existsFn: ((path: string | URL, options?: Record<string, unknown>) => Promise<boolean>) | null = null;
let BaseDirectory: Record<string, number> | null = null;

/** Resolves once initSecureStorage() has settled; null until it is first called. */
let initPromise: Promise<void> | null = null;

/** Initialize filesystem access for device key storage. Call once on startup. */
export function initSecureStorage(): Promise<void> {
	initPromise ??= (async () => {
		try {
			const fs = await import('@tauri-apps/plugin-fs');
			writeTextFile = fs.writeTextFile;
			readTextFile = fs.readTextFile;
			mkdirFn = fs.mkdir;
			existsFn = fs.exists;
			BaseDirectory = fs.BaseDirectory as unknown as Record<string, number>;
			fsReady = true;
		} catch {
			fsReady = false;
		}
	})();
	return initPromise;
}

/**
 * Whether stored secrets can be read right now.
 *
 * `unavailable` means the device key could not be read and a new one was NOT
 * generated in its place. Callers surface this instead of silently behaving as
 * though no keys were ever saved, because re-entering keys under a fresh key
 * is what would make the loss permanent.
 */
export const secureStorageStatus = writable<'ok' | 'unavailable'>('ok');

/**
 * What a device-key read found.
 *
 * The distinction is the whole point: "absent" licenses generating a new key,
 * which permanently orphans every ciphertext derived from the old one. It must
 * therefore require positive proof that the file is not there, and every other
 * outcome — including "the filesystem is not initialized yet" — has to be
 * unreadable rather than absent.
 */
type DeviceKeyRead =
	| { status: 'ok'; hex: string }
	| { status: 'absent' }
	| { status: 'unreadable'; reason: string };

async function readDeviceKeyFromFile(): Promise<DeviceKeyRead> {
	// No Tauri host means there is no key file by construction — a browser or
	// desktop dev session. Generating one there is safe and is what has always
	// happened; failing closed would break saving any key outside the app.
	if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
		return { status: 'absent' };
	}
	// A read that overtakes startup (an automatic translation of the restored
	// page fires before the fs plugin is wired) waits for it instead of
	// reporting the key unreadable — which a caller then reported as "no key".
	if (initPromise) await initPromise;
	if (!fsReady || !readTextFile || !existsFn || !BaseDirectory) {
		// On a real host this is NOT "absent": we have not looked. It is the case
		// that actually fires in the field, when something reaches here before
		// initSecureStorage() has run.
		return { status: 'unreadable', reason: 'filesystem not initialized' };
	}
	let present: boolean;
	try {
		present = await existsFn(DEVICE_KEY_FILE, { baseDir: BaseDirectory.AppData });
	} catch (err) {
		return { status: 'unreadable', reason: `exists check failed: ${String(err)}` };
	}
	if (!present) return { status: 'absent' };

	let contents: string;
	try {
		contents = await readTextFile(DEVICE_KEY_FILE, { baseDir: BaseDirectory.AppData });
	} catch (err) {
		return { status: 'unreadable', reason: `read failed: ${String(err)}` };
	}
	const hex = contents.trim();
	// Trimmed and hex-validated. A bare `length === 64` check read a file with a
	// trailing newline as absent — and then overwrote it — while a 64-character
	// non-hex file passed and derived a silently wrong key from NaN bytes.
	if (/^[0-9a-f]{64}$/i.test(hex)) return { status: 'ok', hex };
	// A file that exists but does not parse is corruption, not absence: the
	// ciphertext it belongs to is still on disk.
	return { status: 'unreadable', reason: `malformed key file (${contents.length} chars)` };
}

/**
 * Second copy of the key. One file is a single point of total, irreversible
 * loss for every stored secret; two independent ones are not.
 */
async function readDeviceKeyBackup(): Promise<string | null> {
	if (!fsReady || !readTextFile || !BaseDirectory) return null;
	try {
		const contents = (await readTextFile(DEVICE_KEY_BACKUP_FILE, { baseDir: BaseDirectory.AppData })).trim();
		return /^[0-9a-f]{64}$/i.test(contents) ? contents : null;
	} catch {
		return null;
	}
}

async function writeDeviceKeyBackup(hex: string): Promise<void> {
	if (!fsReady || !writeTextFile || !BaseDirectory) return;
	try {
		await writeTextFile(DEVICE_KEY_BACKUP_FILE, hex, { baseDir: BaseDirectory.AppData });
	} catch {
		// Best effort — the primary is already written.
	}
}

/** Write device key hex to $APPDATA/device-key.hex. */
async function writeDeviceKeyToFile(hex: string): Promise<boolean> {
	if (!fsReady || !writeTextFile || !BaseDirectory) return false;
	try {
		if (mkdirFn) {
			try { await mkdirFn('', { baseDir: BaseDirectory.AppData, recursive: true }); } catch { /* exists */ }
		}
		await writeTextFile(DEVICE_KEY_FILE, hex, { baseDir: BaseDirectory.AppData });
		return true;
	} catch {
		return false;
	}
}

/** Raised when the key exists but cannot be read; never when there is no key. */
export class SecureStorageUnavailableError extends Error {
	constructor(reason: string) {
		super(`Saved keys can't be read right now (${reason})`);
		this.name = 'SecureStorageUnavailableError';
	}
}

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

/** Resolved key for this session — also avoids re-deriving on every secret read. */
let cachedDeviceKey: Uint8Array | null = null;

/**
 * Get or create the random device key used for key derivation.
 * Priority: file → backup → localStorage (migrate to file) → generate new.
 *
 * Generating a key is only safe when there provably is not one: a fresh key
 * orphans every stored ciphertext irreversibly, and because decrypt failures
 * return '' the loss is silent — the user is told their API key is unset, and
 * re-entering it under the new key is what makes it permanent. So an
 * unreadable key fails closed instead.
 */
async function getOrCreateDeviceKey(): Promise<Uint8Array> {
	if (cachedDeviceKey) return cachedDeviceKey;
	if (typeof localStorage === 'undefined') {
		return crypto.getRandomValues(new Uint8Array(32));
	}

	// 1. The key file, with one retry to absorb a genuinely transient failure.
	let read = await readDeviceKeyFromFile();
	if (read.status === 'unreadable') {
		await new Promise((resolve) => setTimeout(resolve, 250));
		read = await readDeviceKeyFromFile();
	}
	if (read.status === 'ok') {
		localStorage.removeItem(DEVICE_KEY_STORAGE);
		cachedDeviceKey = hexToBytes(read.hex);
		secureStorageStatus.set('ok');
		return cachedDeviceKey;
	}

	if (read.status === 'unreadable') {
		// 2. The backup, so one damaged file is not the end of every secret.
		const backup = await readDeviceKeyBackup();
		if (backup) {
			await writeDeviceKeyToFile(backup);
			cachedDeviceKey = hexToBytes(backup);
			secureStorageStatus.set('ok');
			return cachedDeviceKey;
		}
		console.error('[secure-storage] device key unreadable:', read.reason);
		secureStorageStatus.set('unavailable');
		// Say so out loud. The failure is otherwise indistinguishable from "no
		// keys were ever saved", and the natural response to that — re-entering
		// them, which writes new ciphertext under a newly generated key — is the
		// one action that would make the loss permanent.
		pushKeyedToast('secure-storage-unavailable', {
			tone: 'error',
			message: { code: 'settings_secure_storage_unreadable' }
		});
		throw new SecureStorageUnavailableError(read.reason);
	}

	// 3. Migrate a legacy localStorage key to the file.
	let hex = localStorage.getItem(DEVICE_KEY_STORAGE);
	if (hex && /^[0-9a-f]{64}$/i.test(hex.trim())) {
		hex = hex.trim();
		const written = await writeDeviceKeyToFile(hex);
		// Only drop the localStorage copy once the file provably holds it.
		if (written) {
			await writeDeviceKeyBackup(hex);
			localStorage.removeItem(DEVICE_KEY_STORAGE);
		}
		cachedDeviceKey = hexToBytes(hex);
		secureStorageStatus.set('ok');
		return cachedDeviceKey;
	}

	// 4. Provably no key yet: generate one.
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	const written = await writeDeviceKeyToFile(hex);
	if (written) await writeDeviceKeyBackup(hex);
	else localStorage.setItem(DEVICE_KEY_STORAGE, hex);
	cachedDeviceKey = bytes;
	secureStorageStatus.set('ok');
	return bytes;
}

/** Derive an AES-256-GCM key from the device key via PBKDF2. */
async function deriveAesKey(deviceKey: Uint8Array): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey(
		'raw',
		deviceKey as unknown as ArrayBuffer,
		'PBKDF2',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: SALT, iterations: 100_000, hash: 'SHA-256' },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * Encrypt a value and store it in localStorage.
 * If the value is empty, removes the stored key.
 */
export async function encryptAndStore(value: string): Promise<void> {
	if (typeof localStorage === 'undefined') return;

	if (!value) {
		localStorage.removeItem(ENCRYPTED_KEY_STORAGE);
		removeDurable(ENCRYPTED_KEY_STORAGE);
		return;
	}

	const dk = await getOrCreateDeviceKey();
	const aesKey = await deriveAesKey(dk);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encoded = new TextEncoder().encode(value);
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);

	// Store as base64(iv + ciphertext)
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	const encoded64 = btoa(String.fromCharCode(...combined));
	localStorage.setItem(ENCRYPTED_KEY_STORAGE, encoded64);
	writeDurable(ENCRYPTED_KEY_STORAGE, encoded64);
}

/**
 * Load and decrypt the stored value from localStorage.
 * Returns empty string if nothing is stored or decryption fails.
 */
export async function loadAndDecrypt(): Promise<string> {
	if (typeof localStorage === 'undefined') return '';

	const stored = localStorage.getItem(ENCRYPTED_KEY_STORAGE) ?? readDurable(ENCRYPTED_KEY_STORAGE);
	if (!stored) return '';

	try {
		const dk = await getOrCreateDeviceKey();
		const aesKey = await deriveAesKey(dk);
		const combined = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
		const iv = combined.slice(0, 12);
		const ciphertext = combined.slice(12);
		const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
		return new TextDecoder().decode(decrypted);
	} catch {
		return '';
	}
}

/** Remove the encrypted key from localStorage. */
export function clearSecureKey(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.removeItem(ENCRYPTED_KEY_STORAGE);
	removeDurable(ENCRYPTED_KEY_STORAGE);
}

/**
 * Reconcile localStorage with the app-private mirror.
 *
 * Runs after initSecureStorage() and BEFORE anything decrypts: a launch that
 * finds localStorage evicted must see its secrets restored first, or the
 * settings layer reads them as absent and writes that emptiness back.
 *
 * Deletions are explicit everywhere above precisely so this can be a plain
 * two-way fill: whatever localStorage still has is authoritative, and whatever
 * only the mirror has is put back.
 */
export function reconcileSecureStorageMirror(): void {
	if (typeof localStorage === 'undefined') return;
	// 'unreadable' means we could not look. Writing anything from that state
	// could erase real secrets, so do nothing at all.
	if (durableStoreStatus() !== 'loaded') return;

	for (const key of mirroredLocalStorageKeys()) {
		const live = localStorage.getItem(key);
		if (live !== null) writeDurable(key, live);
	}
	for (const key of durableKeys()) {
		if (localStorage.getItem(key) !== null) continue;
		const value = readDurable(key);
		if (value === null) continue;
		try {
			localStorage.setItem(key, value);
		} catch {
			// Quota or a locked store — reads still fall back to the mirror.
		}
	}
}

/**
 * Every localStorage key the mirror covers: the legacy single key and each
 * per-provider one (which includes Komga and Kavita credentials, since those
 * go through the same provider store). Never the device key — that lives in
 * its own file so one file alone stays useless.
 */
function mirroredLocalStorageKeys(): string[] {
	const keys: string[] = [];
	for (let index = localStorage.length - 1; index >= 0; index -= 1) {
		const key = localStorage.key(index);
		if (!key) continue;
		if (key === ENCRYPTED_KEY_STORAGE || key.startsWith(`${ENCRYPTED_KEY_STORAGE}-`)) keys.push(key);
	}
	return keys;
}

// ---------------------------------------------------------------------------
// Per-provider key storage
// ---------------------------------------------------------------------------

/**
 * Get the localStorage key for a provider's encrypted API key.
 * The legacy `__legacy_openrouter__` provider reuses the original key.
 */
function providerStorageKey(providerId: string): string {
	return providerId === '__legacy_openrouter__'
		? ENCRYPTED_KEY_STORAGE
		: `${ENCRYPTED_KEY_STORAGE}-${providerId}`;
}

/**
 * Encrypt and store an API key for a specific provider.
 * If the value is empty, removes the stored key.
 */
export async function encryptAndStoreForProvider(providerId: string, value: string): Promise<void> {
	if (typeof localStorage === 'undefined') return;

	const storageKey = providerStorageKey(providerId);

	if (!value) {
		localStorage.removeItem(storageKey);
		removeDurable(storageKey);
		return;
	}

	const dk = await getOrCreateDeviceKey();
	const aesKey = await deriveAesKey(dk);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encoded = new TextEncoder().encode(value);
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);

	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	const encodedProvider64 = btoa(String.fromCharCode(...combined));
	localStorage.setItem(storageKey, encodedProvider64);
	writeDurable(storageKey, encodedProvider64);
}

/**
 * Load and decrypt the API key for a specific provider.
 * Falls back to the legacy key for `__legacy_openrouter__`.
 */
export async function loadProviderApiKey(providerId: string): Promise<string> {
	if (typeof localStorage === 'undefined') return '';

	const storageKey = providerStorageKey(providerId);
	const stored = localStorage.getItem(storageKey) ?? readDurable(storageKey);

	if (!stored) {
		// For legacy provider, try the original key path
		if (providerId === '__legacy_openrouter__') {
			return loadAndDecrypt();
		}
		return '';
	}

	try {
		const dk = await getOrCreateDeviceKey();
		const aesKey = await deriveAesKey(dk);
		const combined = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
		const iv = combined.slice(0, 12);
		const ciphertext = combined.slice(12);
		const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
		return new TextDecoder().decode(decrypted);
	} catch (error) {
		// An unreadable device key is not "no key stored": swallowing it here
		// made the reader say "API key not configured" for a key that is on
		// disk, and re-entering one under a fresh device key is what turns the
		// outage into a permanent loss. Say what actually happened.
		if (error instanceof SecureStorageUnavailableError) throw error;
		console.warn(`[secure-storage] stored key for ${providerId} could not be decrypted`);
		return '';
	}
}

/** Remove the encrypted key for a specific provider. */
export function clearProviderKey(providerId: string): void {
	if (typeof localStorage === 'undefined') return;
	const clearedKey = providerStorageKey(providerId);
	localStorage.removeItem(clearedKey);
	removeDurable(clearedKey);
}

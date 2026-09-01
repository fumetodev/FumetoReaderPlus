/**
 * App-private mirror of the localStorage values that must outlive it.
 *
 * Android can evict WebView localStorage when it reclaims storage — this
 * codebase already says so where the settings file layer is defined, and gave
 * settings and the device key a filesystem home for exactly that reason. The
 * encrypted secrets (LLM API keys, Komga credentials, Kavita API keys) never
 * got one: after an eviction, libraries came back from settings.json while
 * the credentials for reaching them did not.
 *
 * The mirror stores each key's EXACT stored string. Ciphertext stays
 * ciphertext — no second encoding, and therefore no second thing to get wrong. The device
 * key itself is deliberately NOT mirrored: keeping it in a separate file from
 * the ciphertext preserves the (modest) property that one file alone is
 * useless, and secure-storage owns its durability.
 */

const STORE_FILE = 'secure-store.json';
const TEMP_FILE = 'secure-store.json.tmp';
const STORE_VERSION = 1;

/**
 * - `loaded`: the mirror was read (or provably does not exist yet).
 * - `unreadable`: it exists but could not be read or parsed. Callers must treat
 *   this as "I could not look", never as "there is nothing there" — the
 *   difference decides whether stored credentials survive.
 * - `unavailable`: no filesystem at all (browser, desktop dev, tests).
 */
export type DurableStoreStatus = 'unavailable' | 'loaded' | 'unreadable';

let status: DurableStoreStatus = 'unavailable';
let entries = new Map<string, string>();

let writeTextFile: ((path: string, contents: string, options?: Record<string, unknown>) => Promise<void>) | null = null;
let readTextFile: ((path: string, options?: Record<string, unknown>) => Promise<string>) | null = null;
let existsFn: ((path: string, options?: Record<string, unknown>) => Promise<boolean>) | null = null;
let renameFn: ((from: string, to: string, options?: Record<string, unknown>) => Promise<void>) | null = null;
let mkdirFn: ((path: string, options?: Record<string, unknown>) => Promise<void>) | null = null;
let BaseDirectory: Record<string, number> | null = null;

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending = false;
let flushChain: Promise<void> = Promise.resolve();

/** Read the mirror once into memory. Every later read is synchronous. */
export async function initDurableStore(): Promise<void> {
	// The plugin module imports cleanly in a plain browser; only its calls fail,
	// because there is no Tauri IPC behind them. Without this check a browser
	// looked like a device whose mirror could not be read, which is both wrong
	// and noisy — it logged an error on every page load.
	if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
		status = 'unavailable';
		return;
	}
	try {
		const fs = await import('@tauri-apps/plugin-fs');
		writeTextFile = fs.writeTextFile as typeof writeTextFile;
		readTextFile = fs.readTextFile as typeof readTextFile;
		existsFn = fs.exists as typeof existsFn;
		renameFn = fs.rename as typeof renameFn;
		mkdirFn = fs.mkdir as typeof mkdirFn;
		BaseDirectory = fs.BaseDirectory as unknown as Record<string, number>;
	} catch {
		status = 'unavailable';
		return;
	}

	try {
		if (!(await existsFn!(STORE_FILE, { baseDir: BaseDirectory!.AppData }))) {
			// Provably nothing yet — a first run, not a failure.
			entries = new Map();
			status = 'loaded';
			return;
		}
		const raw = await readTextFile!(STORE_FILE, { baseDir: BaseDirectory!.AppData });
		const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, string> };
		if (parsed?.version !== STORE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
			status = 'unreadable';
			return;
		}
		entries = new Map(Object.entries(parsed.entries).filter(([, value]) => typeof value === 'string'));
		status = 'loaded';
	} catch (err) {
		// Reading failed, or the file is not the JSON we wrote. Say so; do NOT
		// fall back to an empty map, which would look exactly like "no secrets
		// were ever stored" and let a rewrite erase the real ones.
		console.error('[durable-store] mirror unreadable:', err);
		status = 'unreadable';
	}
}

export function durableStoreStatus(): DurableStoreStatus {
	return status;
}

export function readDurable(key: string): string | null {
	return status === 'loaded' ? (entries.get(key) ?? null) : null;
}

export function durableKeys(): string[] {
	return status === 'loaded' ? [...entries.keys()] : [];
}

export function writeDurable(key: string, value: string): void {
	if (status !== 'loaded') return;
	if (entries.get(key) === value) return;
	entries.set(key, value);
	schedule();
}

export function removeDurable(key: string): void {
	if (status !== 'loaded') return;
	if (!entries.has(key)) return;
	entries.delete(key);
	schedule();
}

function schedule(): void {
	pending = true;
	if (writeTimer) clearTimeout(writeTimer);
	writeTimer = setTimeout(() => void flushDurableStore(), 300);
}

/** Write any pending changes now. Chained so a flush cannot land stale bytes. */
export function flushDurableStore(): Promise<void> {
	if (writeTimer) {
		clearTimeout(writeTimer);
		writeTimer = null;
	}
	flushChain = flushChain.then(() => persist());
	return flushChain;
}

async function persist(): Promise<void> {
	if (!pending || status !== 'loaded' || !writeTextFile || !BaseDirectory) return;
	pending = false;
	const payload = JSON.stringify({
		version: STORE_VERSION,
		updatedAtMs: Date.now(),
		entries: Object.fromEntries(entries)
	});
	try {
		if (mkdirFn) {
			try {
				await mkdirFn('', { baseDir: BaseDirectory.AppData, recursive: true });
			} catch {
				// Directory likely already exists.
			}
		}
		// Temp file then rename: a torn write here loses every credential at
		// once, so the file is replaced atomically rather than edited in place.
		if (renameFn) {
			await writeTextFile(TEMP_FILE, payload, { baseDir: BaseDirectory.AppData });
			await renameFn(TEMP_FILE, STORE_FILE, {
				oldPathBaseDir: BaseDirectory.AppData,
				newPathBaseDir: BaseDirectory.AppData
			});
		} else {
			await writeTextFile(STORE_FILE, payload, { baseDir: BaseDirectory.AppData });
		}
	} catch (err) {
		console.error('[durable-store] failed to persist mirror:', err);
		// Keep the work pending so a later flush can still land it.
		pending = true;
	}
}

/** Test seam: forget module state between cases. */
export function resetDurableStoreForTests(): void {
	status = 'unavailable';
	entries = new Map();
	pending = false;
	if (writeTimer) clearTimeout(writeTimer);
	writeTimer = null;
	writeTextFile = readTextFile = null;
	existsFn = null;
	renameFn = mkdirFn = null;
	BaseDirectory = null;
}

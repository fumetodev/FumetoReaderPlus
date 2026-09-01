/**
 * File-based settings persistence for Android.
 *
 * On Android, WebView localStorage can be lost if the app is killed.
 * This module writes settings to $APPDATA/settings.json via the Tauri
 * filesystem plugin for reliable persistence, falling back to localStorage.
 */

let isTauri = false;
let writeTextFile: ((path: string | URL, contents: string, options?: Record<string, unknown>) => Promise<void>) | null = null;
let readTextFile: ((path: string | URL, options?: Record<string, unknown>) => Promise<string>) | null = null;
let mkdirFn: ((path: string | URL, options?: Record<string, unknown>) => Promise<void>) | null = null;
let BaseDirectory: Record<string, number> | null = null;

const SETTINGS_FILE = 'settings.json';

// Debounce timer for writes
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: string | null = null;

let hideFlushInstalled = false;

/** Initialize the filesystem module (call once on startup) */
export async function initFsPersistence(): Promise<void> {
	try {
		const fs = await import('@tauri-apps/plugin-fs');
		writeTextFile = fs.writeTextFile;
		readTextFile = fs.readTextFile;
		mkdirFn = fs.mkdir;
		BaseDirectory = fs.BaseDirectory as unknown as Record<string, number>;
		isTauri = true;
	} catch {
		// Not in Tauri environment — filesystem not available
		isTauri = false;
	}
	installHideFlush();
}

/**
 * Write any pending settings before the app can be killed.
 *
 * Android gives no reliable pre-kill callback; `visibilitychange` to hidden is
 * the last point JS is guaranteed to run (it fires on the Activity going to
 * the background), and `pagehide` covers the browser. Both are best-effort,
 * but strictly better than a 500 ms timer that process death cancels — which
 * is how a settings change made just before leaving the app was lost.
 */
function installHideFlush(): void {
	if (hideFlushInstalled || typeof document === 'undefined') return;
	hideFlushInstalled = true;
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') void flushSettingsToFile();
	});
	if (typeof window !== 'undefined') {
		window.addEventListener('pagehide', () => void flushSettingsToFile());
	}
}

/** Read settings from $APPDATA/settings.json. Returns null if not available. */
export async function readSettingsFromFile(): Promise<string | null> {
	if (!isTauri || !readTextFile || !BaseDirectory) return null;

	try {
		const contents = await readTextFile(SETTINGS_FILE, {
			baseDir: BaseDirectory.AppData
		});
		return contents || null;
	} catch {
		// File doesn't exist yet or read error
		return null;
	}
}

/** Write settings JSON to $APPDATA/settings.json (debounced, 500ms) */
export function writeSettingsToFile(json: string): void {
	if (!isTauri) return;

	pendingData = json;
	if (writeTimer) clearTimeout(writeTimer);
	writeTimer = setTimeout(() => {
		flushWrite();
	}, 500);
}

/**
 * Write any pending payload now. Safe to call when nothing is pending; writes
 * are chained so a flush can never overtake an in-flight one and land stale
 * bytes on disk.
 */
export function flushSettingsToFile(): Promise<void> {
	if (writeTimer) {
		clearTimeout(writeTimer);
		writeTimer = null;
	}
	flushChain = flushChain.then(() => flushWrite());
	return flushChain;
}

let flushChain: Promise<void> = Promise.resolve();

async function flushWrite(): Promise<void> {
	if (!writeTextFile || !BaseDirectory || !pendingData) return;

	const data = pendingData;
	pendingData = null;

	try {
		// Ensure directory exists
		if (mkdirFn) {
			try {
				await mkdirFn('', { baseDir: BaseDirectory.AppData, recursive: true });
			} catch {
				// Directory likely already exists
			}
		}
		await writeTextFile(SETTINGS_FILE, data, {
			baseDir: BaseDirectory.AppData
		});
	} catch (err) {
		console.error('Failed to persist settings to file:', err);
		// Keep the payload so a later write can still land it. Clearing it before
		// the write meant one failure discarded the change outright, with nothing
		// left to retry.
		if (pendingData === null) pendingData = data;
	}
}

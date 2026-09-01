/**
 * Open a URL in the device's browser. `window.open` is a no-op inside the
 * Android WebView (review B8) — the opener plugin hands the URL to the OS.
 * Falls back to window.open for plain-browser dev sessions.
 */
export async function openExternal(url: string): Promise<void> {
	try {
		const { openUrl } = await import('@tauri-apps/plugin-opener');
		await openUrl(url);
	} catch {
		window.open(url, '_blank', 'noopener');
	}
}

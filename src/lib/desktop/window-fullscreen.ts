/**
 * Full screen for the desktop app's window.
 *
 * WKWebView does not reliably honour the Element Fullscreen API
 * (`requestFullscreen`), so the reader's full-screen button did nothing on a
 * Mac. The window itself can always go full screen — the same thing the green
 * title-bar button and View → Enter Full Screen do.
 */

export interface FullscreenWindow {
	isFullscreen(): Promise<boolean>;
	setFullscreen(fullscreen: boolean): Promise<void>;
}

async function currentWindow(): Promise<FullscreenWindow> {
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	return getCurrentWindow();
}

/** Toggle the window's full screen. Resolves to the new state. */
export async function toggleWindowFullscreen(window?: FullscreenWindow): Promise<boolean> {
	const target = window ?? (await currentWindow());
	const next = !(await target.isFullscreen());
	await target.setFullscreen(next);
	return next;
}

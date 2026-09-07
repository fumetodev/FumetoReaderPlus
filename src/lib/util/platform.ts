/**
 * Platform detection utilities for Fumeto.
 *
 * Used to conditionally render mobile vs desktop UI
 * and gate desktop-only features (file watching, RAR extraction, etc.).
 */

/** Whether the app is running on a mobile device (Android/iOS). */
export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Whether the app is running on Android specifically. */
export const isAndroid = /Android/i.test(navigator.userAgent);

/** Whether the app is running on macOS (Tauri desktop). */
export const isMacOS = /Macintosh|Mac OS X/i.test(navigator.userAgent);

/** Whether the app is running on a desktop platform (not mobile). */
export const isDesktop = !isMobile;

/**
 * Whether a Tauri host is present (Android WebView or the desktop shell).
 * The IPC object is injected before any script runs, so this is stable.
 */
export const isTauriHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Whether this is the Tauri desktop shell (Linux/macOS/Windows), not a plain browser. */
export const isDesktopTauri = isTauriHost && !isMobile;

/** Whether this is the Tauri desktop shell on Linux (WebKitGTK). */
export const isLinuxDesktop = isDesktopTauri && /Linux|X11/i.test(navigator.userAgent);

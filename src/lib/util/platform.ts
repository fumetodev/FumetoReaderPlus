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

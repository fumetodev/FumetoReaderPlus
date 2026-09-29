/**
 * Platform detection utilities for Fumeto.
 *
 * Used to conditionally render mobile vs desktop UI
 * and gate desktop-only features (file watching, RAR extraction, etc.).
 */

/** What the WebView tells us about the device. */
export interface PlatformSignals {
	userAgent: string;
	maxTouchPoints: number;
}

export interface PlatformFlags {
	/** Android specifically. */
	isAndroid: boolean;
	/** iPhone, iPod touch or iPad — including an iPad presenting as a Mac. */
	isIOS: boolean;
	/** A phone or tablet: Android or iOS. */
	isMobile: boolean;
	/** macOS proper (Tauri desktop). Never true on an iPad. */
	isMacOS: boolean;
	/** Not a phone or tablet. */
	isDesktop: boolean;
}

/**
 * Classify the device from its user agent.
 *
 * An iPad cannot be told apart by user agent alone: iPadOS 13+ asks for
 * desktop-class sites, so its WKWebView reports a Macintosh user agent by
 * default. A real Mac has no touch screen and reports zero touch points,
 * which is the standard way to tell the two apart. Without this, an iPad
 * took every desktop path — including the Rust llama.cpp commands, which
 * are not registered on mobile builds.
 */
export function detectPlatform({ userAgent, maxTouchPoints }: PlatformSignals): PlatformFlags {
	const isAndroid = /Android/i.test(userAgent);
	const isIOS =
		/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
	const isMobile = isAndroid || isIOS;
	return {
		isAndroid,
		isIOS,
		isMobile,
		isMacOS: !isIOS && /Macintosh|Mac OS X/i.test(userAgent),
		isDesktop: !isMobile
	};
}

function currentSignals(): PlatformSignals {
	if (typeof navigator === 'undefined') return { userAgent: '', maxTouchPoints: 0 };
	return {
		userAgent: navigator.userAgent ?? '',
		maxTouchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0
	};
}

const flags = detectPlatform(currentSignals());

/** Whether the app is running on a mobile device (Android/iOS). */
export const isMobile = flags.isMobile;

/** Whether the app is running on Android specifically. */
export const isAndroid = flags.isAndroid;

/** Whether the app is running on iOS or iPadOS. */
export const isIOS = flags.isIOS;

/** Whether the app is running on macOS (Tauri desktop). */
export const isMacOS = flags.isMacOS;

/** Whether the app is running on a desktop platform (not mobile). */
export const isDesktop = flags.isDesktop;

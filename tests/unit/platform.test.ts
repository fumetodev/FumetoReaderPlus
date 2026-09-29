import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform } from '$lib/util/platform.js';

const UA = {
	androidWebView:
		'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36',
	iPhoneWebView:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
	iPadMobileMode:
		'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
	// iPadOS 13+ WKWebView default: desktop-class browsing, indistinguishable from a Mac by UA.
	desktopClassMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
	windowsWebView2:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0',
	linuxWebKitGtk: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'
};

describe('detectPlatform', () => {
	it('classifies an Android WebView as Android mobile', () => {
		expect(detectPlatform({ userAgent: UA.androidWebView, maxTouchPoints: 5 })).toEqual({
			isAndroid: true,
			isIOS: false,
			isMobile: true,
			isMacOS: false,
			isDesktop: false
		});
	});

	it('classifies an iPhone WKWebView as iOS mobile, not macOS', () => {
		expect(detectPlatform({ userAgent: UA.iPhoneWebView, maxTouchPoints: 5 })).toEqual({
			isAndroid: false,
			isIOS: true,
			isMobile: true,
			isMacOS: false,
			isDesktop: false
		});
	});

	it('classifies an iPad presenting a Mac user agent as iOS mobile', () => {
		expect(detectPlatform({ userAgent: UA.desktopClassMac, maxTouchPoints: 5 })).toEqual({
			isAndroid: false,
			isIOS: true,
			isMobile: true,
			isMacOS: false,
			isDesktop: false
		});
	});

	it('classifies an iPad in mobile mode as iOS mobile', () => {
		const flags = detectPlatform({ userAgent: UA.iPadMobileMode, maxTouchPoints: 5 });
		expect(flags.isIOS).toBe(true);
		expect(flags.isMobile).toBe(true);
	});

	it('keeps a real Mac (no touch points) on desktop', () => {
		expect(detectPlatform({ userAgent: UA.desktopClassMac, maxTouchPoints: 0 })).toEqual({
			isAndroid: false,
			isIOS: false,
			isMobile: false,
			isMacOS: true,
			isDesktop: true
		});
	});

	it('keeps touch-screen Windows and Linux desktops on desktop', () => {
		for (const userAgent of [UA.windowsWebView2, UA.linuxWebKitGtk]) {
			const flags = detectPlatform({ userAgent, maxTouchPoints: 10 });
			expect(flags.isDesktop).toBe(true);
			expect(flags.isIOS).toBe(false);
			expect(flags.isMacOS).toBe(false);
		}
	});

	it('treats a missing user agent as desktop', () => {
		expect(detectPlatform({ userAgent: '', maxTouchPoints: 0 }).isDesktop).toBe(true);
	});
});

describe('module flags on an iPad', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	async function importOnIPad<T>(specifier: () => Promise<T>): Promise<T> {
		vi.resetModules();
		vi.stubGlobal('navigator', { userAgent: UA.desktopClassMac, maxTouchPoints: 5 });
		return specifier();
	}

	it('exports mobile flags', async () => {
		const platform = await importOnIPad(() => import('$lib/util/platform.js'));
		expect(platform.isIOS).toBe(true);
		expect(platform.isMobile).toBe(true);
		expect(platform.isDesktop).toBe(false);
		expect(platform.isAndroid).toBe(false);
	});

	it('does not offer the desktop llama.cpp commands, which mobile builds do not register', async () => {
		vi.doMock('$lib/settings/settings.js', () => ({
			settings: { subscribe: () => () => undefined },
			ON_DEVICE_TEMPERATURE_DEFAULT: 0.15
		}));
		const invoke = vi.fn(async () => {
			throw new Error('command llama_is_loaded not found');
		});
		vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
		const bridge = await importOnIPad(() => import('$lib/translation/llamacpp-bridge.js'));

		// Before the fix: `true`, from the desktop branch, with every later call failing.
		expect(bridge.isLlamaBridgeAvailable()).toBe(false);
		expect(await bridge.isModelLoaded()).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});
});

/**
 * Facts about the desktop host, read once from the Tauri shell.
 *
 * WebKitGTK exposes neither device memory nor CPU details to a page, and the
 * on-device translation models need both (RAM advice before a download, the
 * CPU baseline before a load). The shell answers a single command; the
 * result is cached for the lifetime of the page and read synchronously by
 * the same callers that read the Android bridge on phones.
 */

import { isDesktopTauri } from '$lib/util/platform.js';

export interface DesktopSystemInfo {
	os: string;
	arch: string;
	totalMemoryBytes: number | null;
	availableMemoryBytes: number | null;
	cpuLogicalCores: number;
	llamaThreads: number;
	cpuBaseline: string;
	cpuBaselineOk: boolean;
	cpuMissingFeatures: string[];
	nvidiaDriverDetected: boolean;
	webkitDmabufWorkaroundApplied: boolean;
	webkitDmabufEnvPresent: boolean;
	appImagePath: string | null;
}

let cached: DesktopSystemInfo | null = null;
let priming: Promise<void> | null = null;

/** Asks the shell once; resolves without throwing so boot never waits on a failure. */
export function primeDesktopSystemInfo(): Promise<void> {
	if (!isDesktopTauri) return Promise.resolve();
	if (priming) return priming;
	priming = import('@tauri-apps/api/core')
		.then(({ invoke }) => invoke<DesktopSystemInfo>('desktop_system_info'))
		.then((info) => {
			cached = info;
		})
		.catch(() => {
			cached = null;
		});
	return priming;
}

/** The cached snapshot, or null in a browser, on Android, or before priming. */
export function desktopSystemInfo(): DesktopSystemInfo | null {
	return cached;
}

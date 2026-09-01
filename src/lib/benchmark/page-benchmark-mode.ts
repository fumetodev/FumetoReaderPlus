/**
 * Non-persistent flags used only by the instrumented Android benchmark build.
 *
 * Keeping the checks here prevents an ordinary WebView script from enabling
 * benchmark-only rendering or suppressing reader persistence in a release APK.
 */

const PERSISTENCE_FLAG = '__fumeto_benchmark_suppress_reader_persistence';
const FORCE_OVERLAY_FLAG = '__fumeto_benchmark_force_overlay_rendering';
const NAVIGATION_TRANSFER_FLAG = '__fumeto_benchmark_navigation_transfer';

type BenchmarkWindow = Window & Record<string, unknown>;

function benchmarkWindow(): BenchmarkWindow | null {
	return typeof window === 'undefined' ? null : window as unknown as BenchmarkWindow;
}

export function isAndroidBenchmarkBuild(): boolean {
	const target = benchmarkWindow();
	const bridge = target?.__fumeto_llama as { isBenchmarkBuild?: () => boolean } | undefined;
	try {
		return bridge?.isBenchmarkBuild?.() === true;
	} catch {
		return false;
	}
}

export function isPageBenchmarkPersistenceSuppressed(): boolean {
	const target = benchmarkWindow();
	return isAndroidBenchmarkBuild() && target?.[PERSISTENCE_FLAG] === true;
}

export function isPageBenchmarkOverlayRenderingForced(): boolean {
	const target = benchmarkWindow();
	return isAndroidBenchmarkBuild() && target?.[FORCE_OVERLAY_FLAG] === true;
}

export function enablePageBenchmarkMode(): boolean {
	const target = benchmarkWindow();
	if (!target || !isAndroidBenchmarkBuild()) return false;
	target[PERSISTENCE_FLAG] = true;
	target[FORCE_OVERLAY_FLAG] = true;
	return true;
}

export function disablePageBenchmarkMode(): void {
	const target = benchmarkWindow();
	if (!target) return;
	delete target[PERSISTENCE_FLAG];
	delete target[FORCE_OVERLAY_FLAG];
	delete target[NAVIGATION_TRANSFER_FLAG];
}

/** Preserve benchmark flags across the intentional reader -> catalog remount. */
export function markPageBenchmarkNavigationTransfer(): boolean {
	const target = benchmarkWindow();
	if (!target || !isPageBenchmarkPersistenceSuppressed()) return false;
	target[NAVIGATION_TRANSFER_FLAG] = true;
	return true;
}

/** Returns true exactly once for an intentional benchmark navigation unmount. */
export function consumePageBenchmarkNavigationTransfer(): boolean {
	const target = benchmarkWindow();
	if (!target || target[NAVIGATION_TRANSFER_FLAG] !== true) return false;
	delete target[NAVIGATION_TRANSFER_FLAG];
	return true;
}

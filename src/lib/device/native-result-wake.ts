/**
 * Releases an answer from a native dialog that the runtime is still holding.
 *
 * A file picker covers the app, and its answer comes back while the app is
 * still behind it. On Android the runtime sometimes does not wake for that
 * answer: the call stays pending — the import dialog sat on its first step as
 * if nothing had been picked — and is delivered the moment any other native
 * call is made, however much later. Measured on a Snapdragon 8 Elite phone,
 * for a picker opened seven seconds after launch: 4 of 14 answers were held,
 * and a call made once the page was visible again released every one.
 *
 * So that call is made here, each time the page returns to view. The first is
 * enough for an answer already waiting; the later ones cover an answer the
 * runtime queues just after the return.
 */
export const NATIVE_RESULT_WAKE_DELAYS_MS: readonly number[] = [0, 250, 1000, 3000];

/** The cheapest call the runtime answers: it reads nothing and changes nothing. */
async function touchRuntime(): Promise<void> {
	const { getVersion } = await import('@tauri-apps/api/app');
	await getVersion();
}

/**
 * Wakes the runtime on every return to view. A no-op in effect wherever there
 * is no runtime to wake (a browser): the call fails and the failure is dropped.
 */
export function installNativeResultWake(
	wake: () => Promise<unknown> = touchRuntime,
	target: Document = document
): () => void {
	let timers: Array<ReturnType<typeof setTimeout>> = [];
	const cancel = () => {
		for (const timer of timers) clearTimeout(timer);
		timers = [];
	};
	const onVisibilityChange = () => {
		cancel();
		if (target.visibilityState !== 'visible') return;
		timers = NATIVE_RESULT_WAKE_DELAYS_MS.map((delay) => setTimeout(() => {
			// A wake that fails has nothing to release; the next one still runs.
			try {
				void wake().catch(() => {});
			} catch {
				// Same for a wake that throws before it returns its promise.
			}
		}, delay));
	};
	target.addEventListener('visibilitychange', onVisibilityChange);
	return () => {
		target.removeEventListener('visibilitychange', onVisibilityChange);
		cancel();
	};
}

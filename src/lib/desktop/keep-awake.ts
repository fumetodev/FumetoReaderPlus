/**
 * Keep the Mac awake while volume translations run in the background — the
 * desktop counterpart of Android's foreground service
 * (`translation/background-service-bridge.ts`).
 *
 * The Rust side (`src-tauri/src/keep_awake.rs`) holds a single macOS
 * user-initiated activity: no App Nap for the process, no idle system sleep.
 * Several volume jobs can run at once, so claims are reference-counted here and
 * the native call is made only on the first claim and the last release. Calls
 * are chained so an enable and a quick disable reach Rust in order.
 *
 * Nothing here throws: a failed native call costs background speed, never the
 * translation itself.
 */

export type KeepAwakeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

let claims = 0;
let pending: Promise<void> = Promise.resolve();
let invokeOverride: KeepAwakeInvoke | null = null;

async function defaultInvoke(command: string, args: Record<string, unknown>): Promise<unknown> {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke(command, args);
}

function setKeepAwake(enabled: boolean): Promise<void> {
	const invoke = invokeOverride ?? defaultInvoke;
	pending = pending.then(async () => {
		try {
			await invoke('app_keep_awake', { enabled });
		} catch (error) {
			console.warn(`[keep-awake] could not ${enabled ? 'begin' : 'end'} the background activity:`, error);
		}
	});
	return pending;
}

/** Claim keep-awake for one running job. Pair every call with `releaseKeepAwake`. */
export function acquireKeepAwake(): Promise<void> {
	claims += 1;
	return claims === 1 ? setKeepAwake(true) : pending;
}

/** Release one claim; the activity ends when the last claim is released. */
export function releaseKeepAwake(): Promise<void> {
	if (claims === 0) return pending;
	claims -= 1;
	return claims === 0 ? setKeepAwake(false) : pending;
}

/** Number of jobs currently holding a claim. */
export function keepAwakeClaims(): number {
	return claims;
}

/** Test-only: replace the native call and reset the claim count. */
export function resetKeepAwakeForTests(invoke: KeepAwakeInvoke | null = null): void {
	invokeOverride = invoke;
	claims = 0;
	pending = Promise.resolve();
}

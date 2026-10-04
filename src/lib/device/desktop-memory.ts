/**
 * The desktop app's RAM figures (`system_memory` in src-tauri), kept for
 * synchronous readers: the model-memory advice (`device-memory.ts`) and the
 * "available RAM" line in Settings (`llamacpp-bridge.ts`).
 *
 * Kept apart from device-memory.ts on purpose: that module renders messages
 * and pulls in the whole message catalogue, which the llama bridge has no
 * reason to load.
 */

import { isTauriDesktop } from '$lib/util/platform.js';

export interface DesktopMemory {
	totalBytes: number;
	availBytes: number;
}

let snapshot: DesktopMemory | null = null;

/** The last answer, or null before the first one (and outside the desktop app). */
export function desktopMemorySnapshot(): DesktopMemory | null {
	return snapshot;
}

export type MemoryInvoke = (command: string) => Promise<unknown>;

/**
 * Ask the desktop app for total and available RAM and keep the answer.
 * Called at startup, so the figure is there before Settings opens, and again
 * when Settings wants a fresh "available" figure. Never throws; outside the
 * desktop app it leaves the snapshot alone.
 */
export async function refreshDesktopMemory(invoke?: MemoryInvoke): Promise<DesktopMemory | null> {
	let call = invoke;
	if (!call) {
		if (!isTauriDesktop()) return snapshot;
		call = async (command) => (await import('@tauri-apps/api/core')).invoke(command);
	}
	try {
		const raw = (await call('system_memory')) as { totalBytes?: unknown; availBytes?: unknown } | null;
		const total = raw?.totalBytes;
		if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
			const avail = raw?.availBytes;
			snapshot = {
				totalBytes: total,
				availBytes: typeof avail === 'number' && Number.isFinite(avail) && avail >= 0 ? avail : 0
			};
		}
	} catch (error) {
		console.warn('[device-memory] could not read system memory:', error);
	}
	return snapshot;
}

/** Test-only: forget the snapshot. */
export function resetDesktopMemoryForTests(): void {
	snapshot = null;
}

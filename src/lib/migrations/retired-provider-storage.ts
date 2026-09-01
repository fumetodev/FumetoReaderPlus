import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, remove } from '@tauri-apps/plugin-fs';

import { db } from '$lib/db/index.js';

const CLEANUP_MARKER = 'fumeto-retired-provider-files-cleaned-v1';

/**
 * Delete the old provider-only filesystem download cache after Dexie v12 has
 * finished copying every complete chapter into its durable local VolumeFiles
 * record. Failures remain retryable on the next launch.
 */
export async function cleanupRetiredProviderStorage(): Promise<void> {
	if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

	try {
		// Always open the current schema, even after filesystem cleanup was marked
		// complete. Android can retain localStorage while rebuilding/restoring its
		// IndexedDB files independently, and the v12 migration must still run.
		await db.open();
		if (localStorage.getItem(CLEANUP_MARKER) === '1') return;

		// The committed v12 schema is the safety boundary: the legacy directory is
		// never removed before complete downloaded chapters have been preserved.
		const downloadsDirectory = await join(await appDataDir(), 'downloads');
		if (await exists(downloadsDirectory)) {
			await remove(downloadsDirectory, { recursive: true });
		}
		localStorage.setItem(CLEANUP_MARKER, '1');
	} catch (error) {
		console.warn('Retired provider download cleanup will be retried:', error);
	}
}

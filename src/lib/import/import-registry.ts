/**
 * Which volume UUIDs are being streamed into `volume_pages` right now.
 *
 * An import writes its page rows long before it writes the owning `volumes`
 * record, so for most of an import those rows are indistinguishable from the
 * debris a crashed import leaves behind. `sweepOrphanVolumePages` cannot tell
 * the two apart on its own and used to delete both — silently emptying any
 * volume whose import overlapped the startup sweep. The first-run sample seed
 * lost that race every time (its import starts while the catalog is still
 * settling), but a user import begun in the first seconds after launch could
 * lose its pages the same way.
 *
 * Membership means "someone is writing this uuid right now", which is exactly
 * the condition that makes an ownerless page row live data rather than garbage.
 *
 * This lives apart from `import-service.ts` so the maintenance sweep can ask
 * the question without importing the archive-extraction machinery — and so the
 * two modules cannot form an import cycle.
 */

const volumeImportsInFlight = new Set<string>();

/** Marks an import as started; returns the matching release function. */
export function beginVolumeImport(volumeUuid: string): () => void {
	volumeImportsInFlight.add(volumeUuid);
	return () => volumeImportsInFlight.delete(volumeUuid);
}

/** True while an import is streaming pages for this volume. */
export function isVolumeImportInFlight(volumeUuid: string): boolean {
	return volumeImportsInFlight.has(volumeUuid);
}

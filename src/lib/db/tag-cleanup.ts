/**
 * Clean up orphaned tags after volume deletion.
 *
 * Given the tag names that were on the deleted volumes, check if any
 * remaining volume still uses each tag. If not, delete the tag from db.tags.
 *
 * Must be called AFTER the volume deletion transaction commits so it sees
 * the post-deletion state.
 */
import { db } from './index.js';

export async function cleanupOrphanedTags(deletedVolumeTags: string[]): Promise<void> {
	if (deletedVolumeTags.length === 0) return;

	const uniqueTags = [...new Set(deletedVolumeTags)];

	// Dexie can't query array members, so fetch all remaining volumes
	const allVolumes = await db.volumes.toArray();

	// Build a set of all tags still in use
	const usedTags = new Set<string>();
	for (const vol of allVolumes) {
		if (vol.tags) {
			for (const t of vol.tags) {
				usedTags.add(t);
			}
		}
	}

	const orphaned = uniqueTags.filter((t) => !usedTags.has(t));
	if (orphaned.length > 0) {
		await db.tags.bulkDelete(orphaned);
	}
}

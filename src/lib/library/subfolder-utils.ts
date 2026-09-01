/**
 * Utilities for deriving subfolder structure from library volumes.
 *
 * Given a list of volumes, these functions compute the subfolder tree
 * based on the `folder_path` field stored on each volume.
 */

import type { VolumeMetadata } from '$lib/types/index.js';

/** Normalize a stored relative folder path across desktop and Android separators. */
export function normalizeSubfolderPath(path: string | undefined): string {
	return (path ?? '')
		.replace(/\\/g, '/')
		.replace(/\/{2,}/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

/** Whether a volume belongs directly to a folder or anywhere below it. */
export function isVolumeInSubfolderTree(
	volumeFolderPath: string | undefined,
	folderPath: string,
): boolean {
	const volumePath = normalizeSubfolderPath(volumeFolderPath);
	const targetPath = normalizeSubfolderPath(folderPath);
	return Boolean(
		volumePath
		&& targetPath
		&& (volumePath === targetPath || volumePath.startsWith(`${targetPath}/`)),
	);
}

/**
 * Build a breadcrumb path from a subfolder string.
 *
 * @param subfolder - e.g. "Manga/One Piece/Volume 01"
 * @returns Array of { name, path } entries for breadcrumb display
 *
 * Example: "a/b/c" → [
 *   { name: "a", path: "a" },
 *   { name: "b", path: "a/b" },
 *   { name: "c", path: "a/b/c" }
 * ]
 */
export function buildBreadcrumbs(
	subfolder: string
): Array<{ name: string; path: string }> {
	if (!subfolder) return [];

	const parts = normalizeSubfolderPath(subfolder).split('/').filter(Boolean);
	return parts.map((name, i) => ({
		name,
		path: parts.slice(0, i + 1).join('/')
	}));
}

/**
 * Derive immediate child subfolder names from volumes' folder_path field.
 *
 * Uses the `folder_path` stored on each volume to build the subfolder tree.
 * This mirrors how remote (YACReader) libraries derive their folder hierarchy.
 *
 * @param volumes - All volumes (already filtered to the selected library)
 * @param currentSubfolder - Current subfolder relative to library root ('' = root)
 * @returns Sorted array of immediate child folder names
 */
export function deriveSubfoldersFromVolumes(
	volumes: VolumeMetadata[],
	currentSubfolder: string
): string[] {
	const immediateChildren = new Set<string>();
	const normalizedCurrent = normalizeSubfolderPath(currentSubfolder);

	for (const vol of volumes) {
		const fp = normalizeSubfolderPath(vol.folder_path);
		if (!fp) continue; // Volume at root level — no subfolder

		if (normalizedCurrent) {
			// We're inside a subfolder — find its immediate children
			const prefix = normalizedCurrent + '/';
			if (!fp.startsWith(prefix) && fp !== normalizedCurrent) continue;
			if (fp === normalizedCurrent) continue; // Same folder, not a child

			const remainder = fp.slice(prefix.length);
			if (!remainder) continue;
			const firstPart = remainder.split('/')[0];
			immediateChildren.add(firstPart);
		} else {
			// At root — show top-level folders
			const firstPart = fp.split('/')[0];
			immediateChildren.add(firstPart);
		}
	}

	return [...immediateChildren].sort((a, b) =>
		a.localeCompare(b, undefined, { numeric: true })
	);
}

/**
 * Merge volume-derived subfolder names with filesystem-derived folder names.
 * Produces a de-duplicated, sorted list. This ensures empty folders (no volumes)
 * still appear in the UI after creation.
 */
export function mergeSubfolderSources(
	volumeDerived: string[],
	filesystemDerived: string[]
): string[] {
	const merged = new Set<string>(volumeDerived);
	for (const f of filesystemDerived) {
		merged.add(f);
	}
	return [...merged].sort((a, b) =>
		a.localeCompare(b, undefined, { numeric: true })
	);
}

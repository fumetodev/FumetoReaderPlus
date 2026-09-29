/**
 * File utility functions for organizing archives in the local library.
 *
 * All operations use @tauri-apps/plugin-fs for Android/desktop compatibility.
 */

import { readFile, writeFile, copyFile, rename, mkdir, remove } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { isArchiveExtension } from '$lib/import/types.js';

/**
 * Strip characters that are invalid in filesystem paths.
 * Preserves Unicode letters/numbers, replaces invalid chars with underscore.
 */
export function sanitizePathSegment(name: string): string {
	return name
		.replace(/[/\\:*?"<>|]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		|| 'Unknown';
}

/**
 * Resolve the display name of a file path.
 * On Android, content:// URIs are resolved via the native ContentResolver bridge.
 * On desktop (or if the bridge is unavailable), falls back to last path segment.
 */
export function resolveDisplayName(path: string): string {
	// Use Android native bridge if available (resolves content:// URI display names)
	const bridge = (globalThis as any).__fumeto_android;
	if (bridge?.getDisplayName && path.startsWith('content://')) {
		try {
			const name = bridge.getDisplayName(path);
			if (name && name !== path) return name;
		} catch { /* fall through */ }
	}
	// Fallback: last path segment
	const segment = path.split(/[\\/]/).pop() || 'archive.cbz';
	// A file:// URL (what the iOS document picker returns) percent-encodes it;
	// "My%20Comic.cbz" must not become the copied file's name and title.
	if (path.startsWith('file://')) {
		try {
			return decodeURIComponent(segment) || 'archive.cbz';
		} catch {
			return segment;
		}
	}
	return segment;
}

/**
 * Extract a valid archive filename from a source path.
 * Ensures the filename has a recognized archive extension.
 */
function extractArchiveFilename(sourcePath: string): string {
	const name = resolveDisplayName(sourcePath);
	const ext = name.split('.').pop()?.toLowerCase() || '';
	if (isArchiveExtension(ext)) return name;
	// No valid extension — append .cbz
	return name + '.cbz';
}

/** Create directory (and parents) if it doesn't exist. */
export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/**
 * Build the destination path for a file in the library.
 * Structure: libraryPath / [author] / [series] / filename
 */
async function buildDestPath(
	libraryPath: string,
	filename: string,
	author?: string,
	series?: string,
): Promise<string> {
	let dir = libraryPath;
	if (author) {
		dir = await join(dir, sanitizePathSegment(author));
		if (series) {
			dir = await join(dir, sanitizePathSegment(series));
		}
	}
	await ensureDir(dir);
	return join(dir, filename);
}

/**
 * Copy an archive file from sourcePath to the organized library folder.
 * Returns the destination path.
 *
 * A real path or `file://` URL (desktop, and the iOS document picker) is copied
 * by the Rust side, so the archive never passes through the JS heap — reading
 * it in and writing it back out held a whole volume in memory at least twice,
 * which an iOS WebView does not survive for a large archive. The copy lands on
 * a `.part` name first, which no scan treats as an archive, and is renamed
 * into place only once complete.
 *
 * An Android `content://` URI keeps the read-then-write path: plugin-fs
 * `copyFile` resolves both ends as filesystem paths and cannot open one.
 */
export async function copyFileToLibrary(
	sourcePath: string,
	libraryPath: string,
	author?: string,
	series?: string,
): Promise<string> {
	const filename = extractArchiveFilename(sourcePath);
	const destPath = await buildDestPath(libraryPath, filename, author, series);
	if (isContentUri(sourcePath)) {
		const data = await readFile(sourcePath);
		await writeFile(destPath, data);
		return destPath;
	}
	const partPath = `${destPath}.part`;
	try {
		await copyFile(sourcePath, partPath);
		await rename(partPath, destPath);
	} catch (error) {
		await remove(partPath).catch(() => undefined);
		throw error;
	}
	return destPath;
}

function isContentUri(path: string): boolean {
	return path.startsWith('content://');
}

/**
 * Write raw bytes (e.g. a generated CBZ) to the organized library folder.
 * Returns the destination path.
 */
export async function writeBytesToLibrary(
	data: Uint8Array,
	filename: string,
	libraryPath: string,
	author?: string,
	series?: string,
): Promise<string> {
	const destPath = await buildDestPath(libraryPath, filename, author, series);
	await writeFile(destPath, data);
	return destPath;
}

/**
 * Attempt to delete a file. Returns true on success, false on failure.
 * Never throws — deletion failures are expected on Android (content:// URIs, scoped storage).
 */
export async function tryDeleteFile(path: string): Promise<boolean> {
	try {
		await remove(path);
		return true;
	} catch (e) {
		console.warn('Could not delete file (may be outside app scope):', path, e);
		return false;
	}
}

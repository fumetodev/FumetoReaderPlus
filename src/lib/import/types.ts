/**
 * Import types for Fumeto.
 * Simplified from mokuro-reader's types — no mokuro file pairing needed.
 */

/** Supported image MIME types */
export const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	bmp: 'image/bmp',
	avif: 'image/avif',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	jxl: 'image/jxl'
};

export const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));

/**
 * System files/directories that should be excluded from import.
 * Adapted from mokuro-reader's EXCLUDED_SYSTEM_PATTERNS.
 */
export const EXCLUDED_SYSTEM_PATTERNS = new Set([
	// macOS
	'__MACOSX',
	'.DS_Store',
	'.Trashes',
	'.Spotlight-V100',
	'.fseventsd',
	'.TemporaryItems',
	'.Trash',
	// Windows
	'System Volume Information',
	'$RECYCLE.BIN',
	'Thumbs.db',
	'desktop.ini',
	'Desktop.ini',
	'RECYCLER',
	'RECYCLED',
	// Linux
	'.Trash-1000',
	'.thumbnails',
	'.directory',
	// Cloud storage / VCS
	'.dropbox',
	'.dropbox.cache',
	'.git',
	'.svn'
]);

const EXCLUDED_EXTENSIONS = new Set(['bak', 'tmp', 'temp']);

/**
 * Check if a path contains system files/directories that should be excluded.
 * Adapted from mokuro-reader's isSystemFile.
 */
export function isSystemFile(path: string): boolean {
	const normalizedPath = path.replace(/\\/g, '/');
	const segments = normalizedPath.split('/');

	for (const segment of segments) {
		if (!segment) continue;
		if (segment.startsWith('._')) return true;
		if (segment.endsWith('~')) return true;
		if (EXCLUDED_SYSTEM_PATTERNS.has(segment)) return true;
	}

	const filename = segments[segments.length - 1] || '';
	const lastDot = filename.lastIndexOf('.');
	if (lastDot >= 0) {
		const ext = filename.slice(lastDot + 1).toLowerCase();
		if (EXCLUDED_EXTENSIONS.has(ext)) return true;
	}

	return false;
}

/** Check if an extension is a supported image format */
export function isImageExtension(ext: string): boolean {
	return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** Get MIME type for an image extension */
export function getImageMimeType(ext: string): string {
	return IMAGE_MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Supported video page MIME types — pages that play (muted, looping) instead
 * of painting. Video entries are accepted only inside zip/cbz archives; the
 * RAR/PDF/EPUB extractors stay image-only.
 */
export const VIDEO_MIME_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm'
};

export const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_MIME_TYPES));

/** Check if an extension is a supported video page format */
export function isVideoExtension(ext: string): boolean {
	return VIDEO_EXTENSIONS.has(ext.toLowerCase());
}

/** Image OR video — everything that can be a page inside a zip/cbz. */
export function isPageMediaExtension(ext: string): boolean {
	return isImageExtension(ext) || isVideoExtension(ext);
}

/** MIME type for any page-media extension (image map, then video map). */
export function getPageMediaMimeType(ext: string): string {
	const lower = ext.toLowerCase();
	return IMAGE_MIME_TYPES[lower] ?? VIDEO_MIME_TYPES[lower] ?? 'application/octet-stream';
}

/**
 * THE shared video-page predicate: a stored page is a video iff its persisted
 * filename (volume_pages / page_dimensions) carries a video extension.
 * Remote page sources synthesize `page_N.jpg` names, so remote pages are
 * never video by construction — every reader/translation/export seam keys on
 * this one function rather than re-deriving the rule.
 */
export function isVideoPageFilename(filename: string): boolean {
	const basename = filename.split('/').pop() ?? filename;
	const dot = basename.lastIndexOf('.');
	if (dot < 0) return false;
	return isVideoExtension(basename.slice(dot + 1));
}

/** Reverse map for honest export naming from a stored Blob's MIME type. */
export function extensionForPageMediaMime(mime: string): string | undefined {
	if (mime === 'video/mp4') return 'mp4';
	if (mime === 'video/webm') return 'webm';
	for (const [ext, imageMime] of Object.entries(IMAGE_MIME_TYPES)) {
		if (imageMime === mime) return ext;
	}
	return undefined;
}

/** Supported archive extensions for detection */
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'cbz', 'cbr', 'rar', 'pdf', 'epub']);

/** Check if extension is an archive */
export function isArchiveExtension(ext: string): boolean {
	return ARCHIVE_EXTENSIONS.has(ext.toLowerCase());
}

/** Detect archive type from file extension */
export function getArchiveType(filename: string): 'zip' | 'rar' | 'pdf' | 'epub' | null {
	const ext = filename.split('.').pop()?.toLowerCase() || '';
	if (ext === 'zip' || ext === 'cbz') return 'zip';
	if (ext === 'rar' || ext === 'cbr') return 'rar';
	if (ext === 'pdf') return 'pdf';
	if (ext === 'epub') return 'epub';
	return null;
}

/**
 * Komga REST API response types.
 *
 * These types represent the JSON shapes returned by the Komga server API (v1).
 * They are separate from Fumeto's internal types to keep concerns isolated.
 */

/** A library available on the Komga server */
export interface KomgaLibrary {
	id: string;
	name: string;
}

/** A series as returned by the Komga server */
export interface KomgaSeries {
	id: string;
	libraryId: string;
	name: string;
	booksCount: number;
	booksReadCount: number;
	booksUnreadCount: number;
	booksInProgressCount: number;
	metadata: KomgaSeriesMetadata;
	deleted: boolean;
	oneshot: boolean;
}

export interface KomgaSeriesMetadata {
	title: string;
	titleSort: string;
	status: string;
	readingDirection: string;
	summary: string;
	publisher: string;
	ageRating: number | null;
	language: string;
	genres: string[];
	tags: string[];
}

/** A book (volume) as returned by the Komga server */
export interface KomgaBook {
	id: string;
	seriesId: string;
	seriesTitle: string;
	libraryId: string;
	name: string;
	number: number;
	sizeBytes: number;
	size: string;
	media: KomgaMediaDto;
	metadata: KomgaBookMetadata;
	readProgress: KomgaReadProgress | null;
	deleted: boolean;
}

/**
 * Deliberately narrower than Komga's MediaDto — nothing in the app filters on
 * media type, and that is load-bearing: image-only (Divina-compatible) EPUB
 * books are served by Komga through the same /books/{id}/pages/{n} API as CBZ
 * and flow through sync + reader untouched (verified 2026-08-05: sync ingests
 * every series/book with no media predicate; page count comes from
 * media.pagesCount; the pages/thumbnail endpoints are container-agnostic).
 * Add `mediaProfile` here only if the app ever needs to DISTINGUISH reflowable
 * EPUBs (pagesCount 0) from page-image books — e.g. to route them to a book
 * reader instead of syncing them as empty volumes.
 */
export interface KomgaMediaDto {
	status: string;
	mediaType: string;
	pagesCount: number;
	comment: string;
}

export interface KomgaBookMetadata {
	title: string;
	summary: string;
	number: string;
	numberSort: number;
	releaseDate: string | null;
	authors: KomgaAuthor[];
	tags: string[];
}

export interface KomgaAuthor {
	name: string;
	role: string;
}

export interface KomgaReadProgress {
	page: number;
	completed: boolean;
	readDate: string;
}

/** Page metadata from Komga */
export interface KomgaPage {
	number: number;
	fileName: string;
	mediaType: string;
	width: number | null;
	height: number | null;
	sizeBytes: number | null;
}

/** Spring-style paginated response wrapper */
export interface KomgaPagedResponse<T> {
	content: T[];
	totalPages: number;
	totalElements: number;
	last: boolean;
	first: boolean;
	size: number;
	number: number;
	empty: boolean;
}

/** Error types from the Komga server */
export type KomgaServerErrorType =
	| 'connection_failed'
	| 'auth_failed'
	| 'not_found'
	| 'server_error'
	| 'timeout'
	| 'invalid_response';

export class KomgaServerError extends Error {
	type: KomgaServerErrorType;
	statusCode?: number;

	constructor(type: KomgaServerErrorType, message: string, statusCode?: number) {
		super(message);
		this.name = 'KomgaServerError';
		this.type = type;
		this.statusCode = statusCode;
	}
}

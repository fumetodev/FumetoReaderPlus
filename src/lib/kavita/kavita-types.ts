/**
 * Kavita REST API response types.
 *
 * These types represent the JSON shapes returned by the Kavita server API.
 * They are separate from Fumeto's internal types to keep concerns isolated.
 *
 * Key differences from Komga: all IDs are numeric (not strings), authentication
 * is JWT-based (API key → token exchange), and the content hierarchy is deeper
 * (Library → Series → Volume → Chapter).
 */

/** A library available on the Kavita server */
export interface KavitaLibraryDto {
	id: number;
	name: string;
	type: number;
}

/** A series as returned by the Kavita server */
export interface KavitaSeriesDto {
	id: number;
	name: string;
	localizedName: string;
	sortName: string;
	pages: number;
	libraryId: number;
	pagesRead: number;
}

/** A volume within a series */
export interface KavitaVolumeDto {
	id: number;
	minNumber: number;
	maxNumber: number;
	name: string;
	pages: number;
	seriesId: number;
	chapters: KavitaChapterDto[];
}

/** A chapter within a volume — this is the reading unit in Kavita */
export interface KavitaChapterDto {
	id: number;
	number: string;
	range: string;
	title: string;
	pages: number;
	volumeId: number;
	isSpecial: boolean;
}

/** Chapter info from /api/reader/chapter-info */
export interface KavitaChapterInfo {
	chapterNumber: string;
	chapterTitle: string;
	volumeNumber: string;
	seriesName: string;
	libraryName: string;
	pages: number;
}

/** Error types from the Kavita server */
export type KavitaServerErrorType =
	| 'connection_failed'
	| 'auth_failed'
	| 'not_found'
	| 'server_error'
	| 'timeout'
	| 'invalid_response';

export class KavitaServerError extends Error {
	type: KavitaServerErrorType;
	statusCode?: number;

	constructor(type: KavitaServerErrorType, message: string, statusCode?: number) {
		super(message);
		this.name = 'KavitaServerError';
		this.type = type;
		this.statusCode = statusCode;
	}
}

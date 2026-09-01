/**
 * YACReader Library Server V2 API response types.
 *
 * These types represent the raw JSON shapes returned by the YACReader server.
 * They are separate from Fumeto's internal types to keep concerns isolated.
 */

/** A library available on the YACReader server */
export interface YACLibrary {
	id: number;
	name: string;
	uuid: string;
}

/** A comic as returned by the YACReader server */
export interface YACComic {
	type: 'comic';
	id: string;
	comic_info_id?: string;
	parent_id: string;
	library_id: string;
	library_uuid?: string;
	file_name: string;
	file_size: string;
	hash: string;
	path?: string;
	current_page: number;
	num_pages: number;
	read: boolean;
	manga: boolean;
	file_type?: number;
	cover_size_ratio?: number;
	number?: number;
	cover_page?: number;
	title?: string;
	universal_number?: string;
	last_time_opened?: number;
	has_been_opened?: boolean;
	added?: number;
	// Extended metadata (from fullinfo endpoint)
	volume?: string;
	total_volume_count?: number;
	genre?: string;
	date?: string;
	synopsis?: string;
	writer?: string;
	publisher?: string;
	series?: string;
	rating?: number;
}

/** A folder as returned by the YACReader server */
export interface YACFolder {
	type: 'folder';
	id: string;
	library_id: string;
	library_uuid?: string;
	folder_name: string;
	num_children: number;
	first_comic_hash?: string;
	finished?: boolean;
	completed?: boolean;
	/** Server-relative custom cover path; empty string means no custom image. */
	custom_image?: string;
	file_type?: number;
	added?: number;
	updated?: number;
	parent_id?: string;
	path?: string;
}

/** A folder content item — either a folder or a comic */
export type YACFolderContentItem = YACFolder | YACComic;

/** Search results use the same discriminated folder/comic union as folder browsing. */
export type YACSearchResult = YACFolderContentItem;

/** Feature-detected result from requesting a server-side library rescan. */
export type YACLibraryUpdateResult =
	| { supported: false; status: 'unsupported' }
	| { supported: true; status: 'started' | 'already_running' | 'update_not_allowed'; running: boolean };

/** Feature-detected server-side rescan status. */
export type YACLibraryUpdateStatusResult =
	| { supported: false; status: 'unsupported' }
	| { supported: true; status: 'idle' | 'running'; running: boolean };

/** A tag/label from the YACReader server */
export interface YACTag {
	type: 'tag';
	id: string;
	library_id: string;
	library_uuid?: string;
	label_name: string;
	color_id?: number;
}

/** A reading list from the YACReader server */
export interface YACReadingList {
	type: 'reading_list';
	id: string;
	library_id: string;
	library_uuid?: string;
	reading_list_name: string;
}

/** Error types from the YACReader server */
export type YACServerErrorType =
	| 'connection_failed'
	| 'not_found'
	| 'page_loading'
	| 'no_session'
	| 'server_error'
	| 'timeout'
	| 'cancelled'
	| 'invalid_response';

export class YACServerError extends Error {
	type: YACServerErrorType;
	statusCode?: number;

	constructor(type: YACServerErrorType, message: string, statusCode?: number) {
		super(message);
		this.name = 'YACServerError';
		this.type = type;
		this.statusCode = statusCode;
	}
}

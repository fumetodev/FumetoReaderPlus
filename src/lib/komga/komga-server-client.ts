/**
 * HTTP client for the Komga REST API (v1).
 *
 * Uses @tauri-apps/plugin-http for HTTP requests, which routes through the
 * Rust backend and bypasses webview CSP/CORS restrictions (same approach as
 * the YACReader client).
 *
 * Every request includes HTTP Basic Auth. Unlike YACReader, Komga pages are
 * served directly (no archive extraction step), so there's no 412 retry logic.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
	KomgaServerError,
	type KomgaLibrary,
	type KomgaSeries,
	type KomgaBook,
	type KomgaPagedResponse
} from './komga-types.js';

/** Max retry attempts for general requests */
const MAX_RETRIES = 3;

/** Request timeout in ms */
const REQUEST_TIMEOUT = 30000;

export class KomgaServerClient {
	private baseUrl: string;
	private authHeader: string;

	constructor(baseUrl: string, username: string, password: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.authHeader = 'Basic ' + btoa(`${username}:${password}`);
	}

	/** Get the base URL this client connects to */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	// ================================================================
	// Public API Methods
	// ================================================================

	/** Test if the server is reachable and credentials are valid */
	async testConnection(): Promise<boolean> {
		try {
			await this.fetchLibraries();
			return true;
		} catch {
			return false;
		}
	}

	/** GET /api/v1/libraries */
	async fetchLibraries(): Promise<KomgaLibrary[]> {
		return this.getJSON<KomgaLibrary[]>('/api/v1/libraries');
	}

	/**
	 * GET /api/v1/series — paginated.
	 * Returns a single page of series for a library.
	 */
	async fetchSeries(
		libraryId: string,
		page = 0,
		size = 500
	): Promise<KomgaPagedResponse<KomgaSeries>> {
		return this.getJSON<KomgaPagedResponse<KomgaSeries>>(
			`/api/v1/series?library_id=${encodeURIComponent(libraryId)}&page=${page}&size=${size}&sort=metadata.titleSort,asc`
		);
	}

	/**
	 * Fetch ALL series in a library (handles pagination automatically).
	 * Uses a large page size and loops until `last === true`.
	 */
	async fetchAllSeries(libraryId: string): Promise<KomgaSeries[]> {
		const all: KomgaSeries[] = [];
		let page = 0;
		const size = 500;
		let done = false;

		while (!done) {
			const resp = await this.fetchSeries(libraryId, page, size);
			all.push(...resp.content);
			done = resp.last;
			page++;
		}

		return all;
	}

	/**
	 * GET /api/v1/series/{seriesId}/books — paginated.
	 * Returns a single page of books in a series.
	 */
	async fetchBooks(
		seriesId: string,
		page = 0,
		size = 500
	): Promise<KomgaPagedResponse<KomgaBook>> {
		return this.getJSON<KomgaPagedResponse<KomgaBook>>(
			`/api/v1/series/${encodeURIComponent(seriesId)}/books?page=${page}&size=${size}&sort=metadata.numberSort,asc`
		);
	}

	/**
	 * Fetch ALL books in a series (handles pagination automatically).
	 */
	async fetchAllBooks(seriesId: string): Promise<KomgaBook[]> {
		const all: KomgaBook[] = [];
		let page = 0;
		const size = 500;
		let done = false;

		while (!done) {
			const resp = await this.fetchBooks(seriesId, page, size);
			all.push(...resp.content);
			done = resp.last;
			page++;
		}

		return all;
	}

	/** GET /api/v1/books/{bookId} */
	async fetchBook(bookId: string): Promise<KomgaBook> {
		return this.getJSON<KomgaBook>(`/api/v1/books/${encodeURIComponent(bookId)}`);
	}

	/**
	 * GET /api/v1/series/{seriesId}/thumbnail
	 * Fetches a series thumbnail as a Blob (JPEG).
	 */
	async fetchSeriesThumbnail(seriesId: string): Promise<Blob> {
		const data = await this.performRequest(
			`${this.baseUrl}/api/v1/series/${encodeURIComponent(seriesId)}/thumbnail`
		);
		return new Blob([data], { type: 'image/jpeg' });
	}

	/**
	 * GET /api/v1/books/{bookId}/thumbnail
	 * Fetches a book thumbnail as a Blob (JPEG).
	 */
	async fetchBookThumbnail(bookId: string, signal?: AbortSignal): Promise<Blob> {
		const data = await this.performRequest(
			`${this.baseUrl}/api/v1/books/${encodeURIComponent(bookId)}/thumbnail`,
			{ signal }
		);
		return new Blob([data], { type: 'image/jpeg' });
	}

	/**
	 * GET /api/v1/books/{bookId}/pages/{pageNumber}
	 * Fetches a single page image as a Blob.
	 * Note: Komga uses 1-indexed page numbers.
	 */
	async fetchPage(bookId: string, pageNumber: number, signal?: AbortSignal): Promise<Blob> {
		const data = await this.performRequest(
			`${this.baseUrl}/api/v1/books/${encodeURIComponent(bookId)}/pages/${pageNumber}`,
			{ signal }
		);
		return new Blob([data], { type: 'image/jpeg' });
	}

	/** Construct a series thumbnail URL without fetching */
	getSeriesThumbnailUrl(seriesId: string): string {
		return `${this.baseUrl}/api/v1/series/${encodeURIComponent(seriesId)}/thumbnail`;
	}

	/** Construct a book thumbnail URL without fetching */
	getBookThumbnailUrl(bookId: string): string {
		return `${this.baseUrl}/api/v1/books/${encodeURIComponent(bookId)}/thumbnail`;
	}

	/**
	 * PATCH /api/v1/books/{bookId}/read-progress
	 * Update reading progress on the Komga server.
	 */
	async updateReadProgress(bookId: string, page: number): Promise<void> {
		const url = `${this.baseUrl}/api/v1/books/${encodeURIComponent(bookId)}/read-progress`;
		const response = await tauriFetch(url, {
			method: 'PATCH',
			headers: {
				Authorization: this.authHeader,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ page }),
			connectTimeout: REQUEST_TIMEOUT
		});

		if (!response.ok) {
			throw new KomgaServerError(
				'server_error',
				`Update read progress failed: ${response.status}`,
				response.status
			);
		}
	}

	// ================================================================
	// Internal Request Helpers
	// ================================================================

	/** GET JSON from a path */
	private async getJSON<T>(path: string): Promise<T> {
		const data = await this.performRequest(`${this.baseUrl}${path}`);
		const text = new TextDecoder().decode(data);
		return JSON.parse(text) as T;
	}

	/**
	 * Perform an HTTP GET request with retry logic.
	 * Uses Tauri's HTTP plugin which routes through the Rust backend.
	 *
	 * @param url - Full URL to request
	 * @param options.signal - AbortSignal for cancellation
	 * @returns Response body as ArrayBuffer
	 */
	private async performRequest(
		url: string,
		options?: { signal?: AbortSignal }
	): Promise<ArrayBuffer> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (options?.signal?.aborted) {
				throw new KomgaServerError('timeout', 'Request was cancelled');
			}

			try {
				const response = await tauriFetch(url, {
					method: 'GET',
					headers: {
						Authorization: this.authHeader
					},
					connectTimeout: REQUEST_TIMEOUT,
					// The signal reached the retry loop's aborted check but never
					// the request itself, so a cancelled fetch still ran to
					// completion and only stopped between attempts.
					signal: options?.signal
				});

				if (response.ok) {
					return await response.arrayBuffer();
				}

				switch (response.status) {
					case 401:
						throw new KomgaServerError(
							'auth_failed',
							'Authentication failed — check username and password',
							401
						);

					case 403:
						throw new KomgaServerError(
							'auth_failed',
							'Forbidden — insufficient permissions',
							403
						);

					case 404:
						throw new KomgaServerError('not_found', `Not found: ${url}`, 404);

					default:
						throw new KomgaServerError(
							'server_error',
							`Server error ${response.status}: ${response.statusText}`,
							response.status
						);
				}
			} catch (err) {
				if (err instanceof KomgaServerError) {
					// Don't retry known server errors (auth, not-found, etc.)
					throw err;
				}

				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < MAX_RETRIES - 1) {
					// Exponential backoff: 500ms, 1s, 1.5s, ...
					const delay = Math.min(500 * (attempt + 1), 3000);
					console.warn(
						`[KomgaServerClient] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}. Retrying in ${delay}ms...`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw new KomgaServerError(
			'connection_failed',
			`Connection failed after ${MAX_RETRIES} attempts: ${lastError?.message || 'Unknown error'}`
		);
	}
}

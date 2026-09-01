/**
 * HTTP client for the Kavita REST API.
 *
 * Uses @tauri-apps/plugin-http for HTTP requests, which routes through the
 * Rust backend and bypasses webview CSP/CORS restrictions (same approach as
 * the Komga and YACReader clients).
 *
 * Authentication: Kavita uses JWT-based auth. The user provides an API key,
 * which is exchanged for a JWT via POST /api/Plugin/authenticate. That endpoint
 * binds BOTH parameters from the query string (?apiKey=&pluginName=) and
 * ignores any request body — a JSON body earns a 400 before the key is ever
 * checked (verified against a live server). The JWT is cached and refreshed on
 * 401 responses.
 *
 * Image endpoints (/api/reader/image, /api/image/*-cover) additionally require
 * the raw apiKey as a query parameter even when a Bearer token is sent — they
 * are designed for <img src> use, where headers cannot be set.
 *
 * Pages are 0-indexed in Kavita (unlike Komga which uses 1-indexed).
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
	KavitaServerError,
	type KavitaLibraryDto,
	type KavitaSeriesDto,
	type KavitaVolumeDto,
	type KavitaChapterInfo
} from './kavita-types.js';

/** Max retry attempts for general requests */
const MAX_RETRIES = 3;

/** Request timeout in ms */
const REQUEST_TIMEOUT = 30000;

/** Reported to the server at authentication; shows up in Kavita's device list. */
const PLUGIN_NAME = 'FumetoReaderPlus';

/**
 * SeriesFilterV2Dto enum values, from Kavita's source. Only the three this
 * client needs: the filter statement `field 19 (Libraries) comparison 0
 * (Equal)` scopes the series list to one library.
 */
const FILTER_COMPARISON_EQUAL = 0;
const FILTER_FIELD_LIBRARIES = 19;
const FILTER_COMBINATION_AND = 1;

export class KavitaServerClient {
	private baseUrl: string;
	private apiKey: string;
	private jwtToken: string | null = null;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.apiKey = apiKey;
	}

	/** Get the base URL this client connects to */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	// ================================================================
	// Authentication
	// ================================================================

	/**
	 * Exchange the API key for a JWT token via POST /api/Plugin/authenticate.
	 * Caches the token for subsequent requests.
	 *
	 * Both parameters travel in the query string and the request has no body:
	 * Kavita binds them with [FromQuery] semantics, so a JSON body is ignored
	 * and rejected with 400 "The apiKey field is required" — which used to make
	 * every connection attempt fail before the key was even looked at.
	 */
	private async authenticate(): Promise<string> {
		try {
			const query = `apiKey=${encodeURIComponent(this.apiKey)}&pluginName=${encodeURIComponent(PLUGIN_NAME)}`;
			const response = await tauriFetch(`${this.baseUrl}/api/Plugin/authenticate?${query}`, {
				method: 'POST',
				connectTimeout: REQUEST_TIMEOUT
			});

			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					throw new KavitaServerError(
						'auth_failed',
						'Authentication failed — check your API key',
						response.status
					);
				}
				throw new KavitaServerError(
					'server_error',
					`Authentication failed: ${response.status} ${response.statusText}`,
					response.status
				);
			}

			const data = await response.json();
			// Kavita returns { token: "...", ... } from the authenticate endpoint
			const token = data.token;
			if (!token) {
				throw new KavitaServerError(
					'invalid_response',
					'Authentication response did not contain a token'
				);
			}

			this.jwtToken = token;
			return token;
		} catch (err) {
			if (err instanceof KavitaServerError) throw err;
			throw new KavitaServerError(
				'connection_failed',
				`Failed to connect to Kavita server: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/** Ensure we have a valid JWT token, authenticating if needed */
	private async ensureAuthenticated(): Promise<string> {
		if (this.jwtToken) return this.jwtToken;
		return this.authenticate();
	}

	// ================================================================
	// Public API Methods
	// ================================================================

	/** Test if the server is reachable and API key is valid */
	async testConnection(): Promise<boolean> {
		try {
			await this.authenticate();
			await this.fetchLibraries();
			return true;
		} catch {
			return false;
		}
	}

	/** GET /api/library/libraries — fetch all accessible libraries */
	async fetchLibraries(): Promise<KavitaLibraryDto[]> {
		return this.getJSON<KavitaLibraryDto[]>('/api/library/libraries');
	}

	/**
	 * POST /api/series/v2 — fetch all series in a library.
	 *
	 * Pagination goes in the query (PageSize=0 means "no limit" server-side);
	 * the body is a SeriesFilterV2Dto whose one statement scopes the result to
	 * the requested library. The older `POST /api/series` route this client
	 * used first does not exist on current servers (404).
	 */
	async fetchAllSeries(libraryId: number): Promise<KavitaSeriesDto[]> {
		const url = `${this.baseUrl}/api/series/v2?PageNumber=1&PageSize=0`;

		const body = {
			statements: [{
				comparison: FILTER_COMPARISON_EQUAL,
				field: FILTER_FIELD_LIBRARIES,
				value: String(libraryId)
			}],
			combination: FILTER_COMBINATION_AND,
			limitTo: 0
		};

		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				// Resolved inside the loop so a 401-triggered re-auth actually
				// changes the token the retry sends.
				const token = await this.ensureAuthenticated();
				const response = await tauriFetch(url, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(body),
					connectTimeout: REQUEST_TIMEOUT
				});

				if (response.status === 401) {
					// Token expired — re-authenticate and retry
					this.jwtToken = null;
					continue;
				}

				if (!response.ok) {
					throw new KavitaServerError(
						'server_error',
						`Failed to fetch series: ${response.status}`,
						response.status
					);
				}

				return await response.json() as KavitaSeriesDto[];
			} catch (err) {
				if (err instanceof KavitaServerError) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < MAX_RETRIES - 1) {
					const delay = Math.min(500 * (attempt + 1), 3000);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw new KavitaServerError(
			'connection_failed',
			`Failed to fetch series after ${MAX_RETRIES} attempts: ${lastError?.message || 'Unknown error'}`
		);
	}

	/** GET /api/Series/volumes?seriesId={id} — fetch volumes (with chapters) in a series */
	async fetchVolumes(seriesId: number): Promise<KavitaVolumeDto[]> {
		return this.getJSON<KavitaVolumeDto[]>(`/api/Series/volumes?seriesId=${seriesId}`);
	}

	/** GET /api/reader/chapter-info?chapterId={id} — fetch chapter page count + metadata */
	async fetchChapterInfo(chapterId: number): Promise<KavitaChapterInfo> {
		return this.getJSON<KavitaChapterInfo>(`/api/reader/chapter-info?chapterId=${chapterId}`);
	}

	/** The apiKey query parameter Kavita's image endpoints demand (see header). */
	private imageKeyParam(): string {
		return `apiKey=${encodeURIComponent(this.apiKey)}`;
	}

	/**
	 * GET /api/reader/image?chapterId={id}&page={n}&apiKey={key}
	 * Fetches a single page image as a Blob. Pages are 0-indexed in Kavita.
	 */
	async fetchPage(chapterId: number, pageIndex: number, signal?: AbortSignal): Promise<Blob> {
		return this.fetchImage(
			`${this.baseUrl}/api/reader/image?chapterId=${chapterId}&page=${pageIndex}&${this.imageKeyParam()}`,
			{ signal }
		);
	}

	/**
	 * GET /api/image/series-cover?seriesId={id}&apiKey={key}
	 * Fetches a series cover as a Blob.
	 */
	async fetchSeriesCover(seriesId: number): Promise<Blob> {
		return this.fetchImage(
			`${this.baseUrl}/api/image/series-cover?seriesId=${seriesId}&${this.imageKeyParam()}`
		);
	}

	/**
	 * GET /api/image/chapter-cover?chapterId={id}&apiKey={key}
	 * Fetches a chapter cover as a Blob.
	 */
	async fetchChapterCover(chapterId: number, signal?: AbortSignal): Promise<Blob> {
		return this.fetchImage(
			`${this.baseUrl}/api/image/chapter-cover?chapterId=${chapterId}&${this.imageKeyParam()}`,
			{ signal }
		);
	}

	/** Covers are not always JPEG (PNG observed live) — trust the response type. */
	private async fetchImage(url: string, options?: { signal?: AbortSignal }): Promise<Blob> {
		const { data, contentType } = await this.performRequestWithType(url, options);
		return new Blob([data], { type: contentType ?? 'image/jpeg' });
	}

	/**
	 * POST /api/reader/progress
	 * Update reading progress on the Kavita server.
	 */
	async updateReadProgress(
		libraryId: number,
		seriesId: number,
		volumeId: number,
		chapterId: number,
		pageNum: number
	): Promise<void> {
		const token = await this.ensureAuthenticated();
		const url = `${this.baseUrl}/api/reader/progress`;

		const response = await tauriFetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				libraryId,
				seriesId,
				volumeId,
				chapterId,
				pageNum
			}),
			connectTimeout: REQUEST_TIMEOUT
		});

		if (response.status === 401) {
			// Re-authenticate and retry once
			this.jwtToken = null;
			await this.authenticate();
			const retryResponse = await tauriFetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.jwtToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ libraryId, seriesId, volumeId, chapterId, pageNum }),
				connectTimeout: REQUEST_TIMEOUT
			});
			if (!retryResponse.ok) {
				throw new KavitaServerError(
					'server_error',
					`Update read progress failed: ${retryResponse.status}`,
					retryResponse.status
				);
			}
			return;
		}

		if (!response.ok) {
			throw new KavitaServerError(
				'server_error',
				`Update read progress failed: ${response.status}`,
				response.status
			);
		}
	}

	// ================================================================
	// Internal Request Helpers
	// ================================================================

	/** GET JSON from a path with JWT auth */
	private async getJSON<T>(path: string): Promise<T> {
		const { data } = await this.performRequestWithType(`${this.baseUrl}${path}`);
		const text = new TextDecoder().decode(data);
		return JSON.parse(text) as T;
	}

	/**
	 * Perform an HTTP GET request with JWT auth and retry logic.
	 * Handles automatic re-authentication on 401 responses.
	 */
	private async performRequestWithType(
		url: string,
		options?: { signal?: AbortSignal }
	): Promise<{ data: ArrayBuffer; contentType: string | null }> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (options?.signal?.aborted) {
				throw new KavitaServerError('timeout', 'Request was cancelled');
			}

			try {
				const token = await this.ensureAuthenticated();
				const response = await tauriFetch(url, {
					method: 'GET',
					headers: {
						Authorization: `Bearer ${token}`
					},
					connectTimeout: REQUEST_TIMEOUT,
					// The signal reached the retry loop's aborted check but never
					// the request itself, so a cancelled fetch still ran to
					// completion and only stopped between attempts.
					signal: options?.signal
				});

				if (response.ok) {
					return {
						data: await response.arrayBuffer(),
						contentType: response.headers.get('content-type')
					};
				}

				switch (response.status) {
					case 401: {
						// JWT expired — re-authenticate and retry
						this.jwtToken = null;
						if (attempt < MAX_RETRIES - 1) continue;
						throw new KavitaServerError(
							'auth_failed',
							'Authentication failed — check your API key',
							401
						);
					}

					case 403:
						throw new KavitaServerError(
							'auth_failed',
							'Forbidden — insufficient permissions',
							403
						);

					case 404:
						throw new KavitaServerError('not_found', `Not found: ${url}`, 404);

					default:
						throw new KavitaServerError(
							'server_error',
							`Server error ${response.status}: ${response.statusText}`,
							response.status
						);
				}
			} catch (err) {
				if (err instanceof KavitaServerError) {
					// Don't retry known server errors (auth, not-found, etc.)
					if (err.type !== 'auth_failed' || attempt >= MAX_RETRIES - 1) {
						throw err;
					}
					// For auth failures, we already cleared the token above
					continue;
				}

				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < MAX_RETRIES - 1) {
					const delay = Math.min(500 * (attempt + 1), 3000);
					console.warn(
						`[KavitaServerClient] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}. Retrying in ${delay}ms...`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw new KavitaServerError(
			'connection_failed',
			`Connection failed after ${MAX_RETRIES} attempts: ${lastError?.message || 'Unknown error'}`
		);
	}
}

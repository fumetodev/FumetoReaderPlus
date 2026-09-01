/**
 * HTTP client for the YACReader Library Server V2 API.
 *
 * Uses @tauri-apps/plugin-http for HTTP requests, which routes through the
 * Rust backend and bypasses webview CSP/CORS restrictions. This is necessary
 * because Tauri's webview CSP blocks fetch() to arbitrary LAN addresses.
 *
 * Based on the protocol from YACServerReaderMac reference implementation.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { randomUUID } from '$lib/util/uuid.js';
import {
	YACServerError,
	type YACLibrary,
	type YACComic,
	type YACFolder,
	type YACFolderContentItem,
	type YACSearchResult,
	type YACLibraryUpdateResult,
	type YACLibraryUpdateStatusResult,
	type YACTag,
	type YACReadingList
} from './yac-types.js';
import {
	appWorkCoordinator,
	type WorkCoordinator,
	type WorkPriority
} from '$lib/work-coordination/work-coordinator.js';

/** Max retry attempts for general requests */
const MAX_RETRIES = 3;

/** Max retry attempts for page requests (server may be extracting the archive) */
const MAX_PAGE_RETRIES = 20;

/** Delay between 412 retries in ms */
const PAGE_RETRY_DELAY = 1000;

/** Request timeout in ms */
const REQUEST_TIMEOUT = 30000;

function cancelledRequestError(): YACServerError {
	// 'cancelled', not 'timeout': consumers treat timeouts as retryable server
	// trouble, while a cancellation (viewport exit, navigation) must not write
	// retry backoff or surface as an error at all.
	return new YACServerError('cancelled', 'Request was cancelled');
}

function delayWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
	if (signal.aborted) return Promise.reject(cancelledRequestError());

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			reject(cancelledRequestError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

export class YACServerClient {
	private baseUrl: string;
	private sessionToken: string;

	/**
	 * Shared request scheduler — ensures only one HTTP request is in flight at a time.
	 * YACReader Library Server is single-threaded Qt and crashes on concurrent connections.
	 *
	 * Session-scoped clients created with createSessionClient() deliberately share
	 * this scheduler while using a distinct x-request-id. YACReader keeps only one
	 * remotely-opened comic per request ID, so sharing a token between readers makes
	 * opening one comic invalidate every other reader.
	 */
	private scheduler: { coordinator: WorkCoordinator; lane: string };

	constructor(
		baseUrl: string,
		scheduler?: { coordinator: WorkCoordinator; lane: string },
		sessionToken?: string
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.sessionToken = sessionToken ?? randomUUID();
		this.scheduler = scheduler ?? {
			coordinator: appWorkCoordinator,
			lane: `yac:${this.baseUrl.toLowerCase()}`
		};
	}

	/**
	 * Create an isolated YACReader session while preserving per-server transport
	 * serialization. Each RemotePageSource must use its own session because the
	 * server associates a single current remote comic with each x-request-id.
	 */
	createSessionClient(sessionToken?: string): YACServerClient {
		return new YACServerClient(this.baseUrl, this.scheduler, sessionToken);
	}

	/** Get the base URL this client connects to */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/** Get the session token (for debugging) */
	getSessionToken(): string {
		return this.sessionToken;
	}

	// ================================================================
	// Public API Methods
	// ================================================================

	/** Test if the server is reachable */
	async testConnection(): Promise<boolean> {
		try {
			await this.fetchLibraries();
			return true;
		} catch {
			return false;
		}
	}

	/** GET /v2/libraries */
	async fetchLibraries(): Promise<YACLibrary[]> {
		return this.getJSON<YACLibrary[]>('/v2/libraries', { kind: 'libraries', priority: 1 });
	}

	/** GET /v2/library/{id}/folder/{folderId}/content */
	async fetchFolderContent(
		libraryId: number,
		folderId: string,
		options: { signal?: AbortSignal; priority?: WorkPriority; owner?: string } = {}
	): Promise<YACFolderContentItem[]> {
		const raw = await this.getJSON<YACFolderContentItem[]>(
			`/v2/library/${libraryId}/folder/${folderId}/content`,
			{
				kind: 'folder-content',
				priority: options.priority ?? 1,
				signal: options.signal,
				owner: options.owner
			}
		);
		return raw;
	}

	/**
	 * Feature-detected recursive folder inventory. It is an integrity signal
	 * only: callers keep /content as the folder-association authority.
	 */
	fetchFolderInfo(libraryId: number, folderId: string, signal?: AbortSignal): Promise<YACFolderContentItem[] | undefined> {
		return this.enqueueResponse(async (taskSignal) => {
			const response = await tauriFetch(
				`${this.baseUrl}/v2/library/${libraryId}/folder/${encodeURIComponent(folderId)}/info`,
				{ method: 'GET', headers: { 'x-request-id': this.sessionToken, Accept: 'application/json' }, signal: taskSignal },
			);
			if (response.status === 404 || response.status === 405) return undefined;
			if (!response.ok) {
				throw new YACServerError('server_error', `Folder info failed: ${response.status}`, response.status);
			}
			const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
			if (contentType.includes('application/json')) {
				const data = await response.json() as unknown;
				const items = Array.isArray(data)
					? data
					: (data && typeof data === 'object'
						? ((data as { comics?: unknown; content?: unknown }).comics
							?? (data as { content?: unknown }).content)
						: undefined);
				if (!Array.isArray(items)) throw new YACServerError('invalid_response', 'Folder info omitted its recursive comic list');
				return items as YACFolderContentItem[];
			}

			// YACReader Library v10 serves this route as one plain-text record per
			// comic: /v2/library/{library}/comic/{id}:<metadata>. The integrity
			// check only needs stable IDs; /content remains hierarchy authority.
			const text = await response.text();
			const comicIds = new Set<string>();
			for (const line of text.split(/\r?\n/)) {
				if (!line) continue;
				const match = /^\/v2\/library\/[^/]+\/comic\/([^:/\r\n]+):/.exec(line);
				if (match) comicIds.add(match[1]);
			}
			if (text.trim() && comicIds.size === 0) {
				throw new YACServerError('invalid_response', 'Folder info used an unrecognized text format');
			}
			return [...comicIds].map((id): YACComic => ({
				type: 'comic', id, parent_id: folderId, library_id: String(libraryId),
				file_name: '', file_size: '0', hash: '', current_page: 0,
				num_pages: 0, read: false, manga: false
			}));
		}, {
			kind: 'folder-integrity', owner: 'yac-index', priority: 3, signal,
			coalescingKey: `folder-info:${libraryId}:${folderId}`,
		});
	}

	/** GET /v2/library/{id}/comic/{comicId}/fullinfo */
	async fetchComic(libraryId: number, comicId: string): Promise<YACComic> {
		return this.getJSON<YACComic>(`/v2/library/${libraryId}/comic/${comicId}/fullinfo`, {
			kind: 'comic-metadata', priority: 1
		});
	}

	/**
	 * GET /v2/library/{id}/comic/{comicId}/remote
	 * Tells the server to prepare a comic for remote reading (extract archive).
	 * Must be called before fetching individual pages.
	 */
	async openComic(libraryId: number, comicId: string, signal?: AbortSignal): Promise<void> {
		await this.performRequest(
			`${this.baseUrl}/v2/library/${libraryId}/comic/${comicId}/remote`,
			{ signal, kind: 'open-reader-comic', priority: 0 }
		);
		// Wait 500ms for server to begin extraction
		await delayWithSignal(500, signal);
	}

	/**
	 * GET /v2/library/{id}/comic/{comicId}/page/{pageNum}/remote
	 * Fetches a single page image as a Blob (JPEG).
	 * Retries up to 20 times on HTTP 412 (server still extracting).
	 */
	async fetchPage(
		libraryId: number,
		comicId: string,
		pageNum: number,
		signal?: AbortSignal
	): Promise<Blob> {
		const url = `${this.baseUrl}/v2/library/${libraryId}/comic/${comicId}/page/${pageNum}/remote`;
		const data = await this.performRequest(url, {
			retryOn412: true,
			signal,
			kind: 'reader-page',
			priority: 0
		});
		return new Blob([data], { type: 'image/jpeg' });
	}

	/**
	 * GET /v2/library/{id}/cover/{hash}.jpg
	 * Fetches a cover thumbnail as a Blob.
	 */
	async fetchCover(libraryId: number, hash: string, signal?: AbortSignal): Promise<Blob> {
		return this.fetchCoverPath(libraryId, `${hash}.jpg`, signal);
	}

	/**
	 * Fetch a cover by its server-relative cover path. Folder custom images are
	 * paths (and may contain directory separators), unlike comic hash covers.
	 */
	async fetchCoverPath(libraryId: number, coverPath: string, signal?: AbortSignal): Promise<Blob> {
		const safePath = coverPath
			.split('/')
			.filter((part) => part.length > 0 && part !== '.' && part !== '..')
			.map((part) => encodeURIComponent(part))
			.join('/');
		if (!safePath) {
			throw new YACServerError('invalid_response', 'Invalid empty cover path');
		}
		const url = `${this.baseUrl}/v2/library/${libraryId}/cover/${safePath}`;
		return this.performBlobRequest(url, {
			kind: 'visible-cover',
			// P2, not P1: covers must never outrank navigation. A folder browse
			// used to queue behind 30-60 already-enqueued same-priority cover
			// fetches on this single-connection lane; aging still floors a
			// waiting cover back to P1 after ~2s, so visible art is not starved.
			priority: 2,
			signal,
			coalescingKey: `cover:${libraryId}:${safePath}`
		});
	}

	/** Construct cover URL without fetching */
	getCoverUrl(libraryId: number, hash: string): string {
		return `${this.baseUrl}/v2/library/${libraryId}/cover/${encodeURIComponent(hash)}.jpg`;
	}

	/** POST /v2/library/{id}/search */
	search(libraryId: number, query: string, signal?: AbortSignal): Promise<YACSearchResult[]> {
		return this.enqueueResponse(async (taskSignal) => {
			const url = `${this.baseUrl}/v2/library/${libraryId}/search`;
			const response = await tauriFetch(url, {
				method: 'POST',
				headers: {
					'x-request-id': this.sessionToken,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ query }),
				signal: taskSignal
			});

			if (!response.ok) {
				throw new YACServerError('server_error', `Search failed: ${response.status}`, response.status);
			}

			return response.json();
		}, { kind: 'search', owner: 'catalog', priority: 1, signal });
	}

	/**
	 * POST /v2/library/{id}/update. Older servers do not expose this endpoint;
	 * a 404 is therefore a capability result rather than a transport failure.
	 */
	requestLibraryUpdate(libraryId: number, signal?: AbortSignal): Promise<YACLibraryUpdateResult> {
		return this.enqueueResponse(async (taskSignal) => {
			const response = await tauriFetch(`${this.baseUrl}/v2/library/${libraryId}/update`, {
				method: 'POST',
				headers: {
					'x-request-id': this.sessionToken,
					'Accept': 'application/json'
				},
				signal: taskSignal
			});

			if (response.status === 404) return { supported: false, status: 'unsupported' };
			if (response.status !== 202 && response.status !== 409) {
				throw new YACServerError(
					'server_error',
					`Library update request failed: ${response.status}`,
					response.status
				);
			}

			const data = await response.json() as { status?: string; running?: boolean };
			if (response.status === 202) {
				return { supported: true, status: 'started', running: data.running ?? true };
			}
			if (data.status === 'update_not_allowed') {
				return { supported: true, status: 'update_not_allowed', running: data.running ?? false };
			}
			return { supported: true, status: 'already_running', running: data.running ?? true };
		}, {
			kind: 'library-update', owner: 'yac-index', priority: 2, signal,
			coalescingKey: `library-update:${libraryId}`
		});
	}

	/** GET /v2/libraries/update/status with explicit old-server detection. */
	getLibraryUpdateStatus(signal?: AbortSignal): Promise<YACLibraryUpdateStatusResult> {
		return this.enqueueResponse(async (taskSignal) => {
			const response = await tauriFetch(`${this.baseUrl}/v2/libraries/update/status`, {
				method: 'GET',
				headers: {
					'x-request-id': this.sessionToken,
					'Accept': 'application/json'
				},
				signal: taskSignal
			});

			if (response.status === 404) return { supported: false, status: 'unsupported' };
			if (!response.ok) {
				throw new YACServerError(
					'server_error',
					`Library update status failed: ${response.status}`,
					response.status
				);
			}

			const data = await response.json() as { running?: boolean };
			if (typeof data.running !== 'boolean') {
				throw new YACServerError('invalid_response', 'Library update status omitted running');
			}
			return {
				supported: true,
				status: data.running ? 'running' : 'idle',
				running: data.running
			};
		}, {
			kind: 'library-update-status', owner: 'yac-index', priority: 2, signal,
			coalescingKey: 'library-update-status'
		});
	}

	/** GET /v2/library/{id}/tags */
	async fetchTags(libraryId: number): Promise<YACTag[]> {
		return this.getJSON<YACTag[]>(`/v2/library/${libraryId}/tags`, { kind: 'tags', priority: 2 });
	}

	/** GET /v2/library/{id}/reading_lists */
	async fetchReadingLists(libraryId: number): Promise<YACReadingList[]> {
		return this.getJSON<YACReadingList[]>(`/v2/library/${libraryId}/reading_lists`, { kind: 'reading-lists', priority: 2 });
	}

	/** GET /v2/library/{id}/favs */
	async fetchFavorites(libraryId: number): Promise<YACComic[]> {
		return this.getJSON<YACComic[]>(`/v2/library/${libraryId}/favs`, { kind: 'favorites', priority: 2 });
	}

	/** GET /v2/library/{id}/reading */
	async fetchCurrentlyReading(libraryId: number): Promise<YACComic[]> {
		return this.getJSON<YACComic[]>(`/v2/library/${libraryId}/reading`, { kind: 'currently-reading', priority: 2 });
	}

	/**
	 * POST /v2/library/{id}/comic/{comicId}/update
	 * Update reading progress on the server.
	 *
	 * YACReader's v10 controller treats a third newline-delimited field as image
	 * filter metadata and indexes its tab-delimited value without validating it.
	 * A progress-only payload must therefore contain exactly the first field and
	 * no trailing newlines. The server stores pages as 1-based values.
	 */
	updateProgress(
		libraryId: number,
		comicId: string,
		currentPage: number
	): Promise<void> {
		return this.enqueueResponse(async (taskSignal) => {
			if (!Number.isSafeInteger(libraryId) || libraryId < 1) {
				throw new YACServerError('invalid_response', 'Invalid YACReader library ID');
			}
			if (!/^\d+$/.test(comicId)) {
				throw new YACServerError('invalid_response', 'Invalid YACReader comic ID');
			}
			if (!Number.isSafeInteger(currentPage) || currentPage < 0) {
				throw new YACServerError('invalid_response', 'Invalid YACReader page index');
			}

			const url = `${this.baseUrl}/v2/library/${libraryId}/comic/${comicId}/update`;
			const body = `currentPage:${currentPage + 1}`;

			const response = await tauriFetch(url, {
				method: 'POST',
				headers: {
					'x-request-id': this.sessionToken,
					'Content-Type': 'text/plain; charset=utf-8',
					'Accept': 'text/plain'
				},
				body,
				connectTimeout: REQUEST_TIMEOUT,
				signal: taskSignal
			});

			// v10 uses 412 specifically for an empty/missing comic-info body, so it
			// is a failed write and must not be reported as success.
			if (!response.ok) {
				throw new YACServerError('server_error', `Update progress failed: ${response.status}`, response.status);
			}
		}, {
			kind: 'reader-progress', owner: 'reader', priority: 0,
			coalescingKey: `progress:${libraryId}:${comicId}:${currentPage}`
		});
	}

	// ================================================================
	// Internal Request Helpers
	// ================================================================

	/** GET JSON from a path */
	private async getJSON<T>(
		path: string,
		options: { kind: string; priority: WorkPriority; signal?: AbortSignal; owner?: string }
	): Promise<T> {
		const data = await this.performRequest(`${this.baseUrl}${path}`, options);
		const text = new TextDecoder().decode(data);
		return JSON.parse(text) as T;
	}

	/**
	 * Perform an HTTP GET request with retry logic.
	 * Uses Tauri's HTTP plugin which routes through the Rust backend.
	 *
	 * @param url - Full URL to request
	 * @param options.retryOn412 - If true, retry up to 20 times on 412 status (page loading)
	 * @param options.signal - AbortSignal for cancellation (checked between retries)
	 * @returns Response body as ArrayBuffer
	 */
	private performRequest(
		url: string,
		options: {
			retryOn412?: boolean;
			signal?: AbortSignal;
			kind: string;
			priority: WorkPriority;
			coalescingKey?: string;
			owner?: string;
		}
	): Promise<ArrayBuffer> {
		return this._doRequest(url, options);
	}

	private async _doRequest(
		url: string,
		options: {
			retryOn412?: boolean;
			signal?: AbortSignal;
			kind: string;
			priority: WorkPriority;
			coalescingKey?: string;
			owner?: string;
		}
	): Promise<ArrayBuffer> {
		const maxAttempts = options?.retryOn412 ? MAX_PAGE_RETRIES : MAX_RETRIES;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (options?.signal?.aborted) {
				throw cancelledRequestError();
			}

			try {
				// Only the HTTP attempt occupies the serialized server lane. Extraction
				// and network retry delays below intentionally run after it is released.
				const response = await this.enqueueResponse(async (taskSignal) => {
					const raw = await tauriFetch(url, {
						method: 'GET',
						headers: { 'x-request-id': this.sessionToken },
						connectTimeout: REQUEST_TIMEOUT,
						signal: taskSignal
					});
					return {
						ok: raw.ok,
						status: raw.status,
						statusText: raw.statusText,
						data: raw.ok ? await raw.arrayBuffer() : undefined
					};
				}, {
					kind: options.kind,
					owner: options.owner ?? (options.priority === 0 ? 'reader' : options.priority === 1 ? 'catalog' : 'yac-index'),
					priority: options.priority,
					signal: options.signal,
					coalescingKey: options.coalescingKey
				});

				if (response.ok) {
					return response.data!;
				}

				switch (response.status) {
					case 412:
						if (options?.retryOn412 && attempt < maxAttempts - 1) {
							console.log(
								`[YACServerClient] Page loading (412), attempt ${attempt + 1}/${maxAttempts}`
							);
							await delayWithSignal(PAGE_RETRY_DELAY, options?.signal);
							continue;
						}
						throw new YACServerError('page_loading', 'Page still loading after max retries', 412);

					case 404:
						throw new YACServerError('not_found', `Not found: ${url}`, 404);

					case 424:
						throw new YACServerError('no_session', 'No valid session', 424);

					default:
						throw new YACServerError(
							'server_error',
							`Server error ${response.status}: ${response.statusText}`,
							response.status
						);
				}
			} catch (err) {
				if (err instanceof YACServerError) {
					// Don't retry known server errors (except 412 handled above)
					throw err;
				}
				if (options?.signal?.aborted) throw cancelledRequestError();

				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < maxAttempts - 1) {
					// Exponential backoff: 500ms, 1s, 1.5s, ...
					const delay = Math.min(500 * (attempt + 1), 3000);
					console.warn(
						`[YACServerClient] Request failed (attempt ${attempt + 1}/${maxAttempts}): ${lastError.message}. Retrying in ${delay}ms...`
					);
					await delayWithSignal(delay, options?.signal);
				}
			}
		}

		throw new YACServerError(
			'connection_failed',
			`Connection failed after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`
		);
	}

	private async performBlobRequest(
		url: string,
		options: { kind: string; priority: WorkPriority; signal?: AbortSignal; coalescingKey?: string }
	): Promise<Blob> {
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
			if (options.signal?.aborted) throw cancelledRequestError();
			try {
				const result = await this.enqueueResponse(async (taskSignal) => {
					const response = await tauriFetch(url, {
						method: 'GET',
						headers: { 'x-request-id': this.sessionToken },
						connectTimeout: REQUEST_TIMEOUT,
						signal: taskSignal
					});
					return { status: response.status, statusText: response.statusText, blob: response.ok ? await response.blob() : undefined };
				}, {
					kind: options.kind, owner: 'catalog', priority: options.priority,
					signal: options.signal, coalescingKey: options.coalescingKey
				});
				if (result.blob) return result.blob;
				if (result.status === 404) throw new YACServerError('not_found', `Not found: ${url}`, 404);
				throw new YACServerError('server_error', `Server error ${result.status}: ${result.statusText}`, result.status);
			} catch (error) {
				if (error instanceof YACServerError) throw error;
				if (options.signal?.aborted) throw cancelledRequestError();
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < MAX_RETRIES - 1) await delayWithSignal(Math.min(500 * (attempt + 1), 3_000), options.signal);
			}
		}
		throw new YACServerError('connection_failed', `Connection failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? 'Unknown error'}`);
	}

	private enqueueResponse<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		options: {
			kind: string;
			owner: string;
			priority: WorkPriority;
			signal?: AbortSignal;
			coalescingKey?: string;
		}
	): Promise<T> {
		return this.scheduler.coordinator.submit({
			...options,
			lane: this.scheduler.lane,
			operation: ({ signal }) => operation(signal)
		}).promise;
	}
}

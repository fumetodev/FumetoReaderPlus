/**
 * Streaming file download for the desktop shell.
 *
 * The on-device translation models are 460 MB to 1.1 GB. Collecting a whole
 * response in JavaScript before one write is an allocation of that size in
 * the web process, which is exactly what gets a WebKit page killed. Chunks
 * go from the HTTP plugin's response stream straight to a file handle from
 * the fs plugin, so the page's memory stays flat for the length of the
 * transfer.
 *
 * The bytes land in `<dest>.part` and are renamed into place only after the
 * last one, so an interrupted download is never mistaken for a finished
 * model by the size check on the next launch. Failure and cancellation both
 * close the handle and remove the partial file. A cancellation always
 * rejects with an AbortError whose message says "abort": callers key on that
 * word to report "idle" rather than a failure, and the HTTP plugin's own
 * mid-stream error text ("Request cancelled") does not contain it.
 *
 * Android never reaches this module; its downloads run in Kotlin.
 */

import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { open, remove, rename, type FileHandle } from '@tauri-apps/plugin-fs';

export interface DesktopDownloadOptions {
	onProgress?: (downloadedBytes: number, totalBytes: number) => void;
	signal?: AbortSignal;
}

export interface DesktopDownloadResult {
	bytes: number;
	ms: number;
}

/** Progress is reported when the byte count crosses another multiple of this. */
export const PROGRESS_STEP_BYTES = 1024 * 1024;

/** The temporary name a transfer writes to until it is complete. */
export function partialPathFor(destPath: string): string {
	return `${destPath}.part`;
}

/** True when `downloaded` has crossed a progress boundary `previous` had not. */
export function crossedProgressStep(
	previous: number,
	downloaded: number,
	step = PROGRESS_STEP_BYTES
): boolean {
	return Math.floor(downloaded / step) > Math.floor(previous / step);
}

/** Parses a Content-Length header; 0 when absent or not a byte count. */
export function contentLengthOf(header: string | null): number {
	const parsed = Number.parseInt(header ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function abortError(): Error {
	return new DOMException('Download aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/**
 * Writes every byte of `chunk`. The fs plugin's `write` is one `write(2)`
 * call underneath and may return short, so loop on the remainder.
 */
async function writeFully(file: FileHandle, chunk: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const written = await file.write(offset === 0 ? chunk : chunk.subarray(offset));
		if (written <= 0) throw new Error('Download failed: the file write made no progress');
		offset += written;
	}
}

/**
 * Downloads `url` to `destPath`, streaming to disk. Resolves with the byte
 * count and elapsed time; rejects with an AbortError on cancellation and
 * with the transport or filesystem error otherwise. In every failure case
 * nothing is left at `destPath` or `destPath.part`.
 */
export async function downloadToFileDesktop(
	url: string,
	destPath: string,
	options: DesktopDownloadOptions = {}
): Promise<DesktopDownloadResult> {
	const { onProgress, signal } = options;
	const partialPath = partialPathFor(destPath);
	const started = performance.now();
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let file: FileHandle | null = null;
	let partialWritten = false;

	try {
		throwIfAborted(signal);
		// Model hosts answer with a redirect to a CDN; follow a few.
		const response = await httpFetch(url, { method: 'GET', signal, maxRedirections: 5 });
		if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
		const totalBytes = contentLengthOf(response.headers.get('content-length'));
		if (!response.body) throw new Error('Download failed: the response carried no body');
		reader = response.body.getReader();

		file = await open(partialPath, { write: true, create: true, truncate: true });
		partialWritten = true;
		let downloaded = 0;
		let reported = 0;
		for (;;) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			await writeFully(file, value);
			downloaded += value.byteLength;
			if (crossedProgressStep(reported, downloaded)) {
				reported = downloaded;
				onProgress?.(downloaded, totalBytes);
			}
		}
		await file.close();
		file = null;
		throwIfAborted(signal);
		await rename(partialPath, destPath);
		partialWritten = false;
		onProgress?.(downloaded, totalBytes || downloaded);
		return { bytes: downloaded, ms: performance.now() - started };
	} catch (error) {
		if (reader) await reader.cancel().catch(() => undefined);
		if (file) await file.close().catch(() => undefined);
		if (partialWritten) await remove(partialPath).catch(() => undefined);
		throw signal?.aborted ? abortError() : error;
	}
}

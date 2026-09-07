/**
 * Streaming file download for the desktop shell.
 *
 * The on-device translation models are 460 MB to 1.1 GB. Collecting a whole
 * response in JavaScript before one write is an allocation of that size in
 * the web process, which is exactly what gets a WebKit page killed — and the
 * HTTP plugin's response stream turned out to hold several copies of the
 * body in that process as well. The transfer therefore runs in the shell
 * (`download_to_file`): chunks go from the socket straight to the file, only
 * progress reports cross into the page, and its memory stays flat for the
 * length of the transfer.
 *
 * The bytes land in `<dest>.part` and are renamed into place only after the
 * last one, so an interrupted download is never mistaken for a finished
 * model by the size check on the next launch. Failure and cancellation both
 * close the handle and remove the partial file. A cancellation always
 * rejects with an AbortError whose message says "abort": callers key on that
 * word to report "idle" rather than a failure.
 *
 * Android never reaches this module; its downloads run in Kotlin.
 */

import { Channel, invoke } from '@tauri-apps/api/core';

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

let lastDownloadId = 0;

/** Distinct per transfer so a cancel reaches the right one. */
function nextDownloadId(): number {
	lastDownloadId += 1;
	return lastDownloadId;
}

function abortError(): Error {
	return new DOMException('Download aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
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
	throwIfAborted(signal);
	const started = performance.now();
	const id = nextDownloadId();
	const progress = new Channel<{ downloadedBytes: number; totalBytes: number }>();
	progress.onmessage = (report) => {
		onProgress?.(report.downloadedBytes, report.totalBytes);
	};
	const cancel = () => {
		void invoke('download_cancel', { id }).catch(() => undefined);
	};
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		const bytes = await invoke<number>('download_to_file', { id, url, destPath, onProgress: progress });
		return { bytes, ms: performance.now() - started };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (signal?.aborted || /abort/i.test(message)) throw abortError();
		throw new Error(message);
	} finally {
		signal?.removeEventListener('abort', cancel);
	}
}

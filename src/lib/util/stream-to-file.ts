/**
 * Write a download to disk as it arrives, in bounded memory.
 *
 * The desktop/iOS download paths used to collect every chunk and then copy them
 * into one buffer before a single `writeFile` — twice the file's size in the JS
 * heap, about 2.3 GB for a 1.13 GB model. A desktop process survives that
 * badly; an iOS WebView content process is killed long before it. Android never
 * had the problem because Kotlin streams its downloads.
 *
 * Chunks are gathered into batches and each batch is appended with plugin-fs
 * `writeFile`, which ships its bytes as a raw IPC body. (`FileHandle.write`
 * would serialize every byte as a JSON number.) The bytes land in
 * `<dest>.part` and are renamed onto `dest` only once the stream completed, so
 * an interrupted transfer never looks like a finished file — and never
 * clobbers a previous good copy at `dest`.
 */

/** Batches this large keep IPC round trips few and peak memory small. */
export const DEFAULT_STREAM_FLUSH_BYTES = 4 * 1024 * 1024;

export interface StreamToFilePorts {
	writeFile(path: string, data: Uint8Array, options: { append: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface StreamToFileOptions {
	/** Called with the running total of bytes received. */
	onProgress?: (receivedBytes: number) => void;
	/** Buffered bytes that trigger an append. */
	flushBytes?: number;
}

export function partialPathFor(destPath: string): string {
	return `${destPath}.part`;
}

async function tauriStreamPorts(): Promise<StreamToFilePorts> {
	const fs = await import('@tauri-apps/plugin-fs');
	return {
		writeFile: (path, data, options) => fs.writeFile(path, data, { append: options.append }),
		rename: (from, to) => fs.rename(from, to),
		remove: (path) => fs.remove(path)
	};
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Stream `body` into `destPath`. Resolves with the number of bytes written.
 * On any failure — including an aborted request — the partial file is removed
 * and the error is rethrown unchanged, so callers can still recognise an abort.
 */
export async function streamToFile(
	body: ReadableStream<Uint8Array>,
	destPath: string,
	options: StreamToFileOptions = {},
	ports?: StreamToFilePorts
): Promise<number> {
	const fs = ports ?? (await tauriStreamPorts());
	const flushBytes = Math.max(1, options.flushBytes ?? DEFAULT_STREAM_FLUSH_BYTES);
	const partPath = partialPathFor(destPath);
	const reader = body.getReader();

	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let receivedBytes = 0;
	let created = false;

	const flush = async () => {
		// The first write always happens, even for an empty body: it creates (or
		// truncates a stale leftover of) the part file the rename expects.
		if (created && pendingBytes === 0) return;
		const batch = concatChunks(pending, pendingBytes);
		pending = [];
		pendingBytes = 0;
		await fs.writeFile(partPath, batch, { append: created });
		created = true;
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			pending.push(value);
			pendingBytes += value.byteLength;
			receivedBytes += value.byteLength;
			options.onProgress?.(receivedBytes);
			if (pendingBytes >= flushBytes) await flush();
		}
		await flush();
		await fs.rename(partPath, destPath);
		return receivedBytes;
	} catch (error) {
		pending = [];
		await reader.cancel(error).catch(() => undefined);
		await fs.remove(partPath).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Fix 3 at its call sites: the non-Android model download streams to disk,
 * and a library import is copied by the Rust side instead of through the heap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const fs = vi.hoisted(() => ({
	writeFile: vi.fn(async (_path: string, _data: Uint8Array, _options?: unknown) => undefined),
	readFile: vi.fn(async (_path: string) => new Uint8Array(4)),
	copyFile: vi.fn(async (_from: string, _to: string) => undefined),
	rename: vi.fn(async (_from: string, _to: string) => undefined),
	remove: vi.fn(async (_path: string) => undefined),
	mkdir: vi.fn(async () => undefined)
}));
const http = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('@tauri-apps/plugin-http', () => http);
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('$lib/settings/settings.js', () => ({
	settings: { subscribe: () => () => undefined },
	ON_DEVICE_TEMPERATURE_DEFAULT: 0.15
}));

// Node's global navigator reports no mobile OS, so these modules take the
// desktop branch — the same one an iPhone or iPad would take for the
// streamed model download (anything not Android).
const { downloadModelFile, ggufDownloadProgress } = await import('$lib/translation/llamacpp-bridge.js');
const { copyFileToLibrary, resolveDisplayName } = await import('$lib/util/file-utils.js');

beforeEach(() => {
	for (const mock of Object.values(fs)) mock.mockClear();
	http.fetch.mockReset();
});

function responseOf(chunks: Uint8Array[], total: number) {
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		}
	});
	return new Response(body, { status: 200, headers: { 'content-length': String(total) } });
}

describe('downloadModelFile (non-Android)', () => {
	it('streams to <dest>.part in bounded batches and renames on completion', async () => {
		const chunkBytes = 256 * 1024;
		const count = 64; // 16 MB
		const chunks = Array.from({ length: count }, (_, i) => new Uint8Array(chunkBytes).fill(i));
		http.fetch.mockResolvedValue(responseOf(chunks, chunkBytes * count));

		await downloadModelFile('https://example.test/model.gguf', '/models/Manga.gguf');

		const writes = fs.writeFile.mock.calls;
		expect(writes.length).toBeGreaterThan(1);
		expect(writes.every(([path]) => path === '/models/Manga.gguf.part')).toBe(true);
		const largest = Math.max(...writes.map(([, data]) => data.byteLength));
		// Before: one write holding the whole file (16 MB here, 1.13 GB for a real model).
		expect(largest).toBeLessThanOrEqual(4 * 1024 * 1024 + chunkBytes);
		expect(writes.reduce((sum, [, data]) => sum + data.byteLength, 0)).toBe(chunkBytes * count);
		expect(fs.rename).toHaveBeenCalledWith('/models/Manga.gguf.part', '/models/Manga.gguf');
		expect(get(ggufDownloadProgress).status).toBe('completed');
	});

	it('leaves any previous model alone and reports an error when the transfer fails', async () => {
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(new Uint8Array(5 * 1024 * 1024));
				} else {
					controller.error(new Error('connection reset'));
				}
			}
		});
		http.fetch.mockResolvedValue(new Response(body, { status: 200 }));

		await expect(downloadModelFile('https://example.test/model.gguf', '/models/Manga.gguf')).rejects.toThrow('connection reset');
		expect(fs.rename).not.toHaveBeenCalled();
		expect(fs.remove).toHaveBeenCalledWith('/models/Manga.gguf.part');
		expect(get(ggufDownloadProgress)).toMatchObject({ status: 'error', error: 'connection reset' });
	});

	it('writes nothing for an HTTP error', async () => {
		http.fetch.mockResolvedValue(new Response('nope', { status: 404 }));
		await expect(downloadModelFile('https://example.test/model.gguf', '/models/Manga.gguf')).rejects.toThrow('HTTP 404');
		expect(fs.writeFile).not.toHaveBeenCalled();
	});
});

describe('copyFileToLibrary', () => {
	it('copies a real path on the Rust side, via a part file', async () => {
		const dest = await copyFileToLibrary('/Users/me/Downloads/Vol 1.cbz', '/lib/Comics', 'Author', 'Series');
		expect(dest).toBe('/lib/Comics/Author/Series/Vol 1.cbz');
		expect(fs.copyFile).toHaveBeenCalledWith('/Users/me/Downloads/Vol 1.cbz', `${dest}.part`);
		expect(fs.rename).toHaveBeenCalledWith(`${dest}.part`, dest);
		// Before: readFile + writeFile, the whole archive through the JS heap.
		expect(fs.readFile).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();
	});

	it('names an iOS picker file:// URL by its decoded filename', async () => {
		const source = 'file:///private/var/mobile/Containers/Data/Application/ABC/tmp/com.fumeto.reader-Inbox/My%20Comic%20%231.cbz';
		expect(resolveDisplayName(source)).toBe('My Comic #1.cbz');
		const dest = await copyFileToLibrary(source, '/lib/Comics');
		expect(dest).toBe('/lib/Comics/My Comic #1.cbz');
		expect(fs.copyFile).toHaveBeenCalledWith(source, `${dest}.part`);
	});

	it('keeps the read/write path for an Android content:// URI, which copyFile cannot open', async () => {
		const dest = await copyFileToLibrary('content://com.android.providers.downloads.documents/document/42', '/lib/Comics');
		expect(fs.readFile).toHaveBeenCalledWith('content://com.android.providers.downloads.documents/document/42');
		expect(fs.writeFile).toHaveBeenCalledWith(dest, expect.any(Uint8Array));
		expect(fs.copyFile).not.toHaveBeenCalled();
	});

	it('cleans up the part file and rethrows when the copy fails', async () => {
		fs.copyFile.mockRejectedValueOnce(new Error('No space left on device'));
		await expect(copyFileToLibrary('/Users/me/Vol 2.cbz', '/lib/Comics')).rejects.toThrow('No space left on device');
		expect(fs.rename).not.toHaveBeenCalled();
		expect(fs.remove).toHaveBeenCalledWith('/lib/Comics/Vol 2.cbz.part');
	});

	it('leaves plain paths with percent signs alone', () => {
		expect(resolveDisplayName('/Users/me/100%25 Real.cbz')).toBe('100%25 Real.cbz');
	});
});

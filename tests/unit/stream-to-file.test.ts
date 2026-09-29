import { describe, expect, it } from 'vitest';
import { partialPathFor, streamToFile, type StreamToFilePorts } from '$lib/util/stream-to-file.js';

/** A filesystem that also records the size of every write it was handed. */
function memoryFs(initial: Record<string, Uint8Array> = {}) {
	const files = new Map<string, Uint8Array>(Object.entries(initial));
	const writes: Array<{ path: string; bytes: number; append: boolean }> = [];
	const ports: StreamToFilePorts = {
		async writeFile(path, data, { append }) {
			writes.push({ path, bytes: data.byteLength, append });
			const previous = append ? (files.get(path) ?? new Uint8Array()) : new Uint8Array();
			const next = new Uint8Array(previous.byteLength + data.byteLength);
			next.set(previous, 0);
			next.set(data, previous.byteLength);
			files.set(path, next);
		},
		async rename(from, to) {
			const file = files.get(from);
			if (!file) throw new Error(`missing ${from}`);
			files.delete(from);
			files.set(to, file);
		},
		async remove(path) {
			if (!files.delete(path)) throw new Error(`missing ${path}`);
		}
	};
	return { files, writes, ports };
}

function chunk(size: number, fill: number): Uint8Array {
	return new Uint8Array(size).fill(fill);
}

function streamOf(chunks: Uint8Array[], failAfter?: { index: number; error: Error }): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (failAfter && index === failAfter.index) {
				controller.error(failAfter.error);
				return;
			}
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[index++]);
		}
	});
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

describe('streamToFile', () => {
	it('writes the exact bytes to the destination and leaves no part file', async () => {
		const chunks = Array.from({ length: 10 }, (_, i) => chunk(300 + i, i + 1));
		const { files, ports } = memoryFs();
		const written = await streamToFile(streamOf(chunks), '/models/m.gguf', { flushBytes: 1000 }, ports);
		expect(written).toBe(concat(chunks).byteLength);
		expect(files.get('/models/m.gguf')).toEqual(concat(chunks));
		expect(files.has(partialPathFor('/models/m.gguf'))).toBe(false);
	});

	it('never buffers much more than one batch: memory is bounded, not the file size', async () => {
		const flushBytes = 64 * 1024;
		const chunkBytes = 16 * 1024;
		const chunks = Array.from({ length: 200 }, (_, i) => chunk(chunkBytes, i % 251)); // 3.2 MB
		const { writes, ports } = memoryFs();
		await streamToFile(streamOf(chunks), '/models/m.gguf', { flushBytes }, ports);
		expect(writes.length).toBeGreaterThan(40);
		expect(Math.max(...writes.map((w) => w.bytes))).toBeLessThanOrEqual(flushBytes + chunkBytes);
		// First write creates/truncates the part file; every later one appends.
		expect(writes[0]).toMatchObject({ path: '/models/m.gguf.part', append: false });
		expect(writes.slice(1).every((w) => w.append && w.path === '/models/m.gguf.part')).toBe(true);
	});

	it('reports a running byte total', async () => {
		const progress: number[] = [];
		const { ports } = memoryFs();
		await streamToFile(streamOf([chunk(10, 1), chunk(5, 2), chunk(7, 3)]), '/d', { onProgress: (n) => progress.push(n) }, ports);
		expect(progress).toEqual([10, 15, 22]);
	});

	it('creates an empty file for an empty body', async () => {
		const { files, ports } = memoryFs();
		expect(await streamToFile(streamOf([]), '/d', {}, ports)).toBe(0);
		expect(files.get('/d')).toEqual(new Uint8Array());
	});

	it('truncates a part file left behind by an earlier crash', async () => {
		const { files, ports } = memoryFs({ '/d.part': chunk(50, 9) });
		await streamToFile(streamOf([chunk(3, 1)]), '/d', {}, ports);
		expect(files.get('/d')).toEqual(chunk(3, 1));
	});

	it('on a failed transfer removes the part file, keeps the previous good copy and rethrows the same error', async () => {
		const previous = chunk(8, 7);
		const { files, ports } = memoryFs({ '/models/m.gguf': previous });
		const failure = new Error('connection reset');
		await expect(
			streamToFile(
				streamOf([chunk(1000, 1), chunk(1000, 2), chunk(1000, 3)], { index: 2, error: failure }),
				'/models/m.gguf',
				{ flushBytes: 500 },
				ports
			)
		).rejects.toBe(failure);
		expect(files.get('/models/m.gguf')).toBe(previous);
		expect(files.has('/models/m.gguf.part')).toBe(false);
	});

	it('propagates an abort unchanged so callers can tell it from a failure', async () => {
		const { files, ports } = memoryFs();
		const abort = new DOMException('The operation was aborted.', 'AbortError');
		await expect(
			streamToFile(streamOf([chunk(10, 1)], { index: 1, error: abort }), '/d', { flushBytes: 1 }, ports)
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(files.size).toBe(0);
	});

	it('removes the part file when the disk write itself fails', async () => {
		const { files, ports } = memoryFs();
		let calls = 0;
		const failing: StreamToFilePorts = {
			...ports,
			async writeFile(path, data, options) {
				if (++calls === 2) throw new Error('No space left on device');
				await ports.writeFile(path, data, options);
			}
		};
		await expect(
			streamToFile(streamOf([chunk(10, 1), chunk(10, 2), chunk(10, 3)]), '/d', { flushBytes: 10 }, failing)
		).rejects.toThrow('No space left on device');
		expect(files.size).toBe(0);
	});
});

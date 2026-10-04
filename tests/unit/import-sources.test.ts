import { describe, expect, it } from 'vitest';
import {
	fileSource,
	importSourcesSequentially,
	partitionImportSources,
	pathSource,
	type ImportSource
} from '$lib/import/import-sources.js';
import { dispatchFileDropEvent } from '$lib/desktop/file-drop.js';

const EXTENSIONS = ['zip', 'cbz', 'cbr', 'rar', 'epub', 'pdf'];

function namedSource(name: string, log: string[] = [], fail = false): ImportSource {
	return {
		name,
		load: async () => {
			log.push(`load ${name}`);
			if (fail) throw new Error(`cannot read ${name}`);
			return new File([new Uint8Array([1, 2, 3])], name);
		}
	};
}

describe('partitionImportSources', () => {
	it('splits by extension and existing names without reading anything', () => {
		const log: string[] = [];
		const result = partitionImportSources(
			[
				namedSource('One.cbz', log),
				namedSource('notes.txt', log),
				namedSource('Two.CBZ', log),
				namedSource('Old.zip', log),
				namedSource('README', log)
			],
			EXTENSIONS,
			new Set(['Old.zip'])
		);

		expect(result.accepted.map((s) => s.name)).toEqual(['One.cbz', 'Two.CBZ']);
		expect(result.unsupported).toEqual(['notes.txt', 'README']);
		expect(result.duplicates).toEqual(['Old.zip']);
		expect(log).toEqual([]);
	});

	it('names a path source by its last segment, decoding file:// URLs', async () => {
		const read = async (path: string) => new File([], path);
		expect(pathSource('/Volumes/Manga/Vol 01.cbz', read).name).toBe('Vol 01.cbz');
		expect(pathSource('file:///Users/me/My%20Comic.cbz', read).name).toBe('My Comic.cbz');
		expect(pathSource('C:\\Comics\\Vol 02.cbz', read).name).toBe('Vol 02.cbz');
		expect((await pathSource('/a/b.cbz', read).load()).name).toBe('/a/b.cbz');
	});

	it('wraps an in-memory File without copying it', async () => {
		const file = new File(['x'], 'Dropped.cbz');
		const source = fileSource(file);
		expect(source.name).toBe('Dropped.cbz');
		expect(await source.load()).toBe(file);
	});
});

describe('importSourcesSequentially', () => {
	it('reads each file only when its turn comes', async () => {
		const log: string[] = [];
		const sources = [namedSource('A.cbz', log), namedSource('B.cbz', log), namedSource('C.cbz', log)];

		const result = await importSourcesSequentially(sources, async (file, index) => {
			log.push(`import ${file.name}`);
			return `uuid-${index}`;
		}, { onStart: (index, source) => log.push(`start ${index} ${source.name}`) });

		expect(log).toEqual([
			'start 0 A.cbz', 'load A.cbz', 'import A.cbz',
			'start 1 B.cbz', 'load B.cbz', 'import B.cbz',
			'start 2 C.cbz', 'load C.cbz', 'import C.cbz'
		]);
		expect(result).toEqual({ succeeded: ['uuid-0', 'uuid-1', 'uuid-2'], failed: [] });
	});

	it('records a file that cannot be read and carries on', async () => {
		const log: string[] = [];
		const sources = [namedSource('A.cbz', log), namedSource('Gone.cbz', log, true), namedSource('C.cbz', log)];

		const result = await importSourcesSequentially(sources, async (file) => `uuid-${file.name}`);

		expect(result.succeeded).toEqual(['uuid-A.cbz', 'uuid-C.cbz']);
		expect(result.failed).toEqual([{ name: 'Gone.cbz', error: 'cannot read Gone.cbz' }]);
	});

	it('records an import failure with the fallback message when the error has none', async () => {
		const result = await importSourcesSequentially(
			[namedSource('A.cbz')],
			async () => {
				throw 'not an Error';
			},
			{ fallbackError: () => 'Import failed' }
		);

		expect(result.failed).toEqual([{ name: 'A.cbz', error: 'Import failed' }]);
	});
});

describe('dispatchFileDropEvent', () => {
	function recorder() {
		const events: string[] = [];
		return {
			events,
			handlers: {
				onHover: (active: boolean) => events.push(`hover ${active}`),
				onDrop: (paths: string[]) => events.push(`drop ${paths.join(',')}`)
			}
		};
	}

	it('maps enter/over/leave to hover and a drop to the dropped paths', () => {
		const { events, handlers } = recorder();
		dispatchFileDropEvent({ type: 'enter', paths: ['/a.cbz'] }, handlers);
		dispatchFileDropEvent({ type: 'over' }, handlers);
		dispatchFileDropEvent({ type: 'leave' }, handlers);
		dispatchFileDropEvent({ type: 'drop', paths: ['/a.cbz', '/b.cbz'] }, handlers);

		expect(events).toEqual(['hover true', 'hover true', 'hover false', 'hover false', 'drop /a.cbz,/b.cbz']);
	});

	it('does not import an empty drop', () => {
		const { events, handlers } = recorder();
		dispatchFileDropEvent({ type: 'drop', paths: [] }, handlers);
		expect(events).toEqual(['hover false']);
	});
});

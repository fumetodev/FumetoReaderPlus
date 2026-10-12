/**
 * Phase 3, item 1: the desktop app downloads the speech-balloon layout model
 * its WebAssembly tier reads, and nothing else; Android's list is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const fs = vi.hoisted(() => ({
	exists: vi.fn(async (_path: string) => false),
	mkdir: vi.fn(async (_path: string, _options?: unknown) => undefined),
	readFile: vi.fn(async (_path: string) => new Uint8Array(4)),
	remove: vi.fn(async (_path: string) => undefined),
	stat: vi.fn(async (_path: string) => ({ size: 0 }))
}));
const bridge = vi.hoisted(() => ({
	downloadModelFile: vi.fn(async (_url: string, _dest: string, _options?: unknown) => undefined),
	cancelDownload: vi.fn()
}));
const digest = vi.hoisted(() => ({ value: '' }));

vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('@tauri-apps/api/path', () => ({
	appDataDir: async () => '/data',
	join: async (...parts: string[]) => parts.join('/')
}));
vi.mock('$lib/translation/llamacpp-bridge.js', () => bridge);
vi.mock('$lib/paraglide/messages.js', () => ({ ocr_download_failed: () => 'Download failed' }));
vi.mock('$lib/detection/ocr-model-specs.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/detection/ocr-model-specs.js')>()),
	sha256Hex: async () => digest.value
}));

const specs = await vi.importActual<typeof import('$lib/detection/ocr-model-specs.js')>(
	'$lib/detection/ocr-model-specs.js'
);
const { CANDIDATE_FILES } = await import('$lib/detection/candidates/candidate-model-files.js');
const manager = await import('$lib/detection/ocr-model-manager.js');

const globals = globalThis as unknown as { window?: unknown };
const [desktopLayout] = specs.DESKTOP_OCR_MODELS;

beforeEach(() => {
	for (const mock of Object.values(fs)) mock.mockClear();
	bridge.downloadModelFile.mockClear();
	fs.exists.mockImplementation(async () => false);
	fs.stat.mockImplementation(async () => ({ size: 0 }));
	digest.value = '';
});

afterEach(() => {
	delete globals.window;
	manager.ocrModelDownloadState.set({ status: 'idle', error: undefined, progress: undefined });
});

describe('which vision models each host downloads', () => {
	it('keeps Android on its three models', () => {
		expect(specs.managedOcrModels('android').map((spec) => spec.filename)).toEqual([
			'ppocr-det-v6-medium.onnx',
			'ppocr-rec-v6-small.onnx',
			'rtmdet-manga-layout-1024.onnx'
		]);
		expect(specs.ocrModelsTotalBytes('android')).toBe(62_032_837 + 21_143_614 + 43_227_772);
	});

	it('gives the desktop only the 960 layout model, under the name its WebAssembly tier reads', () => {
		expect(specs.managedOcrModels('desktop')).toEqual([desktopLayout]);
		expect(desktopLayout.filename).toBe(CANDIDATE_FILES['rtmdet-manga'][0]);
		expect(desktopLayout.url).toMatch(/\/resolve\/[0-9a-f]{40}\/rtmdet-manga-layout-960\.onnx$/);
		expect(desktopLayout.sizeBytes).toBe(43_206_748);
		expect(desktopLayout.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(specs.ocrModelsTotalBytes('desktop')).toBe(43_206_748);
	});

	it('manages nothing in a browser, and still quotes the full set there', () => {
		expect(specs.managedOcrModels('none')).toEqual([]);
		expect(specs.ocrModelsTotalBytes('none')).toBe(specs.ocrModelsTotalBytes('android'));
	});

	it('hashes with sha256', async () => {
		expect(await specs.sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('the desktop app', () => {
	beforeEach(() => {
		globals.window = { __TAURI_INTERNALS__: {} };
	});

	it('asks for the layout model until it is on disk at the right size', async () => {
		expect(manager.ocrModelsTotalBytes()).toBe(43_206_748);
		expect(await manager.missingOcrModels()).toEqual([desktopLayout]);
		expect(await manager.areOcrModelsReady()).toBe(false);

		fs.exists.mockImplementation(async () => true);
		fs.stat.mockImplementation(async () => ({ size: 43_206_748 }));
		expect(await manager.areOcrModelsReady()).toBe(true);
		expect(fs.stat).toHaveBeenCalledWith('/data/models/rtmdet-manga-layout.onnx');
	});

	it('downloads it and keeps it when the contents check out', async () => {
		fs.stat.mockImplementation(async () => ({ size: 43_206_748 }));
		digest.value = desktopLayout.sha256 ?? '';

		await manager.downloadOcrModels();

		expect(bridge.downloadModelFile).toHaveBeenCalledTimes(1);
		expect(bridge.downloadModelFile.mock.calls[0][0]).toBe(desktopLayout.url);
		expect(bridge.downloadModelFile.mock.calls[0][1]).toBe('/data/models/rtmdet-manga-layout.onnx');
		expect(fs.remove).not.toHaveBeenCalled();
		expect(get(manager.ocrModelDownloadState).status).toBe('completed');
	});

	it('deletes a download of the right size with the wrong contents', async () => {
		fs.stat.mockImplementation(async () => ({ size: 43_206_748 }));
		digest.value = '0'.repeat(64);

		await expect(manager.downloadOcrModels()).rejects.toThrow(/unexpected contents/);

		expect(fs.remove).toHaveBeenCalledWith('/data/models/rtmdet-manga-layout.onnx');
		expect(get(manager.ocrModelDownloadState).status).toBe('error');
	});

	it('deletes only its own file', async () => {
		fs.exists.mockImplementation(async () => true);
		await manager.deleteOcrModels();
		expect(fs.remove.mock.calls).toEqual([['/data/models/rtmdet-manga-layout.onnx']]);
	});
});

describe('a browser', () => {
	it('never asks for a download', async () => {
		expect(await manager.missingOcrModels()).toEqual([]);
		expect(await manager.installedOcrModelBytes()).toBe(0);
		expect(fs.exists).not.toHaveBeenCalled();
	});
});

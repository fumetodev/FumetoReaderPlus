/**
 * Phase 3, item 6: the Mac app runs every WebAssembly vision model threaded
 * once WebKit isolates the page; every other host keeps its old counts.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyOrtWasmThreads, ortWasmThreads, type OrtWasmEnvironment } from '$lib/detection/ort-wasm-threads.js';

const env = (overrides: Partial<OrtWasmEnvironment>): OrtWasmEnvironment => ({
	macApp: false,
	crossOriginIsolated: false,
	sharedArrayBuffer: false,
	hardwareConcurrency: 8,
	...overrides
});

describe('the WebAssembly thread count', () => {
	it('keeps PP-OCR single-threaded off the Mac app, isolated or not', () => {
		expect(ortWasmThreads('ppocr', env({}))).toBe(1);
		expect(ortWasmThreads('ppocr', env({ crossOriginIsolated: true, sharedArrayBuffer: true }))).toBe(1);
	});

	it('keeps the candidate models’ old formula off the Mac app', () => {
		expect(ortWasmThreads('candidate', env({}))).toBe(1);
		expect(ortWasmThreads('candidate', env({ sharedArrayBuffer: true }))).toBe(4);
		expect(ortWasmThreads('candidate', env({ sharedArrayBuffer: true, hardwareConcurrency: 2 }))).toBe(2);
	});

	it('changes nothing in the Mac app while WebKit has not isolated the page', () => {
		const mac = env({ macApp: true });
		expect(ortWasmThreads('ppocr', mac)).toBe(1);
		expect(ortWasmThreads('candidate', mac)).toBe(1);
	});

	it('gives every caller in an isolated Mac app the same count: half the cores, at most four', () => {
		const isolated = (hardwareConcurrency: number) =>
			env({ macApp: true, crossOriginIsolated: true, sharedArrayBuffer: true, hardwareConcurrency });
		// M1/M2/M3: 4 performance + 4 efficiency cores.
		expect(ortWasmThreads('ppocr', isolated(8))).toBe(4);
		expect(ortWasmThreads('candidate', isolated(8))).toBe(4);
		expect(ortWasmThreads('ppocr', isolated(12))).toBe(4);
		expect(ortWasmThreads('ppocr', isolated(4))).toBe(2);
		expect(ortWasmThreads('ppocr', isolated(1))).toBe(1);
		expect(ortWasmThreads('ppocr', isolated(Number.NaN))).toBe(1);
	});

	it('sets the count on ORT’s environment and reports it once', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const wasm: { numThreads?: number } = {};
		const isolatedMac = env({ macApp: true, crossOriginIsolated: true, sharedArrayBuffer: true });

		expect(applyOrtWasmThreads(wasm, 'ppocr', isolatedMac)).toBe(4);
		expect(wasm.numThreads).toBe(4);
		applyOrtWasmThreads(wasm, 'candidate', isolatedMac);

		expect(log.mock.calls).toEqual([['[ort] wasm threads: 4 (isolated: yes)']]);
		log.mockRestore();
	});
});

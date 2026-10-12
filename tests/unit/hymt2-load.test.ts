/**
 * Phase 3: every on-device model load carries its variant's options, and the
 * desktop app passes them to `llama_load` the way Android passes them to its
 * bridge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

const { hyMT2LoadOptions, plannedBackend } = await import('$lib/translation/hymt2-load-options.js');
// Node's navigator reports no mobile OS, so the bridge takes its desktop branch.
const bridge = await import('$lib/translation/llamacpp-bridge.js');

const format = { prefix: '<|user|>\n', suffix: '\n<|assistant|>\n', stops: ['<|end|>'] };

beforeEach(() => {
	core.invoke.mockReset();
});

describe('per-variant load options', () => {
	it('gives the multilingual guidance to v3 alone', () => {
		expect(hyMT2LoadOptions('manga-v3').multilingualGuidance).toBe(true);
		for (const variant of ['stock', 'manga-v2', 'manga-v5', 'custom'] as const) {
			expect(hyMT2LoadOptions(variant).multilingualGuidance).toBe(false);
		}
	});

	it('hands a prompt format to the custom model only', () => {
		expect(hyMT2LoadOptions('custom', { promptFormat: format }).promptFormat).toEqual(format);
		expect(hyMT2LoadOptions('manga-v5', { promptFormat: format }).promptFormat).toBeUndefined();
	});

	it('asks for the GPU only in the Mac app, with the switch on, and never for the stock model', () => {
		const mac = { gpuCapable: true, useGpu: true };
		for (const variant of ['manga-v2', 'manga-v3', 'manga-v5', 'custom'] as const) {
			expect(hyMT2LoadOptions(variant, mac).gpu).toBe(true);
		}
		// Metal has no kernel for the stock model's STQ1_0 weights.
		expect(hyMT2LoadOptions('stock', mac).gpu).toBe(false);
		expect(hyMT2LoadOptions('manga-v5', { gpuCapable: true, useGpu: false }).gpu).toBe(false);
		// Android, Windows, Linux and the browser never ask.
		expect(hyMT2LoadOptions('manga-v5', { gpuCapable: false, useGpu: true }).gpu).toBe(false);
		expect(hyMT2LoadOptions('manga-v5').gpu).toBe(false);
	});
});

describe('the Compute line', () => {
	const idle = { backend: 'cpu', gpuDevice: 'Apple M1', loaded: false };

	it('names the backend of the loaded model', () => {
		expect(plannedBackend({ backend: 'metal:Apple M1', gpuDevice: 'Apple M1', loaded: true }, false)).toBe('metal:Apple M1');
		// A GPU load that fell back to the CPU says so.
		expect(plannedBackend({ backend: 'cpu', gpuDevice: 'Apple M1', loaded: true }, true)).toBe('cpu');
	});

	it('names where the selected model will load when nothing is loaded', () => {
		expect(plannedBackend(idle, true)).toBe('metal:Apple M1');
		expect(plannedBackend(idle, false)).toBe('cpu');
		expect(plannedBackend({ ...idle, gpuDevice: null }, true)).toBe('cpu');
	});
});

describe('the desktop llama_load call', () => {
	it('carries the guidance scope', async () => {
		core.invoke.mockResolvedValue(true);

		await bridge.loadHyMT2Model('/models/v3.gguf', undefined, hyMT2LoadOptions('manga-v3'));
		await bridge.loadHyMT2Model('/models/v5.gguf', undefined, hyMT2LoadOptions('manga-v5'));

		expect(core.invoke.mock.calls).toEqual([
			['llama_load', { modelPath: '/models/v3.gguf', options: { guidanceScope: 'all-targets', gpu: false } }],
			['llama_load', { modelPath: '/models/v5.gguf', options: { guidanceScope: 'english-only', gpu: false } }]
		]);
	});

	it('carries the GPU choice', async () => {
		core.invoke.mockResolvedValue(true);
		await bridge.loadHyMT2Model('/models/v5-gpu.gguf', undefined, hyMT2LoadOptions('manga-v5', { gpuCapable: true, useGpu: true }));
		expect(core.invoke).toHaveBeenCalledWith('llama_load', {
			modelPath: '/models/v5-gpu.gguf',
			options: { guidanceScope: 'english-only', gpu: true }
		});
	});

	it('defaults to English-only guidance on the CPU when given no options', () => {
		expect(bridge.desktopLoadOptions()).toEqual({ guidanceScope: 'english-only', gpu: false });
	});

	it('reads the backend report, and answers null when there is none', async () => {
		const report = { backend: 'cpu', description: 'llama.cpp CPU (4 threads)', gpuDevice: 'Apple M1', threads: 4, loaded: false };
		core.invoke.mockResolvedValueOnce(report);
		expect(await bridge.getBackendInfo()).toEqual(report);
		expect(core.invoke).toHaveBeenLastCalledWith('llama_get_backend');

		core.invoke.mockRejectedValueOnce('command llama_get_backend not found');
		expect(await bridge.getBackendInfo()).toBeNull();
	});

	it('turns the command’s rejected string into an Error that keeps the text', async () => {
		core.invoke.mockRejectedValue('needs-prompt-format: the GGUF embeds no chat template');

		const error = await bridge.loadHyMT2Model('/models/custom.gguf').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('needs-prompt-format: the GGUF embeds no chat template');
	});
});

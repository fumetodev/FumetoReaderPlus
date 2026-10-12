/**
 * Phase 3: every on-device model load carries its variant's options, and the
 * desktop app passes them to `llama_load` the way Android passes them to its
 * bridge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

const { hyMT2LoadOptions } = await import('$lib/translation/hymt2-load-options.js');
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
});

describe('the desktop llama_load call', () => {
	it('carries the guidance scope', async () => {
		core.invoke.mockResolvedValue(true);

		await bridge.loadHyMT2Model('/models/v3.gguf', undefined, hyMT2LoadOptions('manga-v3'));
		await bridge.loadHyMT2Model('/models/v5.gguf', undefined, hyMT2LoadOptions('manga-v5'));

		expect(core.invoke.mock.calls).toEqual([
			['llama_load', { modelPath: '/models/v3.gguf', options: { guidanceScope: 'all-targets' } }],
			['llama_load', { modelPath: '/models/v5.gguf', options: { guidanceScope: 'english-only' } }]
		]);
	});

	it('defaults to English-only guidance when given no options', () => {
		expect(bridge.desktopLoadOptions()).toEqual({ guidanceScope: 'english-only' });
	});

	it('turns the command’s rejected string into an Error that keeps the text', async () => {
		core.invoke.mockRejectedValue('needs-prompt-format: the GGUF embeds no chat template');

		const error = await bridge.loadHyMT2Model('/models/custom.gguf').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('needs-prompt-format: the GGUF embeds no chat template');
	});
});

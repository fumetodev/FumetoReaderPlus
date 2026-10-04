import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { readDeviceMemory } from '$lib/device/device-memory.js';
import { refreshDesktopMemory, resetDesktopMemoryForTests } from '$lib/device/desktop-memory.js';
import { menuCommand, runMenuCommand } from '$lib/desktop/app-menu.js';
import { toggleWindowFullscreen } from '$lib/desktop/window-fullscreen.js';
import { openSettingsDialog, settingsDialogOpen, settingsLoading } from '$lib/stores/ui-state.js';

const GIB = 1024 ** 3;
const globals = globalThis as unknown as { window?: unknown };

afterEach(() => {
	resetDesktopMemoryForTests();
	delete globals.window;
	settingsDialogOpen.set(false);
	settingsLoading.set(false);
	vi.useRealTimers();
});

describe('device memory on the desktop', () => {
	it('is unknown until the desktop app has answered', () => {
		expect(readDeviceMemory()).toBeNull();
	});

	it('keeps the system_memory answer for the synchronous reader', async () => {
		const invoke = vi.fn(async () => ({ totalBytes: 16 * GIB, availBytes: 9 * GIB }));
		await refreshDesktopMemory(invoke);

		expect(invoke).toHaveBeenCalledWith('system_memory');
		expect(readDeviceMemory()).toEqual({ totalBytes: 16 * GIB, availBytes: 9 * GIB, lowMemory: false });
	});

	it('ignores an answer without a usable total and keeps the previous one', async () => {
		await refreshDesktopMemory(async () => ({ totalBytes: 8 * GIB, availBytes: 2 * GIB }));
		await refreshDesktopMemory(async () => null);
		await refreshDesktopMemory(async () => ({ totalBytes: 0, availBytes: 1 }));
		await refreshDesktopMemory(async () => {
			throw new Error('command not found');
		});

		expect(readDeviceMemory()?.totalBytes).toBe(8 * GIB);
	});

	it('treats a missing available figure as zero', async () => {
		await refreshDesktopMemory(async () => ({ totalBytes: 8 * GIB, availBytes: 'n/a' }));
		expect(readDeviceMemory()).toEqual({ totalBytes: 8 * GIB, availBytes: 0, lowMemory: false });
	});

	it('prefers the Android bridge when there is one', async () => {
		await refreshDesktopMemory(async () => ({ totalBytes: 16 * GIB, availBytes: 9 * GIB }));
		globals.window = {
			__fumeto_android: {
				getMemoryInfo: () => JSON.stringify({ totalBytes: 6 * GIB, availBytes: 2 * GIB, lowMemory: true })
			}
		};

		expect(readDeviceMemory()).toEqual({ totalBytes: 6 * GIB, availBytes: 2 * GIB, lowMemory: true });
	});

	it('feeds the "available RAM" figure in Settings', async () => {
		const { getAvailableMemoryGB } = await import('$lib/translation/llamacpp-bridge.js');
		expect(getAvailableMemoryGB()).toBe(0);

		await refreshDesktopMemory(async () => ({ totalBytes: 16 * GIB, availBytes: 3 * GIB }));
		expect(getAvailableMemoryGB()).toBe(3);
	});
});

describe('menu commands', () => {
	it('opens Settings and Import, and ignores anything else', () => {
		const opened: string[] = [];
		const actions = { openSettings: () => opened.push('settings'), openImport: () => opened.push('import') };

		expect(runMenuCommand('settings', actions)).toBe(true);
		expect(runMenuCommand('import', actions)).toBe(true);
		expect(runMenuCommand('quit', actions)).toBe(false);
		expect(runMenuCommand(undefined, actions)).toBe(false);

		expect(opened).toEqual(['settings', 'import']);
		expect(menuCommand({ command: 'settings' })).toBeNull();
	});

	it('opens the desktop Settings dialog once, after the loading overlay', () => {
		vi.useFakeTimers();
		openSettingsDialog();
		expect(get(settingsLoading)).toBe(true);
		expect(get(settingsDialogOpen)).toBe(false);
		vi.advanceTimersByTime(100);
		expect(get(settingsDialogOpen)).toBe(true);

		// ⌘, while it is open must not bring the loading overlay back.
		settingsLoading.set(false);
		openSettingsDialog();
		expect(get(settingsLoading)).toBe(false);
	});
});

describe('window full screen', () => {
	it('toggles the window state both ways', async () => {
		let fullscreen = false;
		const window = {
			isFullscreen: async () => fullscreen,
			setFullscreen: async (next: boolean) => {
				fullscreen = next;
			}
		};

		expect(await toggleWindowFullscreen(window)).toBe(true);
		expect(fullscreen).toBe(true);
		expect(await toggleWindowFullscreen(window)).toBe(false);
		expect(fullscreen).toBe(false);
	});
});

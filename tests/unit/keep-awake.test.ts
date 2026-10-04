import { afterEach, describe, expect, it } from 'vitest';
import {
	acquireKeepAwake,
	keepAwakeClaims,
	releaseKeepAwake,
	resetKeepAwakeForTests
} from '$lib/desktop/keep-awake.js';

function recordingInvoke(fail = false) {
	const calls: Array<{ command: string; enabled: unknown }> = [];
	const invoke = async (command: string, args: Record<string, unknown>) => {
		calls.push({ command, enabled: args.enabled });
		if (fail) throw new Error('bridge unavailable');
		return true;
	};
	return { calls, invoke };
}

afterEach(() => resetKeepAwakeForTests());

describe('keep-awake reference counting', () => {
	it('begins one activity for the first job and ends it after the last', async () => {
		const { calls, invoke } = recordingInvoke();
		resetKeepAwakeForTests(invoke);

		await acquireKeepAwake();
		await acquireKeepAwake();
		expect(keepAwakeClaims()).toBe(2);
		await releaseKeepAwake();
		expect(calls).toEqual([{ command: 'app_keep_awake', enabled: true }]);
		await releaseKeepAwake();

		expect(keepAwakeClaims()).toBe(0);
		expect(calls).toEqual([
			{ command: 'app_keep_awake', enabled: true },
			{ command: 'app_keep_awake', enabled: false }
		]);
	});

	it('delivers a quick enable and disable in order', async () => {
		const { calls, invoke } = recordingInvoke();
		resetKeepAwakeForTests(invoke);

		void acquireKeepAwake();
		await releaseKeepAwake();

		expect(calls.map((call) => call.enabled)).toEqual([true, false]);
	});

	it('ignores a release without a claim', async () => {
		const { calls, invoke } = recordingInvoke();
		resetKeepAwakeForTests(invoke);

		await releaseKeepAwake();

		expect(keepAwakeClaims()).toBe(0);
		expect(calls).toEqual([]);
	});

	it('never throws when the native call fails', async () => {
		const { calls, invoke } = recordingInvoke(true);
		resetKeepAwakeForTests(invoke);

		await expect(acquireKeepAwake()).resolves.toBeUndefined();
		await expect(releaseKeepAwake()).resolves.toBeUndefined();
		expect(calls).toHaveLength(2);
	});
});

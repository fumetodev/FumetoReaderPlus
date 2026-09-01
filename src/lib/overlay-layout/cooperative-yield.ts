export interface CooperativeYieldBudget {
	checkpoint(): Promise<void>;
}

type SchedulerWithYield = {
	yield?: () => Promise<void>;
};

function now(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

async function yieldToBrowser(): Promise<void> {
	const scheduler = (globalThis as typeof globalThis & { scheduler?: SchedulerWithYield }).scheduler;
	if (typeof scheduler?.yield === 'function') {
		await scheduler.yield.call(scheduler);
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Yield long candidate searches back to the browser without changing their
 * deterministic ordering. Server-side evaluation deliberately remains fully
 * synchronous so corpus and fuzz gates do not acquire timer overhead.
 */
export function createCooperativeYieldBudget(
	timeBudgetMs = 8,
	minimumOperations = 8
): CooperativeYieldBudget {
	let operations = 0;
	let lastYield = now();
	return {
		async checkpoint(): Promise<void> {
			operations += 1;
			if (operations % minimumOperations !== 0) return;
			if (typeof (globalThis as typeof globalThis & { window?: unknown }).window === 'undefined') return;
			if (now() - lastYield < timeBudgetMs) return;
			await yieldToBrowser();
			lastYield = now();
		}
	};
}

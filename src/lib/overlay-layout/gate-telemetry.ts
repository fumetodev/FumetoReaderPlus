/**
 * Liveness instrumentation for the overlay's shape gates.
 *
 * Five thresholds shipped tuned against hand-written test polygons and sat
 * outside the range real manga occupies. Each made the machinery behind it dead
 * code — the lobe split never fired on a real balloon, the free-column
 * adjacency bound never fired at all, an item-type filter excluded exactly the
 * class it was meant to admit — and every gate in the repository stayed green
 * throughout, because a test that asserts "this fixture still splits" cannot
 * notice that nothing else ever does.
 *
 * A gate that never fires over a corpus of real pages is dead. A gate that
 * never declines is not a gate. Both are mechanical to detect and neither needs
 * a judgement call, which is the point: this catches the whole class without
 * anyone having to suspect a particular constant.
 *
 * What it does NOT catch, and the reason it is not the only thing here: a gate
 * that fires with the wrong boundary (band snapping did, at 0.34, landing 138px
 * from a real join), or one that compares the wrong quantity (verticality did,
 * measuring a union bounding box). Those need the plateau audit and better
 * labels respectively.
 *
 * Cost when disarmed is one null check per gate evaluation. Counts are never
 * written into `OverlayRenderPlanV2.diagnostics`, which is persisted inside
 * `cachedPlan` and has to stay small.
 */

export type GateOutcome = 'fired' | 'declined';
/**
 * `value` is the quantity the gate compared, when the gate has one.
 *
 * Liveness alone cannot tell a threshold sitting in the middle of a gulf from
 * one sitting on the edge of its population — and the second is how five
 * constants came to be wrong. Recording what was actually measured turns the
 * same instrumentation into the input for the plateau audit: where the
 * threshold sits relative to the values it is asked about.
 */
export type GateSink = (gate: string, outcome: GateOutcome, value?: number) => void;

export interface GateCount {
	fired: number;
	declined: number;
	/** Observed values, split by which side of the threshold they landed on. */
	firedValues?: number[];
	declinedValues?: number[];
}

export interface GateCounts {
	[gate: string]: GateCount;
}

let sink: GateSink | null = null;

/**
 * Route gate outcomes to `next`, or to nothing when null.
 *
 * Armed explicitly rather than defaulting to `import.meta.env.DEV`: a
 * development build that silently counted would make the disarmed path the
 * untested one, and the disarmed path is the only one that ships.
 */
export function armGateTelemetry(next: GateSink | null): void {
	sink = next;
}

export function recordGate(gate: string, outcome: GateOutcome, value?: number): void {
	sink?.(gate, outcome, value);
}

/** Convenience: record `fired` when true, `declined` when false, and pass it through. */
export function recordGateResult(gate: string, fired: boolean, value?: number): boolean {
	sink?.(gate, fired ? 'fired' : 'declined', value);
	return fired;
}

/**
 * Count every gate outcome produced while `run` executes.
 *
 * Restores whatever sink was previously armed rather than clearing, so nesting
 * one collection inside another cannot silently disarm the outer one.
 */
export async function collectGateCounts<T>(run: () => T | Promise<T>): Promise<{ result: T; counts: GateCounts }> {
	const previous = sink;
	const counts: GateCounts = {};
	sink = (gate, outcome, value) => {
		const entry = counts[gate] ?? (counts[gate] = { fired: 0, declined: 0 });
		entry[outcome] += 1;
		if (value === undefined || !Number.isFinite(value)) return;
		const bucket = outcome === 'fired' ? 'firedValues' : 'declinedValues';
		(entry[bucket] ?? (entry[bucket] = [])).push(value);
	};
	try {
		return { result: await run(), counts };
	} finally {
		sink = previous;
	}
}

/** Merge counts from several runs into one tally. */
export function mergeGateCounts(into: GateCounts, from: GateCounts): GateCounts {
	for (const [gate, entry] of Object.entries(from)) {
		const target = into[gate] ?? (into[gate] = { fired: 0, declined: 0 });
		target.fired += entry.fired;
		target.declined += entry.declined;
		for (const bucket of ['firedValues', 'declinedValues'] as const) {
			if (!entry[bucket]?.length) continue;
			(target[bucket] ?? (target[bucket] = [])).push(...entry[bucket]);
		}
	}
	return into;
}

import type { OverlayRenderPlanV2 } from '$lib/types/index.js';
import type { OverlayLayoutInput, OverlayLayoutService } from './ports.js';
import { canonicalStringify, compareCanonicalText, sha256 } from './canonical.js';
import { computeOverlayLayoutInputHash, overlayLayoutService } from './layout-service.js';
import { pageOverlayRepository } from './repository.js';
import { isValidCachedPlan } from './schema.js';

export type OverlayPlanPhase = 'idle' | 'loading-fonts' | 'planning' | 'ready' | 'failed';

export interface OverlayPlanSnapshot {
	phase: OverlayPlanPhase;
	key: string | null;
	plan: OverlayRenderPlanV2 | null;
	error: string | null;
	revision: number;
}

export interface OverlayPlanRequestOptions {
	volumeUuid?: string;
	pageIndex?: number;
	persist?: boolean;
	signal?: AbortSignal;
	/** Request-bound lifecycle observer. It never receives another request's status. */
	onStatus?: (snapshot: OverlayPlanSnapshot) => void;
}

type CacheEntry = { plan: OverlayRenderPlanV2; bytes: number; lastUsed: number };
type PendingControllerPlan = {
	work: Promise<OverlayRenderPlanV2>;
	controller: AbortController;
	scopeId: string;
	consumers: number;
	settled: boolean;
};

const MAX_PAGES = 12;
const MAX_BYTES = 32 * 1024 * 1024;

export class PageOverlayPlanController {
	private snapshot: OverlayPlanSnapshot = { phase: 'idle', key: null, plan: null, error: null, revision: 0 };
	private readonly listeners = new Set<(snapshot: OverlayPlanSnapshot) => void>();
	private readonly pending = new Map<string, PendingControllerPlan>();
	private readonly cache = new Map<string, CacheEntry>();
	private generation = 0;
	private requestOrder = 0;
	private latestResolvedOrder = 0;
	private latestResolvedKey: string | null = null;
	private clock = 0;
	private cacheBytes = 0;

	constructor(private readonly service: OverlayLayoutService = overlayLayoutService) {}

	inspect(): OverlayPlanSnapshot {
		return { ...this.snapshot };
	}

	subscribe(listener: (snapshot: OverlayPlanSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.inspect());
		return () => this.listeners.delete(listener);
	}

	private publish(patch: Partial<OverlayPlanSnapshot>): OverlayPlanSnapshot {
		this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 };
		const snapshot = this.inspect();
		for (const listener of this.listeners) listener(this.inspect());
		return snapshot;
	}

	private publishForRequest(
		options: OverlayPlanRequestOptions,
		patch: Partial<OverlayPlanSnapshot>
	): OverlayPlanSnapshot {
		const snapshot = this.publish(patch);
		try {
			options.onStatus?.(snapshot);
		} catch (error) {
			// A presentation observer must never corrupt canonical planning work.
			console.error('Overlay plan status observer failed', error);
		}
		return snapshot;
	}

	private consume(pending: PendingControllerPlan, signal?: AbortSignal): Promise<OverlayRenderPlanV2> {
		pending.consumers += 1;
		return new Promise<OverlayRenderPlanV2>((resolve, reject) => {
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				pending.consumers = Math.max(0, pending.consumers - 1);
				if (pending.consumers === 0 && !pending.settled) pending.controller.abort();
			};
			const abort = () => {
				signal?.removeEventListener('abort', abort);
				release();
				reject(new DOMException('Overlay planning cancelled', 'AbortError'));
			};
			signal?.addEventListener('abort', abort, { once: true });
			pending.work.then(
				(value) => { signal?.removeEventListener('abort', abort); release(); resolve(value); },
				(error) => { signal?.removeEventListener('abort', abort); release(); reject(error); }
			);
			if (signal?.aborted) abort();
		});
	}

	async request(input: OverlayLayoutInput, options: OverlayPlanRequestOptions = {}): Promise<OverlayRenderPlanV2> {
		if (options.signal?.aborted) throw new DOMException('Overlay planning cancelled', 'AbortError');
		const order = ++this.requestOrder;
		const key = await computeOverlayLayoutInputHash(input);
		if (options.signal?.aborted) throw new DOMException('Overlay planning cancelled', 'AbortError');
		if (order < this.latestResolvedOrder && key !== this.latestResolvedKey) throw new DOMException('Stale overlay plan request', 'AbortError');
		if (order >= this.latestResolvedOrder) {
			this.latestResolvedOrder = order;
			this.latestResolvedKey = key;
		}
		const token = this.snapshot.key === key ? this.generation : ++this.generation;
		const cached = this.cache.get(key);
		if (cached) {
			cached.lastUsed = ++this.clock;
			const plan = { ...cached.plan, diagnostics: { ...cached.plan.diagnostics, cacheHit: true } };
			this.publishForRequest(options, { phase: 'ready', key, plan, error: null });
			return plan;
		}
		const persisted = input.document.cachedPlan;
		const diagnostics = this.service.inspect();
		const persistedIsValid = Boolean(persisted && await isValidCachedPlan(input.document, key, {
			algorithmVersion: diagnostics.algorithmVersion,
			fontFingerprint: diagnostics.fonts.fingerprint,
			settingsFingerprint: await sha256(input.settings)
		}));
		if (options.signal?.aborted || token !== this.generation) {
			throw new DOMException('Stale overlay plan request', 'AbortError');
		}
		if (persisted && persistedIsValid) {
			const plan = { ...persisted.plan, diagnostics: { ...persisted.plan.diagnostics, cacheHit: true } };
			this.remember(key, plan);
			this.publishForRequest(options, { phase: 'ready', key, plan, error: null });
			return plan;
		}

		this.publishForRequest(options, { phase: 'loading-fonts', key, plan: null, error: null });
		let pending = this.pending.get(key);
		if (pending?.controller.signal.aborted) {
			this.pending.delete(key);
			pending = undefined;
		}
		this.publishForRequest(options, { phase: 'planning', key, plan: null, error: null });
		if (!pending) {
			const controller = new AbortController();
			pending = {
				work: Promise.resolve(null as never),
				controller,
				scopeId: input.scopeId,
				consumers: 0,
				settled: false
			};
			const entry = pending;
			entry.work = this.service.plan(input, controller.signal).finally(() => {
				entry.settled = true;
				if (this.pending.get(key) === entry) this.pending.delete(key);
			});
			this.pending.set(key, entry);
		}
		try {
			const plan = await this.consume(pending, options.signal);
			if (token !== this.generation || key !== this.snapshot.key) throw new DOMException('Stale overlay plan publication', 'AbortError');
			this.remember(key, plan);
			if (options.persist && options.volumeUuid !== undefined && options.pageIndex !== undefined) {
				await pageOverlayRepository.persistCachedPlan(options.volumeUuid, options.pageIndex, key, plan);
			}
			if (options.signal?.aborted || token !== this.generation || key !== this.snapshot.key) {
				throw new DOMException('Stale overlay plan publication', 'AbortError');
			}
			this.publishForRequest(options, { phase: 'ready', key, plan, error: null });
			return plan;
		} catch (error) {
			const cancelled = error instanceof DOMException && error.name === 'AbortError';
			if (token === this.generation && !cancelled) {
				this.publishForRequest(options, { phase: 'failed', key, plan: null, error: error instanceof Error ? error.message : String(error) });
			}
			throw error;
		}
	}

	invalidate(scopeId?: string): void {
		this.generation += 1;
		this.latestResolvedOrder = ++this.requestOrder;
		this.latestResolvedKey = null;
		if (scopeId) {
			for (const pending of this.pending.values()) {
				if (pending.scopeId === scopeId) pending.controller.abort();
			}
			this.service.clearScope(scopeId);
		}
		this.publish({ phase: 'idle', key: null, plan: null, error: null });
	}

	private remember(key: string, plan: OverlayRenderPlanV2): void {
		const prior = this.cache.get(key);
		if (prior) this.cacheBytes -= prior.bytes;
		const bytes = canonicalStringify(plan).length * 2;
		this.cache.set(key, { plan, bytes, lastUsed: ++this.clock });
		this.cacheBytes += bytes;
		while (this.cache.size > MAX_PAGES || this.cacheBytes > MAX_BYTES) {
			const oldest = [...this.cache.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed || compareCanonicalText(left[0], right[0]))[0];
			if (!oldest) break;
			this.cache.delete(oldest[0]);
			this.cacheBytes -= oldest[1].bytes;
		}
	}

	inspectCache(): { pages: number; bytes: number; maxPages: number; maxBytes: number } {
		return { pages: this.cache.size, bytes: this.cacheBytes, maxPages: MAX_PAGES, maxBytes: MAX_BYTES };
	}
}

export const overlayPlanController = new PageOverlayPlanController();

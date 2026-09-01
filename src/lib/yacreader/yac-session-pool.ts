import type { PageSourcePurpose } from '$lib/reader/page-source.js';
import { randomUUID } from '$lib/util/uuid.js';
import type { YACServerClient } from './yac-server-client.js';

export interface YacSessionLease {
	client: YACServerClient;
	purpose: PageSourcePurpose;
	release(): void;
}

interface Slot {
	client: YACServerClient;
	inUse: boolean;
}

interface Waiter {
	resolve: (lease: YacSessionLease) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * One background comic session per server, deliberately. Opening a comic
 * (`/comic/{id}/remote`) starts an asynchronous extraction thread inside the
 * Qt server, so the server's real concurrency is the number of open comic
 * sessions — not connections (the transport lane already serializes those).
 * Two long-lived batch-translation sessions churning open/reopen cycles for
 * hours is exactly the workload that crashes YACReaderLibraryServer; a second
 * batch job now queues on the lease instead ("Waiting for a server
 * session…"), which costs it nothing — the on-device OCR/LLM bridges
 * serialize anyway.
 */
const SLOT_COUNTS: Record<PageSourcePurpose, number> = {
	reader: 1,
	preview: 1,
	background: 1
};

function installationId(): string {
	const key = 'fumeto-installation-id';
	try {
		const existing = localStorage.getItem(key);
		if (existing) return existing;
		const created = randomUUID();
		localStorage.setItem(key, created);
		return created;
	} catch {
		return randomUUID();
	}
}

function abortedLeaseError(): Error {
	const error = new Error('Page source lease cancelled');
	error.name = 'AbortError';
	return error;
}

export class YacSessionPool {
	private readonly slots: Record<PageSourcePurpose, Slot[]>;
	private readonly waiters: Record<PageSourcePurpose, Waiter[]> = {
		reader: [], preview: [], background: []
	};

	constructor(rootClient: YACServerClient, id = installationId()) {
		this.slots = {
			reader: this.createSlots(rootClient, id, 'reader'),
			preview: this.createSlots(rootClient, id, 'preview'),
			background: this.createSlots(rootClient, id, 'background')
		};
	}

	private createSlots(root: YACServerClient, id: string, purpose: PageSourcePurpose): Slot[] {
		return Array.from({ length: SLOT_COUNTS[purpose] }, (_, index) => ({
			client: root.createSessionClient(`${id}:${purpose}:${index}`),
			inUse: false
		}));
	}

	acquire(purpose: PageSourcePurpose, signal?: AbortSignal): Promise<YacSessionLease> {
		if (signal?.aborted) return Promise.reject(abortedLeaseError());
		const slot = this.slots[purpose].find((candidate) => !candidate.inUse);
		if (slot) return Promise.resolve(this.claim(purpose, slot));
		return new Promise<YacSessionLease>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters[purpose].indexOf(waiter);
					if (index >= 0) this.waiters[purpose].splice(index, 1);
					reject(abortedLeaseError());
				};
				signal.addEventListener('abort', waiter.onAbort, { once: true });
			}
			this.waiters[purpose].push(waiter);
		});
	}

	private claim(purpose: PageSourcePurpose, slot: Slot): YacSessionLease {
		slot.inUse = true;
		let released = false;
		return {
			client: slot.client,
			purpose,
			release: () => {
				if (released) return;
				released = true;
				const waiter = this.waiters[purpose].shift();
				if (waiter) {
					if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
					waiter.resolve(this.claim(purpose, slot));
				} else {
					slot.inUse = false;
				}
			}
		};
	}

	inspect(): Record<PageSourcePurpose, { active: number; queued: number; capacity: number }> {
		return {
			reader: this.inspectPurpose('reader'),
			preview: this.inspectPurpose('preview'),
			background: this.inspectPurpose('background')
		};
	}

	private inspectPurpose(purpose: PageSourcePurpose) {
		return {
			active: this.slots[purpose].filter((slot) => slot.inUse).length,
			queued: this.waiters[purpose].length,
			capacity: this.slots[purpose].length
		};
	}
}

const pools = new Map<string, YacSessionPool>();

export function getYacSessionPool(rootClient: YACServerClient): YacSessionPool {
	const key = rootClient.getBaseUrl().replace(/\/+$/, '').toLowerCase();
	let pool = pools.get(key);
	if (!pool) {
		pool = new YacSessionPool(rootClient);
		pools.set(key, pool);
	}
	return pool;
}

export function resetYacSessionPools(): void {
	pools.clear();
}

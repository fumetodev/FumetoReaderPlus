import { readable } from 'svelte/store';

export type PageTranslationActivityOwner = 'manual' | 'automatic' | 'overlay-generation' | 'legacy';

export interface PageTranslationActivityTarget {
	volumeUuid: string;
	pageIndex: number;
}

export interface PageTranslationActivityToken {
	readonly id: number;
	readonly owner: PageTranslationActivityOwner;
	readonly target: Readonly<PageTranslationActivityTarget>;
}

export type PageTranslationActivityCancelReason =
	| 'explicit-user'
	| 'target-changed'
	| 'target-deleted'
	| 'superseded'
	| 'shutdown';

export interface PageTranslationActivityControl {
	/** Cancel only the operation that owns this activity token. */
	cancel(reason: PageTranslationActivityCancelReason): void;
}

export interface PageTranslationActivitySnapshot extends PageTranslationActivityToken {
	readonly cancellable: boolean;
	readonly cancelRequested: boolean;
}

interface ActivePageTranslationActivity {
	token: PageTranslationActivityToken;
	control: PageTranslationActivityControl | null;
	cancelRequested: boolean;
}

let nextTokenId = 0;
const active = new Map<number, ActivePageTranslationActivity>();
const listeners = new Set<(busy: boolean) => void>();
const activityListeners = new Set<(activities: PageTranslationActivitySnapshot[]) => void>();
let legacyToken: PageTranslationActivityToken | null = null;

function cloneActivity(activity: ActivePageTranslationActivity): PageTranslationActivitySnapshot {
	return {
		...activity.token,
		target: { ...activity.token.target },
		cancellable: activity.control !== null || activity.token.owner === 'automatic',
		cancelRequested: activity.cancelRequested
	};
}

function snapshotActivities(): PageTranslationActivitySnapshot[] {
	return [...active.values()].map(cloneActivity);
}

function publish(): void {
	const busy = active.size > 0;
	for (const listener of listeners) listener(busy);
	const activities = snapshotActivities();
	for (const listener of activityListeners) listener(activities);
}

export function acquirePageTranslationActivity(
	owner: PageTranslationActivityOwner,
	target: PageTranslationActivityTarget,
	control: PageTranslationActivityControl | null = null
): PageTranslationActivityToken {
	const token = Object.freeze({
		id: ++nextTokenId,
		owner,
		target: Object.freeze({ ...target })
	});
	active.set(token.id, { token, control, cancelRequested: false });
	publish();
	return token;
}

export function releasePageTranslationActivity(token: PageTranslationActivityToken | null | undefined): boolean {
	if (!token || active.get(token.id)?.token !== token) return false;
	active.delete(token.id);
	if (legacyToken === token) legacyToken = null;
	publish();
	return true;
}

export function inspectPageTranslationActivities(): PageTranslationActivityToken[] {
	return [...active.values()].map(({ token }) => ({ ...token, target: { ...token.target } }));
}

export function inspectPageTranslationActivitySnapshots(): PageTranslationActivitySnapshot[] {
	return snapshotActivities();
}

export function markPageTranslationActivityCancelling(
	token: PageTranslationActivityToken | null | undefined
): boolean {
	if (!token) return false;
	const activity = active.get(token.id);
	if (!activity || activity.token !== token || activity.cancelRequested) return false;
	activity.cancelRequested = true;
	publish();
	return true;
}

export interface AutomaticPageTranslationOwner {
	inspectTarget(): PageTranslationActivityTarget | null;
	cancel(): void;
	waitForIdle(): Promise<void>;
}

const automaticOwners = new Set<AutomaticPageTranslationOwner>();

export function registerAutomaticPageTranslationOwner(owner: AutomaticPageTranslationOwner): () => void {
	automaticOwners.add(owner);
	return () => automaticOwners.delete(owner);
}

function sameActivityTarget(
	left: Readonly<PageTranslationActivityTarget>,
	right: Readonly<PageTranslationActivityTarget>
): boolean {
	return left.volumeUuid === right.volumeUuid && left.pageIndex === right.pageIndex;
}

/**
 * Cancel reader-owned work for exactly one volume/page.
 *
 * Volume jobs are deliberately outside this registry. Multiple owners may
 * briefly overlap while manual work supersedes automatic work, so every
 * matching cancellable owner is notified.
 */
export function cancelPageTranslationActivities(
	target: PageTranslationActivityTarget,
	reason: PageTranslationActivityCancelReason = 'explicit-user'
): number {
	const matches = [...active.values()].filter((activity) => sameActivityTarget(activity.token.target, target));
	let cancelled = 0;

	for (const activity of matches) {
		if (!activity.control || activity.cancelRequested) continue;
		activity.cancelRequested = true;
		cancelled += 1;
		try {
			activity.control.cancel(reason);
		} catch (error) {
			console.error('Failed to cancel page translation activity', error);
		}
	}

	// PageViewer historically registered its automatic scheduler separately
	// from its activity token. Keep that adapter cancellable until it supplies a
	// token-local control directly.
	const uncontrolledAutomatic = matches.some((activity) =>
		activity.token.owner === 'automatic' && activity.control === null && !activity.cancelRequested
	);
	if (uncontrolledAutomatic) {
		for (const owner of automaticOwners) {
			const ownerTarget = owner.inspectTarget();
			if (!ownerTarget || !sameActivityTarget(ownerTarget, target)) continue;
			for (const activity of matches) {
				if (activity.token.owner === 'automatic' && !activity.cancelRequested) {
					activity.cancelRequested = true;
					cancelled += 1;
				}
			}
			try {
				owner.cancel();
			} catch (error) {
				console.error('Failed to cancel automatic page translation', error);
			}
		}
	}

	if (cancelled > 0) publish();
	return cancelled;
}

/** Manual work wins only after matching automatic work has fully settled. */
export async function supersedeAutomaticPageTranslation(
	target: PageTranslationActivityTarget,
	signal: AbortSignal
): Promise<void> {
	const matching = [...automaticOwners].filter((owner) => {
		const activeTarget = owner.inspectTarget();
		return activeTarget?.volumeUuid === target.volumeUuid && activeTarget.pageIndex === target.pageIndex;
	});
	for (const owner of matching) owner.cancel();
	if (matching.length === 0) return;
	if (signal.aborted) throw new DOMException('Translation cancelled', 'AbortError');
	let onAbort: (() => void) | null = null;
	try {
		await Promise.race([
			Promise.all(matching.map((owner) => owner.waitForIdle())).then(() => undefined),
			new Promise<never>((_, reject) => {
				onAbort = () => reject(new DOMException('Translation cancelled', 'AbortError'));
				signal.addEventListener('abort', onAbort, { once: true });
			})
		]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

/** Compatibility store. Production owners use acquire/release; set only owns a legacy token. */
export const isPageTranslating = {
	...readable(false, (set) => {
		const listener = (busy: boolean) => set(busy);
		listeners.add(listener);
		set(active.size > 0);
		return () => listeners.delete(listener);
	}),
	set(value: boolean): void {
		if (value && !legacyToken) {
			legacyToken = acquirePageTranslationActivity('legacy', { volumeUuid: '', pageIndex: -1 });
		} else if (!value && legacyToken) {
			releasePageTranslationActivity(legacyToken);
		}
	}
};

export const pageTranslationActivities = readable<PageTranslationActivitySnapshot[]>([], (set) => {
	const listener = (activities: PageTranslationActivitySnapshot[]) => set(activities);
	activityListeners.add(listener);
	set(snapshotActivities());
	return () => activityListeners.delete(listener);
});

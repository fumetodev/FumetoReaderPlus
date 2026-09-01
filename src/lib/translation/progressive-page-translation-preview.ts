import {
	compareAndSetCurrentPageTranslationPayload,
	readCurrentPageTranslationPayload
} from '$lib/stores/translation-state.js';
import type { PageOverlayData, PageTranslation } from '$lib/types/index.js';

export interface ProgressivePageTranslationTarget {
	readerSessionId: string;
	targetEpoch: number;
	volumeUuid: string;
	pageIndex: number;
}

export interface ProgressivePageTranslationSnapshot {
	target: {
		volumeUuid: string;
		pageIndex: number;
	};
	pageTranslation: PageTranslation;
	overlayData: PageOverlayData;
}

export interface ProgressivePageTranslationPreviewToken {
	readonly generation: number;
	readonly target: Readonly<ProgressivePageTranslationTarget>;
}

export interface ProgressivePageTranslationPreviewState {
	generation: number;
	target: ProgressivePageTranslationTarget;
	documentRevision: number | null;
	ownedPayloadVersion: number;
}

export interface ProgressivePageTranslationPreviewPort {
	read(): {
		pageTranslation: PageTranslation | null;
		overlayData: PageOverlayData | null;
		version: number;
	};
	compareAndSet(
		expectedVersion: number,
		pageTranslation: PageTranslation | null,
		overlayData: PageOverlayData | null
	): number | null;
}

export interface ProgressivePageTranslationPreviewCoordinator {
	begin(
		target: Readonly<ProgressivePageTranslationTarget>,
		currentTarget: Readonly<ProgressivePageTranslationTarget> | null
	): ProgressivePageTranslationPreviewToken;
	publish(
		token: ProgressivePageTranslationPreviewToken,
		snapshot: ProgressivePageTranslationSnapshot,
		currentTarget: Readonly<ProgressivePageTranslationTarget> | null
	): boolean;
	commit(
		token: ProgressivePageTranslationPreviewToken,
		snapshot: ProgressivePageTranslationSnapshot,
		currentTarget: Readonly<ProgressivePageTranslationTarget> | null
	): boolean;
	rollback(
		token: ProgressivePageTranslationPreviewToken,
		currentTarget: Readonly<ProgressivePageTranslationTarget> | null
	): 'restored' | 'abandoned' | 'superseded' | 'not-owner';
	abandon(token: ProgressivePageTranslationPreviewToken): boolean;
	inspect(): ProgressivePageTranslationPreviewState | null;
}

interface ActivePreview {
	generation: number;
	target: ProgressivePageTranslationTarget;
	prior: { pageTranslation: PageTranslation | null; overlayData: PageOverlayData | null };
	lastOwnedVersion: number;
	documentRevision: number | null;
	serializedSnapshot: string | null;
}

function copyTarget(target: Readonly<ProgressivePageTranslationTarget>): ProgressivePageTranslationTarget {
	return {
		readerSessionId: target.readerSessionId,
		targetEpoch: target.targetEpoch,
		volumeUuid: target.volumeUuid,
		pageIndex: target.pageIndex
	};
}

export function sameProgressivePageTranslationTarget(
	left: Readonly<ProgressivePageTranslationTarget> | null,
	right: Readonly<ProgressivePageTranslationTarget> | null
): boolean {
	return !!left && !!right
		&& left.readerSessionId === right.readerSessionId
		&& left.targetEpoch === right.targetEpoch
		&& left.volumeUuid === right.volumeUuid
		&& left.pageIndex === right.pageIndex;
}

function validateTarget(target: Readonly<ProgressivePageTranslationTarget>): void {
	if (!target.readerSessionId || !target.volumeUuid) throw new TypeError('Progressive preview target is incomplete');
	if (!Number.isSafeInteger(target.targetEpoch) || target.targetEpoch < 0) {
		throw new TypeError('Progressive preview target epoch is invalid');
	}
	if (!Number.isSafeInteger(target.pageIndex) || target.pageIndex < 0) {
		throw new TypeError('Progressive preview page index is invalid');
	}
}

function validateSnapshot(
	target: Readonly<ProgressivePageTranslationTarget>,
	snapshot: ProgressivePageTranslationSnapshot
): void {
	if (
		snapshot.target.volumeUuid !== target.volumeUuid
		|| snapshot.target.pageIndex !== target.pageIndex
		|| snapshot.pageTranslation.volume_uuid !== target.volumeUuid
		|| snapshot.pageTranslation.page_index !== target.pageIndex
	) throw new TypeError('Progressive preview snapshot belongs to another page');
	if (snapshot.pageTranslation.overlay_data !== snapshot.overlayData) {
		throw new TypeError('Progressive preview translation and overlay are not one coherent snapshot');
	}
	if (!Number.isSafeInteger(snapshot.overlayData.documentRevision) || snapshot.overlayData.documentRevision < 1) {
		throw new TypeError('Progressive preview document revision is invalid');
	}
	const entryById = new Map(snapshot.pageTranslation.entries.map((entry) => [entry.id, entry]));
	for (const item of snapshot.overlayData.items) {
		const entry = entryById.get(item.translationEntryId);
		if (!entry || entry.overlayItemId !== item.id) {
			throw new TypeError(`Progressive preview item ${item.id} has no matching translation entry`);
		}
	}
}

function serializeSnapshot(snapshot: ProgressivePageTranslationSnapshot): string {
	return JSON.stringify(snapshot);
}

export function createProgressivePageTranslationPreviewCoordinator(
	port: ProgressivePageTranslationPreviewPort
): ProgressivePageTranslationPreviewCoordinator {
	let nextGeneration = 0;
	let active: ActivePreview | null = null;

	const owns = (token: ProgressivePageTranslationPreviewToken): boolean => (
		active?.generation === token.generation
		&& sameProgressivePageTranslationTarget(active.target, token.target)
	);

	const abandonForTargetMismatch = (
		token: ProgressivePageTranslationPreviewToken,
		currentTarget: Readonly<ProgressivePageTranslationTarget> | null
	): boolean => {
		if (!owns(token)) return true;
		if (sameProgressivePageTranslationTarget(token.target, currentTarget)) return false;
		active = null;
		return true;
	};

	const publish = (
		token: ProgressivePageTranslationPreviewToken,
		snapshot: ProgressivePageTranslationSnapshot,
		currentTarget: Readonly<ProgressivePageTranslationTarget> | null
	): boolean => {
		if (!owns(token) || abandonForTargetMismatch(token, currentTarget)) return false;
		validateSnapshot(token.target, snapshot);
		const revision = snapshot.overlayData.documentRevision;
		const serialized = serializeSnapshot(snapshot);
		if (active!.documentRevision !== null) {
			if (revision < active!.documentRevision) {
				throw new TypeError('Progressive preview document revision moved backwards');
			}
			if (revision === active!.documentRevision && serialized !== active!.serializedSnapshot) {
				throw new TypeError('Progressive preview reused a revision for different content');
			}
		}
		const nextVersion = port.compareAndSet(
			active!.lastOwnedVersion,
			snapshot.pageTranslation,
			snapshot.overlayData
		);
		if (nextVersion === null) {
			active = null;
			return false;
		}
		// Store subscribers run synchronously and may themselves publish a newer
		// same-page payload before compareAndSet returns. In that case this exact
		// version is no longer current, so the preview must relinquish ownership.
		if (port.read().version !== nextVersion) {
			active = null;
			return false;
		}
		active!.lastOwnedVersion = nextVersion;
		active!.documentRevision = revision;
		active!.serializedSnapshot = serialized;
		return true;
	};

	return {
		begin(target, currentTarget) {
			validateTarget(target);
			if (!sameProgressivePageTranslationTarget(target, currentTarget)) {
				throw new TypeError('Cannot begin a progressive preview for a stale reader target');
			}
			const observed = port.read();
			const prior = active
				&& sameProgressivePageTranslationTarget(active.target, target)
				&& active.lastOwnedVersion === observed.version
				? active.prior
				: {
					pageTranslation: observed.pageTranslation,
					overlayData: observed.overlayData
				};
			const generation = ++nextGeneration;
			const copiedTarget = copyTarget(target);
			active = {
				generation,
				target: copiedTarget,
				prior,
				lastOwnedVersion: observed.version,
				documentRevision: null,
				serializedSnapshot: null
			};
			return Object.freeze({ generation, target: Object.freeze(copyTarget(copiedTarget)) });
		},
		publish,
		commit(token, snapshot, currentTarget) {
			if (!publish(token, snapshot, currentTarget)) return false;
			active = null;
			return true;
		},
		rollback(token, currentTarget) {
			if (!owns(token)) return 'not-owner';
			if (!sameProgressivePageTranslationTarget(token.target, currentTarget)) {
				active = null;
				return 'abandoned';
			}
			const prior = active!.prior;
			const lastOwnedVersion = active!.lastOwnedVersion;
			active = null;
			if (port.compareAndSet(
				lastOwnedVersion,
				prior.pageTranslation,
				prior.overlayData
			) === null) return 'superseded';
			return 'restored';
		},
		abandon(token) {
			if (!owns(token)) return false;
			active = null;
			return true;
		},
		inspect() {
			return active ? {
				generation: active.generation,
				target: copyTarget(active.target),
				documentRevision: active.documentRevision,
				ownedPayloadVersion: active.lastOwnedVersion
			} : null;
		}
	};
}

export const progressivePageTranslationPreview = createProgressivePageTranslationPreviewCoordinator({
	read: readCurrentPageTranslationPayload,
	compareAndSet: compareAndSetCurrentPageTranslationPayload
});

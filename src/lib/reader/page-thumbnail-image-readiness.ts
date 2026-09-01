export interface ThumbnailImageRenderIdentity {
	slot: number;
	index: number;
	url: string;
}

export interface ThumbnailImageReadyCandidate {
	expected: ThumbnailImageRenderIdentity;
	current: ThumbnailImageRenderIdentity | null;
	attemptToken: number;
	currentAttemptToken: number | undefined;
	connected: boolean;
	complete: boolean;
	naturalWidth: number;
	naturalHeight: number;
	renderedWidth: number;
	renderedHeight: number;
}

export type ThumbnailLoadStatus = 'idle' | 'queued' | 'loading' | 'loaded' | 'error';

export function sameThumbnailImageRender(
	left: ThumbnailImageRenderIdentity | null | undefined,
	right: ThumbnailImageRenderIdentity | null | undefined,
): boolean {
	return Boolean(left && right
		&& left.slot === right.slot
		&& left.index === right.index
		&& left.url === right.url);
}

/**
 * A generated object URL is not presentation evidence. Only publish a
 * thumbnail as loaded after the image mounted in this exact physical carousel
 * slot has decoded, occupied a rendered box, and survived the paint gate.
 *
 * The attempt token matters even when an away/back gesture returns the same
 * page and URL to the same slot: a late continuation from the first mount must
 * not certify the replacement image.
 */
export function canPublishThumbnailImageReady(candidate: ThumbnailImageReadyCandidate): boolean {
	return candidate.attemptToken === candidate.currentAttemptToken
		&& sameThumbnailImageRender(candidate.expected, candidate.current)
		&& candidate.connected
		&& candidate.complete
		&& candidate.naturalWidth > 0
		&& candidate.naturalHeight > 0
		&& candidate.renderedWidth > 0
		&& candidate.renderedHeight > 0;
}

/** Translate internal URL-generation state into the state exposed to tests and
 * accessibility tooling. A cached URL remains `loading` in a newly reused slot
 * until that slot's concrete image has passed the decode/paint gate. */
export function getPublishedThumbnailState(
	loadStatus: ThumbnailLoadStatus,
	render: ThumbnailImageRenderIdentity | null,
	readyRender: ThumbnailImageRenderIdentity | null | undefined,
): ThumbnailLoadStatus {
	if (loadStatus !== 'loaded') return loadStatus;
	return sameThumbnailImageRender(render, readyRender) ? 'loaded' : 'loading';
}

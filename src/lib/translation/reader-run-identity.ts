export interface ReaderTranslationRunIdentity {
	runId: number;
	targetEpoch: number;
	volumeUuid: string;
	pageIndex: number;
	signal: AbortSignal;
}

/**
 * Whether a run still belongs to the reader target that started it.
 *
 * This intentionally ignores cancellation. An aborted run may still need to
 * publish user-facing cancellation feedback, but it must never do so after the
 * user navigates away or a newer run supersedes it.
 */
export function isReaderTranslationTargetCurrent(
	run: ReaderTranslationRunIdentity,
	currentRunId: number,
	currentTargetEpoch: number,
	currentVolumeUuid: string | null,
	currentPageIndex: number
): boolean {
	return run.runId === currentRunId
		&& run.targetEpoch === currentTargetEpoch
		&& run.volumeUuid === currentVolumeUuid
		&& run.pageIndex === currentPageIndex;
}

/**
 * Reader translations may complete long after navigation. Keep all publication
 * decisions tied to the exact run, volume, and page that started the work.
 */
export function isReaderTranslationRunRelevant(
	run: ReaderTranslationRunIdentity,
	currentRunId: number,
	currentTargetEpoch: number,
	currentVolumeUuid: string | null,
	currentPageIndex: number
): boolean {
	return !run.signal.aborted
		&& isReaderTranslationTargetCurrent(
			run,
			currentRunId,
			currentTargetEpoch,
			currentVolumeUuid,
			currentPageIndex
		);
}

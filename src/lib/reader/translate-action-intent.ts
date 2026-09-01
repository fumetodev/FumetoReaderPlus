/**
 * What a tap on the compact Translate action should do, given the current
 * page-translation state. Pure so the bar's behavior is unit-testable:
 * cancellable runs cancel, a translation failure opens the details dialog,
 * other terminal states acknowledge in place, and an idle page starts a run
 * directly.
 *
 * A failed overlay LAYOUT is deliberately not a details state. Its message is
 * already on screen (the reader's dismissible layout-error banner), and the
 * only recovery is a fresh translation run — which used to require a detour
 * through the globe menu's "Translate whole page". The tap now IS that run.
 */

export type TranslateActionIntent = 'cancel' | 'ack' | 'show-failure' | 'start' | 'none';

export interface TranslateActionState {
	translating: boolean;
	translationCancellable: boolean;
	translationCancelling: boolean;
	translationTerminal: 'completed' | 'saved' | 'cancelled' | 'failed' | null;
	overlayPlanningBusy: boolean;
	overlayPlanningFailed: boolean;
}

export function decideTranslateActionIntent(state: TranslateActionState): TranslateActionIntent {
	if (state.translating && state.translationCancellable && !state.translationCancelling) return 'cancel';
	// Busy but not cancellable (or already cancelling): the button is a
	// progress indicator; a tap does nothing.
	if (state.translating || state.translationCancelling || state.overlayPlanningBusy) return 'none';
	// The translation's own failure is only shown in the status dialog, so
	// that state must still route there.
	if (state.translationTerminal === 'failed') return 'show-failure';
	if (state.overlayPlanningFailed) return 'start';
	if (state.translationTerminal) return 'ack';
	return 'start';
}

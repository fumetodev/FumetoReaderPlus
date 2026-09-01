/**
 * Single-tap ownership between overlay pointer handlers and the reader's
 * touch-gesture machinery.
 *
 * One physical tap raises pointer events AND touch events on the same
 * elements. Overlay surfaces (long-pressed boxes, the guided-region review
 * canvas) act on pointer events, which Chromium delivers BEFORE the paired
 * touchend; PageViewer's page-gesture machinery acts on the touchend. Without
 * an ownership signal both act on the same contact: the machinery's
 * disclosure guard closes the popover the pointer handler just opened, chrome
 * toggles under a selection gesture, and the two handlers oscillate.
 *
 * Protocol: a pointer-level handler that fully handled the current contact
 * calls {@link claimReaderTapGesture}. The machinery calls
 * {@link consumeReaderTapClaim} in touchend and stands down when it returns
 * true. Every touchstart/touchcancel resets the claim so a leaked claim can
 * never outlive its own gesture and eat a later tap.
 */

let claimed = false;

/** Mark the in-flight contact as fully handled by an overlay surface. */
export function claimReaderTapGesture(): void {
	claimed = true;
}

/** Read-and-clear the claim; true means the machinery must stand down. */
export function consumeReaderTapClaim(): boolean {
	const wasClaimed = claimed;
	claimed = false;
	return wasClaimed;
}

/** Drop any stale claim at gesture boundaries (touchstart / touchcancel). */
export function resetReaderTapClaim(): void {
	claimed = false;
}

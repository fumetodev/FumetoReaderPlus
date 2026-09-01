/**
 * Scroll-edge affordance for panels whose scrollbars are globally hidden
 * (app.css removes every scrollbar): with no thumb to see, an overflowing menu
 * ends flush and looks complete while rows sit unreachable below the fold.
 * While content overflows and the view is not at the end, the node carries
 * `data-scroll-edge-fade="true"`, which CSS turns into a bottom fade mask.
 */

/** True when scrollable content extends beyond the current view bottom. */
export function hasHiddenScrollContent(
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	epsilon = 4
): boolean {
	if (scrollHeight <= clientHeight + epsilon) return false;
	return scrollTop + clientHeight < scrollHeight - epsilon;
}

/** Svelte action keeping `data-scroll-edge-fade` in sync on a scrollable node. */
export function scrollEdgeFade(node: HTMLElement): { destroy(): void } {
	const update = () => {
		if (hasHiddenScrollContent(node.scrollTop, node.clientHeight, node.scrollHeight)) {
			node.setAttribute('data-scroll-edge-fade', 'true');
		} else {
			node.removeAttribute('data-scroll-edge-fade');
		}
	};
	node.addEventListener('scroll', update, { passive: true });
	const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
	resizeObserver?.observe(node);
	// Content can grow without the clamped panel resizing (an error row
	// appearing, a fieldset enabling) — watch the subtree, not just the box.
	const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
	mutationObserver?.observe(node, { childList: true, subtree: true });
	update();
	return {
		destroy() {
			node.removeEventListener('scroll', update);
			resizeObserver?.disconnect();
			mutationObserver?.disconnect();
		}
	};
}

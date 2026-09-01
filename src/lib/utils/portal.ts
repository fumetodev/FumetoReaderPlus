/**
 * Svelte action: re-parents the element to `document.body` on mount.
 *
 * Viewport-anchored elements (`position: fixed` modals and scrims) must not be
 * rendered inside a subtree whose ancestor has a `transform`, `filter`, or
 * `backdrop-filter` — any of those turns the ancestor into the containing
 * block for fixed-position descendants, so `inset: 0` resolves against the
 * ancestor's box instead of the screen. The reader chrome does exactly that:
 * the header/bottom-bar wrappers slide with `transform: translateY(...)` and
 * the header uses `backdrop-blur`. Portaling to <body> restores true viewport
 * coordinates regardless of where the component is mounted.
 */
export function portal(node: HTMLElement): { destroy(): void } {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
}

/**
 * fadeOnDecode — Svelte action for <img>: freshly-loaded images fade in over
 * --motion-fast instead of popping; images that are already decoded (warm
 * cache, object-URL swaps that resolve synchronously) render instantly with
 * no dimming, so warm paths never flash. Reduced motion collapses the fade
 * via the global CSS escape hatch (it's a plain CSS transition).
 *
 * Also sets decoding="async" (never block the main thread on decode) unless
 * the element opted out explicitly.
 */
export function fadeOnDecode(node: HTMLImageElement): { destroy(): void } {
	if (!node.hasAttribute('decoding')) node.decoding = 'async';

	let raf = 0;

	const reveal = () => {
		node.classList.remove('fade-on-decode-pending');
		node.classList.add('fade-on-decode-reveal');
	};

	const arm = () => {
		// Complete before we ever painted → cache hit: skip the fade entirely.
		if (node.complete && node.naturalWidth > 0) {
			node.classList.remove('fade-on-decode-pending');
			return;
		}
		node.classList.add('fade-on-decode-pending');
	};

	const onLoad = () => {
		// Class flip on the next frame so the pending state actually commits
		// first; otherwise the browser may coalesce and skip the transition.
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(reveal);
	};

	const onError = () => {
		// Never leave a broken image invisible.
		node.classList.remove('fade-on-decode-pending');
	};

	arm();
	node.addEventListener('load', onLoad);
	node.addEventListener('error', onError);

	return {
		destroy() {
			cancelAnimationFrame(raf);
			node.removeEventListener('load', onLoad);
			node.removeEventListener('error', onError);
		}
	};
}

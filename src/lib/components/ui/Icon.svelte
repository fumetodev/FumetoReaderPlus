<script lang="ts" module>
	/**
	 * The app's single icon set: vendored Lucide-style geometry on a 24-grid,
	 * stroke-drawn (1.8 default, round caps/joins). Dots are zero-length round-cap
	 * strokes (`h.01`), the Lucide idiom, so they scale with stroke width.
	 * Add icons here rather than inlining ad-hoc SVGs in components; `data-icon`
	 * on the rendered <svg> is the stable identity tests may assert on.
	 */
	const ICONS = {
		tabs: '<rect x="4" y="6" width="13" height="14" rx="3"/><path d="M8 6V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-1"/>',
		// An open book, not the old shelf-of-three. That one was drawn as one
		// path of unclosed subpaths: the tilted volume never returned to its
		// start, so its spine edge was simply missing, and the first volume's
		// `z` doubled back over its own left edge and left a spur below the
		// rounded corner. At 22 px the result read as a flap peeling off a
		// card. This shape is also the one silhouette in the dock that is not
		// a rounded rectangle — `tabs` already owns layered cards.
		library:
			'<path d="M12 6.5C10.5 5 8.5 4.2 6 4.2c-1 0-2 .15-3 .45V19c1-.3 2-.45 3-.45 2.5 0 4.5.8 6 2.25 1.5-1.45 3.5-2.25 6-2.25 1 0 2 .15 3 .45V4.65c-1-.3-2-.45-3-.45-2.5 0-4.5.8-6 2.3z"/><path d="M12 6.5v14.3"/>',
		// Generated, not hand-drawn: an exact 8-tooth gear (tips on a 9.4 circle,
		// roots on 7.1, tooth half-widths 9.5°/13°, teeth at -90° + k·45°), so it
		// is rotationally symmetric by construction and mirror-symmetric about
		// both axes. The previous glyph was eyeballed and its teeth landed
		// unevenly — visibly lopsided in the reader menu. Regenerate with
		// scripts/generate-gear-icon.mjs rather than editing coordinates.
		settings:
			'<circle cx="12" cy="12" r="3.2"/><path d="M10.4 5.08L10.45 2.73A9.4 9.4 0 0 1 13.55 2.73L13.6 5.08A7.1 7.1 0 0 1 15.76 5.98L17.46 4.35A9.4 9.4 0 0 1 19.65 6.54L18.02 8.24A7.1 7.1 0 0 1 18.92 10.4L21.27 10.45A9.4 9.4 0 0 1 21.27 13.55L18.92 13.6A7.1 7.1 0 0 1 18.02 15.76L19.65 17.46A9.4 9.4 0 0 1 17.46 19.65L15.76 18.02A7.1 7.1 0 0 1 13.6 18.92L13.55 21.27A9.4 9.4 0 0 1 10.45 21.27L10.4 18.92A7.1 7.1 0 0 1 8.24 18.02L6.54 19.65A9.4 9.4 0 0 1 4.35 17.46L5.98 15.76A7.1 7.1 0 0 1 5.08 13.6L2.73 13.55A9.4 9.4 0 0 1 2.73 10.45L5.08 10.4A7.1 7.1 0 0 1 5.98 8.24L4.35 6.54A9.4 9.4 0 0 1 6.54 4.35L8.24 5.98A7.1 7.1 0 0 1 10.4 5.08z"/>',
		'chevron-left': '<path d="M15 18l-6-6 6-6"/>',
		'chevron-right': '<path d="M9 18l6-6-6-6"/>',
		'more-vertical': '<path d="M12 5h.01M12 12h.01M12 19h.01"/>',
		search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
		x: '<path d="M6 6l12 12M18 6L6 18"/>',
		play: '<path d="M7.5 5.2a1 1 0 0 1 1.5-.87l11 6.3a1 1 0 0 1 0 1.74l-11 6.3a1 1 0 0 1-1.5-.87z"/>',
		check: '<path d="M20 6L9 17l-5-5"/>',
		folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
		globe:
			'<circle cx="12" cy="12" r="9"/><path d="M3.5 12h17M12 3.5c2.6 2.5 3.9 5.4 3.9 8.5s-1.3 6-3.9 8.5C9.4 18 8.1 15.1 8.1 12S9.4 6 12 3.5z"/>',
		calendar:
			'<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 10.5h16"/>',
		'arrow-down-up': '<path d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3"/>',
		'grid-3': '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
		'grid-2': '<rect x="4" y="5" width="7" height="14" rx="1.5"/><rect x="13" y="5" width="7" height="14" rx="1.5"/>',
		list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
		star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
		clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/>',
		download: '<path d="M12 3v12M7 10l5 5 5-5M4.5 20.5h15"/>',
		trash:
			'<path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12"/><path d="M10 11v6M14 11v6"/>'
	} as const;

	export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
	interface Props {
		name: IconName;
		/** Rendered box in px (viewBox stays 24). */
		size?: number;
		strokeWidth?: number;
		class?: string;
	}

	let { name, size = 22, strokeWidth = 1.8, class: className = '' }: Props = $props();
</script>

<svg
	class={className}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	data-icon={name}
>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- static vendored geometry, never user input -->
	{@html ICONS[name]}
</svg>

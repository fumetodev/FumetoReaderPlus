<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * Shared shell for the interactive Help figures: renders a replica of a
	 * piece of app UI (provided as a snippet), tracks which element the user
	 * tapped, and shows that element's name + description underneath.
	 *
	 * The replica snippet receives { selected, select } and is expected to
	 * render its controls as buttons that call select(id) and highlight
	 * themselves when selected === id.
	 */
	import type { Snippet } from 'svelte';

	export interface HelpFigurePart {
		id: string;
		label: string;
		description: string;
	}

	interface Props {
		/** Stable, locale-independent id — the locator tests and the screenshot generator address the figure by it. */
	id: string;
	title: string;
		parts: HelpFigurePart[];
		figure: Snippet<[{ selected: string | null; select: (id: string) => void }]>;
	}

	let { id, title, parts, figure }: Props = $props();

	let selected = $state<string | null>(null);
	const select = (id: string) => {
		selected = selected === id ? null : id;
	};
	let active = $derived(parts.find((part) => part.id === selected) ?? null);
</script>

<div class="my-3 rounded-lg border border-surface-700 bg-surface-950/60 p-3" data-help-interactive={id}>
	<p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-surface-500">{m.help_fig_header({ title })}</p>
	{@render figure({ selected, select })}
	<div class="mt-2 min-h-[44px] rounded-md bg-surface-800/70 px-3 py-2" data-help-interactive-description aria-live="polite">
		{#if active}
			<p class="text-xs font-medium text-surface-200">{active.label}</p>
			<p class="mt-0.5 text-[11px] leading-relaxed text-surface-400">{active.description}</p>
		{:else}
			<p class="text-[11px] italic text-surface-500">{m.help_fig_tap_any_control_in()}</p>
		{/if}
	</div>
</div>

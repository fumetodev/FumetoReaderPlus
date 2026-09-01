<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		pressed?: boolean;
		expanded?: boolean;
		controls?: string;
		disabled?: boolean;
		title?: string;
		class?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	}

	let {
		label, pressed, expanded, controls, disabled = false, title, class: className = '', onclick, children
	}: Props = $props();
</script>

<button
	type="button"
	class="press-feedback flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-xl {className}"
	aria-label={label}
	aria-pressed={pressed}
	aria-expanded={expanded}
	aria-controls={controls}
	{disabled}
	{title}
	{onclick}
>
	{@render children()}
</button>

<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		columns: 1 | 2 | 3;
		label?: string;
		class?: string;
		style?: string;
		children: Snippet;
	}

	let { columns, label, class: className = '', style = '', children }: Props = $props();
</script>

<div
	class="grid min-w-0 gap-2 {className}"
	style={`grid-template-columns:repeat(${columns},minmax(0,1fr));${style}`}
	role={label ? 'group' : undefined}
	aria-label={label}
	data-reader-action-row
>
	{@render children()}
</div>

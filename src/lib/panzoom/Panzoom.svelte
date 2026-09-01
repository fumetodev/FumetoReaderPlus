<script lang="ts">
	import { initPanzoom } from './util.js';

	interface Props {
		children?: import('svelte').Snippet;
	}

	let { children }: Props = $props();
</script>

<div use:initPanzoom style="display: inline-block; transform-origin: 0 0;">
	{@render children?.()}
</div>

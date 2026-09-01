<script lang="ts">
	import { parseRichMessage, type RichNode } from '$lib/i18n/rich-message.js';

	let {
		message,
		links = {},
		emClass = 'text-surface-200',
		codeClass = 'rounded bg-surface-800 px-1 font-mono text-[0.9em]',
		linkClass = 'text-primary-400 underline'
	}: {
		message: string;
		/** Handlers by `<link name="…">`; a link with no handler renders as emphasised text. */
		links?: Record<string, () => void>;
		emClass?: string;
		codeClass?: string;
		linkClass?: string;
	} = $props();

	const nodes = $derived(parseRichMessage(message));
</script>

{#snippet render(items: RichNode[])}
	{#each items as node, index (index)}
		{#if node.kind === 'text'}{node.text}{:else if node.kind === 'br'}<br />{:else if node.kind === 'em'}<span class={emClass}>{@render render(node.children)}</span>{:else if node.kind === 'code'}<code class={codeClass}>{@render render(node.children)}</code>{:else if node.kind === 'link'}{#if links[node.name]}<button type="button" class={linkClass} onclick={links[node.name]}>{@render render(node.children)}</button>{:else}<span class={emClass}>{@render render(node.children)}</span>{/if}{/if}
	{/each}
{/snippet}

{@render render(nodes)}

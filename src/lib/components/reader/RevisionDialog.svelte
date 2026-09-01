<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { fade, scale } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { portal } from '$lib/utils/portal.js';

	interface Props {
		scope: 'box' | 'page';
		targetOrder?: number | null;
		onsubmit: (instructions: string) => void;
		onclose: () => void;
	}

	let { scope, targetOrder = null, onsubmit, onclose }: Props = $props();

	let instructions = $state('');

	let title = $derived(
		scope === 'box' && targetOrder !== null
			? `Revise Entry #${targetOrder}`
			: 'Revise Page'
	);

	let placeholder = $derived(
		scope === 'box'
			? 'e.g., "The speaker is female, adjust pronouns" or "Make this more casual"'
			: 'e.g., "The main character is female" or "Use a more formal tone throughout"'
	);

	function handleSubmit() {
		if (!instructions.trim()) return;
		onsubmit(instructions.trim());
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleSubmit();
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	use:portal
	class="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-scrim-modal)] p-4"
	onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}
	in:fade={{ duration: motionDuration(150) }}
	out:fade={{ duration: motionDuration(exitDuration(150)) }}
	data-revision-dialog-backdrop
>
	<div
		class="w-full max-w-md rounded-[var(--radius-panel)] bg-surface-container-high p-6 shadow-2xl"
		in:scale={{ duration: motionDuration(150), start: 0.95 }}
		out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		role="dialog"
		aria-modal="true"
		aria-label={title}
		data-revision-dialog
	>
		<h2 class="mb-1 text-lg font-semibold text-surface-100">{title}</h2>
		<p class="mb-4 text-xs text-surface-500">
			{m.reader_describe_how_you_want()}
		</p>

		<textarea
			bind:value={instructions}
			{placeholder}
			rows="4"
			onkeydown={handleKeydown}
			class="w-full resize-y rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
		></textarea>

		<p class="mt-1.5 text-[10px] text-surface-600">
			{#if scope === 'box'}
				{m.reader_only_this_entry_will()}
			{:else}
				{m.reader_all_entries_on_this()}
			{/if}
		</p>

		<div class="mt-4 flex justify-end gap-2">
			<button
				onclick={onclose}
				class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200"
			>
				{m.common_cancel()}
			</button>
			<button
				onclick={handleSubmit}
				disabled={!instructions.trim()}
				class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{m.reader_revise()}
			</button>
		</div>
	</div>
</div>

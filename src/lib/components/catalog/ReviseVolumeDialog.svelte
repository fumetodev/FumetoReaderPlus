<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { motionDuration } from '$lib/util/motion.js';
	import { fade, scale } from 'svelte/transition';
	import type { VolumeMetadata } from '$lib/types/index.js';

	interface Props {
		volume: VolumeMetadata | null;
		onsubmit: (instructions: string) => void;
		onclose: () => void;
	}

	let { volume, onclose, onsubmit }: Props = $props();

	let instructions = $state('');

	// Reset form when dialog opens
	$effect(() => {
		if (volume) {
			instructions = '';
		}
	});

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

{#if volume}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}
		transition:fade={{ duration: motionDuration(150) }}
	>
		<div
			class="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			transition:scale={{ duration: motionDuration(150), start: 0.95 }}
		>
			<h2 class="mb-1 text-lg font-semibold text-surface-100">{m.catalog_revise_translation()}</h2>
			<p class="mb-4 truncate text-xs text-surface-500" title={volume.title}>
				{volume.title} · {volume.page_count} pages
			</p>

			<div class="mb-4">
				<label for="revision-instructions" class="mb-1.5 block text-sm font-medium text-surface-300">
					{m.catalog_revision_instructions()}
				</label>
				<textarea
					id="revision-instructions"
					bind:value={instructions}
					placeholder={m.catalog_e_g_the_main()}
					rows="4"
					onkeydown={handleKeydown}
					class="w-full resize-y rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
				></textarea>
				<p class="mt-1.5 text-[10px] text-surface-500">
					{m.catalog_all_translated_pages_will()}
				</p>
			</div>

			<div class="flex justify-end gap-2">
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
					{m.catalog_start_revision()}
				</button>
			</div>
		</div>
	</div>
{/if}

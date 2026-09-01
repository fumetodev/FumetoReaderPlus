<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { LLMModel } from '$lib/translation/llm-types.js';

	interface Props {
		id: string;
		models: LLMModel[];
		value: string;
		onselect: (modelId: string) => void;
		formatPrice: (price: string) => string;
	}

	let { id, models, value, onselect, formatPrice }: Props = $props();

	const RENDER_CAP = 50;

	let open = $state(false);
	let filter = $state('');
	let highlightIndex = $state(0);
	let inputElement = $state<HTMLInputElement | null>(null);

	let filtered = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		if (q === '') return models;
		return models.filter(
			(m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)
		);
	});
	let visible = $derived(filtered.slice(0, RENDER_CAP));
	let selected = $derived(models.find((m) => m.id === value) ?? null);

	function openList() {
		open = true;
		filter = '';
		highlightIndex = Math.max(0, filtered.findIndex((m) => m.id === value));
	}

	function close() {
		open = false;
		filter = '';
	}

	function choose(modelId: string) {
		onselect(modelId);
		close();
		inputElement?.blur();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
			event.preventDefault();
			openList();
			return;
		}
		if (!open) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			highlightIndex = Math.min(visible.length - 1, highlightIndex + 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			highlightIndex = Math.max(0, highlightIndex - 1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const pick = visible[highlightIndex];
			if (pick) choose(pick.id);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}

	// Keep highlight in range as the filter narrows.
	$effect(() => {
		if (highlightIndex >= visible.length) highlightIndex = Math.max(0, visible.length - 1);
	});
</script>

<div class="relative">
	<input
		bind:this={inputElement}
		{id}
		type="text"
		role="combobox"
		aria-expanded={open}
		aria-controls={`${id}-listbox`}
		aria-activedescendant={open && visible[highlightIndex] ? `${id}-option-${highlightIndex}` : undefined}
		aria-autocomplete="list"
		value={open ? filter : (selected?.name ?? value)}
		placeholder={open ? m.settings_type_to_filter_models() : m.settings_select_a_model()}
		onfocus={openList}
		oninput={(e) => { filter = (e.target as HTMLInputElement).value; highlightIndex = 0; }}
		onkeydown={onKeydown}
		onblur={() => setTimeout(close, 150)}
		class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
	/>
	{#if open}
		<ul
			id={`${id}-listbox`}
			role="listbox"
			class="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-surface-600 bg-surface-800 py-1 shadow-xl"
		>
			{#if visible.length === 0}
				<li class="px-2.5 py-1.5 text-[11px] text-surface-500">{m.settings_no_models_match({ filter })}</li>
			{:else}
				{#each visible as model, index (model.id)}
					<li
						id={`${id}-option-${index}`}
						role="option"
						aria-selected={model.id === value}
					>
						<button
							type="button"
							onmousedown={(e) => { e.preventDefault(); choose(model.id); }}
							class="block w-full px-2.5 py-1.5 text-left transition-colors {index === highlightIndex ? 'bg-primary-600/20' : 'hover:bg-surface-700/60'}"
						>
							<span class="flex items-center gap-1.5">
								<span class="truncate text-xs {model.id === value ? 'text-primary-300' : 'text-surface-200'}">{model.name || model.id}</span>
								{#if model.supportsVision}
									<span class="shrink-0 rounded bg-teal-600/20 px-1 py-px text-[10px] font-medium text-teal-300">vision</span>
								{/if}
							</span>
							<span class="mt-0.5 block truncate text-[11px] text-surface-500">
								{model.id}{model.pricing ? m.settings_in_prompt_out_completion({ prompt: formatPrice(model.pricing.prompt), completion: formatPrice(model.pricing.completion) }) : ''}
							</span>
						</button>
					</li>
				{/each}
				{#if filtered.length > RENDER_CAP}
					<li class="px-2.5 py-1.5 text-[11px] text-surface-500">
						{m.settings_models_more_keep_typing({ n: filtered.length - RENDER_CAP })}
					</li>
				{/if}
			{/if}
		</ul>
	{/if}
</div>

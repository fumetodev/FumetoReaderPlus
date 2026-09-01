<script lang="ts">
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	/**
	 * Settings switch row: label (plus optional sublabel) on the left, a
	 * 48×28 tonal track on the right, the whole row a ≥44px touch target.
	 * The real checkbox input stretches invisibly across the row — it stays
	 * hit-testable and actionable, so `check()`/`toBeChecked()` and anchor-
	 * scoped `input` locators keep working unchanged. opacity is 0.01, not 0:
	 * WebdriverIO's isDisplayed treats exactly-zero opacity as hidden, and the
	 * live e2e specs interact with these inputs directly.
	 */
	interface Props {
		checked?: boolean;
		disabled?: boolean;
		label: string;
		sublabel?: string;
		onchange?: (event: Event) => void;
		dataTestid?: string;
	}

	let { checked = $bindable(false), disabled = false, label, sublabel, onchange, dataTestid }: Props = $props();

	function handleChange(event: Event): void {
		playReaderHaptic('selection');
		onchange?.(event);
	}
</script>

<label class="relative flex min-h-[44px] select-none items-center justify-between gap-4 {disabled ? 'cursor-not-allowed' : 'cursor-pointer'}">
	<input
		type="checkbox"
		role="switch"
		class="absolute inset-0 z-[1] m-0 h-full w-full appearance-none opacity-[0.01] {disabled ? 'cursor-not-allowed' : 'cursor-pointer'}"
		bind:checked
		{disabled}
		onchange={handleChange}
		data-testid={dataTestid}
		aria-label={label}
	/>
	<span class="min-w-0 flex-1">
		<span class="block text-sm {disabled ? 'text-surface-500' : 'text-surface-200'}">{label}</span>
		{#if sublabel}
			<span class="mt-0.5 block text-[11px] text-surface-500">{sublabel}</span>
		{/if}
	</span>
	<span class="switch-track relative h-[28px] w-[48px] shrink-0 rounded-full bg-surface-700 {disabled ? 'opacity-50' : ''}" aria-hidden="true">
		<span class="switch-thumb absolute left-[3px] top-[3px] h-[22px] w-[22px] rounded-full bg-surface-300"></span>
	</span>
</label>

<style>
	.switch-track {
		transition: background-color 120ms var(--ease-standard);
	}
	.switch-thumb {
		transition:
			translate 200ms var(--ease-spring),
			background-color 120ms var(--ease-standard);
	}
	input:checked ~ .switch-track {
		background-color: var(--color-primary-600);
	}
	input:checked ~ .switch-track > .switch-thumb {
		translate: 20px 0;
		background-color: white;
	}
	input:focus-visible ~ .switch-track {
		outline: 2px solid var(--color-primary-400);
		outline-offset: 2px;
	}
</style>

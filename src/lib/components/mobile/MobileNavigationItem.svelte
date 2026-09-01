<script lang="ts">
	import { playReaderHaptic } from '$lib/reader/reader-haptics.js';
	import Icon, { type IconName } from '$lib/components/ui/Icon.svelte';
	interface Props {
		label: string;
		icon: IconName;
		active?: boolean;
		disabled?: boolean;
		onclick: () => void | Promise<void>;
		dataDestination?: string;
		dataReaderControl?: string;
		dataReaderTabs?: boolean;
	}

	let {
		label,
		icon,
		active = false,
		disabled = false,
		onclick,
		dataDestination,
		dataReaderControl,
		dataReaderTabs = false
	}: Props = $props();

	function handleClick(): void {
		playReaderHaptic('control');
		void onclick();
	}
</script>

<button
	type="button"
	{disabled}
	aria-current={active ? 'page' : undefined}
	class="press-morph relative flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-[26px] text-[11px] font-semibold disabled:opacity-50 {active ? 'text-on-accent-strong' : 'text-surface-400 active:bg-surface-800'}"
	onclick={handleClick}
	data-mobile-destination={dataDestination}
	data-reader-control={dataReaderControl}
	data-reader-tabs={dataReaderTabs ? '' : undefined}
>
	<span class="leading-none" aria-hidden="true"><Icon name={icon} size={22} /></span>
	<span class="max-w-full truncate">{label}</span>
</button>

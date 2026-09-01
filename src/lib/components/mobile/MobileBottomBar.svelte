<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { MobileDestination } from '$lib/navigation/mobile-navigation.js';
	import type { IconName } from '$lib/components/ui/Icon.svelte';
	import MobileNavigationItem from './MobileNavigationItem.svelte';
	import { slidingSelection } from '$lib/util/sliding-selection.js';

	interface Props {
		active: MobileDestination;
		disabled?: boolean;
		onnavigate: (destination: MobileDestination) => void | Promise<void>;
	}

	let { active, disabled = false, onnavigate }: Props = $props();
	const destinations: Array<{ id: MobileDestination; label: () => string; icon: IconName }> = [
		{ id: 'tabs', label: () => m.shell_nav_tabs(), icon: 'tabs' },
		{ id: 'catalog', label: () => m.shell_nav_library(), icon: 'library' },
		{ id: 'settings', label: () => m.shell_nav_settings(), icon: 'settings' }
	];
</script>

<!-- Floating dock: the outer frame owns position + safe areas + the dock
     geometry tokens (single-owner rule — the pill itself never pads insets);
     it is tap-transparent so the gutters pass through to content. The pill
     keeps grid-cols-3, which is what holds the equal-item-width contract. -->
<div
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40"
	style="padding: 0 calc(var(--dock-inset-x) + var(--sar, 0px)) calc(var(--dock-inset-bottom) + var(--sab, 0px)) calc(var(--dock-inset-x) + var(--sal, 0px));"
>
	<nav
		class="pointer-events-auto relative grid h-[var(--dock-height)] grid-cols-3 rounded-[var(--dock-radius)] bg-surface-container-high p-[6px] shadow-dock [--segment-radius:26px]"
		aria-label={m.shell_nav_aria()}
		data-mobile-bottom-bar
		use:slidingSelection
	>
		{#each destinations as destination (destination.id)}
			<MobileNavigationItem
				label={destination.label()}
				icon={destination.icon}
				active={active === destination.id}
				{disabled}
				onclick={() => onnavigate(destination.id)}
				dataDestination={destination.id}
			/>
		{/each}
	</nav>
</div>

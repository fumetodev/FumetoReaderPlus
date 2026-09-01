<script lang="ts">
	/**
	 * SettingsPanel — the settings surface shared by the desktop dialog and the
	 * mobile Settings view: search, tab bar, scrollable tab content, apply-error
	 * row. Owns draft hydration and the apply-immediately watcher, both keyed on
	 * the `active` prop's rising edge (the dialog passes its open store, the
	 * view passes appView === 'settings') — settings can change from the reader
	 * while a keep-alive view is hidden, so hydration must re-run on every
	 * entry, never once per mount.
	 */
	import * as m from '$lib/paraglide/messages.js';
	import { tick } from 'svelte';
	import { get } from 'svelte/store';
	import { searchSettings, type SettingsSearchMatch } from '$lib/settings/settings-search.js';
	import { settingsLoading, settingsInitialTab } from '$lib/stores/ui-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { settingsDraft as draft, scheduleApply } from './settings-state.svelte.js';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import TranslationTab from './TranslationTab.svelte';
	import OverlayTab from './OverlayTab.svelte';
	import DisplayTab from './DisplayTab.svelte';
	import LibrariesTab from './LibrariesTab.svelte';
	import HelpTab from './HelpTab.svelte';

	type SettingsTabId = 'translation' | 'overlay' | 'display' | 'libraries' | 'help';
	// Labels are getters so a language switch re-renders them in place.
	const TABS: Array<{ id: SettingsTabId; label: () => string }> = [
		{ id: 'translation', label: () => m.settings_tab_translation() },
		{ id: 'overlay', label: () => m.settings_tab_overlay() },
		{ id: 'display', label: () => m.settings_tab_display() },
		{ id: 'libraries', label: () => m.settings_tab_libraries() },
		{ id: 'help', label: () => m.settings_tab_help() }
	];
	const tabLabel = (id: SettingsTabId): string => TABS.find((tab) => tab.id === id)?.label() ?? id;

	interface Props {
		/** The surface is currently presented (dialog open / view active). */
		active: boolean;
		/** Pad the scroller past the floating dock (mobile view only). */
		bottomClearance?: boolean;
	}

	let { active, bottomClearance = false }: Props = $props();

	// Kept across activations so re-entry lands where the user last was.
	let settingsTab = $state<SettingsTabId>('translation');
	let scrollElement = $state<HTMLElement | null>(null);
	let wasActive = false;

	// Settings search: typing filters a static control index; picking a result
	// switches tab and flash-scrolls to its anchor.
	let searchQuery = $state('');
	let searchResults = $derived(searchSettings(searchQuery));

	async function jumpToSearchResult(match: SettingsSearchMatch) {
		settingsTab = match.tab;
		searchQuery = '';
		await tick();
		// Anchors can sit inside collapsed <details> — open them first.
		const target = scrollElement?.querySelector<HTMLElement>(`[data-settings-anchor="${match.anchor}"]`);
		if (!target) return;
		if (target instanceof HTMLDetailsElement) target.open = true;
		target.scrollIntoView({ block: 'center' });
		target.classList.add('settings-search-flash');
		setTimeout(() => target.classList.remove('settings-search-flash'), 1700);
	}

	// Hydrate the draft from the store on every activation edge.
	$effect(() => {
		const isActive = active;
		if (isActive && !wasActive) {
			const initialTab = get(settingsInitialTab);
			if (initialTab) {
				settingsTab = initialTab;
				settingsInitialTab.set(null);
			}
			draft.hydrate(get(settings));
			// Release the hydration guard only after this effect batch settled,
			// so the watch effect's first run (which tracks every field) never
			// schedules an apply for the hydration itself.
			queueMicrotask(() => {
				draft.hydrating = false;
			});
			// Dismiss the loading overlay now that the surface is presented.
			settingsLoading.set(false);
		}
		wasActive = isActive;
	});

	// Apply-immediately: track every draft field; any edit after hydration
	// schedules a debounced apply. All exit paths flush the same pending
	// apply, so no path can silently discard work.
	$effect(() => {
		if (!active) return;
		draft.collectPatch();
		void draft.pendingApiKeys;
		if (draft.hydrating) return;
		scheduleApply();
	});
</script>

<!-- Search -->
<div class="px-3 pt-2 sm:px-6">
	<input
		type="search"
		bind:value={searchQuery}
		placeholder={m.settings_search_placeholder()}
		aria-label={m.settings_search_aria()}
		autocapitalize="off"
		autocorrect="off"
		class="w-full rounded-full border border-surface-700 bg-surface-container-high px-4 py-2 text-xs text-surface-100 placeholder-surface-500 focus:border-primary-500 focus:outline-none"
	/>
</div>

<!-- Tab bar: pill segmented control (tab semantics preserved) -->
<div class="px-3 pb-1 pt-2 sm:px-6">
	<div class="relative grid grid-cols-5 rounded-full bg-surface-container-high p-1" role="tablist" aria-label={m.settings_sections_aria()} use:slidingSelection>
		{#each TABS as tab (tab.id)}
			<button
				role="tab"
				data-settings-tab={tab.id}
				aria-selected={settingsTab === tab.id}
				class="press-morph relative flex min-h-11 min-w-0 items-center justify-center rounded-full px-1 text-center text-[11px] font-semibold leading-tight [overflow-wrap:anywhere] hyphens-auto
					{settingsTab === tab.id
						? 'text-on-accent-strong'
						: 'text-surface-400 hover:text-surface-200 active:bg-surface-800'}"
				onclick={() => (settingsTab = tab.id)}
			>
				{tab.label()}
			</button>
		{/each}
	</div>
</div>

<!-- Tab content (scrollable) -->
<div
	bind:this={scrollElement}
	class="settings-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5"
	style={bottomClearance ? 'padding-bottom: calc(var(--app-bottom-clearance) + 40px);' : ''}
>
	{#if searchQuery.trim().length >= 2}
		<!-- Search results replace tab content while a query is active -->
		<div aria-label={m.settings_search_results_aria()}>
			{#if searchResults.length === 0}
				<p class="py-6 text-center text-xs text-surface-500">{m.settings_search_no_match({ query: searchQuery.trim() })}</p>
			{:else}
				<div class="space-y-1.5">
					{#each searchResults as match (match.tab + ':' + match.anchor)}
						<button
							onclick={() => void jumpToSearchResult(match)}
							class="block w-full rounded-lg border border-surface-700 bg-surface-800/50 px-3 py-2.5 text-left transition-colors hover:border-primary-600/60"
						>
							<span class="block text-xs font-medium text-surface-200">{match.labelText}</span>
							<span class="mt-0.5 block text-[11px] text-surface-500">{m.settings_search_result_tab({ tab: tabLabel(match.tab) })}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{:else if settingsTab === 'translation'}
		<TranslationTab />
	{:else if settingsTab === 'overlay'}
		<OverlayTab />
	{:else if settingsTab === 'display'}
		<DisplayTab />
	{:else if settingsTab === 'libraries'}
		<LibrariesTab />
	{:else if settingsTab === 'help'}
		<HelpTab />
	{/if}
</div>

{#if draft.applyError}
	<p class="border-t border-red-900/50 bg-red-950/30 px-6 py-2 text-xs text-red-300" role="alert">
		{m.settings_apply_error({ detail: draft.applyError })}
	</p>
{/if}

<style>
	:global(.settings-search-flash) {
		animation: settings-search-flash 1.6s ease-out;
		border-radius: 8px;
	}
	@keyframes settings-search-flash {
		0%, 55% {
			box-shadow: 0 0 0 2px var(--color-primary-500, #69de7b);
		}
		100% {
			box-shadow: 0 0 0 2px transparent;
		}
	}
</style>

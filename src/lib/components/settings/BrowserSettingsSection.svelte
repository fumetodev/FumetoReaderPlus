<script lang="ts">
	/**
	 * Settings → Libraries → Web browser: the Tabs button, the search engine, ad blocking (with the lists' credits,
	 * their state, and the sites it is turned off for) and clearing the browser's data. Shown only where the
	 * browser exists (Android).
	 */
	import * as m from '$lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { formatDate } from '$lib/i18n/format.js';
	import { pushToast } from '$lib/stores/toasts.js';
	import { settingsDraft as draft } from './settings-state.svelte.js';
	import { BROWSER_SEARCH_ENGINES, isBrowserSearchEngine, searchEngineName } from '$lib/web-browser/address.js';
	import { browserAvailable, browserNative, type BrowserListsStatus } from '$lib/web-browser/browser-bridge.js';

	let lists = $state<BrowserListsStatus | null>(null);
	let updating = $state(false);
	let clearArmed = $state(false);
	let clearing = $state(false);
	const available = browserAvailable();

	const updatedAt = $derived(lists && lists.lists.some((l) => l.updatedAt > 0) ? Math.max(...lists.lists.map((l) => l.updatedAt)) : 0);

	onMount(() => {
		if (available) lists = browserNative.listsStatus();
	});

	async function updateLists(): Promise<void> {
		if (updating) return;
		updating = true;
		try {
			lists = await browserNative.refreshLists(true);
		} catch {
			lists = browserNative.listsStatus();
		} finally {
			updating = false;
		}
	}

	async function clearData(): Promise<void> {
		if (!clearArmed) {
			clearArmed = true;
			setTimeout(() => (clearArmed = false), 4000);
			return;
		}
		clearArmed = false;
		clearing = true;
		try {
			if (await browserNative.clearData()) pushToast({ message: { code: 'browser_data_cleared' } });
		} finally {
			clearing = false;
		}
	}
</script>

<div data-settings-anchor="web-browser">
	<h3 class="mb-3 block text-sm font-medium text-surface-300">{m.libraries_browser_title()}</h3>
	<div class="space-y-3 rounded-lg border border-surface-700 bg-surface-800/50 p-3">
		<Switch
			bind:checked={draft.browserShowButton}
			dataTestid="browser-show-button"
			label={m.libraries_browser_show_button()}
			sublabel={m.libraries_browser_show_button_hint()}
		/>

		<div>
			<label for="browser-search-engine" class="mb-1 block text-xs text-surface-300">{m.libraries_browser_search_engine()}</label>
			<select
				id="browser-search-engine"
				value={draft.browserSearchEngine}
				onchange={(event) => { const value = (event.target as HTMLSelectElement).value; if (isBrowserSearchEngine(value)) draft.browserSearchEngine = value; }}
				class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
			>
				{#each BROWSER_SEARCH_ENGINES as engine (engine)}
					<option value={engine}>{searchEngineName(engine)}</option>
				{/each}
			</select>
		</div>

		<div class="border-t border-surface-700 pt-3">
			<Switch
				bind:checked={draft.browserAdBlock}
				dataTestid="browser-ad-block"
				label={m.libraries_browser_ad_block()}
				sublabel={m.libraries_browser_ad_block_hint()}
			/>
			{#if available}
				<div class="mt-2 flex items-center justify-between gap-3">
					<p class="min-w-0 text-[11px] text-surface-500">
						{#if lists && updatedAt > 0}
							{m.libraries_browser_lists_status({ domains: lists.domains.toLocaleString(), date: formatDate(updatedAt, 'medium') })}
						{:else}
							{m.libraries_browser_lists_never()}
						{/if}
					</p>
					<button
						type="button"
						class="shrink-0 rounded-md border border-primary-600 px-2.5 py-1.5 text-[11px] font-medium text-primary-400 transition-colors active:bg-primary-600/20 disabled:opacity-50"
						disabled={updating}
						onclick={() => void updateLists()}
					>
						{updating ? m.libraries_browser_lists_updating() : m.libraries_browser_lists_update()}
					</button>
				</div>
			{/if}
			{#if draft.browserAdBlockOffHosts.length > 0}
				<p class="mt-3 text-xs text-surface-300">{m.libraries_browser_off_sites()}</p>
				<ul class="mt-1 space-y-1">
					{#each draft.browserAdBlockOffHosts as host (host)}
						<li class="flex items-center justify-between gap-2 rounded-md bg-surface-800 px-3 py-1.5">
							<span class="min-w-0 truncate text-xs text-surface-200">{host}</span>
							<button
								type="button"
								class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-surface-400 active:bg-surface-700"
								aria-label={m.libraries_browser_off_site_remove({ host })}
								onclick={() => (draft.browserAdBlockOffHosts = draft.browserAdBlockOffHosts.filter((h) => h !== host))}
							>×</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if available}
			<div class="border-t border-surface-700 pt-3">
				<button
					type="button"
					class="rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50 {clearArmed ? 'border-red-500 text-red-400 active:bg-red-600/20' : 'border-surface-600 text-surface-200 active:bg-surface-700'}"
					disabled={clearing}
					onclick={() => void clearData()}
					data-browser-clear-data
				>
					{clearArmed ? m.libraries_browser_clear_again() : m.libraries_browser_clear()}
				</button>
				<p class="mt-1.5 text-[11px] text-surface-500">{m.libraries_browser_clear_hint()}</p>
			</div>
		{/if}
	</div>
</div>

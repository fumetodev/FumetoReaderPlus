<script lang="ts">
	/**
	 * The in-app browser's screen. The web page itself is a native WebView laid over the `page` rectangle below
	 * (`browser/BrowserHost.kt`); everything else here is the app's: the toolbar, the start page, and the bar that
	 * offers to read the comic pages the page finder found. Nothing of the app's can draw over the native page, so
	 * the menu swaps it for a still image while it is open (`coverBrowser`).
	 */
	import * as m from '$lib/paraglide/messages.js';
	import Icon from '$lib/components/ui/Icon.svelte';
	import BrowserStartPage from './BrowserStartPage.svelte';
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { appView } from '$lib/stores/reader-state.js';
	import { settings } from '$lib/settings/settings.js';
	import { settingsInitialAnchor, settingsInitialTab, settingsLoading, settingsReturnView, settingsViewMounted } from '$lib/stores/ui-state.js';
	import { browserNative } from '$lib/web-browser/browser-bridge.js';
	import { displayAddress, resolveBrowserInput } from '$lib/web-browser/address.js';
	import {
		blockedOnPage,
		browserCovered,
		browserNav,
		browserProgress,
		browserSnapshot,
		collectedPages,
		coverBrowser,
		finderReport,
		hasPage,
		hostOf,
		navigate,
		pagesToRead,
		browserTransientClose,
		cancelReopen,
		reopening,
		showStartPage,
		readPages,
		startCollecting,
		stopCollecting,
		toggleBlockingForSite
	} from '$lib/web-browser/browser-controller.js';

	interface Props {
		active: boolean;
	}

	let { active }: Props = $props();

	let pageEl: HTMLDivElement | undefined = $state();
	let inputEl: HTMLInputElement | undefined = $state();
	let editing = $state(false);
	let draft = $state('');
	let menuOpen = $state(false);
	let opening = $state(false);

	const loaded = $derived(hasPage($browserNav));
	const showNative = $derived(active && loaded && !$browserCovered && !$showStartPage);
	const host = $derived(hostOf($browserNav.url));
	const blockingOff = $derived(!!host && $settings.browserAdBlockOffHosts.includes(host));
	const report = $derived($finderReport);
	const collecting = $derived($collectedPages);
	const loading = $derived($browserProgress < 100);
	const toRead = $derived(pagesToRead(collecting, report));

	function pageRect() {
		const r = pageEl?.getBoundingClientRect();
		return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
	}

	// The native page follows the rectangle and the screen's state.
	$effect(() => {
		if (showNative) {
			const r = pageRect();
			if (r) browserNative.show(r);
		} else {
			browserNative.hide();
		}
	});

	let resizeObserver: ResizeObserver | null = null;
	const syncRect = () => {
		if (!showNative) return;
		const r = pageRect();
		if (r) browserNative.setRect(r);
	};

	onMount(() => {
		resizeObserver = new ResizeObserver(syncRect);
		if (pageEl) resizeObserver.observe(pageEl);
		window.addEventListener('resize', syncRect);
		window.addEventListener('fumeto:window-insets', syncRect);
	});

	onDestroy(() => {
		if (menuOpen) browserTransientClose.set(null);
		resizeObserver?.disconnect();
		window.removeEventListener('resize', syncRect);
		window.removeEventListener('fumeto:window-insets', syncRect);
		browserNative.hide();
	});

	function beginEditing(): void {
		draft = $browserNav.url;
		editing = true;
		queueMicrotask(() => inputEl?.select());
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		const url = resolveBrowserInput(draft, $settings.browserSearchEngine);
		editing = false;
		inputEl?.blur();
		if (url) navigate(url);
	}

	const closeMenu = () => void setMenu(false);

	async function setMenu(open: boolean): Promise<void> {
		if (open === menuOpen) return;
		if (open) await coverBrowser(true);
		menuOpen = open;
		browserTransientClose.set(open ? closeMenu : null);
		if (!open) await coverBrowser(false);
	}

	function openBrowserSettings(): void {
		void setMenu(false);
		settingsReturnView.set('browser');
		settingsInitialTab.set('libraries');
		settingsInitialAnchor.set({ anchor: 'web-browser' });
		if (!get(settingsViewMounted)) settingsLoading.set(true);
		appView.set('settings');
	}

	async function read(): Promise<void> {
		if (opening) return;
		opening = true;
		try {
			await readPages(toRead);
		} finally {
			opening = false;
		}
	}
</script>

<section
	class="flex h-full min-h-0 flex-col bg-surface-950"
	style="padding-top: var(--sat, 0px); padding-left: var(--sal, 0px); padding-right: var(--sar, 0px);"
	aria-label={m.browser_view_label()}
	data-browser-view
>
	<!-- Toolbar -->
	<div class="relative flex h-14 shrink-0 items-center gap-1 px-2" data-browser-toolbar>
		<button
			type="button"
			class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-surface-200 active:bg-surface-800 disabled:text-surface-600"
			aria-label={m.browser_back()}
			disabled={!$browserNav.canGoBack}
			onclick={() => browserNative.back()}
		>
			<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
		</button>
		<form class="min-w-0 flex-1" onsubmit={submit}>
			<input
				bind:this={inputEl}
				type="text"
				inputmode="url"
				enterkeyhint="go"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				class="h-10 w-full rounded-full border-0 bg-surface-container-high px-4 text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
				aria-label={m.browser_address_label()}
				placeholder={m.browser_address_placeholder()}
				value={editing ? draft : displayAddress($browserNav.url)}
				oninput={(event) => (draft = event.currentTarget.value)}
				onfocus={beginEditing}
				onblur={() => (editing = false)}
				data-browser-address
			/>
		</form>
		{#if loading && loaded}
			<button
				type="button"
				class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-surface-200 active:bg-surface-800"
				aria-label={m.browser_stop()}
				onclick={() => browserNative.stop()}
			>
				<Icon name="x" size={20} />
			</button>
		{:else}
			<button
				type="button"
				class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-surface-200 active:bg-surface-800 disabled:text-surface-600"
				aria-label={m.browser_reload()}
				disabled={!loaded}
				onclick={() => browserNative.reload()}
			>
				<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
			</button>
		{/if}
		<button
			type="button"
			class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-surface-200 active:bg-surface-800"
			aria-label={m.browser_menu_label()}
			aria-expanded={menuOpen}
			onclick={() => void setMenu(!menuOpen)}
			data-browser-menu-button
		>
			<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>
		</button>
		{#if loading && loaded}
			<div class="absolute inset-x-0 bottom-0 h-0.5 bg-surface-800" aria-hidden="true">
				<div class="h-full bg-primary-500 transition-[width] duration-200" style="width: {Math.max(5, $browserProgress)}%"></div>
			</div>
		{/if}
	</div>

	<!-- The page. The native browser sits exactly over this element. -->
	<div bind:this={pageEl} class="relative min-h-0 flex-1 overflow-hidden" data-browser-page>
		{#if !loaded || $showStartPage}
			<BrowserStartPage />
		{:else if $browserCovered && $browserSnapshot}
			<img src={$browserSnapshot} alt="" class="h-full w-full object-cover object-top" draggable="false" />
		{/if}

		{#if menuOpen}
			<button type="button" class="absolute inset-0 bg-black/30" aria-label={m.browser_menu_close()} onclick={() => void setMenu(false)}></button>
			<div class="absolute right-2 top-1 w-72 max-w-[calc(100%-1rem)] overflow-hidden rounded-2xl bg-surface-container-high shadow-dock" role="menu" data-browser-menu>
				{#if loaded && host}
					<button type="button" role="menuitem" class="block w-full px-4 py-3 text-left text-sm text-surface-100 active:bg-surface-700" onclick={() => { toggleBlockingForSite(); void setMenu(false); }}>
						{blockingOff ? m.browser_menu_blocking_on({ host }) : m.browser_menu_blocking_off({ host })}
					</button>
					{#if $settings.browserAdBlock && !blockingOff}
						<p class="px-4 pb-2 text-[11px] text-surface-500">{m.browser_menu_blocked_count({ n: $blockedOnPage })}</p>
					{/if}
				{/if}
				<button type="button" role="menuitem" class="block w-full border-t border-surface-700 px-4 py-3 text-left text-sm text-surface-100 active:bg-surface-700" onclick={() => { showStartPage.set(true); void setMenu(false); }} data-browser-menu-saved>
					{m.browser_saved_chapters()}
				</button>
				{#if $browserNav.canGoForward}
					<button type="button" role="menuitem" class="block w-full border-t border-surface-700 px-4 py-3 text-left text-sm text-surface-100 active:bg-surface-700" onclick={() => { browserNative.forward(); void setMenu(false); }}>
						{m.browser_forward()}
					</button>
				{/if}
				<button type="button" role="menuitem" class="block w-full border-t border-surface-700 px-4 py-3 text-left text-sm text-surface-100 active:bg-surface-700" onclick={openBrowserSettings}>
					{m.browser_menu_settings()}
				</button>
			</div>
		{/if}
	</div>

	<!-- A saved chapter being opened again through its site -->
	{#if $reopening}
		<div class="flex min-h-14 shrink-0 items-center gap-2 border-t border-surface-800 px-3 py-2" role="status" data-browser-reopen-bar>
			<span class="shrink-0 text-primary-300" aria-hidden="true"><Icon name="clock" size={20} /></span>
			<p class="min-w-0 flex-1 text-xs text-surface-200">
				{#if $reopening.phase === 'site'}
					{m.browser_reopening({ title: $reopening.title })}
				{:else if $reopening.phase === 'retrace'}
					{m.browser_reopen_retrace({ title: $reopening.title })}
				{:else}
					{m.browser_reopen_manual({ title: $reopening.title })}
				{/if}
			</p>
			<button type="button" class="h-10 shrink-0 rounded-full px-3 text-xs font-semibold text-surface-300 active:bg-surface-800" onclick={cancelReopen}>{m.common_cancel()}</button>
		</div>
	{/if}

	<!-- What the page finder found -->
	{#if loaded && !$showStartPage && (collecting || (report && report.kind !== 'none'))}
		<div class="flex min-h-14 shrink-0 items-center gap-2 border-t border-surface-800 px-3 py-2" data-browser-found-bar>
			<span class="shrink-0 text-primary-300" aria-hidden="true"><Icon name="library" size={20} /></span>
			{#if collecting}
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium text-surface-100">{m.browser_collected({ n: toRead.length })}</p>
					<p class="truncate text-[11px] text-surface-500">{m.browser_collect_hint()}</p>
				</div>
				<button type="button" class="h-10 shrink-0 rounded-full px-3 text-xs font-semibold text-surface-300 active:bg-surface-800" onclick={stopCollecting}>{m.common_cancel()}</button>
				<button type="button" class="h-10 shrink-0 rounded-full bg-primary-600 px-4 text-xs font-semibold text-white active:bg-primary-700 disabled:opacity-50" disabled={toRead.length === 0 || opening} onclick={() => void read()}>{m.browser_read()}</button>
			{:else if report?.kind === 'protected'}
				<p class="min-w-0 flex-1 text-xs text-surface-300">{m.browser_protected()}</p>
			{:else if report}
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium text-surface-100">{m.browser_found_pages({ n: toRead.length })}</p>
					{#if report.pager || report.kind === 'single'}
						<p class="line-clamp-2 text-[11px] text-surface-500">{m.browser_pager_hint()}</p>
					{/if}
				</div>
				<button type="button" class="h-10 shrink-0 rounded-full px-3 text-xs font-semibold text-primary-300 active:bg-surface-800" onclick={startCollecting} data-browser-collect>{m.browser_collect()}</button>
				<button type="button" class="h-10 shrink-0 rounded-full bg-primary-600 px-4 text-xs font-semibold text-white active:bg-primary-700 disabled:opacity-50" disabled={opening} onclick={() => void read()} data-browser-read>{m.browser_read()}</button>
			{/if}
		</div>
	{/if}

	<!-- Room for the floating dock: the page ends where the dock begins. -->
	<div class="shrink-0" style="height: var(--app-bottom-clearance);" aria-hidden="true"></div>
</section>

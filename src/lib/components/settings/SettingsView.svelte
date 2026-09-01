<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * SettingsView — the mobile Settings surface as a real dock destination.
	 * Lazily mounted on first entry by the shell, then kept alive (hidden with
	 * visibility/inert like catalog and tabs), so re-entry is a visibility flip.
	 *
	 * There is deliberately no Done button and no dialog role: the dock is the
	 * exit, changes auto-apply, and a destination with a live dock is not a
	 * modal — announcing one would be false semantics. The title below is a
	 * view header like Library/Tabs, not a dialog h2. The desktop dialog keeps
	 * its modal chrome; both surfaces share SettingsPanel and are addressable
	 * in tests via [data-settings-surface].
	 */
	import { get } from 'svelte/store';
	import { appView } from '$lib/stores/reader-state.js';
	import {
		settingsCommitHandler,
		settingsNavigationBusy,
		settingsReturnView,
		settingsViewMounted
	} from '$lib/stores/ui-state.js';
	import { flushPendingApply } from './settings-state.svelte.js';
	import SettingsPanel from './SettingsPanel.svelte';
	import { APP_NAME, APP_VERSION } from '$lib/version.js';
	import type { AppView } from '$lib/types/index.js';

	let active = $derived($appView === 'settings');

	$effect(() => {
		settingsViewMounted.set(true);
		return () => settingsViewMounted.set(false);
	});

	/**
	 * The flush port: leaving Settings (dock tap, Android Back) flushes the
	 * pending apply before the view switches, so no exit path can discard work.
	 */
	async function flushAndLeave(destination?: AppView): Promise<boolean> {
		if (get(settingsNavigationBusy)) return false;
		settingsNavigationBusy.set(true);
		try {
			await flushPendingApply();
			appView.set(destination ?? get(settingsReturnView));
			return true;
		} finally {
			settingsNavigationBusy.set(false);
		}
	}

	$effect(() => {
		if (!active) return;
		const handler = (destination?: AppView) => flushAndLeave(destination);
		settingsCommitHandler.set(handler);
		return () => {
			if (get(settingsCommitHandler) === handler) settingsCommitHandler.set(null);
		};
	});
</script>

<section
	aria-label={m.shell_nav_settings()}
	data-settings-surface
	class="relative flex h-full w-full flex-col overflow-x-hidden [overflow-wrap:anywhere] bg-surface-900"
	style="padding-top: var(--sat, 0px); padding-left: var(--sal, 0px); padding-right: var(--sar, 0px);"
>
	<!-- View header (a destination header, not a dialog h2 — no Done, the
	     dock is the exit). Same app-bar contract as Tabs and both Library
	     headers: 12px top gap + a 60px bar with a bottom-aligned title
	     block, so the bar's bottom edge lands on the same pixel in every
	     bottom-nav destination. -->
	<header
		class="flex min-w-0 items-end"
		style="margin-top: var(--reader-top-gap); min-height: var(--reader-top-height); padding-left: 12px; padding-right: 12px;"
		data-settings-header
	>
		<div class="min-w-0">
			<p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary-400">{APP_NAME} · v{APP_VERSION}</p>
			<h2 class="truncate text-2xl font-bold tracking-tight text-surface-100">{m.shell_nav_settings()}</h2>
		</div>
	</header>
	<SettingsPanel {active} bottomClearance />
	<!-- Chip backdrop keeps the caption legible while cards scroll beneath it
	     (it floats in the same layer as the dock, which overlaps by design). -->
	<p
		class="pointer-events-none absolute inset-x-0 text-center"
		style="bottom: calc(var(--app-bottom-clearance) + 10px);"
	>
		<span class="inline-block rounded-full bg-surface-900/90 px-3 py-1 text-[11px] text-surface-500">
			{m.settings_changes_are_saved_automatically()}
		</span>
	</p>
</section>

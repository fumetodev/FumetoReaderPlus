<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * SettingsDialog — the DESKTOP settings surface: modal dialog with scrim,
	 * heading, Escape, and a Done button. Mobile settings is SettingsView (a
	 * dock destination); the shell mounts exactly one of the two per platform.
	 * The shared interior (search, tabs, content, auto-apply) is SettingsPanel.
	 */
	import { motionDuration } from '$lib/util/motion.js';
	import { fade, scale } from 'svelte/transition';
	import { get } from 'svelte/store';
	import {
		settingsDialogOpen,
		settingsLoading,
		settingsCommitHandler,
		settingsNavigationBusy
	} from '$lib/stores/ui-state.js';
	import { flushPendingApply } from './settings-state.svelte.js';
	import SettingsPanel from './SettingsPanel.svelte';

	let dialogElement = $state<HTMLElement | null>(null);

	// Focus the dialog once its DOM exists after opening.
	$effect(() => {
		if ($settingsDialogOpen) queueMicrotask(() => dialogElement?.focus());
	});

	async function flushAndClose(): Promise<boolean> {
		if (get(settingsNavigationBusy)) return false;
		settingsNavigationBusy.set(true);
		try {
			await flushPendingApply();
			settingsDialogOpen.set(false);
			return true;
		} finally {
			settingsNavigationBusy.set(false);
		}
	}

	// Registered so external flows (e.g. benchmark navigation) can commit the
	// draft through the same port the mobile view exposes.
	$effect(() => {
		if (!$settingsDialogOpen) return;
		const handler = () => flushAndClose();
		settingsCommitHandler.set(handler);
		return () => {
			if (get(settingsCommitHandler) === handler) settingsCommitHandler.set(null);
		};
	});

	function onWindowKeydown(event: KeyboardEvent) {
		if ($settingsDialogOpen && event.key === 'Escape') {
			event.preventDefault();
			void flushAndClose();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- Lightweight loading overlay — shown instantly BEFORE the heavy dialog DOM is created -->
{#if $settingsLoading && !$settingsDialogOpen}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
		<div class="flex flex-col items-center gap-3">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
			<span class="text-sm text-surface-400">{m.reader_loading()}</span>
		</div>
	</div>
{/if}

{#if $settingsDialogOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) void flushAndClose(); }}
		data-dialog
		transition:fade={{ duration: motionDuration(150) }}
	>
		<div
			bind:this={dialogElement}
			role="dialog"
			aria-modal="true"
			aria-label={m.shell_nav_settings()}
			tabindex="-1"
			data-settings-surface
			class="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden [overflow-wrap:anywhere] rounded-xl border border-surface-700 bg-surface-900 shadow-2xl outline-none"
			transition:scale={{ duration: motionDuration(150), start: 0.95 }}
		>
			<h2 class="px-6 pt-6 text-lg font-semibold text-surface-100">{m.shell_nav_settings()}</h2>

			<SettingsPanel active={$settingsDialogOpen} />

			<!-- Footer: changes apply as you make them; Done just closes. -->
			<div class="flex items-center justify-between gap-3 border-t border-surface-800 px-6 py-3">
				<p class="text-[11px] text-surface-500">{m.settings_changes_are_saved_automatically()}</p>
				<button
					onclick={() => { void flushAndClose(); }}
					disabled={$settingsNavigationBusy}
					class="rounded-lg bg-primary-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-60"
				>
					{$settingsNavigationBusy ? m.settings_saving() : m.common_done()}
				</button>
			</div>
		</div>
	</div>
{/if}

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { get } from 'svelte/store';
	import { settings } from '$lib/settings/settings.js';
	import { settingsDraft as draft } from './settings-state.svelte.js';
	import {
		parseSettingsImport,
		serializeSettingsExport,
		SettingsImportError,
		type SettingsImportResult
	} from '$lib/settings/settings-transfer.js';
	import { APP_VERSION } from '$lib/version.js';
	import { applyColorScheme } from '$lib/settings/color-schemes.js';

	let statusMessage = $state<string | null>(null);
	let statusKind = $state<'ok' | 'error'>('ok');
	let pendingImport = $state<SettingsImportResult | null>(null);
	let resetConfirming = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	function note(kind: 'ok' | 'error', message: string) {
		statusKind = kind;
		statusMessage = message;
	}

	/** Re-seed the open dialog's draft after wholesale settings replacement. */
	function rehydrateDraft() {
		draft.hydrate(get(settings));
		queueMicrotask(() => {
			draft.hydrating = false;
		});
		applyColorScheme(get(settings).colorScheme);
	}

	async function exportSettings() {
		statusMessage = null;
		const json = serializeSettingsExport(get(settings), APP_VERSION);
		const suggestedName = `fumeto-settings-${new Date().toISOString().slice(0, 10)}.json`;
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const target = await save({
				title: m.settings_transfer_export_settings(),
				defaultPath: suggestedName,
				filters: [{ name: 'JSON', extensions: ['json'] }]
			});
			if (!target) return; // user cancelled
			const { writeTextFile } = await import('@tauri-apps/plugin-fs');
			await writeTextFile(target, json);
			note('ok', m.settings_transfer_settings_exported_api_keys());
		} catch {
			// Plain-browser dev fallback: download via anchor.
			try {
				const blob = new Blob([json], { type: 'application/json' });
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = suggestedName;
				anchor.click();
				URL.revokeObjectURL(url);
				note('ok', m.settings_transfer_settings_exported_api_keys());
			} catch {
				note('error', m.settings_transfer_export_failed());
			}
		}
	}

	async function pickImportFile() {
		statusMessage = null;
		pendingImport = null;
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				title: m.settings_transfer_import_settings(),
				multiple: false,
				filters: [{ name: 'JSON', extensions: ['json'] }]
			});
			if (!selected || typeof selected !== 'string') return;
			const { readTextFile } = await import('@tauri-apps/plugin-fs');
			stageImport(await readTextFile(selected));
		} catch {
			// Plain-browser dev fallback: hidden file input.
			fileInput?.click();
		}
	}

	function onFileInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		void file.text().then(stageImport);
	}

	function stageImport(json: string) {
		try {
			pendingImport = parseSettingsImport(json);
		} catch (error) {
			pendingImport = null;
			note('error', error instanceof SettingsImportError ? error.message : m.settings_transfer_could_not_read_this());
		}
	}

	function confirmImport() {
		if (!pendingImport) return;
		settings.patch(pendingImport.settings);
		rehydrateDraft();
		const warningSuffix = pendingImport.warnings.length > 0 ? ` ${pendingImport.warnings.length} note(s) below.` : '';
		note('ok', m.settings_transfer_settings_imported_warningsuffix_re({ warningSuffix }));
		pendingImport = { ...pendingImport, settings: {} }; // keep warnings visible
		if (pendingImport.warnings.length === 0) pendingImport = null;
	}

	function confirmReset() {
		settings.reset();
		rehydrateDraft();
		resetConfirming = false;
		note('ok', m.settings_transfer_all_settings_restored_to());
	}
</script>

<div data-settings-anchor="settings-backup">
	<h3 class="mb-3 block text-sm font-medium text-surface-300">{m.settings_transfer_settings_backup()}</h3>
	<div class="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
		<p class="text-[11px] text-surface-500">
			{m.settings_transfer_save_your_settings_as()}
		</p>
		<!-- One row when the labels fit: the two save/restore actions lead, the
		     destructive one is pushed to the far edge. Longer labels (German,
		     the pseudolocale) wrap Reset onto its own line rather than off the
		     screen; it keeps its right alignment there. -->
		<div class="mt-2 flex flex-wrap items-center gap-2">
			<button
				onclick={() => void exportSettings()}
				class="shrink-0 rounded-md border border-primary-600 px-3 py-1.5 text-xs font-medium text-primary-400 transition-colors active:bg-primary-600/20"
			>
				{m.settings_transfer_export()}
			</button>
			<button
				onclick={() => void pickImportFile()}
				class="shrink-0 rounded-md border border-primary-600 px-3 py-1.5 text-xs font-medium text-primary-400 transition-colors active:bg-primary-600/20"
			>
				{m.common_import()}
			</button>
			{#if !resetConfirming}
				<button
					onclick={() => (resetConfirming = true)}
					class="ml-auto rounded-md border border-red-600/50 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-600/10"
				>
					{m.settings_transfer_reset_all_settings()}
				</button>
			{/if}
		</div>

		<input
			bind:this={fileInput}
			type="file"
			accept="application/json,.json"
			class="hidden"
			onchange={onFileInputChange}
			aria-hidden="true"
			tabindex="-1"
		/>

		{#if resetConfirming}
			<div class="mt-2 rounded-md border border-red-600/40 bg-red-950/30 p-2">
				<p class="text-[11px] text-red-300">
					{m.settings_transfer_restore_every_setting_to()}
				</p>
				<div class="mt-1.5 flex gap-2">
					<button
						onclick={confirmReset}
						class="rounded-md bg-red-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-red-700"
					>
						{m.settings_transfer_reset_to_defaults()}
					</button>
					<button
						onclick={() => (resetConfirming = false)}
						class="rounded-md border border-surface-600 px-2.5 py-1.5 text-[11px] font-medium text-surface-400 transition-colors hover:bg-surface-700 hover:text-surface-200"
					>
						{m.common_cancel()}
					</button>
				</div>
			</div>
		{/if}

		{#if pendingImport && Object.keys(pendingImport.settings).length > 0}
			<div class="mt-2 rounded-md border border-primary-600/40 bg-primary-600/10 p-2">
				<p class="text-[11px] text-surface-200">
					{m.settings_transfer_replace_confirm({ from: pendingImport.appVersion ? ` ${m.settings_transfer_from_app_appversion({ appVersion: pendingImport.appVersion })}` : '' })}
				</p>
				<div class="mt-1.5 flex gap-2">
					<button
						onclick={confirmImport}
						class="rounded-md bg-primary-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary-700"
					>
						{m.settings_transfer_import_settings()}
					</button>
					<button
						onclick={() => (pendingImport = null)}
						class="rounded-md border border-surface-600 px-2.5 py-1.5 text-[11px] font-medium text-surface-400 transition-colors hover:bg-surface-700 hover:text-surface-200"
					>
						{m.common_cancel()}
					</button>
				</div>
			</div>
		{/if}

		{#if statusMessage}
			<p class="mt-2 text-[11px] {statusKind === 'ok' ? 'text-green-400' : 'text-red-400'}" role="status">{statusMessage}</p>
		{/if}
		{#if pendingImport && pendingImport.warnings.length > 0}
			<ul class="mt-1 list-disc space-y-0.5 pl-4">
				{#each pendingImport.warnings as warning (warning)}
					<li class="text-[11px] text-amber-400">{warning}</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

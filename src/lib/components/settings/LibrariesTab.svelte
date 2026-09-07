<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import { formatBytes, formatDate } from '$lib/i18n/format.js';
	import { settingsDraft as draft, applyDraftNow } from './settings-state.svelte.js';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { randomUUID } from '$lib/util/uuid.js';
	import { isLocalLibrary, isYACReaderLibrary, isKomgaLibrary, isKavitaLibrary, isRemoteServerLibrary, type Library } from '$lib/settings/settings.js';
	import { open } from '@tauri-apps/plugin-dialog';
	import { revokeThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
	import { invalidateLibrarySync } from '$lib/yacreader/yac-sync-service.js';
	import RemoteServerForm from './RemoteServerForm.svelte';
	import { assignAuthorsFromFolders } from '$lib/library/author-from-folders.js';
	import { eraseAndRescanLibrary } from '$lib/library/library-scanner.js';
	import { deleteLibraryData } from '$lib/library/library-removal-service.js';
	import { libraryWatchStatus } from '$lib/library/library-watcher.js';
	import { isMobile, isAndroid } from '$lib/util/platform.js';
	import { mkdir, exists as fsExists } from '@tauri-apps/plugin-fs';
	import { appDataDir, join } from '@tauri-apps/api/path';
	import { resolveMobileLocalLibrary } from '$lib/settings/local-library-bootstrap.js';
	import { storageDurability, refreshStorageDurability, requestStoragePersistence } from '$lib/storage/durability.js';
	import OnDeviceModelsCard from './OnDeviceModelsCard.svelte';
	import SettingsTransferCard from './SettingsTransferCard.svelte';

	let visibleManagedLibraries = $derived(draft.libraries.map((lib, i) => ({ lib, i })));


	// This tab only mounts while it is the active tab, so mount-time work
	// replaces the old settingsTab-watching effects (and cannot loop — B2).
	$effect(() => {
		void refreshStorageDurability();
		if (isMobile) {
			void (async () => {
				try {
					const entry = await resolveMobileLocalLibrary(draft.libraries, {
						appDataDir,
						join,
						exists: fsExists,
						mkdir,
						randomUUID: () => randomUUID()
					});
					if (entry) draft.libraries = [...draft.libraries, entry];
				} catch (err) {
					console.error('Failed to create local library:', err);
				}
			})();
		}
	});

	async function addLibrary() {
		const selected = await open({
			directory: true,
			multiple: false,
			title: m.libraries_select_folder_title()
		});

		if (selected && typeof selected === 'string') {
			const folderName = selected.split(/[\\/]/).pop() || 'Library';
			draft.libraries = [...draft.libraries, {
				id: randomUUID(),
				type: 'local' as const,
				name: folderName,
				path: selected,
				autoScan: true,
				watchEnabled: false
			}];
		}
	}

	async function changeLibraryPath(index: number) {
		const lib = draft.libraries[index];
		if (!lib || !isLocalLibrary(lib)) return;

		const selected = await open({
			directory: true,
			multiple: false,
			title: m.libraries_select_folder_title()
		});

		if (selected && typeof selected === 'string') {
			draft.libraries = draft.libraries.map((l, i) =>
				i === index ? { ...l, path: selected } : l
			);
		}
	}

	// ============================================================
	// Library removal (B1): deleting a library's data is irreversible, so it
	// requires an explicit confirm and then removes the config entry and the
	// data in one confirmed action — never as a side effect of a draft edit.
	// ============================================================
	let removeStatus = $state<Map<number, 'idle' | 'confirm' | 'running' | 'error'>>(new Map());
	let removeMessage = $state<Map<number, string>>(new Map());

	function requestRemoveLibrary(index: number) {
		removeStatus = new Map(removeStatus).set(index, 'confirm');
	}

	function cancelRemoveLibrary(index: number) {
		removeStatus = new Map(removeStatus).set(index, 'idle');
		removeMessage = new Map(removeMessage).set(index, '');
	}

	async function confirmRemoveLibrary(index: number) {
		const lib = draft.libraries[index];
		if (!lib) return;

		removeStatus = new Map(removeStatus).set(index, 'running');
		try {
			if (isYACReaderLibrary(lib)) invalidateLibrarySync(lib.id);
			const { volumes: vols, deletedTags } = await deleteLibraryData(lib.id);

			for (const volume of vols) revokeThumbnailUrl(volume.volume_uuid);
			if (deletedTags.length > 0) {
				const { cleanupOrphanedTags } = await import('$lib/db/tag-cleanup.js');
				await cleanupOrphanedTags(deletedTags);
			}
			draft.libraries = draft.libraries.filter((_, i) => i !== index);
			removeStatus = new Map(removeStatus).set(index, 'idle');
			// Persist the config removal together with the data deletion.
			await applyDraftNow();
		} catch (error) {
			console.error(`Failed to remove library ${lib.name}:`, error);
			removeStatus = new Map(removeStatus).set(index, 'error');
			removeMessage = new Map(removeMessage).set(
				index,
				error instanceof Error ? error.message : m.libraries_remove_failed()
			);
		}
	}

	function updateLibraryName(index: number, name: string) {
		draft.libraries = draft.libraries.map((lib, i) =>
			i === index ? { ...lib, name } : lib
		);
	}

	function toggleLibraryAutoScan(index: number) {
		draft.libraries = draft.libraries.map((lib, i) => {
			if (i !== index || !isLocalLibrary(lib)) return lib;
			return { ...lib, autoScan: !lib.autoScan };
		});
	}

	function toggleLibraryWatch(index: number) {
		draft.libraries = draft.libraries.map((lib, i) => {
			if (i !== index || !isLocalLibrary(lib)) return lib;
			return { ...lib, watchEnabled: !lib.watchEnabled };
		});
		// Apply now rather than after the debounce: the status line under the
		// switch answers this tap, and a watcher that cannot start says so here.
		void applyDraftNow();
	}

	// ============================================================
	// Remote server add/edit (structured form component)
	// ============================================================

	let showAddRemote = $state(false);
	/** Library id whose connection is being edited, or null. */
	let editingConnectionId = $state<string | null>(null);

	function handleRemoteAdded(library: Library) {
		draft.libraries = [...draft.libraries, library];
		showAddRemote = false;
	}

	function handleConnectionUpdated(libraryId: string, serverUrl: string) {
		draft.libraries = draft.libraries.map((lib) =>
			lib.id === libraryId && isRemoteServerLibrary(lib) ? { ...lib, serverUrl } : lib
		);
		const updated = draft.libraries.find((lib) => lib.id === libraryId);
		if (updated && isYACReaderLibrary(updated)) {
			// Force a fresh sync against the (possibly different) server.
			invalidateLibrarySync(libraryId);
		}
		editingConnectionId = null;
	}

	// ============================================================
	// Author from folders
	// ============================================================

	let authorAssignStatus = $state<Map<number, 'idle' | 'running' | 'done' | 'error'>>(new Map());
	let authorAssignMessage = $state<Map<number, string>>(new Map());

	async function setAuthorsFromFolders(index: number) {
		const lib = draft.libraries[index];
		if (!lib) return;

		authorAssignStatus = new Map(authorAssignStatus).set(index, 'running');
		authorAssignMessage = new Map(authorAssignMessage).set(index, m.libraries_computing_authors());

		try {
			const result = await assignAuthorsFromFolders(lib, (progress) => {
				authorAssignMessage = new Map(authorAssignMessage).set(index, renderUserMessage(progress.message));
			});
			authorAssignStatus = new Map(authorAssignStatus).set(index, 'done');
			authorAssignMessage = new Map(authorAssignMessage).set(
				index,
				m.libraries_authors_done({ updated: result.updated, root: result.skippedAtRoot })
			);
			setTimeout(() => {
				authorAssignStatus = new Map(authorAssignStatus).set(index, 'idle');
				authorAssignMessage = new Map(authorAssignMessage).set(index, '');
			}, 4000);
		} catch (err) {
			authorAssignStatus = new Map(authorAssignStatus).set(index, 'error');
			authorAssignMessage = new Map(authorAssignMessage).set(
				index,
				err instanceof Error ? err.message : m.libraries_assign_failed()
			);
		}
	}

	// ============================================================
	// Erase & Rescan Library
	// ============================================================

	let eraseRescanStatus = $state<Map<number, 'idle' | 'confirm' | 'running' | 'done' | 'error'>>(new Map());
	let eraseRescanMessage = $state<Map<number, string>>(new Map());

	function requestEraseAndRescan(index: number) {
		eraseRescanStatus = new Map(eraseRescanStatus).set(index, 'confirm');
		eraseRescanMessage = new Map(eraseRescanMessage).set(
			index,
			m.libraries_erase_confirm_text()
		);
	}

	function cancelEraseAndRescan(index: number) {
		eraseRescanStatus = new Map(eraseRescanStatus).set(index, 'idle');
		eraseRescanMessage = new Map(eraseRescanMessage).set(index, '');
	}

	async function confirmEraseAndRescan(index: number) {
		const lib = draft.libraries[index];
		if (!lib || !isLocalLibrary(lib)) return;

		eraseRescanStatus = new Map(eraseRescanStatus).set(index, 'running');
		eraseRescanMessage = new Map(eraseRescanMessage).set(index, m.libraries_erasing_data());

		try {
			const result = await eraseAndRescanLibrary(lib.id, lib.path, (progress) => {
				eraseRescanMessage = new Map(eraseRescanMessage).set(index, renderUserMessage(progress.message));
			});

			eraseRescanStatus = new Map(eraseRescanStatus).set(index, 'done');
			eraseRescanMessage = new Map(eraseRescanMessage).set(
				index,
				result.failed.length > 0
					? m.libraries_rescan_done_failed({ n: result.newImported, failed: result.failed.length })
					: m.libraries_rescan_done({ n: result.newImported })
			);
			setTimeout(() => {
				eraseRescanStatus = new Map(eraseRescanStatus).set(index, 'idle');
				eraseRescanMessage = new Map(eraseRescanMessage).set(index, '');
			}, 4000);
		} catch (err) {
			eraseRescanStatus = new Map(eraseRescanStatus).set(index, 'error');
			eraseRescanMessage = new Map(eraseRescanMessage).set(
				index,
				err instanceof Error ? err.message : m.libraries_rescan_failed()
			);
		}
	}
</script>

<div class="space-y-5">
	<!-- Libraries -->
	<div data-settings-anchor="libraries-list">
		<div class="mb-3 flex items-center justify-between">
			<h3 class="block text-sm font-medium text-surface-300">
				{m.libraries_title()}
			</h3>
			<div class="flex gap-1.5">
				{#if !isMobile}
				<button
					onclick={addLibrary}
					class="rounded-md border border-primary-600 px-3 py-1 text-xs font-medium text-primary-400 transition-colors active:bg-primary-600/20"
				>
					{m.libraries_add_local()}
				</button>
				{/if}
			<button
				onclick={() => { showAddRemote = true; editingConnectionId = null; }}
					class="rounded-md border border-primary-600 px-3 py-1 text-xs font-medium text-primary-400 transition-colors active:bg-primary-600/20"
			>
				{m.libraries_add_remote()}
			</button>
		</div>
	</div>

		{#if isMobile}
			<div class="mb-3 rounded-lg border border-primary-600/30 bg-primary-600/10 p-3 text-xs text-surface-200">
				<p>{m.libraries_android_hint()}</p>
				<div class="mt-1.5 overflow-x-auto rounded border border-surface-700 bg-surface-900/50 px-2 py-1">
					<span class="whitespace-nowrap font-mono text-primary-400">Android/data/com.fumeto.reader/files/Comics/</span>
				</div>
			</div>
		{/if}

		<!-- Add Remote Library (structured host/port/HTTPS form) -->
		{#if showAddRemote}
			<div class="mb-3">
				<RemoteServerForm
					mode="add"
					onadd={handleRemoteAdded}
					oncancel={() => (showAddRemote = false)}
				/>
			</div>
		{/if}

		{#if visibleManagedLibraries.length === 0}
		<div class="rounded-lg border border-dashed border-surface-700 px-4 py-6 text-center">
			<p class="text-xs text-surface-500">
				{m.libraries_empty()}
				</p>
			</div>
		{:else}
			<div class="space-y-3">
				{#each visibleManagedLibraries as { lib, i } (lib.id)}
					<div class="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
						<!-- Library name + delete -->
						<div class="mb-2 flex items-center gap-2">
							<input
								type="text"
								value={lib.name}
								oninput={(e) => updateLibraryName(i, (e.target as HTMLInputElement).value)}
								class="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium text-surface-100 transition-colors focus:border-surface-600 focus:bg-surface-800 focus:outline-none"
								placeholder={m.libraries_name_placeholder()}
								aria-label={m.libraries_name_placeholder()}
							/>
							{#if !(isMobile && isLocalLibrary(lib) && lib.path.endsWith('/Comics')) && removeStatus.get(i) !== 'confirm' && removeStatus.get(i) !== 'running'}
							<!-- The destructive-button idiom Settings already uses for
							     Erase Data & Rescan and Reset All Settings; as a bare
							     label it read as a caption, not an action. -->
							<button
								onclick={() => requestRemoveLibrary(i)}
								class="shrink-0 rounded-md border border-red-600/50 px-2.5 py-1.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/10 hover:text-red-300"
								title={m.libraries_remove_title()}
							>
								{m.common_remove()}
							</button>
						{/if}
						</div>

						<!-- Removal confirm (B1: data deletion is irreversible) -->
						{#if removeStatus.get(i) === 'confirm'}
							<div class="mb-2 rounded-md border border-red-600/40 bg-red-950/30 p-2">
								<p class="text-[11px] text-red-300">
									{m.libraries_remove_confirm()}
								</p>
								<div class="mt-1.5 flex gap-2">
									<button
										onclick={() => confirmRemoveLibrary(i)}
										class="rounded-md bg-red-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-red-700"
									>
										{m.libraries_remove_delete_data()}
									</button>
									<button
										onclick={() => cancelRemoveLibrary(i)}
										class="rounded-md border border-surface-600 px-2.5 py-1.5 text-[11px] font-medium text-surface-400 transition-colors hover:bg-surface-700 hover:text-surface-200"
									>
										{m.common_cancel()}
									</button>
								</div>
							</div>
						{:else if removeStatus.get(i) === 'running'}
							<p class="mb-2 text-[11px] font-medium text-surface-400">{m.libraries_removing()}</p>
						{:else if removeStatus.get(i) === 'error'}
							<p class="mb-2 text-[11px] text-red-400">{removeMessage.get(i)}</p>
						{/if}

						{#if isLocalLibrary(lib)}
							<!-- Path + browse -->
							<div class="mb-2 flex items-center gap-1.5">
								<p class="flex-1 truncate text-[11px] text-surface-500" title={lib.path}>
									{lib.path}
								</p>
								{#if !isMobile}
									<!-- Directory picking is unsupported by the dialog plugin on Android (B6) -->
									<button
										onclick={() => changeLibraryPath(i)}
										class="shrink-0 text-[11px] text-primary-400 transition-colors hover:text-primary-300"
									>
										{m.common_change()}
									</button>
								{/if}
							</div>

							<!-- Toggles -->
							<div class="flex items-center gap-6">
								<div class="flex-1">
									<Switch checked={lib.autoScan} onchange={() => toggleLibraryAutoScan(i)} label={m.libraries_auto_scan()} />
								</div>
								{#if !isMobile}
									<div class="flex-1">
										<Switch checked={lib.watchEnabled} onchange={() => toggleLibraryWatch(i)} label={m.libraries_watch()} />
									</div>
								{/if}
							</div>
							{#if !isMobile && lib.watchEnabled && $libraryWatchStatus[lib.id]}
								{@const watchStatus = $libraryWatchStatus[lib.id]}
								<p
									class="mt-1 text-[11px] {watchStatus.state === 'error' ? 'text-red-400' : 'text-surface-500'}"
									data-library-watch-status={watchStatus.state}
								>
									{watchStatus.state === 'error'
										? m.libraries_watch_failed({ detail: watchStatus.detail ?? '' })
										: m.libraries_watch_active()}
								</p>
							{/if}
						{:else if isYACReaderLibrary(lib)}
							<div class="mb-2 flex items-center gap-1.5">
								<span class="rounded bg-primary-600/20 px-1.5 py-0.5 text-[10px] font-medium text-primary-300">YACReader</span>
								<p class="flex-1 truncate text-[11px] text-surface-500">
									{lib.serverUrl}
								</p>
							</div>
							<div class="flex items-center gap-3">
								<span class="text-[11px] text-surface-400">
									{m.libraries_sync_prefix()} <span class="text-surface-300">{lib.syncMode === 'full' ? m.libraries_sync_full() : m.libraries_sync_browse()}</span>
								</span>
								{#if lib.lastSyncAt}
									<span class="text-[11px] text-surface-500">
										{m.libraries_last_sync({ date: formatDate(lib.lastSyncAt, 'short') })}
									</span>
								{/if}
							</div>
							<!-- Edit Connection lives in the shared actions row below, so
							     remote cards get the same two-up button layout as local
							     ones; only the form stays with its provider block. -->
							{#if editingConnectionId === lib.id}
								<div class="mt-2">
									<RemoteServerForm
										mode="edit"
										editLibrary={lib}
										onupdateconnection={(url) => handleConnectionUpdated(lib.id, url)}
										oncancel={() => (editingConnectionId = null)}
									/>
								</div>
							{/if}
						{:else if isKomgaLibrary(lib)}
							<div class="mb-2 flex items-center gap-1.5">
								<span class="rounded bg-amber-600/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">Komga</span>
								<p class="flex-1 truncate text-[11px] text-surface-500">
									{lib.serverUrl}
								</p>
							</div>
							<div class="flex items-center gap-3">
								<span class="text-[11px] text-surface-400">
									{m.libraries_sync_prefix()} <span class="text-surface-300">{lib.syncMode === 'full' ? m.libraries_sync_full() : m.libraries_sync_browse()}</span>
								</span>
								{#if lib.lastSyncAt}
									<span class="text-[11px] text-surface-500">
										{m.libraries_last_sync({ date: formatDate(lib.lastSyncAt, 'short') })}
									</span>
								{/if}
							</div>
							<!-- Edit Connection lives in the shared actions row below, so
							     remote cards get the same two-up button layout as local
							     ones; only the form stays with its provider block. -->
							{#if editingConnectionId === lib.id}
								<div class="mt-2">
									<RemoteServerForm
										mode="edit"
										editLibrary={lib}
										onupdateconnection={(url) => handleConnectionUpdated(lib.id, url)}
										oncancel={() => (editingConnectionId = null)}
									/>
								</div>
							{/if}
						{:else if isKavitaLibrary(lib)}
							<div class="mb-2 flex items-center gap-1.5">
								<span class="rounded bg-teal-600/20 px-1.5 py-0.5 text-[10px] font-medium text-teal-300">Kavita</span>
								<p class="flex-1 truncate text-[11px] text-surface-500">
									{lib.serverUrl}
								</p>
							</div>
							<div class="flex items-center gap-3">
								<span class="text-[11px] text-surface-400">
									{m.libraries_sync_prefix()} <span class="text-surface-300">{lib.syncMode === 'full' ? m.libraries_sync_full() : m.libraries_sync_browse()}</span>
								</span>
								{#if lib.lastSyncAt}
									<span class="text-[11px] text-surface-500">
										{m.libraries_last_sync({ date: formatDate(lib.lastSyncAt, 'short') })}
									</span>
								{/if}
							</div>
							<!-- Edit Connection lives in the shared actions row below, so
							     remote cards get the same two-up button layout as local
							     ones; only the form stays with its provider block. -->
							{#if editingConnectionId === lib.id}
								<div class="mt-2">
									<RemoteServerForm
										mode="edit"
										editLibrary={lib}
										onupdateconnection={(url) => handleConnectionUpdated(lib.id, url)}
										oncancel={() => (editingConnectionId = null)}
									/>
								</div>
							{/if}
				{:else}
							<p class="text-[11px] text-surface-500">{m.libraries_unknown_type()}</p>
						{/if}

				<!-- Library actions: equal-width columns with centered labels, so the
				     row is balanced whatever the pairing is (Edit Connection + Set
				     Authors on remotes, Set Authors + Erase on local). basis-0 makes
				     the split independent of label length, and a lone button simply
				     fills the row. -->
				<div class="mt-2 border-t border-surface-700/50 pt-2">
					<div class="flex items-stretch gap-2">
						{#if !isLocalLibrary(lib) && editingConnectionId !== lib.id}
							<button
								onclick={() => (editingConnectionId = lib.id)}
								class="min-w-0 flex-1 basis-0 rounded-md border border-surface-600 px-2.5 py-1.5 text-center text-[11px] font-medium text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-100"
							>
								{m.libraries_edit_connection()}
							</button>
						{/if}
						<button
							onclick={() => setAuthorsFromFolders(i)}
							disabled={authorAssignStatus.get(i) === 'running'}
							class="min-w-0 flex-1 basis-0 rounded-md border border-surface-600 px-2.5 py-1.5 text-center text-[11px] font-medium text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-100 disabled:cursor-wait disabled:opacity-50"
						>
							{#if authorAssignStatus.get(i) === 'running'}
								{m.libraries_assigning()}
							{:else}
								{m.libraries_set_authors()}
							{/if}
						</button>
								{#if isLocalLibrary(lib)}
									{#if eraseRescanStatus.get(i) === 'running'}
										<span class="min-w-0 flex-1 basis-0 self-center text-center text-[11px] font-medium text-surface-400">{m.libraries_erasing_rescanning()}</span>
									{:else if eraseRescanStatus.get(i) !== 'confirm'}
										<button
											onclick={() => requestEraseAndRescan(i)}
											class="min-w-0 flex-1 basis-0 rounded-md border border-red-600/50 px-2.5 py-1.5 text-center text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/10 hover:text-red-300"
										>
											{m.libraries_erase_rescan()}
										</button>
									{/if}
								{/if}
							</div>
							{#if authorAssignMessage.get(i)}
								<p class="mt-1 text-[11px] {authorAssignStatus.get(i) === 'error' ? 'text-red-400' : authorAssignStatus.get(i) === 'done' ? 'text-green-400' : 'text-surface-500'}">
									{authorAssignMessage.get(i)}
								</p>
							{/if}
							{#if isLocalLibrary(lib) && eraseRescanStatus.get(i) === 'confirm'}
								<div class="mt-2 rounded-md border border-amber-600/30 bg-amber-950/30 p-2">
									<p class="text-[11px] text-amber-400">
										{eraseRescanMessage.get(i)}
									</p>
									<div class="mt-1.5 flex gap-2">
										<button
											onclick={() => confirmEraseAndRescan(i)}
											class="rounded-md bg-red-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-red-700"
										>
											{m.libraries_erase_confirm_yes()}
										</button>
										<button
											onclick={() => cancelEraseAndRescan(i)}
											class="rounded-md border border-surface-600 px-2.5 py-1.5 text-[11px] font-medium text-surface-400 transition-colors hover:bg-surface-700 hover:text-surface-200"
										>
											{m.common_cancel()}
										</button>
									</div>
								</div>
							{:else if isLocalLibrary(lib) && eraseRescanMessage.get(i) && eraseRescanStatus.get(i) !== 'idle'}
								<p class="mt-1 text-[11px] {eraseRescanStatus.get(i) === 'error' ? 'text-red-400' : eraseRescanStatus.get(i) === 'done' ? 'text-green-400' : 'text-surface-500'}">
									{eraseRescanMessage.get(i)}
								</p>
							{/if}
						</div>
					</div>
				{/each}
			</div>
			<p class="mt-2 text-[11px] text-surface-600">
				{m.libraries_remove_note()}
			</p>
		{/if}
	</div>

	<!-- Scan notifications -->
	<div data-settings-anchor="scan-progress">
		<Switch
			bind:checked={draft.showLibraryScanProgress}
			dataTestid="show-library-scan-progress"
			label={m.settings_libraries_scan_progress_label()}
			sublabel={m.settings_libraries_scan_progress_sublabel()}
		/>
	</div>

	<!-- Storage durability -->
	<div data-settings-anchor="storage">
		<h3 class="mb-3 block text-sm font-medium text-surface-300">{m.libraries_storage_title()}</h3>
		<div class="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
			{#if $storageDurability.supported}
				<div class="flex items-center justify-between">
					<span class="text-xs text-surface-300">{m.libraries_storage_protection()}</span>
					{#if $storageDurability.persisted}
						<span class="rounded-full bg-green-600/15 px-2 py-0.5 text-[11px] font-medium text-green-400">{m.libraries_storage_protected()}</span>
					{:else if $storageDurability.persisted === false && isAndroid}
						<!-- The Android WebView has no persist() permission UI, so the
						     request is always denied — but app-private storage is never
						     selectively evicted by the OS, so "at risk" would be false
						     alarm. State the real contract instead. -->
						<span class="rounded-full bg-green-600/15 px-2 py-0.5 text-[11px] font-medium text-green-400">{m.libraries_storage_app()}</span>
					{:else if $storageDurability.persisted === false}
						<span class="rounded-full bg-amber-600/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">{m.libraries_storage_at_risk()}</span>
					{:else}
						<span class="rounded-full bg-surface-700 px-2 py-0.5 text-[11px] font-medium text-surface-400">{m.libraries_storage_unknown()}</span>
					{/if}
				</div>
				{#if $storageDurability.persisted === false && isAndroid}
					<p class="mt-1.5 text-[11px] text-surface-500">
						{m.libraries_storage_android_note()}
					</p>
				{:else if $storageDurability.persisted === false}
					<p class="mt-1.5 text-[11px] text-surface-500">
						{m.libraries_storage_browser_note()}
					</p>
					<button
						onclick={() => void requestStoragePersistence()}
						class="mt-2 rounded-md border border-primary-600 px-2.5 py-1.5 text-[11px] font-medium text-primary-400 transition-colors active:bg-primary-600/20"
					>
						{m.libraries_storage_request()}
					</button>
				{/if}
				{#if $storageDurability.usageBytes !== null && $storageDurability.quotaBytes}
					<div class="mt-3">
						<div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
							<div
								class="h-full rounded-full bg-primary-500"
								style="width: {Math.min(100, Math.max(1, ($storageDurability.usageBytes / $storageDurability.quotaBytes) * 100)).toFixed(1)}%"
							></div>
						</div>
						<p class="mt-1 text-[11px] text-surface-500">
							{m.libraries_storage_usage({ used: formatBytes($storageDurability.usageBytes), quota: formatBytes($storageDurability.quotaBytes) })}
						</p>
					</div>
				{/if}
			{:else}
				<p class="text-xs text-surface-500">{m.libraries_storage_unavailable()}</p>
			{/if}
		</div>
	</div>

	<OnDeviceModelsCard />

	<SettingsTransferCard />
</div>
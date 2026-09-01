<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { Library, YACReaderLibrary, KomgaLibrary, KavitaLibrary } from '$lib/settings/settings.js';
	import { randomUUID } from '$lib/util/uuid.js';
	import { getOrCreateClient } from '$lib/yacreader/yac-client-manager.js';
	import type { YACLibrary } from '$lib/yacreader/yac-types.js';
	import { KomgaServerClient } from '$lib/komga/komga-server-client.js';
	import type { KomgaLibrary as KomgaLibraryResponse } from '$lib/komga/komga-types.js';
	import { saveKomgaCredentials } from '$lib/komga/komga-credentials.js';
	import { KavitaServerClient } from '$lib/kavita/kavita-server-client.js';
	import type { KavitaLibraryDto } from '$lib/kavita/kavita-types.js';
	import { saveKavitaApiKey } from '$lib/kavita/kavita-credentials.js';
	import {
		composeServerUrl,
		decomposeServerUrl,
		defaultSchemeForHost,
		parseServerAddressInput,
		splitKavitaOpdsPath,
		SERVER_TYPE_DEFAULT_PORTS,
		type RemoteServerType
	} from '$lib/settings/server-address.js';
	import { humanizeConnectionError, type HumanizedConnectionError } from '$lib/settings/connection-errors.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';

	interface Props {
		mode: 'add' | 'edit';
		/** Edit mode: the library whose connection is being changed. */
		editLibrary?: Library & { serverUrl: string };
		onadd?: (library: Library) => void;
		onupdateconnection?: (serverUrl: string) => void;
		oncancel: () => void;
	}

	let { mode, editLibrary, onadd, onupdateconnection, oncancel }: Props = $props();

	const SERVER_TYPE_LABELS: Record<RemoteServerType, string> = {
		yacreader: 'YACReader',
		komga: 'Komga',
		kavita: 'Kavita'
	};

	function initialType(): RemoteServerType {
		if (mode === 'edit' && editLibrary) return editLibrary.type as RemoteServerType;
		return 'yacreader';
	}

	// Initial-value capture is intentional: the form seeds its fields from the
	// library being edited on mount and then owns them.
	// svelte-ignore state_referenced_locally
	const initialParts = mode === 'edit' && editLibrary ? decomposeServerUrl(editLibrary.serverUrl) : null;

	let serverType = $state<RemoteServerType>(initialType());
	let host = $state(initialParts?.host ?? '');
	let portText = $state(
		initialParts ? String(initialParts.port ?? '') : String(SERVER_TYPE_DEFAULT_PORTS[initialType()])
	);
	let portTouched = $state(initialParts !== null);
	let useHttps = $state(initialParts ? initialParts.scheme === 'https' : false);
	let httpsTouched = $state(initialParts !== null);
	let basePath = $state(initialParts?.basePath ?? '');
	let advancedOpen = $state((initialParts?.basePath ?? '') !== '');

	let username = $state('');
	let password = $state('');
	let apiKey = $state('');

	let testStatus = $state<'idle' | 'testing' | 'connected' | 'error'>('idle');
	let testError = $state<HumanizedConnectionError | null>(null);
	let yacLibraries = $state<YACLibrary[]>([]);
	let komgaLibraries = $state<KomgaLibraryResponse[]>([]);
	let kavitaLibraries = $state<KavitaLibraryDto[]>([]);
	let selectedYacId = $state<number | null>(null);
	let selectedKomgaId = $state<string | null>(null);
	let selectedKavitaId = $state<number | null>(null);
	let syncMode = $state<'full' | 'browse'>('full');
	let libraryName = $state('');
	let saving = $state(false);

	let portValue = $derived.by(() => {
		const trimmed = portText.trim();
		if (trimmed === '') return null;
		const parsed = Number(trimmed);
		return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
	});
	let portInvalid = $derived(portText.trim() !== '' && portValue === null);

	let composedUrl = $derived.by(() => {
		const trimmedHost = host.trim();
		if (trimmedHost === '') return null;
		return composeServerUrl({
			scheme: useHttps ? 'https' : 'http',
			host: trimmedHost,
			port: portValue,
			basePath
		});
	});

	function resetTestState() {
		testStatus = 'idle';
		testError = null;
		yacLibraries = [];
		komgaLibraries = [];
		kavitaLibraries = [];
		selectedYacId = null;
		selectedKomgaId = null;
		selectedKavitaId = null;
		libraryName = '';
	}

	function onServerTypeChange() {
		resetTestState();
		if (!portTouched) portText = String(SERVER_TYPE_DEFAULT_PORTS[serverType]);
	}

	/**
	 * Interpret pasted/typed structure in the host field on blur or paste:
	 * a full URL (or host:port/path) is split across the structured fields.
	 * Runs on blur — not per keystroke — so typing "host:2…" is not mangled.
	 */
	function distributeHostInput() {
		const raw = host.trim();
		const hadExplicitScheme = /^https?:\/\//iu.test(raw);
		const parsed = parseServerAddressInput(raw, useHttps ? 'https' : 'http');
		if (!parsed) return;
		host = parsed.parts.host;
		if (hadExplicitScheme) {
			useHttps = parsed.parts.scheme === 'https';
			httpsTouched = true;
		}
		if (parsed.parts.port !== null) {
			portText = String(parsed.parts.port);
			portTouched = true;
		}
		// Kavita's UI hands users the OPDS URL (…/api/opds/<key>) as the thing
		// to connect with, so accept it pasted whole: the trailing segment is
		// the API key, not part of the server path.
		if (serverType === 'kavita' && parsed.parts.basePath !== '') {
			const split = splitKavitaOpdsPath(parsed.parts.basePath);
			if (split.apiKey !== null) {
				apiKey = split.apiKey;
				parsed.parts.basePath = split.basePath;
			}
		}
		if (parsed.parts.basePath !== '') {
			basePath = parsed.parts.basePath;
			advancedOpen = true;
		}
		if (!httpsTouched) {
			useHttps = defaultSchemeForHost(host) === 'https';
		}
	}

	function onHostPaste() {
		// Let the paste land in the input first, then distribute.
		setTimeout(distributeHostInput, 0);
	}

	async function testConnection() {
		distributeHostInput();
		const url = composedUrl;
		if (!url) {
			testError = {
				message: { code: 'conn_form_no_address' },
				hint: null,
				raw: 'empty host'
			};
			testStatus = 'error';
			return;
		}
		if (portInvalid) {
			testError = {
				message: { code: 'conn_form_bad_port' },
				hint: null,
				raw: `invalid port: ${portText}`
			};
			testStatus = 'error';
			return;
		}
		if (serverType === 'kavita' && !apiKey.trim()) {
			testError = { message: { code: 'conn_form_kavita_key' }, hint: { code: 'conn_form_kavita_key_hint' }, raw: 'missing api key' };
			testStatus = 'error';
			return;
		}
		if (serverType === 'komga' && (!username.trim() || !password)) {
			testError = { message: { code: 'conn_form_komga_credentials' }, hint: null, raw: 'missing credentials' };
			testStatus = 'error';
			return;
		}

		testStatus = 'testing';
		testError = null;
		yacLibraries = [];
		komgaLibraries = [];
		kavitaLibraries = [];

		try {
			if (serverType === 'kavita') {
				const client = new KavitaServerClient(url, apiKey.trim());
				const libs = await client.fetchLibraries();
				if (libs.length === 0) {
					testError = { message: { code: 'conn_form_no_libraries' }, hint: null, raw: 'empty library list' };
					testStatus = 'error';
					return;
				}
				kavitaLibraries = libs;
				selectedKavitaId = libs[0].id;
				libraryName = libs[0].name;
			} else if (serverType === 'komga') {
				const client = new KomgaServerClient(url, username.trim(), password);
				const libs = await client.fetchLibraries();
				if (libs.length === 0) {
					testError = { message: { code: 'conn_form_no_libraries' }, hint: null, raw: 'empty library list' };
					testStatus = 'error';
					return;
				}
				komgaLibraries = libs;
				selectedKomgaId = libs[0].id;
				libraryName = libs[0].name;
			} else {
				// Reuse the per-server client so this probe shares the same
				// serialized transport as catalog hydration, sync, page reads,
				// and progress writes.
				const client = getOrCreateClient(url);
				const libs = await client.fetchLibraries();
				if (libs.length === 0) {
					testError = { message: { code: 'conn_form_no_libraries' }, hint: null, raw: 'empty library list' };
					testStatus = 'error';
					return;
				}
				yacLibraries = libs;
				selectedYacId = libs[0].id;
				libraryName = libs[0].name;
			}
			testStatus = 'connected';
		} catch (err) {
			testStatus = 'error';
			testError = humanizeConnectionError(err, serverType, url);
		}
	}

	function onLibrarySelected(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		if (serverType === 'kavita') {
			const id = parseInt(value, 10);
			selectedKavitaId = id;
			const lib = kavitaLibraries.find((l) => l.id === id);
			if (lib) libraryName = lib.name;
		} else if (serverType === 'komga') {
			selectedKomgaId = value;
			const lib = komgaLibraries.find((l) => l.id === value);
			if (lib) libraryName = lib.name;
		} else {
			const id = parseInt(value, 10);
			selectedYacId = id;
			const lib = yacLibraries.find((l) => l.id === id);
			if (lib) libraryName = lib.name;
		}
	}

	let canConfirmAdd = $derived(
		testStatus === 'connected' &&
		libraryName.trim() !== '' &&
		(serverType === 'yacreader' ? selectedYacId !== null : serverType === 'komga' ? selectedKomgaId !== null : selectedKavitaId !== null)
	);

	async function confirmAdd() {
		const url = composedUrl;
		if (!url || !canConfirmAdd || saving) return;
		saving = true;
		try {
			if (serverType === 'kavita') {
				const selectedLib = kavitaLibraries.find((l) => l.id === selectedKavitaId);
				if (!selectedLib) return;
				const newLib: KavitaLibrary = {
					id: randomUUID(),
					type: 'kavita',
					name: libraryName.trim(),
					serverUrl: url,
					kavitaLibraryId: selectedLib.id,
					syncMode
				};
				await saveKavitaApiKey(url, apiKey.trim());
				onadd?.(newLib);
			} else if (serverType === 'komga') {
				const selectedLib = komgaLibraries.find((l) => l.id === selectedKomgaId);
				if (!selectedLib) return;
				const newLib: KomgaLibrary = {
					id: randomUUID(),
					type: 'komga',
					name: libraryName.trim(),
					serverUrl: url,
					komgaLibraryId: selectedLib.id,
					syncMode
				};
				await saveKomgaCredentials(url, username.trim(), password);
				onadd?.(newLib);
			} else {
				const selectedLib = yacLibraries.find((l) => l.id === selectedYacId);
				if (!selectedLib) return;
				const newLib: YACReaderLibrary = {
					id: randomUUID(),
					type: 'yacreader',
					name: libraryName.trim(),
					serverUrl: url,
					remoteLibraryId: selectedLib.id,
					remoteLibraryUuid: selectedLib.uuid,
					syncMode
				};
				onadd?.(newLib);
			}
		} catch (err) {
			// Storing the credential can now fail closed: when the device key is
			// unreadable, secure storage refuses to write ciphertext under a newly
			// generated key rather than orphaning every other saved secret. Without
			// this the throw escaped confirmAdd/confirmUpdateConnection, onadd was
			// never called, and the form silently did nothing.
			testStatus = 'error';
			testError = {
				message: { code: 'conn_form_save_failed' },
				hint: { code: 'conn_form_save_failed_hint' },
				raw: err instanceof Error ? err.message : String(err)
			};
		} finally {
			saving = false;
		}
	}

	async function confirmUpdateConnection() {
		const url = composedUrl;
		if (!url || testStatus !== 'connected' || saving) return;
		saving = true;
		try {
			if (serverType === 'kavita') {
				await saveKavitaApiKey(url, apiKey.trim());
			} else if (serverType === 'komga') {
				await saveKomgaCredentials(url, username.trim(), password);
			}
			onupdateconnection?.(url);
		} catch (err) {
			// Storing the credential can now fail closed: when the device key is
			// unreadable, secure storage refuses to write ciphertext under a newly
			// generated key rather than orphaning every other saved secret. Without
			// this the throw escaped confirmAdd/confirmUpdateConnection, onadd was
			// never called, and the form silently did nothing.
			testStatus = 'error';
			testError = {
				message: { code: 'conn_form_save_failed' },
				hint: { code: 'conn_form_save_failed_hint' },
				raw: err instanceof Error ? err.message : String(err)
			};
		} finally {
			saving = false;
		}
	}
</script>

<div class="rounded-lg border border-primary-600/40 bg-primary-600/5 p-3">
	<h4 class="mb-2 text-xs font-medium text-primary-300">
		{mode === 'add' ? m.settings_server_add_servertype_server({ serverType: SERVER_TYPE_LABELS[serverType] }) : m.settings_server_edit_connection_name({ name: editLibrary?.name ?? '' })}
	</h4>

	{#if mode === 'add'}
		<!-- Server type selection -->
		<div class="mb-3">
			<label for="remote-server-type" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_server_type()}</label>
			<select
				id="remote-server-type"
				bind:value={serverType}
				onchange={onServerTypeChange}
				class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
			>
				<option value="yacreader">{m.settings_server_yacreader_server()}</option>
				<option value="komga">{m.settings_server_komga_server()}</option>
				<option value="kavita">{m.settings_server_kavita_server()}</option>
			</select>
		</div>
	{/if}

	<!-- Server address (host only — no scheme required) -->
	<div class="mb-3">
		<label for="remote-server-host" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_server_address()}</label>
		<input
			id="remote-server-host"
			type="text"
			bind:value={host}
			onblur={distributeHostInput}
			onpaste={onHostPaste}
			oninput={() => { if (testStatus !== 'idle') resetTestState(); }}
			placeholder={m.settings_server_192_168_1_50()}
			autocapitalize="off"
			autocorrect="off"
			spellcheck="false"
			class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
		/>
		<p class="mt-1 text-[11px] text-surface-500">
			{m.settings_server_ip_or_hostname_no()}
		</p>
	</div>

	<!-- Port + HTTPS -->
	<div class="mb-3 flex items-start gap-3">
		<div class="w-28 shrink-0">
			<label for="remote-server-port" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_port()}</label>
			<input
				id="remote-server-port"
				type="text"
				inputmode="numeric"
				pattern="[0-9]*"
				bind:value={portText}
				oninput={() => { portTouched = true; if (testStatus !== 'idle') resetTestState(); }}
				placeholder={String(SERVER_TYPE_DEFAULT_PORTS[serverType])}
				class="w-full rounded-md border {portInvalid ? 'border-red-500/70' : 'border-surface-700'} bg-surface-800 px-2.5 py-2 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
			/>
			{#if portInvalid}
				<p class="mt-1 text-[11px] text-red-400">1–65535</p>
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<span class="mb-1 block text-[11px] text-surface-400">{m.settings_server_use_https()}</span>
			<button
				type="button"
				role="switch"
				aria-checked={useHttps}
				aria-label={m.settings_server_use_https()}
				onclick={() => { useHttps = !useHttps; httpsTouched = true; if (testStatus !== 'idle') resetTestState(); }}
				class="inline-flex h-[34px] items-center gap-2 rounded-md border border-surface-700 bg-surface-800 px-3 text-xs font-medium transition-colors {useHttps ? 'text-green-400' : 'text-surface-400'}"
			>
				<span class="inline-block h-3.5 w-6 rounded-full transition-colors {useHttps ? 'bg-green-500/70' : 'bg-surface-600'}">
					<span class="block h-3.5 w-3.5 rounded-full bg-white transition-transform {useHttps ? 'translate-x-2.5' : ''}"></span>
				</span>
				{useHttps ? m.settings_server_on() : m.settings_server_off()}
			</button>
			<p class="mt-1 text-[11px] text-surface-500">
				{useHttps ? m.settings_server_encrypted_for_servers_reachable() : m.settings_server_plain_http_typical_for()}
			</p>
		</div>
	</div>

	<!-- Advanced: base path -->
	<details class="mb-3" bind:open={advancedOpen}>
		<summary class="cursor-pointer select-none text-[11px] text-surface-400 hover:text-surface-300">
			{m.settings_server_advanced()} <span class="text-surface-500">{m.settings_server_base_path_e_g()}</span>
		</summary>
		<div class="mt-2">
			<label for="remote-server-base-path" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_base_path()}</label>
			<input
				id="remote-server-base-path"
				type="text"
				bind:value={basePath}
				oninput={() => { if (testStatus !== 'idle') resetTestState(); }}
				placeholder="/komga"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
				class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
			/>
		</div>
	</details>

	<!-- Credentials -->
	{#if serverType === 'kavita'}
		<div class="mb-3">
			<label for="remote-server-api-key" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_api_key()}</label>
			<input
				id="remote-server-api-key"
				type="password"
				bind:value={apiKey}
				oninput={() => { if (testStatus !== 'idle') resetTestState(); }}
				placeholder={mode === 'edit' ? m.settings_server_re_enter_the_api() : m.settings_server_kavita_settings_account_api()}
				class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
			/>
		</div>
	{:else if serverType === 'komga'}
		<div class="mb-3 space-y-2">
			<div>
				<label for="remote-server-username" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_username()}</label>
				<input
					id="remote-server-username"
					type="text"
					bind:value={username}
					oninput={() => { if (testStatus !== 'idle') resetTestState(); }}
					placeholder={mode === 'edit' ? m.settings_server_re_enter_to_test() : m.settings_server_username_email()}
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
				/>
			</div>
			<div>
				<label for="remote-server-password" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_password()}</label>
				<input
					id="remote-server-password"
					type="password"
					bind:value={password}
					oninput={() => { if (testStatus !== 'idle') resetTestState(); }}
					placeholder={mode === 'edit' ? m.settings_server_re_enter_to_test() : m.settings_server_password()}
					class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
				/>
			</div>
		</div>
	{/if}

	<!-- Live URL preview + test -->
	<div class="mb-2 flex items-center gap-2">
		<p class="min-w-0 flex-1 truncate rounded border border-surface-700/60 bg-surface-900/60 px-2 py-1.5 font-mono text-[11px] {composedUrl ? 'text-primary-300' : 'text-surface-600'}" data-testid="server-url-preview" title={composedUrl ?? ''}>
			{composedUrl ?? m.settings_server_server_address_preview()}
		</p>
		<button
			onclick={testConnection}
			disabled={testStatus === 'testing'}
			class="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors
				{testStatus === 'connected'
					? 'bg-green-600/80 text-white'
					: testStatus === 'testing'
						? 'cursor-wait bg-surface-700 text-surface-400'
						: 'bg-primary-600 text-white hover:bg-primary-700'}"
		>
			{#if testStatus === 'testing'}
				{m.settings_server_testing()}
			{:else if testStatus === 'connected'}
				{m.settings_server_connected()}
			{:else}
				{m.settings_server_test()}
			{/if}
		</button>
	</div>

	{#if testError}
		<div class="mb-2 rounded-md border border-red-800/50 bg-red-950/30 px-2.5 py-2">
			<p class="text-[11px] font-medium text-red-300">{renderUserMessage(testError.message)}</p>
			{#if testError.hint}
				<p class="mt-0.5 text-[11px] text-red-400/90">{renderUserMessage(testError.hint)}</p>
			{/if}
			{#if testError.raw && testError.raw !== renderUserMessage(testError.message)}
				<details class="mt-1">
					<summary class="cursor-pointer text-[11px] text-surface-500 hover:text-surface-400">{m.settings_server_technical_details()}</summary>
					<p class="mt-0.5 break-words font-mono text-[11px] text-surface-500">{testError.raw}</p>
				</details>
			{/if}
		</div>
	{/if}

	<!-- Step 2 (add): library picker + sync mode + name -->
	{#if mode === 'add' && testStatus === 'connected'}
		<div class="space-y-2 border-t border-surface-700/50 pt-2">
			<div>
				<label for="remote-server-library" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_server_library()}</label>
				<select
					id="remote-server-library"
					onchange={onLibrarySelected}
					class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
				>
					{#if serverType === 'yacreader'}
						{#each yacLibraries as rLib (rLib.id)}
							<option value={rLib.id} selected={rLib.id === selectedYacId}>
								{rLib.name}
							</option>
						{/each}
					{:else if serverType === 'komga'}
						{#each komgaLibraries as rLib (rLib.id)}
							<option value={rLib.id} selected={rLib.id === selectedKomgaId}>
								{rLib.name}
							</option>
						{/each}
					{:else}
						{#each kavitaLibraries as rLib (rLib.id)}
							<option value={rLib.id} selected={rLib.id === selectedKavitaId}>
								{rLib.name}
							</option>
						{/each}
					{/if}
				</select>
			</div>

			<div>
				<p class="mb-1 block text-[11px] text-surface-400">{m.settings_server_sync_mode()}</p>
				<div class="flex gap-3">
					<label class="flex items-center gap-1.5 text-xs">
						<input type="radio" name="sync-mode" value="full" bind:group={syncMode} />
						<span class="text-surface-200">{m.settings_server_full_sync()}</span>
					</label>
					<label class="flex items-center gap-1.5 text-xs">
						<input type="radio" name="sync-mode" value="browse" bind:group={syncMode} />
						<span class="text-surface-200">{m.libraries_sync_browse()}</span>
					</label>
				</div>
				<p class="mt-0.5 text-[11px] text-surface-500">
					{syncMode === 'full'
						? m.settings_server_download_all_metadata_and()
						: m.settings_server_fetch_folder_by_folder()}
				</p>
			</div>

			<div>
				<label for="remote-library-display-name" class="mb-1 block text-[11px] text-surface-400">{m.settings_server_display_name()}</label>
				<input
					id="remote-library-display-name"
					type="text"
					bind:value={libraryName}
					class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-2 text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
					placeholder={m.libraries_name_placeholder()}
				/>
			</div>
		</div>
	{/if}

	<!-- Actions: Cancel is always available (review bug B4) -->
	<div class="mt-2 flex justify-end gap-2">
		<button
			onclick={oncancel}
			class="rounded-md px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200"
		>
			{m.common_cancel()}
		</button>
		{#if mode === 'add' && testStatus === 'connected'}
			<button
				onclick={confirmAdd}
				disabled={!canConfirmAdd || saving}
				class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{m.settings_server_add_library()}
			</button>
		{:else if mode === 'edit' && testStatus === 'connected'}
			<button
				onclick={confirmUpdateConnection}
				disabled={saving}
				class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{m.settings_server_save_connection()}
			</button>
		{/if}
	</div>
</div>

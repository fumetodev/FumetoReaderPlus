<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { getLanguageDisplayName } from '$lib/i18n/language-names.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';
	import { settingsDraft as draft, registerEditorCommit, flushPendingApply } from './settings-state.svelte.js';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { slidingSelection } from '$lib/util/sliding-selection.js';
	import { randomUUID } from '$lib/util/uuid.js';
	import { ggufDownloadState, downloadHyMT2Model, cancelModelDownload as cancelGgufDownload, deleteHyMT2Model, isModelDownloaded, HYMT2_VARIANTS, BUNDLED_HYMT2_VARIANTS, bundledSpec, type HyMT2Variant, type BundledHyMT2Variant } from '$lib/translation/gguf-model-manager.js';
	import { modelMemoryAdvice, readDeviceMemory } from '$lib/device/device-memory.js';
	import { ocrModelDownloadState, downloadOcrModels, cancelOcrModelDownload, deleteOcrModels, areOcrModelsReady, OCR_MODELS_TOTAL_BYTES } from '$lib/detection/ocr-model-manager.js';

	// Read once — the same advice the future Pro purchase flow must show
	// BEFORE purchase, so a 4 GB device learns its limits before paying.
	const deviceMemory = readDeviceMemory();
	import { isLlamaBridgeAvailable, unloadModel as unloadHyMT2Model, getBackend, getAvailableMemoryGB } from '$lib/translation/llamacpp-bridge.js';
	import { settings, DEFAULT_OPENROUTER_MODEL, SUPPORTED_LANGUAGES, ON_DEVICE_SOURCE_LANGUAGES, ON_DEVICE_TARGET_LANGUAGES, ON_DEVICE_TEMPERATURE_DEFAULT, ON_DEVICE_TEMPERATURE_MIN, ON_DEVICE_TEMPERATURE_MAX } from '$lib/settings/settings.js';
	import { untrack } from 'svelte';
	import { fetchModelsForProvider } from '$lib/translation/llm-client.js';
	import { validateOpenRouterApiKey } from '$lib/translation/openrouter-client.js';
	import type { ProviderConfig, ProviderType, LLMModel } from '$lib/translation/llm-types.js';
	import { loadProviderApiKey } from '$lib/settings/secure-storage.js';
	import { stageProviderKeyDraft } from '$lib/settings/provider-key-drafts.js';
	import { isAndroid } from '$lib/util/platform.js';
	import ModelPicker from './ModelPicker.svelte';

	// ============================================================
	// Pipeline sub-tabs — VIEW state only. Selecting a sub-tab no longer
	// changes which pipeline runs (review §3.1.1); the explicit switch
	// control below does.
	// ============================================================
	let translationSubTab = $state<'off-device' | 'on-device'>(draft.translationPipeline);

	// ============================================================
	// Multi-provider editor state (transient — resets when the tab unmounts)
	// ============================================================
	let editingProviderIndex = $state<number | null>(null);
	let editProviderType = $state<ProviderType>('openrouter');
	let editProviderName = $state('');
	let editProviderBaseUrl = $state('');
	let editProviderApiKey = $state('');
	let editProviderModel = $state('');
	let editProviderRequiresKey = $state(true);
	let editProviderVisionOnly = $state(true);
	let providerConnectionStatus = $state<'idle' | 'connecting' | 'connected' | 'error'>('idle');
	let providerConnectionError = $state<string | null>(null);
	let providerAvailableModels = $state<LLMModel[]>([]);
	let providerEditorGeneration = 0;
	let providerConnectionGeneration = 0;
	let providerConnectionController: AbortController | null = null;

	const PROVIDER_DEFAULTS: Record<ProviderType, { name: string; baseUrl: string; requiresApiKey: boolean; visionOnly: boolean }> = {
		'openrouter':        { name: 'OpenRouter',          baseUrl: '',                           requiresApiKey: true,  visionOnly: true },
		'openai-compatible': { name: 'OpenAI',              baseUrl: 'https://api.openai.com',     requiresApiKey: true,  visionOnly: false },
		'ollama':            { name: 'Ollama',              baseUrl: 'http://localhost:11434',      requiresApiKey: false, visionOnly: false },
		'lmstudio':          { name: 'LM Studio',           baseUrl: 'http://localhost:1234',       requiresApiKey: false, visionOnly: false },
		'local-compatible':  { name: m.settings_translation_local_server(),        baseUrl: 'http://localhost:8080',       requiresApiKey: false, visionOnly: false },
		'claude':            { name: 'Claude (Anthropic)',   baseUrl: 'https://api.anthropic.com',  requiresApiKey: true,  visionOnly: true },
	};

	const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
		'openrouter': 'OpenRouter',
		'openai-compatible': 'OpenAI Compatible',
		'ollama': 'Ollama',
		'lmstudio': 'LM Studio',
		'local-compatible': 'Local Server',
		'claude': 'Claude',
	};

	// The open provider row is an editor the draft cannot see into: its key and
	// model are staged only when it collapses. Leaving Settings commits it
	// through the flush, so a key typed and never collapsed by hand is saved.
	$effect(() => registerEditorCommit(() => {
		if (editingProviderIndex === null) return false;
		collapseProvider();
		return true;
	}));

	// Belt and braces for a teardown that did not come through the flush (a tab
	// switch inside Settings): stage, then apply now rather than trusting a
	// watch effect that may already be inactive.
	$effect(() => {
		return () => {
			if (editingProviderIndex === null) return;
			collapseProvider();
			void flushPendingApply();
		};
	});

	function addProvider() {
		const defaults = PROVIDER_DEFAULTS['openrouter'];
		const newProvider: ProviderConfig = {
			id: randomUUID(),
			type: 'openrouter',
			name: defaults.name,
			requiresApiKey: defaults.requiresApiKey,
			visionOnly: defaults.visionOnly,
			baseUrl: defaults.baseUrl || undefined,
			defaultModel: DEFAULT_OPENROUTER_MODEL
		};
		draft.providers = [...draft.providers, newProvider];
		if (draft.providers.length === 1) {
			draft.activeProviderId = newProvider.id;
		}
		expandProvider(draft.providers.length - 1);
	}

	async function expandProvider(index: number) {
		const provider = draft.providers[index];
		if (!provider) return;
		if (editingProviderIndex !== null && editingProviderIndex !== index) {
			collapseProvider();
		}
		providerConnectionGeneration++;
		providerConnectionController?.abort();
		providerConnectionController = null;
		const editorGeneration = ++providerEditorGeneration;
		const providerId = provider.id;

		editingProviderIndex = index;
		editProviderType = provider.type;
		editProviderName = provider.name;
		editProviderBaseUrl = provider.baseUrl ?? PROVIDER_DEFAULTS[provider.type]?.baseUrl ?? '';
		editProviderModel = provider.defaultModel ?? '';
		editProviderRequiresKey = provider.requiresApiKey;
		editProviderVisionOnly = provider.visionOnly ?? PROVIDER_DEFAULTS[provider.type]?.visionOnly ?? false;
		providerConnectionStatus = 'idle';
		providerConnectionError = null;
		providerAvailableModels = [];

		try {
			const loadedKey = draft.pendingApiKeys.has(provider.id)
				? draft.pendingApiKeys.get(provider.id)!
				: await loadProviderApiKey(provider.id);
			if (
				editorGeneration !== providerEditorGeneration ||
				draft.providers[editingProviderIndex ?? -1]?.id !== providerId
			) return;
			editProviderApiKey = loadedKey;
		} catch {
			if (editorGeneration !== providerEditorGeneration) return;
			editProviderApiKey = '';
		}

		if (editProviderApiKey || !editProviderRequiresKey) {
			connectProvider();
		}
	}

	function collapseProvider() {
		if (editingProviderIndex !== null && editingProviderIndex < draft.providers.length) {
			const provider = draft.providers[editingProviderIndex];
			draft.providers = draft.providers.map((p, i) =>
				i === editingProviderIndex
					? {
						...p,
						type: editProviderType,
						name: editProviderName,
						baseUrl: editProviderBaseUrl || undefined,
						defaultModel: editProviderModel || undefined,
						requiresApiKey: editProviderRequiresKey,
						visionOnly: editProviderVisionOnly
					}
					: p
			);
			if (provider) {
				draft.pendingApiKeys = stageProviderKeyDraft(
					draft.pendingApiKeys,
					provider.id,
					editProviderRequiresKey,
					editProviderApiKey
				);
			}
		}
		providerEditorGeneration++;
		providerConnectionGeneration++;
		providerConnectionController?.abort();
		providerConnectionController = null;
		editingProviderIndex = null;
	}

	function onProviderTypeChange(newType: ProviderType) {
		providerConnectionGeneration++;
		providerConnectionController?.abort();
		providerConnectionController = null;
		editProviderType = newType;
		const defaults = PROVIDER_DEFAULTS[newType];
		editProviderName = defaults.name;
		editProviderBaseUrl = defaults.baseUrl;
		editProviderRequiresKey = defaults.requiresApiKey;
		editProviderVisionOnly = defaults.visionOnly;
		providerConnectionStatus = 'idle';
		providerConnectionError = null;
		providerAvailableModels = [];
		editProviderApiKey = '';
		editProviderModel = '';
	}

	/** Auto-toggle vision mode based on the selected model's capabilities. */
	function autoSuggestVisionMode(modelId: string) {
		const model = providerAvailableModels.find((m) => m.id === modelId);
		if (model?.supportsVision === true) {
			editProviderVisionOnly = true;
		} else if (model?.supportsVision === false) {
			editProviderVisionOnly = false;
		}
	}

	async function connectProvider() {
		if (editProviderRequiresKey && !editProviderApiKey) {
			providerConnectionError = m.settings_translation_please_enter_an_api();
			providerConnectionStatus = 'error';
			return;
		}

		const providerId = draft.providers[editingProviderIndex ?? -1]?.id;
		if (!providerId) return;
		providerConnectionController?.abort();
		const controller = new AbortController();
		providerConnectionController = controller;
		const operation = ++providerConnectionGeneration;
		const apiKeySnapshot = editProviderApiKey;
		const modelSnapshot = editProviderModel;
		const config: ProviderConfig = {
			id: providerId,
			type: editProviderType,
			name: editProviderName,
			baseUrl: editProviderBaseUrl || undefined,
			requiresApiKey: editProviderRequiresKey,
			visionOnly: editProviderVisionOnly
		};

		providerConnectionStatus = 'connecting';
		providerConnectionError = null;
		const editorStillMatchesSnapshot = () =>
			draft.providers[editingProviderIndex ?? -1]?.id === providerId &&
			editProviderType === config.type &&
			editProviderName === config.name &&
			(editProviderBaseUrl || undefined) === config.baseUrl &&
			editProviderRequiresKey === config.requiresApiKey &&
			editProviderVisionOnly === config.visionOnly &&
			editProviderApiKey === apiKeySnapshot &&
			editProviderModel === modelSnapshot;

		try {
			// OpenRouter's model-list endpoint is public, so fetching it alone
			// does not validate the credential. Probe the authenticated
			// current-key endpoint before showing a successful state.
			if (config.type === 'openrouter') {
				await validateOpenRouterApiKey(apiKeySnapshot, controller.signal);
			}
			const availableModels = await fetchModelsForProvider(
				config,
				apiKeySnapshot,
				controller.signal
			);
			if (
				controller.signal.aborted ||
				operation !== providerConnectionGeneration ||
				!editorStillMatchesSnapshot()
			) {
				if (operation === providerConnectionGeneration) providerConnectionStatus = 'idle';
				return;
			}
			providerAvailableModels = availableModels;
			providerConnectionStatus = 'connected';

			if (providerAvailableModels.length > 0) {
				const hasCurrentModel = providerAvailableModels.some((m) => m.id === modelSnapshot);
				if (!hasCurrentModel) {
					if (editProviderType === 'openrouter') {
						const defaultModel = providerAvailableModels.find((m) => m.id === DEFAULT_OPENROUTER_MODEL)
							|| providerAvailableModels[0];
						editProviderModel = defaultModel.id;
					} else {
						editProviderModel = providerAvailableModels[0].id;
					}
				}
				autoSuggestVisionMode(editProviderModel);
			}
		} catch (err) {
			if (
				controller.signal.aborted ||
				operation !== providerConnectionGeneration ||
				!editorStillMatchesSnapshot()
			) return;
			providerConnectionStatus = 'error';
			providerConnectionError = err instanceof Error ? err.message : m.settings_translation_failed_to_connect();
			providerAvailableModels = [];
		}
	}

	function removeProvider(index: number) {
		const provider = draft.providers[index];
		if (!provider) return;

		if (draft.activeProviderId === provider.id) {
			const remaining = draft.providers.filter((_, i) => i !== index);
			draft.activeProviderId = remaining.length > 0 ? remaining[0].id : null;
		}

		if (editingProviderIndex === index) {
			providerEditorGeneration++;
			providerConnectionGeneration++;
			providerConnectionController?.abort();
			providerConnectionController = null;
			editingProviderIndex = null;
		} else if (editingProviderIndex !== null && editingProviderIndex > index) {
			editingProviderIndex--;
		}

		draft.providers = draft.providers.filter((_, i) => i !== index);
		const nextPending = new Map(draft.pendingApiKeys);
		nextPending.delete(provider.id);
		draft.pendingApiKeys = nextPending;
	}

	function formatPrice(priceStr: string): string {
		const price = parseFloat(priceStr);
		if (isNaN(price) || price === 0) return 'free';
		if (price < 0.001) return `$${(price * 1000000).toFixed(2)}/M`;
		return `$${(price * 1000000).toFixed(1)}/M`;
	}

	// ============================================================
	// On-device state (deferred heavy checks)
	// ============================================================
	let onDeviceChecksLoaded = $state(false);
	let hyMT2CheckStarted = $state(false);
	let hyMT2ChecksLoaded = $state(false);
	let hyMT2Downloaded = $state<Record<HyMT2Variant, boolean>>({
		stock: false,
		'manga-v2': false,
		'manga-v3': false,
		'manga-v5': false,
		custom: false
	});
	let hyMT2Backend = $state('unknown');

	// Vision models (PP-OCR detector + recogniser, rtmdet layout). Downloaded
	// on demand; the readiness flag drives the card below and nothing else, so
	// a failed probe simply shows the download button again.
	let ocrModelsReady = $state(false);
	const ocrModelsTotalMB = Math.round(OCR_MODELS_TOTAL_BYTES / 1024 / 1024);

	async function refreshOcrModels(): Promise<void> {
		ocrModelsReady = await areOcrModelsReady().catch(() => false);
	}

	$effect(() => {
		// Re-probe whenever a transfer settles, so Ready/Download flips without
		// leaving the tab.
		const status = $ocrModelDownloadState.status;
		if (status === 'idle' || status === 'completed') untrack(() => { void refreshOcrModels(); });
	});

	async function refreshHyMT2Downloaded(): Promise<void> {
		const next: Record<HyMT2Variant, boolean> = {
			stock: false,
			'manga-v2': false,
			'manga-v3': false,
			'manga-v5': false,
			custom: false
		};
		for (const variant of Object.keys(HYMT2_VARIANTS) as HyMT2Variant[]) {
			next[variant] = await isModelDownloaded(variant).catch(() => false);
		}
		hyMT2Downloaded = next;
	}

	async function selectHyMT2Variant(variant: HyMT2Variant): Promise<void> {
		if (draft.hyMT2Variant === variant) return;
		draft.hyMT2Variant = variant;
		// Next translation loads the newly selected file; drop the old one now.
		const { unloadModel } = await import('$lib/translation/llamacpp-bridge.js');
		await unloadModel().catch(() => undefined);
	}

	// ============================================================
	// Custom (user-supplied) model
	// ============================================================
	let customError = $state<string | null>(null);
	let customFormatBusy = $state(false);
	let customPrefix = $state('');
	let customSuffix = $state('');
	let customStops = $state('');

	// Seeded from the store, not the settings draft: the draft does not
	// re-hydrate from store writes, so an import that lands while this dialog
	// is open would otherwise leave these fields stale.
	$effect(() => {
		const record = $settings.customModel;
		if (record?.templateMode !== 'manual') return;
		untrack(() => {
			customPrefix = record.promptPrefix ?? '';
			customSuffix = record.promptSuffix ?? '';
			customStops = (record.stopStrings ?? []).join('\n');
		});
	});

	function formatCustomSize(bytes: number): string {
		const mb = bytes / (1024 * 1024);
		return mb >= 1024 ? `~${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`;
	}

	function describeImportOutcome(status: string): string | null {
		if (status === 'needs-format') {
			return m.settings_translation_fumeto_couldn_t_recognise_2();
		}
		if (status === 'load-failed') {
			// Deliberately does NOT mention prompt formats: this branch is
			// reached for out-of-memory, truncated files and unsupported
			// quants, none of which a chat template can fix.
			return m.settings_translation_this_model_wouldn_t_2();
		}
		// 'failed-self-test' deliberately returns nothing: the row renders a
		// persistent warning from the stored record, and showing a second,
		// near-identical line beside it just reads as two problems.
		return null;
	}

	async function chooseCustomModel(): Promise<void> {
		customError = null;
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			// The extension filter is inert on Android — MimeTypeMap has no
			// entry for "gguf", so the intent falls back to */* — but it is
			// correct on desktop, and the native import checks the file's GGUF
			// magic bytes before copying anything.
			const picked = await open({
				multiple: false,
				filters: [{ name: m.settings_translation_gguf_model(), extensions: ['gguf'] }]
			});
			const uri = Array.isArray(picked) ? picked[0] : picked;
			if (!uri) return;

			const { resolveDisplayName } = await import('$lib/util/file-utils.js');
			const displayName = await resolveDisplayName(uri);

			const { importCustomModel } = await import('$lib/translation/gguf-model-manager.js');
			const status = await importCustomModel(uri, displayName);
			customError = describeImportOutcome(status);
			await refreshHyMT2Downloaded();
			if (status === 'ready') await selectHyMT2Variant('custom');
		} catch (err) {
			const message = err instanceof Error ? err.message : m.import_failed();
			// The bridge reuses the download transport, so a cancelled import
			// rejects with "Download cancelled" — confusing wording for an
			// action the user took on a file copy, and not an error at all.
			customError = /cancel/i.test(message) ? null : message;
		}
	}

	async function removeCustomModel(): Promise<void> {
		customError = null;
		try {
			const { unloadModel } = await import('$lib/translation/llamacpp-bridge.js');
			await unloadModel().catch(() => undefined);
			const { deleteCustomModel } = await import('$lib/translation/gguf-model-manager.js');
			await deleteCustomModel();
			// deleteCustomModel resets the STORED selection; this keeps the open
			// dialog's draft in step, since the draft does not re-hydrate from
			// store writes.
			if (draft.hyMT2Variant === 'custom') draft.hyMT2Variant = 'stock';
			await refreshHyMT2Downloaded();
		} catch (err) {
			customError = err instanceof Error ? err.message : m.settings_translation_delete_failed();
		}
	}

	async function saveCustomPromptFormat(): Promise<void> {
		customFormatBusy = true;
		customError = null;
		try {
			const { applyCustomPromptFormat } = await import('$lib/translation/gguf-model-manager.js');
			const status = await applyCustomPromptFormat({
				prefix: customPrefix,
				suffix: customSuffix,
				stops: customStops.split('\n').map((s) => s.trim()).filter(Boolean)
			});
			customError = describeImportOutcome(status);
			if (status === 'ready') await selectHyMT2Variant('custom');
		} catch (err) {
			customError = err instanceof Error ? err.message : m.settings_translation_could_not_apply_that();
		} finally {
			customFormatBusy = false;
		}
	}
	let llamaBridgeAvailable = $state(false);

	$effect(() => {
		if (translationSubTab === 'on-device' && !onDeviceChecksLoaded) {
			onDeviceChecksLoaded = true;
			llamaBridgeAvailable = isLlamaBridgeAvailable();
		}
	});

	// Deferred local-model checks — only when the local Hy-MT2 backend is
	// selected. The legacy settings literal remains 'translategemma'.
	$effect(() => {
		if (draft.onDeviceTranslationBackend === 'translategemma' && !hyMT2CheckStarted) {
			hyMT2CheckStarted = true;
			getBackend().then(b => { hyMT2Backend = b; }).catch(() => { hyMT2Backend = 'unknown'; });
			refreshHyMT2Downloaded()
				.finally(() => { hyMT2ChecksLoaded = true; });
		}
	});

	async function handleBackgroundToggle(e: Event) {
		const checkbox = e.target as HTMLInputElement;
		if (!checkbox.checked) return; // Turning OFF needs no permission check

		try {
			const { isBackgroundServiceAvailable, hasNotificationPermission, requestNotificationPermission } =
				await import('$lib/translation/background-service-bridge.js');

			if (!isBackgroundServiceAvailable()) {
				checkbox.checked = false;
				draft.backgroundTranslation = false;
				return;
			}

			if (!hasNotificationPermission()) {
				const granted = await requestNotificationPermission();
				// Even if denied, the service still works (notification hidden).
				if (!granted) {
					console.warn('[settings] POST_NOTIFICATIONS denied — service will work but notification will be hidden');
				}
			}
		} catch (err) {
			console.warn('[settings] Background translation permission check failed:', err);
		}
	}
</script>

<!-- Pipeline sub-tabs (navigation only — see the switch control below) -->
<div class="relative mb-4 flex gap-1 rounded-full bg-surface-container-high p-1" role="tablist" aria-label={m.settings_translation_translation_pipeline_sections()} data-settings-anchor="pipeline" use:slidingSelection>
	{#each [
		{ value: 'off-device', label: () => m.settings_translation_off_device() },
		{ value: 'on-device', label: () => m.settings_translation_on_device() }
	] as tab (tab.value)}
		<button
			type="button"
			role="tab"
			aria-selected={translationSubTab === tab.value}
			aria-label={draft.translationPipeline === tab.value ? m.settings_translation_label_active_pipeline({ label: tab.label() }) : tab.label()}
			onclick={() => (translationSubTab = tab.value as 'off-device' | 'on-device')}
			class="relative flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors {translationSubTab === tab.value
				? 'text-white'
				: 'text-surface-400 hover:text-surface-200'}"
		>
			{#if draft.translationPipeline === tab.value}
				<!-- Dot, not text: e2e helpers match on exact button text -->
				<span class="h-1.5 w-1.5 shrink-0 rounded-full {translationSubTab === tab.value ? 'bg-green-300' : 'bg-green-400'}" title={m.settings_translation_active_pipeline()} aria-hidden="true"></span>
			{/if}
			{tab.label()}
		</button>
	{/each}
</div>

<!-- Explicit pipeline switch — browsing a sub-tab must not change behavior -->
{#if draft.translationPipeline !== translationSubTab}
	<div class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-primary-600/40 bg-primary-600/10 px-3 py-2.5">
		<p class="text-xs text-surface-200">
			<RichMessage message={m.settings_translation_currently_run({ pipeline: draft.translationPipeline === 'off-device' ? m.settings_translation_off_device() : m.settings_translation_on_device() })} emClass="font-medium" />
		</p>
		<button
			type="button"
			onclick={() => (draft.translationPipeline = translationSubTab)}
			class="shrink-0 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
		>
			{m.settings_translation_use_pipeline({ pipeline: translationSubTab === 'off-device' ? m.settings_translation_off_device() : m.settings_translation_on_device() })}
		</button>
	</div>
{/if}

{#if translationSubTab === 'off-device'}
<div class="space-y-5">
	<!-- LLM Providers -->
	<div data-settings-anchor="providers">
		<div class="mb-2 flex items-center justify-between">
			<h3 class="block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_search_providers_label()}</h3>
			<button
				onclick={addProvider}
				class="rounded-md bg-primary-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-700"
			>
				{m.settings_translation_add_provider()}
			</button>
		</div>

		{#if draft.providers.length === 0}
			<div class="rounded-lg border border-dashed border-surface-700 px-4 py-4 text-center">
				<p class="text-xs text-surface-500">
					{m.settings_translation_no_providers_configured_add()}
				</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each draft.providers as provider, i (provider.id)}
					<div class="rounded-lg border {draft.activeProviderId === provider.id ? 'border-primary-600/60' : 'border-surface-700'} bg-surface-800/50">
						<!-- Provider header (always visible) -->
						<div class="flex items-center gap-2 px-3 py-2">
							<input
								type="radio"
								name="active-provider"
								checked={draft.activeProviderId === provider.id}
								onchange={() => (draft.activeProviderId = provider.id)}
								class="h-3.5 w-3.5 accent-primary-500"
								aria-label={m.settings_translation_use_name_for_translations({ name: provider.name })}
								title={m.settings_translation_set_as_active_provider()}
							/>
							<div class="flex flex-1 items-center gap-2 overflow-hidden">
								<span class="truncate text-sm font-medium text-surface-200">{provider.name}</span>
								<span class="shrink-0 rounded bg-surface-700 px-1.5 py-0.5 text-[10px] font-medium text-surface-400">
									{PROVIDER_TYPE_LABELS[provider.type]}
								</span>
								{#if draft.activeProviderId === provider.id}
									<span class="shrink-0 rounded bg-primary-600/20 px-1.5 py-0.5 text-[10px] font-medium text-primary-300">{m.settings_translation_active()}</span>
								{/if}
							</div>
							<button
								onclick={() => editingProviderIndex === i ? collapseProvider() : expandProvider(i)}
								class="shrink-0 rounded px-2 py-1 text-xs text-surface-400 transition-colors hover:text-surface-200"
								aria-expanded={editingProviderIndex === i}
								aria-label={editingProviderIndex === i ? m.settings_translation_collapse_name_settings({ name: provider.name }) : m.settings_translation_configure_name({ name: provider.name })}
								title={editingProviderIndex === i ? m.settings_translation_collapse() : m.settings_translation_configure()}
							>
								{editingProviderIndex === i ? '▲' : '▼'}
							</button>
						</div>

						<!-- Expanded provider card -->
						{#if editingProviderIndex === i}
							<div class="space-y-3 border-t border-surface-700/50 px-3 pb-3 pt-3">
								<!-- Provider type -->
								<div>
									<label for={`settings-provider-type-${i}`} class="mb-1 block text-[11px] text-surface-400">{m.settings_translation_provider_type()}</label>
									<select
										id={`settings-provider-type-${i}`}
										value={editProviderType}
										onchange={(e) => onProviderTypeChange((e.target as HTMLSelectElement).value as ProviderType)}
										class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
									>
										<option value="openrouter">{m.settings_translation_openrouter()}</option>
										<option value="claude">{m.settings_translation_claude_anthropic()}</option>
										<option value="openai-compatible">{m.settings_translation_openai_compatible()}</option>
										<option value="ollama">{m.settings_translation_ollama()}</option>
										<option value="lmstudio">{m.settings_translation_lm_studio()}</option>
										<option value="local-compatible">{m.settings_translation_local_server()}</option>
									</select>
								</div>

								<!-- Provider name -->
								<div>
									<label for={`settings-provider-name-${i}`} class="mb-1 block text-[11px] text-surface-400">{m.settings_server_display_name()}</label>
									<input
										id={`settings-provider-name-${i}`}
										type="text"
										bind:value={editProviderName}
										class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
										placeholder={m.settings_translation_provider_name()}
									/>
								</div>

								<!-- Base URL (non-OpenRouter and non-Claude — fixed endpoints) -->
								{#if editProviderType !== 'openrouter' && editProviderType !== 'claude'}
									<div>
										<label for={`settings-provider-url-${i}`} class="mb-1 block text-[11px] text-surface-400">{m.settings_translation_base_url()}</label>
										<input
											id={`settings-provider-url-${i}`}
											type="text"
											bind:value={editProviderBaseUrl}
											class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
											placeholder={PROVIDER_DEFAULTS[editProviderType]?.baseUrl ?? 'http://localhost:8080'}
										/>
									</div>
								{/if}

								<!-- API Key + Connect -->
								<div>
									<div class="flex items-end gap-2">
										{#if editProviderRequiresKey}
											<div class="min-w-0 flex-1">
											<label for={`settings-provider-key-${i}`} class="mb-1 block text-[11px] text-surface-400">{m.settings_server_api_key()}</label>
											<input
												id={`settings-provider-key-${i}`}
													type="password"
													bind:value={editProviderApiKey}
													placeholder={editProviderType === 'openrouter' ? 'sk-or-...' : editProviderType === 'claude' ? 'sk-ant-...' : 'sk-...'}
													class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
												/>
											</div>
										{/if}
										<button
											onclick={connectProvider}
											disabled={providerConnectionStatus === 'connecting'}
											class="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors
												{providerConnectionStatus === 'connected'
													? 'bg-green-600/80 text-white hover:bg-green-600'
													: providerConnectionStatus === 'connecting'
														? 'cursor-wait bg-surface-700 text-surface-400'
														: 'bg-primary-600 text-white hover:bg-primary-700'}"
										>
											{#if providerConnectionStatus === 'connecting'}
												{m.settings_translation_connecting()}
											{:else if providerConnectionStatus === 'connected'}
												{m.settings_translation_connected_count({ n: providerAvailableModels.length })}
											{:else}
												{m.settings_translation_connect()}
											{/if}
										</button>
									</div>
									{#if providerConnectionStatus === 'error' && providerConnectionError}
										<p class="mt-1 break-words text-[11px] text-red-400">{providerConnectionError}</p>
									{:else if providerConnectionStatus === 'connected'}
										<p class="mt-1 text-[11px] text-green-400">
											{m.settings_translation_connected_models({ n: providerAvailableModels.length })}
										</p>
									{:else if editProviderRequiresKey}
										<p class="mt-1 text-[11px] text-surface-500">
											{m.settings_translation_stored_locally_encrypted_click()}
										</p>
									{:else}
										<p class="mt-1 text-[11px] text-surface-500">
											{m.settings_translation_no_api_key_required()}
										</p>
									{/if}
								</div>

								<!-- Model selection -->
								<div>
									<label for={`settings-provider-model-${i}`} class="mb-1 block text-[11px] text-surface-400">{m.settings_translation_model()}</label>
									{#if providerAvailableModels.length > 0}
										<ModelPicker
											id={`settings-provider-model-${i}`}
											models={providerAvailableModels}
											value={editProviderModel}
											onselect={(modelId) => { editProviderModel = modelId; autoSuggestVisionMode(modelId); }}
											{formatPrice}
										/>
										{#if editProviderType === 'openrouter' && editProviderVisionOnly}
											<p class="mt-1 text-[11px] text-surface-500">
												{m.settings_translation_prices_per_million_tokens()}
											</p>
										{:else if editProviderType === 'openrouter' && !editProviderVisionOnly}
											<p class="mt-1 text-[11px] text-surface-500">
												{m.settings_translation_prices_per_million_tokens_2()}
											</p>
										{/if}
									{:else}
										<input
											id={`settings-provider-model-${i}`}
											type="text"
											bind:value={editProviderModel}
										placeholder={editProviderType === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : 'model-name'}
											class="w-full rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-xs text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none"
										/>
										<p class="mt-1 text-[11px] text-surface-500">
											{m.settings_translation_connect_to_see_available()}
										</p>
									{/if}
								</div>

								<!-- Vision Only toggle -->
								<div class="flex items-center justify-between rounded-md border border-surface-700/50 px-3 py-2">
									<div>
										<span class="text-xs text-surface-200">{m.settings_translation_vision_models_only()}</span>
											{#if providerAvailableModels.find((m) => m.id === editProviderModel)?.supportsVision !== undefined}
												<span class="ml-1 text-[10px] text-primary-400">(auto-detected)</span>
											{/if}
										<p class="text-[11px] text-surface-500">
											{#if editProviderVisionOnly}
												{m.settings_translation_sends_page_images_to()}
											{:else}
												{m.settings_translation_uses_pp_ocr_text()}
											{/if}
										</p>
									</div>
									<button
										role="switch"
										aria-checked={editProviderVisionOnly}
										aria-label={m.settings_translation_vision_models_only_2()}
										onclick={() => { editProviderVisionOnly = !editProviderVisionOnly; if (providerConnectionStatus === 'connected') connectProvider(); }}
										class="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors
											{editProviderVisionOnly
												? 'bg-primary-600/80 text-white'
												: 'bg-surface-700 text-surface-400'}"
									>
										{editProviderVisionOnly ? m.settings_translation_on() : m.settings_translation_off()}
									</button>
								</div>

								<!-- Concurrent Requests (local providers only) -->
								{#if editProviderType === 'lmstudio' || editProviderType === 'ollama' || editProviderType === 'local-compatible'}
									<div class="rounded-md border border-surface-700/50 px-3 py-2">
										<div class="flex items-center justify-between">
											<div>
												<span class="text-xs text-surface-200">{m.settings_translation_concurrent_requests()}</span>
												<p class="text-[11px] text-surface-500">
													{m.settings_translation_match_your_server_s()}
												</p>
											</div>
											<input
												type="number"
												min="1"
												max="8"
												aria-label={m.settings_translation_concurrent_requests_2()}
												bind:value={draft.localProviderConcurrency}
												class="w-14 rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-center text-xs text-surface-100 focus:border-primary-500 focus:outline-none"
											/>
										</div>
									</div>
								{/if}

								<!-- Delete provider -->
								<div class="flex justify-end pt-1">
									<button
										onclick={() => removeProvider(i)}
										class="rounded-md px-2.5 py-1.5 text-[11px] text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
									>
										{m.settings_translation_remove_provider()}
									</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Source / Target Language -->
	<div class="grid grid-cols-2 gap-3" data-settings-anchor="language-pair">
		<div>
			<label for="source-lang" class="mb-1.5 block text-sm font-medium text-surface-300">
				{m.settings_translation_translate_from()}
			</label>
			<select
				id="source-lang"
				bind:value={draft.sourceLanguage}
				class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
			>
				{#each SUPPORTED_LANGUAGES as lang (lang.code)}
					<option value={lang.code}>{getLanguageDisplayName(lang.code)}</option>
				{/each}
			</select>
		</div>
		<div>
			<label for="target-lang" class="mb-1.5 block text-sm font-medium text-surface-300">
				{m.settings_translation_translate_to()}
			</label>
			<select
				id="target-lang"
				bind:value={draft.targetLanguage}
				class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
			>
				{#each SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto') as lang (lang.code)}
					<option value={lang.code}>{getLanguageDisplayName(lang.code)}</option>
				{/each}
			</select>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Translation Mode -->
	<div data-settings-anchor="translation-mode">
		<p class="mb-1.5 block text-sm font-medium text-surface-300">
			{m.settings_search_translation_mode_label()}
		</p>
		<div class="space-y-2">
			<label class="flex items-start gap-2 text-sm">
				<input type="radio" name="mode" value={1} bind:group={draft.translationMode} class="mt-0.5" />
				<div>
					<span class="text-surface-200">{m.settings_translation_mode_1_isolated()}</span>
					<p class="text-xs text-surface-500">{m.settings_translation_translate_only_the_highlighted()}</p>
				</div>
			</label>
			<label class="flex items-start gap-2 text-sm">
				<input type="radio" name="mode" value={2} bind:group={draft.translationMode} class="mt-0.5" />
				<div>
					<span class="text-surface-200">{m.settings_translation_mode_2_page_context()}</span>
					<p class="text-xs text-surface-500">{m.settings_translation_include_context_from_other()}</p>
				</div>
			</label>
			<label class="flex items-start gap-2 text-sm">
				<input type="radio" name="mode" value={3} bind:group={draft.translationMode} class="mt-0.5" />
				<div>
					<span class="text-surface-200">{m.settings_translation_mode_3_full_context()}</span>
					<p class="text-xs text-surface-500">{m.settings_translation_include_context_from_the()}</p>
				</div>
			</label>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Skip Review Pass -->
	<div data-settings-anchor="skip-review">
		<Switch bind:checked={draft.skipReviewPass} label={m.settings_search_skip_review_label()} />
		<p class="text-[11px] text-surface-500">
			{m.settings_translation_when_enabled_volume_translations()}
		</p>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Advanced (expert-level knobs, collapsed by default) -->
	<details class="group" data-settings-anchor="advanced-llm">
		<summary class="cursor-pointer select-none text-sm font-medium text-surface-300 transition-colors hover:text-surface-100">
			{m.settings_translation_advanced()}
			<span class="ml-1 text-[11px] font-normal text-surface-500">{m.settings_translation_temperature_response_budget()}</span>
		</summary>
		<div class="mt-3 space-y-5 pl-1">
			<!-- Temperature -->
			<div>
				<label for="temperature" class="mb-1.5 block text-sm font-medium text-surface-300">
					{m.settings_translation_temperature_label({ value: draft.temperature.toFixed(1) })}
				</label>
				<input
					id="temperature"
					type="range"
					min="0"
					max="1.5"
					step="0.1"
					bind:value={draft.temperature}
					class="w-full accent-primary-500"
				/>
				<div class="mt-1 flex justify-between text-[11px] text-surface-500">
					<span>{m.settings_translation_precise_0()}</span>
					<span>{m.settings_translation_balanced_1_0()}</span>
					<span>{m.settings_translation_loose_1_5()}</span>
				</div>
				<p class="mt-1 text-xs text-surface-500">
					{m.settings_translation_lower_values_give_more()}
				</p>
			</div>

			<!-- Max response tokens -->
			<div>
				<label for="max-context-tokens" class="mb-1.5 block text-sm font-medium text-surface-300">
					{m.settings_translation_max_response_tokens()}
				</label>
				<div class="flex items-center gap-3">
					<input
						id="max-context-tokens"
						type="number"
						min="1024"
						max="128000"
						step="256"
						bind:value={draft.maxContextTokens}
						class="w-32 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
					/>
					<span class="text-xs text-surface-500">{m.settings_translation_tokens_1_024_128()}</span>
				</div>
				<p class="mt-1 text-xs text-surface-500">
					{m.settings_translation_response_budget_for_llm()}
				</p>
			</div>
		</div>
	</details>
</div>
{:else}
<!-- On-Device Translation Settings -->
<div class="space-y-5">
	<!-- Translation Backend -->
	<div data-settings-anchor="on-device-backend">
		<p class="mb-2 block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_translation_translation_backend()}</p>
		<!-- Hy-MT2 is the only on-device engine; ML Kit was dropped 2026-07-24. -->
		<div class="rounded-lg bg-surface-800 px-3 py-2">
			<span class="text-xs font-medium text-primary-400">{m.settings_translation_hy_mt2_1_8b()}</span>
		</div>
		<p class="mt-1.5 text-[11px] text-surface-500">
			{m.settings_translation_hy_mt2_intro({ note: isAndroid ? m.settings_translation_optimized_for_low_memory() : m.settings_translation_uses_the_available_llama() })}
		</p>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Device Compatibility -->
	<div>
		<h3 class="mb-2 block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_translation_device_compatibility()}</h3>
		<div class="rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-3">
			{#if llamaBridgeAvailable}
					<div class="flex items-center gap-2">
						<span class="h-2 w-2 rounded-full bg-green-500"></span>
						<span class="text-xs text-green-400">{m.settings_translation_llama_cpp_bridge_available()}</span>
					</div>
					<div class="mt-1.5 space-y-1">
						<p class="text-[11px] text-surface-500">
							<RichMessage message={m.settings_translation_compute({ backend: hyMT2Backend === 'cpu' ? m.settings_translation_cpu_arm_neon_stq() : hyMT2Backend.startsWith('metal') ? m.settings_translation_cpu_metal_runtime() : m.settings_translation_checking() })} emClass="text-surface-300" />
						</p>
						{#if getAvailableMemoryGB() > 0}
							<p class="text-[11px] text-surface-500">
								<RichMessage message={m.settings_translation_available_ram({ gb: getAvailableMemoryGB().toFixed(1) })} emClass={getAvailableMemoryGB() >= 2 ? 'text-green-400' : getAvailableMemoryGB() >= 1.5 ? 'text-yellow-400' : 'text-red-400'} />
								{#if getAvailableMemoryGB() < 2}
									<span class="text-yellow-400"> {m.settings_translation_more_memory_headroom_is()}</span>
								{/if}
							</p>
						{/if}
					</div>
				{:else}
					<div class="flex items-center gap-2">
						<span class="h-2 w-2 rounded-full bg-red-500"></span>
						<span class="text-xs text-red-400">{m.settings_translation_llama_cpp_bridge_not()}</span>
					</div>
					<p class="mt-1.5 text-[11px] text-surface-500">
						{m.settings_translation_hy_mt2_requires_the()}
					</p>
			{/if}
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Local Hy-MT2 Model Download -->
	<div data-settings-anchor="hymt2-model">
		<h3 class="mb-2 block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_translation_hy_mt2_1_8b_2()}</h3>
		{#if !hyMT2ChecksLoaded && $ggufDownloadState.status !== 'downloading'}
			<div class="rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-3">
				<div class="flex items-center gap-2">
					<svg class="h-4 w-4 animate-spin text-surface-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					<span class="text-xs text-surface-400">{m.settings_translation_checking_model_status()}</span>
				</div>
			</div>
		{:else}
		<div class="rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-3" data-hymt2-variant-picker>
			<p class="mb-1 text-[11px] text-surface-500">{m.settings_translation_model_used_by_the()}</p>
			{#each BUNDLED_HYMT2_VARIANTS as variantKey (variantKey)}
				{@const variant = variantKey as BundledHyMT2Variant}
				{@const spec = bundledSpec(variant)}
				{@const downloaded = hyMT2Downloaded[variant] || ($ggufDownloadState.status === 'completed' && $ggufDownloadState.variant === variant)}
				{@const downloadingThis = $ggufDownloadState.status === 'downloading' && $ggufDownloadState.variant === variant}
				{@const memoryAdvice = modelMemoryAdvice(deviceMemory?.totalBytes ?? null, spec.sizeBytes)}
				<!-- Card anatomy (user-specified): row 1 = radio + full-width title;
				     row 2 = meta block with the action column centered against it
				     alone (Ready/Delete stack vertically with a small gap); the
				     progress bar and the italic description span the full card
				     width below. -->
				<label class="mt-1.5 block rounded-[var(--radius-card)] border px-3 py-2.5 {draft.hyMT2Variant === variant ? 'border-primary-500/60 bg-primary-600/10' : 'border-surface-700'}" data-hymt2-variant={variant}>
					<div class="flex items-center gap-3">
						<input
							type="radio"
							name="hymt2-variant"
							class="h-4 w-4 shrink-0 accent-primary-500"
							checked={draft.hyMT2Variant === variant}
							onchange={() => void selectHyMT2Variant(variant)}
							data-testid="hymt2-variant-{variant}"
						/>
						<p class="min-w-0 flex-1 text-xs font-medium text-surface-200" data-hymt2-title>{spec.title()}</p>
					</div>
					<div class="mt-1.5 flex items-center gap-3">
						<div class="min-w-0 flex-1" data-hymt2-meta>
							<p class="text-[11px] text-surface-400">{m.settings_translation_meta_model({ value: spec.modelName })}</p>
							<p class="text-[11px] text-surface-400">{m.settings_translation_meta_size({ value: spec.sizeLabel })}</p>
							<p class="text-[11px] text-surface-400">{m.settings_translation_meta_quant({ value: spec.quantLabel })}</p>
							{#if memoryAdvice.level === 'tight' || memoryAdvice.level === 'low'}
								<p
									data-memory-advice={memoryAdvice.level}
									class="mt-0.5 text-[11px] {memoryAdvice.level === 'low' ? 'text-red-400' : 'text-amber-400'}"
								>
									{memoryAdvice.message}
								</p>
							{/if}
						</div>
						<div class="flex shrink-0 flex-col items-stretch justify-center gap-2" data-hymt2-actions>
							{#if downloadingThis}
								<button
									type="button"
									onclick={() => cancelGgufDownload()}
									class="rounded-full bg-surface-700 px-3 py-1.5 text-[11px] font-medium text-surface-300 transition-colors hover:bg-surface-600"
								>
									{m.common_cancel()}
								</button>
							{:else if downloaded}
								<span class="rounded-full bg-green-600/20 px-3 py-1 text-center text-[11px] font-medium text-green-400">{m.settings_models_ready()}</span>
								<button
									type="button"
									onclick={async () => {
										const { unloadModel } = await import('$lib/translation/llamacpp-bridge.js');
										await unloadModel().catch(() => undefined);
										await deleteHyMT2Model(variant);
										await refreshHyMT2Downloaded();
									}}
									class="rounded-full bg-red-600/20 px-3 py-1.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/30"
									data-testid="hymt2-delete-{variant}"
								>
									{m.settings_models_delete()}
								</button>
							{:else}
								<button
									type="button"
									onclick={async () => {
										await downloadHyMT2Model(variant);
										await refreshHyMT2Downloaded();
									}}
									disabled={$ggufDownloadState.status === 'downloading'}
									class="rounded-full bg-primary-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
									data-testid="hymt2-download-{variant}"
								>
									{m.settings_models_download()}
								</button>
							{/if}
						</div>
					</div>
					{#if downloadingThis && $ggufDownloadState.progress}
						{@const pct = $ggufDownloadState.progress.totalBytes > 0
							? Math.round(($ggufDownloadState.progress.downloadedBytes / $ggufDownloadState.progress.totalBytes) * 100)
							: 0}
						<div class="mt-2 h-1.5 w-full rounded-full bg-surface-700">
							<div class="h-1.5 rounded-full bg-primary-500 transition-all" style="width: {pct}%"></div>
						</div>
						<p class="mt-1 text-[11px] text-surface-500">
							{m.settings_translation_download_progress({ done: ($ggufDownloadState.progress.downloadedBytes / 1024 / 1024) | 0, total: ($ggufDownloadState.progress.totalBytes / 1024 / 1024) | 0, pct })}
						</p>
					{/if}
					<p class="mt-1.5 text-[11px] italic text-surface-500" data-hymt2-description>{spec.description()}</p>
				</label>
			{/each}

			<!-- Custom model. Android only: the file has to be copied into the
			     app's model directory through the Kotlin bridge, and desktop is
			     shelved. Gated on isAndroid rather than isLlamaBridgeAvailable(),
			     which returns true unconditionally on desktop. -->
			{#if isAndroid}
				{@const custom = $settings.customModel}
				{@const customSpec = HYMT2_VARIANTS.custom}
				{@const importing = $ggufDownloadState.status === 'downloading' && $ggufDownloadState.variant === 'custom'}
				<label
					class="mt-1.5 block rounded-[var(--radius-card)] border px-3 py-2.5 {draft.hyMT2Variant === 'custom' ? 'border-primary-500/60 bg-primary-600/10' : 'border-surface-700'}"
					data-hymt2-variant="custom"
				>
					<div class="flex items-center gap-3">
						<!-- A model that failed its self-test stays selectable: the user
						     chose it and it does run. One that will not LOAD does not. -->
						<input
							type="radio"
							name="hymt2-variant"
							class="h-4 w-4 shrink-0 accent-primary-500"
							checked={draft.hyMT2Variant === 'custom'}
							disabled={!custom || !!custom.loadError}
							onchange={() => void selectHyMT2Variant('custom')}
							data-testid="hymt2-variant-custom"
						/>
						<p class="min-w-0 flex-1 text-xs font-medium text-surface-200" data-hymt2-title>{customSpec.title()}</p>
					</div>
					<div class="mt-1.5 flex items-center gap-3">
						<div class="min-w-0 flex-1" data-hymt2-meta>
							<p class="truncate text-[11px] text-surface-400">{m.settings_translation_meta_model({ value: custom?.displayName ?? customSpec.modelName })}</p>
							<p class="text-[11px] text-surface-400">{m.settings_translation_meta_size({ value: custom ? formatCustomSize(custom.sizeBytes) : customSpec.sizeLabel })}</p>
							<p class="text-[11px] text-surface-400">
								{m.settings_translation_meta_prompt_format({ value: custom ? (custom.templateMode === 'auto' ? m.settings_translation_detected() : m.settings_translation_manual()) : customSpec.quantLabel })}
							</p>
							{#if custom}
								{@const customAdvice = modelMemoryAdvice(deviceMemory?.totalBytes ?? null, custom.sizeBytes)}
								{#if customAdvice.level === 'tight' || customAdvice.level === 'low'}
									<p
										data-memory-advice={customAdvice.level}
										class="mt-0.5 text-[11px] {customAdvice.level === 'low' ? 'text-red-400' : 'text-amber-400'}"
									>
										{customAdvice.message}
									</p>
								{/if}
							{/if}
						</div>
						<div class="flex shrink-0 flex-col items-stretch justify-center gap-2" data-hymt2-actions>
							{#if importing}
								<button
									type="button"
									onclick={() => cancelGgufDownload()}
									class="rounded-full bg-surface-700 px-3 py-1.5 text-[11px] font-medium text-surface-300 transition-colors hover:bg-surface-600"
								>
									{m.common_cancel()}
								</button>
							{:else if custom}
								<button
									type="button"
									onclick={() => void chooseCustomModel()}
									class="rounded-full bg-surface-700 px-3 py-1 text-[11px] font-medium text-surface-200 transition-colors hover:bg-surface-600"
									data-testid="hymt2-replace-custom"
								>
									{m.settings_translation_replace()}
								</button>
								<button
									type="button"
									onclick={() => void removeCustomModel()}
									class="rounded-full bg-red-600/20 px-3 py-1.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/30"
									data-testid="hymt2-delete-custom"
								>
									{m.settings_models_delete()}
								</button>
							{:else}
								<button
									type="button"
									onclick={() => void chooseCustomModel()}
									disabled={$ggufDownloadState.status === 'downloading'}
									class="rounded-full bg-primary-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
									data-testid="hymt2-choose-custom"
								>
									{m.settings_translation_choose_file()}
								</button>
							{/if}
						</div>
					</div>
					{#if importing && $ggufDownloadState.progress}
						{@const total = $ggufDownloadState.progress.totalBytes}
						{@const pct = total > 0 ? Math.round(($ggufDownloadState.progress.downloadedBytes / total) * 100) : 0}
						<div class="mt-2 h-1.5 w-full rounded-full bg-surface-700">
							<div class="h-1.5 rounded-full bg-primary-500 transition-all" style="width: {pct}%"></div>
						</div>
						<p class="mt-1 text-[11px] text-surface-500">
							{m.settings_translation_copying_progress({ done: ($ggufDownloadState.progress.downloadedBytes / 1024 / 1024) | 0, rest: total > 0 ? ` ${m.settings_translation_total_mb_pct({ total: (total / 1024 / 1024) | 0, pct })}` : '' })}
						</p>
					{/if}
					{#if custom?.templateMode === 'manual'}
						<!-- Shown only when llama.cpp could not recognise the model's
						     own chat template. In 'auto' mode there is nothing to fill in. -->
						<div class="mt-2 rounded-[var(--radius-card)] border border-amber-600/30 bg-amber-600/5 px-2.5 py-2" data-custom-prompt-format>
							<p class="text-[11px] font-medium text-amber-400">{m.settings_translation_prompt_format()}</p>
							<p class="mt-0.5 text-[11px] text-surface-400">
								{m.settings_translation_fumeto_couldn_t_recognise()}
							</p>
							<!-- Textareas, not text inputs: a chat template's wrapping
							     almost always ends in a newline, and a single-line input
							     silently discards one. -->
							<label class="mt-1.5 block text-[11px] text-surface-400">
								{m.settings_translation_prompt_prefix_label()}
								<textarea
									rows="2"
									bind:value={customPrefix}
									placeholder="<|im_start|>user"
									class="mt-0.5 w-full rounded border border-surface-700 bg-surface-900 px-2 py-1 font-mono text-[11px] text-surface-200"
									data-testid="custom-prompt-prefix"
								></textarea>
							</label>
							<label class="mt-1.5 block text-[11px] text-surface-400">
								{m.settings_translation_prompt_suffix_label()}
								<textarea
									rows="2"
									bind:value={customSuffix}
									placeholder="<|im_end|> <|im_start|>assistant"
									class="mt-0.5 w-full rounded border border-surface-700 bg-surface-900 px-2 py-1 font-mono text-[11px] text-surface-200"
									data-testid="custom-prompt-suffix"
								></textarea>
							</label>
							<label class="mt-1.5 block text-[11px] text-surface-400">
								{m.settings_translation_prompt_stop_label()}
								<textarea
									rows="2"
									bind:value={customStops}
									placeholder="<|im_end|>"
									class="mt-0.5 w-full rounded border border-surface-700 bg-surface-900 px-2 py-1 font-mono text-[11px] text-surface-200"
									data-testid="custom-prompt-stops"
								></textarea>
							</label>
							<button
								type="button"
								onclick={() => void saveCustomPromptFormat()}
								disabled={customFormatBusy}
								class="mt-2 rounded-full bg-primary-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-50"
								data-testid="custom-prompt-save"
							>
								{customFormatBusy ? m.settings_translation_testing() : m.settings_translation_save_and_test()}
							</button>
						</div>
					{/if}
					{#if custom?.failedSelfTest}
						<p class="mt-1.5 text-[11px] text-amber-400" data-custom-self-test-warning>
							{m.settings_translation_this_model_loaded_but()}
						</p>
					{:else if custom?.loadError}
						<p class="mt-1.5 text-[11px] text-red-400" data-custom-load-error>
							{m.settings_translation_this_model_wouldn_t()}
						</p>
					{/if}
					{#if customError}
						<p class="mt-1.5 break-words text-[11px] text-red-400" data-custom-error>{customError}</p>
					{/if}
					<p class="mt-1.5 text-[11px] italic text-surface-500" data-hymt2-description>{customSpec.description()}</p>
				</label>
			{/if}

			{#if $ggufDownloadState.status === 'error'}
				<p class="mt-2 break-words text-[11px] text-red-400">{$ggufDownloadState.error}</p>
			{/if}
		</div>
		{/if}
		{#if hyMT2ChecksLoaded && hyMT2Backend === 'cpu'}
			<p class="mt-1.5 text-[11px] text-green-400">{m.settings_translation_stq1_0_is_using()}</p>
		{/if}
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- On-device sampler temperature -->
	<div data-settings-anchor="on-device-temperature">
		<h3 class="mb-2 block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_translation_translation_temperature()}</h3>
		<div class="rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-3">
			<label for="on-device-temperature" class="mb-1.5 flex items-baseline justify-between text-sm font-medium text-surface-300">
				<span>{m.settings_translation_temperature()}</span>
				<span class="tabular-nums text-primary-400" data-on-device-temperature-value>
					{draft.onDeviceTemperature === 0 ? m.settings_translation_0_00_deterministic() : draft.onDeviceTemperature.toFixed(2)}
				</span>
			</label>
			<input
				id="on-device-temperature"
				type="range"
				min={ON_DEVICE_TEMPERATURE_MIN}
				max={ON_DEVICE_TEMPERATURE_MAX}
				step="0.05"
				bind:value={draft.onDeviceTemperature}
				class="w-full accent-primary-500"
				data-testid="on-device-temperature"
			/>
			<div class="mt-1 flex justify-between text-[11px] text-surface-500">
				<span>{m.settings_translation_literal_0()}</span>
				<span>{m.settings_translation_default_value({ value: ON_DEVICE_TEMPERATURE_DEFAULT.toFixed(2) })}</span>
				<span>{m.settings_translation_loose_1_00()}</span>
			</div>
			<p class="mt-2 text-xs text-surface-500">
				{m.settings_translation_temperature_help({ value: ON_DEVICE_TEMPERATURE_DEFAULT.toFixed(2) })}
			</p>
			{#if draft.onDeviceTemperature !== ON_DEVICE_TEMPERATURE_DEFAULT}
				<button
					type="button"
					class="mt-2 min-h-[44px] text-xs font-medium text-primary-400 hover:text-primary-300"
					onclick={() => (draft.onDeviceTemperature = ON_DEVICE_TEMPERATURE_DEFAULT)}
					data-testid="on-device-temperature-reset"
				>
					{m.settings_translation_reset_recommended({ value: ON_DEVICE_TEMPERATURE_DEFAULT.toFixed(2) })}
				</button>
			{/if}
			<p class="mt-1 text-[11px] text-surface-500">
				{m.settings_translation_applies_to_on_device()}
			</p>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- OCR Provider -->
	<div data-settings-anchor="ocr-provider">
		<p class="mb-2 block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_translation_ocr_provider()}</p>
		<!-- PP-OCRv6 is the only OCR engine; ML Kit was dropped 2026-07-24. -->
		<div class="rounded-lg bg-surface-800 px-3 py-2">
			<span class="text-xs font-medium text-primary-400">{m.settings_translation_pp_ocrv6()}</span>
		</div>
		<p class="mt-1.5 text-[11px] text-surface-500">
			{m.settings_translation_pp_ocrv6_medium_detection()}
		</p>

		<div class="mt-3 rounded-lg border border-surface-700 bg-surface-800/50 px-3 py-2.5" data-ocr-models-card>
			<div class="flex items-center justify-between gap-3">
				<div class="min-w-0">
					<p class="text-xs font-semibold text-surface-100">{m.settings_translation_vision_models()}</p>
					<p class="mt-0.5 text-[11px] text-surface-400">{ocrModelsTotalMB} MB</p>
				</div>
				<div class="flex shrink-0 flex-col items-stretch justify-center gap-2">
					{#if $ocrModelDownloadState.status === 'downloading'}
						<button
							type="button"
							onclick={() => cancelOcrModelDownload()}
							class="rounded-full bg-surface-700 px-3 py-1.5 text-[11px] font-medium text-surface-300 transition-colors hover:bg-surface-600"
						>
							{m.common_cancel()}
						</button>
					{:else if ocrModelsReady}
						<span class="rounded-full bg-green-600/20 px-3 py-1 text-center text-[11px] font-medium text-green-400">{m.settings_models_ready()}</span>
						<button
							type="button"
							onclick={async () => { await deleteOcrModels(); await refreshOcrModels(); }}
							class="rounded-full bg-red-600/20 px-3 py-1.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/30"
							data-testid="ocr-models-delete"
						>
							{m.settings_models_delete()}
						</button>
					{:else}
						<button
							type="button"
							onclick={async () => { await downloadOcrModels().catch(() => undefined); await refreshOcrModels(); }}
							class="rounded-full bg-primary-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
							data-testid="ocr-models-download"
						>
							{m.settings_models_download()}
						</button>
					{/if}
				</div>
			</div>
			{#if $ocrModelDownloadState.status === 'downloading' && $ocrModelDownloadState.progress}
				{@const pct = $ocrModelDownloadState.progress.totalBytes > 0
					? Math.round(($ocrModelDownloadState.progress.downloadedBytes / $ocrModelDownloadState.progress.totalBytes) * 100)
					: 0}
				<div class="mt-2 h-1.5 w-full rounded-full bg-surface-700">
					<div class="h-1.5 rounded-full bg-primary-500 transition-all" style="width: {pct}%"></div>
				</div>
				<p class="mt-1 text-[11px] text-surface-500">
					{m.settings_translation_download_progress({ done: ($ocrModelDownloadState.progress.downloadedBytes / 1024 / 1024) | 0, total: ($ocrModelDownloadState.progress.totalBytes / 1024 / 1024) | 0, pct })}
				</p>
			{/if}
			{#if $ocrModelDownloadState.status === 'error'}
				<p class="mt-1.5 text-[11px] text-red-400">{$ocrModelDownloadState.error}</p>
			{/if}
			<p class="mt-1.5 text-[11px] italic text-surface-500">{m.settings_translation_vision_models_desc()}</p>
			{#if !ocrModelsReady}
				<p class="mt-1 text-[11px] text-amber-400/90">{m.settings_translation_vision_models_needed()}</p>
			{/if}
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Language Settings -->
	<div>
		<h3 class="mb-2 block text-sm font-medium text-surface-300">{m.settings_translation_language()}</h3>
		<div class="rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-3 space-y-3">
			<div class="flex items-center gap-3">
				<label for="on-device-source-language" class="w-28 shrink-0 text-xs text-surface-400">{m.settings_translation_translate_from_2()}</label>
				<select
					id="on-device-source-language"
					bind:value={draft.onDeviceSourceLang}
					class="flex-1 rounded-md border border-surface-600 bg-surface-700 px-2 py-1.5 text-xs text-surface-200 focus:border-primary-500 focus:outline-none"
				>
					{#each ON_DEVICE_SOURCE_LANGUAGES as lang (lang.code)}
						<option value={lang.code}>{getLanguageDisplayName(lang.code)}</option>
					{/each}
				</select>
			</div>
			<div class="flex items-center gap-3">
				<label for="on-device-target-language" class="w-28 shrink-0 text-xs text-surface-400">{m.settings_translation_translate_to_2()}</label>
				<select
					id="on-device-target-language"
					bind:value={draft.onDeviceTargetLang}
					class="flex-1 rounded-md border border-surface-600 bg-surface-700 px-2 py-1.5 text-xs text-surface-200 focus:border-primary-500 focus:outline-none"
				>
					{#each ON_DEVICE_TARGET_LANGUAGES as lang (lang.code)}
						<option value={lang.code}>{getLanguageDisplayName(lang.code)}</option>
					{/each}
				</select>
			</div>
			<p class="text-[11px] text-surface-500">
				{m.settings_translation_hy_mt2_is_multilingual()}
			</p>
		</div>
	</div>

	<div class="border-t border-surface-700"></div>

	<!-- Limitations Note -->
	<div class="rounded-lg border border-amber-600/30 bg-amber-600/5 px-4 py-3">
		<p class="text-xs font-medium text-amber-400">{m.settings_translation_on_device_limitations()}</p>
		<ul class="mt-1.5 space-y-1 text-[11px] text-surface-400">
			<li>{m.settings_translation_no_review_revision_pass()}</li>
			<li>{m.settings_translation_volume_translation_skips_consistency()}</li>
			<li>{m.settings_translation_quality_is_below_a()}</li>
			<li>{m.settings_translation_needs_a_model_downloaded()}</li>
		</ul>
	</div>
</div>
{/if}

<!-- General translation options (apply to both pipelines) -->
{#if isAndroid}
<div class="mt-5 border-t border-surface-700 pt-5" data-settings-anchor="background-translation">
	<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_translation_both_pipelines()}</p>
	<div>
		<Switch
			bind:checked={draft.backgroundTranslation}
			onchange={handleBackgroundToggle}
			label={m.settings_search_background_translation_label()}
		/>
		<p class="text-[11px] text-surface-500">
			{m.settings_translation_prevents_android_from_stopping()}
		</p>
	</div>
</div>
{/if}

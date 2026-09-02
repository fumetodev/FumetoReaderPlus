<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';
	import { ggufDownloadState, downloadHyMT2Model, cancelModelDownload as cancelGgufDownload, deleteHyMT2Model, deleteCustomModel, isModelDownloaded, BUNDLED_HYMT2_VARIANTS, bundledSpec, type BundledHyMT2Variant } from '$lib/translation/gguf-model-manager.js';
	import { settings } from '$lib/settings/settings.js';
	import { unloadModel as unloadHyMT2Model } from '$lib/translation/llamacpp-bridge.js';
	import { isAndroid } from '$lib/util/platform.js';
	import { modelMemoryAdvice, readDeviceMemory, type MemoryAdvice } from '$lib/device/device-memory.js';
	import { installedOcrModelBytes, ocrModelDownloadState } from '$lib/detection/ocr-model-manager.js';
	import { untrack } from 'svelte';

	// Read once: total RAM doesn't change, and the advice must be identical
	// wherever it appears (here and, later, in the Pro purchase flow).
	const deviceMemory = readDeviceMemory();
	const adviceFor = (sizeMB: number): MemoryAdvice =>
		modelMemoryAdvice(deviceMemory?.totalBytes ?? null, sizeMB * 1024 * 1024);

	// One place to see and manage everything the app can download
	// (settings review §3.2.5) — the per-feature entry points remain.
	//
	// Rows are derived from the variant registry rather than hand-written. The
	// hand-written version carried its own size numbers, which had already
	// drifted from the registry's `sizeBytes`, and selected each row's download
	// state by testing a single variant id — with a third variant that would
	// have shown a v3 download's progress bar on the Standard model's row.
	const USED_FOR: Record<BundledHyMT2Variant, string> = {
		stock: m.settings_models_on_device_translation_compact(),
		'manga-v2': m.settings_models_on_device_translation_manga(),
		'manga-v3': m.settings_models_on_device_translation_manga_2(),
		'manga-v4': m.settings_models_on_device_translation_manga_v4()
	};

	let downloaded = $state<Record<BundledHyMT2Variant, boolean>>({
		stock: false,
		'manga-v2': false,
		'manga-v3': false,
		'manga-v4': false
	});

	async function refreshDownloaded(): Promise<void> {
		// Built from scratch, never spread from `downloaded`: reading the state
		// this function also writes makes the $effect below re-trigger itself
		// forever, which locks the whole WebView the moment the tab opens.
		const next: Record<BundledHyMT2Variant, boolean> = {
			stock: false,
			'manga-v2': false,
			'manga-v3': false,
			'manga-v4': false
		};
		for (const variant of BUNDLED_HYMT2_VARIANTS) {
			next[variant] = await isModelDownloaded(variant).catch(() => false);
		}
		downloaded = next;
	}

	$effect(() => {
		void refreshDownloaded();
	});
	// Track completion of an in-dialog download too. Only the variant that
	// actually completed becomes ready.
	$effect(() => {
		const state = $ggufDownloadState;
		if (state.status === 'completed' && state.variant && state.variant !== 'custom') {
			const completed = state.variant;
			// untrack the read for the same reason as above — this effect writes
			// `downloaded`, so reading it here would make it its own dependency.
			untrack(() => {
				downloaded = { ...downloaded, [completed]: true };
			});
		}
	});

	interface ModelRow {
		key: string;
		variant: BundledHyMT2Variant | 'custom';
		name: string;
		sizeMB: number;
		usedFor: string;
		state: { status: string; progress?: { downloadedBytes: number; totalBytes: number } | null };
		ready: boolean;
		download: () => void;
		cancel: () => void;
		remove: () => void;
	}

	let rows = $derived.by((): ModelRow[] => {
		const bundled: ModelRow[] = BUNDLED_HYMT2_VARIANTS.map((variant) => {
			const spec = bundledSpec(variant);
			return {
				key: variant,
				variant,
				name: spec.label,
				sizeMB: Math.round(spec.sizeBytes / (1024 * 1024)),
				usedFor: USED_FOR[variant],
				state: $ggufDownloadState.variant === variant ? $ggufDownloadState : { status: 'idle' },
				ready: downloaded[variant],
				download: () =>
					void downloadHyMT2Model(variant)
						.then(() => refreshDownloaded())
						.catch(() => {}),
				cancel: () => cancelGgufDownload(),
				remove: () =>
					void unloadHyMT2Model()
						.catch(() => {})
						.then(() => deleteHyMT2Model(variant))
						.then(() => refreshDownloaded())
			};
		});

		// An imported model can be several gigabytes — larger than all three
		// bundled ones together — so leaving it out would make this card's
		// storage total a lie. It has no Download action: it is chosen from
		// Settings → Translation, not fetched.
		const custom = $settings.customModel;
		if (!custom) return bundled;
		return [
			...bundled,
			{
				key: 'custom',
				variant: 'custom',
				name: custom.displayName,
				sizeMB: Math.round(custom.sizeBytes / (1024 * 1024)),
				usedFor: m.settings_models_on_device_translation_your(),
				state: $ggufDownloadState.variant === 'custom' ? $ggufDownloadState : { status: 'idle' },
				ready: true,
				download: () => {},
				cancel: () => cancelGgufDownload(),
				remove: () =>
					void unloadHyMT2Model()
						.catch(() => {})
						.then(() => deleteCustomModel())
						.catch(() => {})
			}
		];
	});

	// The vision models live outside this card's rows but occupy the same
	// storage the line below reports, so a user reading "downloaded now" gets
	// the whole figure rather than only the translation half.
	let ocrModelsMB = $state(0);

	async function refreshOcrModelBytes(): Promise<void> {
		ocrModelsMB = Math.round((await installedOcrModelBytes().catch(() => 0)) / 1024 / 1024);
	}

	$effect(() => {
		const status = $ocrModelDownloadState.status;
		if (status === 'idle' || status === 'completed') untrack(() => { void refreshOcrModelBytes(); });
	});

	let totalDownloadedMB = $derived(
		rows.filter((row) => row.ready).reduce((sum, row) => sum + row.sizeMB, 0) + ocrModelsMB
	);

	function formatMB(mb: number): string {
		return mb >= 100 ? `${Math.round(mb)} MB` : `${mb} MB`;
	}

	function progressPct(row: ModelRow): number {
		const progress = row.state.progress;
		if (!progress || !progress.totalBytes) return 0;
		return Math.round((progress.downloadedBytes / progress.totalBytes) * 100);
	}
</script>

<div data-settings-anchor="on-device-models">
	<h3 class="mb-3 block text-xs font-semibold uppercase tracking-wider text-surface-400">{m.settings_models_on_device_models()}</h3>
	<div class="rounded-lg border border-surface-700 bg-surface-800/50">
		{#each rows as row, index (row.key)}
			<div class="flex items-center gap-3 px-3 py-2.5 {index > 0 ? 'border-t border-surface-700/50' : ''}" data-model-row={row.variant}>
				<div class="min-w-0 flex-1">
					<p class="break-words text-xs leading-snug text-surface-200">{row.name}</p>
					<p class="break-words text-[11px] leading-snug text-surface-500">{row.usedFor} · {formatMB(row.sizeMB)}</p>
					{#if adviceFor(row.sizeMB).level === 'tight' || adviceFor(row.sizeMB).level === 'low'}
						{@const advice = adviceFor(row.sizeMB)}
						<p
							data-memory-advice={advice.level}
							class="mt-0.5 text-[11px] {advice.level === 'low' ? 'text-red-400' : 'text-amber-400'}"
						>
							{advice.message}
						</p>
					{/if}
					{#if row.state.status === 'error'}
						<p class="mt-0.5 break-words text-[11px] text-red-400">{'error' in row.state ? (row.state as { error?: string }).error ?? m.settings_models_download_failed() : m.settings_models_download_failed()}</p>
					{/if}
				</div>
				{#if row.state.status === 'downloading'}
					<div class="flex shrink-0 items-center gap-2">
						<div class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-700">
							<div class="h-full rounded-full bg-primary-500 transition-all" style="width: {progressPct(row)}%"></div>
						</div>
						<span class="w-8 text-right text-[11px] text-surface-400">{progressPct(row)}%</span>
						<button onclick={row.cancel} class="rounded px-2 py-1 text-[11px] text-surface-400 transition-colors hover:text-red-400">{m.common_cancel()}</button>
					</div>
				{:else if row.ready}
					<!-- Same action-column anatomy as the variant picker: Ready above
					     Delete, centered against the row's meta block. -->
					<div class="flex shrink-0 flex-col items-stretch justify-center gap-2">
						<span class="rounded-full bg-green-600/20 px-3 py-1 text-center text-[11px] font-medium text-green-400">{m.settings_models_ready()}</span>
						<button onclick={row.remove} class="rounded-full bg-red-600/20 px-3 py-1 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-600/30">{m.settings_models_delete()}</button>
					</div>
				{:else}
					<button onclick={row.download} class="shrink-0 rounded-full bg-primary-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary-700">{m.settings_models_download()}</button>
				{/if}
			</div>
		{/each}
		<div class="border-t border-surface-700/50 px-3 py-2">
			<p class="text-[11px] text-surface-500">
				<RichMessage message={m.settings_models_downloaded_now({ size: formatMB(totalDownloadedMB) })} emClass="text-surface-300" />
				{#if totalDownloadedMB === 0}<span> {m.settings_models_nothing_takes_up_space()}</span>{/if}
			</p>
		</div>
	</div>
</div>

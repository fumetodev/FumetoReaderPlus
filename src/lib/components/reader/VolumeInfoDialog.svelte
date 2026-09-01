<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { get } from 'svelte/store';
	import { fade, scale } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { portal } from '$lib/utils/portal.js';
	import { settings } from '$lib/settings/settings.js';
	import { effectiveReadingDirection } from '$lib/reader/reading-direction.js';
	import { readerTransientCloseHandler } from '$lib/stores/ui-state.js';
	import type { VolumeMetadata } from '$lib/types/index.js';

	interface Props {
		volume: VolumeMetadata;
		onclose: () => void;
	}

	let { volume, onclose }: Props = $props();

	let libraryName = $derived(
		$settings.libraries.find((library) => library.id === volume.library_id)?.name ?? null
	);

	let addedOn = $derived.by(() => {
		const stamp = Date.parse(volume.created_at ?? '');
		return Number.isNaN(stamp) ? null : new Date(stamp).toLocaleDateString();
	});

	let rows = $derived.by(() => {
		const entries: Array<{ label: string; value: string }> = [];
		if (libraryName) entries.push({ label: m.reader_info_library(), value: libraryName });
		if (volume.folder_path) entries.push({ label: m.reader_info_folder(), value: volume.folder_path });
		if (volume.filename) entries.push({ label: m.reader_info_file(), value: volume.filename });
		entries.push({ label: m.reader_info_pages(), value: `${volume.page_count}` });
		const direction = effectiveReadingDirection(volume, $settings);
		entries.push({
			label: m.reader_reading_direction(),
			value: volume.reading_direction === undefined
				? (direction === 'rtl' ? m.reader_direction_rtl() : m.reader_direction_ltr())
				: m.reader_direction_pinned({ direction: direction === 'rtl' ? m.reader_direction_rtl() : m.reader_direction_ltr() })
		});
		if (volume.author) entries.push({ label: m.reader_info_author(), value: volume.author });
		if (volume.tags?.length) entries.push({ label: m.reader_info_tags(), value: volume.tags.join(', ') });
		if (addedOn) entries.push({ label: m.reader_info_added(), value: addedOn });
		return entries;
	});

	// Android back dismisses the dialog before the reader ladder runs.
	$effect(() => {
		readerTransientCloseHandler.set(onclose);
		return () => {
			if (get(readerTransientCloseHandler) === onclose) readerTransientCloseHandler.set(null);
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	use:portal
	class="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-scrim-modal)] p-6"
	onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}
	in:fade={{ duration: motionDuration(150) }}
	out:fade={{ duration: motionDuration(exitDuration(150)) }}
	data-volume-info-backdrop
>
	<div
		class="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface-container-high shadow-2xl"
		in:scale={{ duration: motionDuration(150), start: 0.95 }}
		out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
		role="dialog"
		aria-modal="true"
		aria-label={m.reader_comic_information()}
		data-volume-info-dialog
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			<h2 class="break-words text-base font-semibold leading-snug text-surface-100" data-volume-info-title>
				{volume.title}
			</h2>
			<dl class="mt-4 space-y-2.5">
				{#each rows as row (row.label)}
					<div class="flex items-baseline gap-3">
						<dt class="w-28 shrink-0 text-xs text-surface-500">{row.label}</dt>
						<dd class="min-w-0 flex-1 break-words text-xs text-surface-200">{row.value}</dd>
					</div>
				{/each}
			</dl>
		</div>
		<button
			type="button"
			class="flex min-h-12 w-full items-center justify-center border-t border-surface-800 px-4 text-sm font-medium text-surface-300 active:bg-surface-800"
			onclick={onclose}
			data-volume-info-close
		>
			{m.reader_close()}
		</button>
	</div>
</div>

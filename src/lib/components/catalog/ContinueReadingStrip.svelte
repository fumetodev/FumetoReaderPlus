<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	/**
	 * ContinueReadingStrip — the single most-recently-read volume as a
	 * tappable resume card. Mounted at the top of both the Library and the
	 * Tabs view; `surface` names which, because both are permanently mounted
	 * and a bare shared attribute would make either one ambiguous to address.
	 * The page label is computed with openingPageFor(), so what it promises is
	 * exactly where a tap lands — including the restart-finished-volumes rule.
	 */
	import { untrack } from 'svelte';
	import { fadeOnDecode } from '$lib/util/fade-on-decode.js';
	import { getThumbnailUrl, pinThumbnailUrl } from '$lib/stores/thumbnail-cache.js';
	import { catalogController } from '$lib/controllers/catalog-controller.js';
	import { openingPageFor } from '$lib/reader/opening-page.js';
	import { isBookVolume } from '$lib/book/media-kind.js';
	import { settings } from '$lib/settings/settings.js';
	import type { VolumeMetadata } from '$lib/types/index.js';

	interface Props {
		volume: VolumeMetadata;
		/** Which mounted view this instance belongs to; also its test hook. */
		surface: 'library' | 'tabs';
		onopen: (vol: VolumeMetadata) => void;
	}

	let { volume, surface, onopen }: Props = $props();

	/**
	 * Track the uuid, not the whole volume: the live query hands back a fresh
	 * object on every emission, and the reader writes progress on a debounce
	 * while you read — so depending on the object identity would re-fetch the
	 * cover and churn the pin several times a second, across both instances.
	 */
	let volumeUuid = $derived(volume.volume_uuid);

	/**
	 * The strip's <img> stays mounted while the grid below scrolls through
	 * hundreds of covers; without a pin, that scrolling evicts (and
	 * eventually revokes) this URL out from under it. The pin releases when
	 * the volume changes or the strip unmounts.
	 */
	let thumbUrl = $state<string | null>(null);
	$effect(() => {
		const uuid = volumeUuid;
		const legacyThumbnail = untrack(() => volume.thumbnail);
		// Drop the outgoing cover up front. This effect re-runs only when the
		// volume changes, and a volume with no stored cover resolves to no URL —
		// leaving the old one in place would caption the previous comic's art
		// with the new comic's title. An empty well for one read is honest.
		thumbUrl = null;
		let live = true;
		let releasePin: (() => void) | null = null;
		void catalogController.loadThumbnailAssets([uuid]).then((assets) => {
			if (!live) return;
			const asset = assets.get(uuid);
			const url = getThumbnailUrl(uuid, asset?.blob ?? legacyThumbnail, asset?.revision);
			if (!url) return;
			releasePin = pinThumbnailUrl(uuid);
			thumbUrl = url;
		});
		return () => {
			live = false;
			releasePin?.();
		};
	});

	let openingPage = $derived(openingPageFor(volume, $settings));
	/**
	 * Books show whole-book percent (page_count is the spine SECTION count —
	 * "Page 3 of 12" would be nonsense copy); the persisted fraction is exact,
	 * with coarse section math as the fallback for pre-fraction rows.
	 */
	let isBook = $derived(isBookVolume(volume));
	let bookPercent = $derived(
		Math.min(
			100,
			Math.round(
				(volume.book_progress_fraction ??
					(volume.page_count > 0 ? openingPage / volume.page_count : 0)) * 100
			)
		)
	);
</script>

<div class="px-2 pb-1 pt-2">
	<button
		type="button"
		class="flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-surface-container-high p-2 pr-3 text-left transition-[background-color] duration-100 active:bg-surface-700"
		onclick={() => onopen(volume)}
		data-continue-reading={surface}
	>
		<div class="relative h-[60px] w-[44px] shrink-0 overflow-hidden rounded-lg bg-surface-800">
			{#if thumbUrl}
				<img src={thumbUrl} alt="" class="h-full w-full object-cover" draggable="false" use:fadeOnDecode />
			{/if}
			{#if volume.page_count > 0}
				<div class="absolute bottom-0 left-0 h-[3px] bg-primary-500" style="width: {isBook ? bookPercent : Math.min(100, Math.round(((openingPage + 1) / volume.page_count) * 100))}%"></div>
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<p class="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-400">{m.catalog_continue_reading()}</p>
			<p class="truncate text-sm font-semibold leading-tight text-surface-100">{volume.title}</p>
			<p class="truncate text-[11px] text-surface-500" data-continue-reading-page>
				{#if isBook}{m.catalog_continue_percent_read({ percent: bookPercent })}{:else}{m.catalog_page_x_of_y({ page: openingPage + 1, total: volume.page_count })}{/if}
			</p>
		</div>
		<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white" aria-hidden="true">
			<svg class="ml-0.5 h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l11.02-6.86a1.05 1.05 0 0 0 0-1.8L9.56 4.24A1.05 1.05 0 0 0 8 5.14Z"/></svg>
		</span>
	</button>
</div>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { formatDate } from '$lib/i18n/format.js';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { fade, scale } from 'svelte/transition';
	import { get } from 'svelte/store';
	import { db } from '$lib/db/index.js';
	import { setVolumeFavorited, updateVolume } from '$lib/catalog/catalog-repository.js';
	import { currentVolume, readingDirection } from '$lib/stores/reader-state.js';
	import { settings } from '$lib/settings/settings.js';
	import type { VolumeMetadata } from '$lib/types/index.js';

	interface Props {
		volume: VolumeMetadata | null;
		thumbnailUrl?: string;
		onclose: () => void;
	}

	let { volume, thumbnailUrl, onclose }: Props = $props();

	// Form state. 'default' = no per-volume override; the volume follows the
	// global Display setting and moves with it.
	let author = $state('');
	let direction = $state<'default' | 'rtl' | 'ltr'>('default');
	let favorited = $state(false);

	// Sync form state when volume changes
	$effect(() => {
		if (volume) {
			author = volume.author || '';
			direction = volume.reading_direction ?? 'default';
			favorited = Boolean(volume.favorited_at);
		}
	});

	const effectiveDirection = $derived(
		direction === 'default' ? $settings.defaultReadingDirection : direction
	);

	async function save() {
		if (!volume) return;

		const override = direction === 'default' ? undefined : direction;
		await updateVolume(volume.volume_uuid, {
			author: author.trim() || undefined,
			reading_direction: override
		});
		if (favorited !== Boolean(volume.favorited_at)) {
			await setVolumeFavorited(volume.volume_uuid, favorited);
			volume.favorited_at = favorited ? new Date().toISOString() : undefined;
		}

		// An open reader session should feel the change immediately.
		if (get(currentVolume)?.volume_uuid === volume.volume_uuid) {
			currentVolume.update((v) => (v ? { ...v, reading_direction: override } : v));
			readingDirection.set(effectiveDirection);
		}

		onclose();
	}

</script>

{#if volume}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}
		in:fade={{ duration: motionDuration(150) }} out:fade={{ duration: motionDuration(exitDuration(150)) }}
	>
		<div
			class="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-2xl"
			in:scale={{ duration: motionDuration(150), start: 0.95 }} out:scale={{ duration: motionDuration(exitDuration(150)), start: 0.95 }}
			data-volume-details
		>
			<div class="mb-4 flex items-center justify-between gap-3">
				<h2 class="text-lg font-semibold text-surface-100">{m.catalog_volume_details()}</h2>
				<!-- Favorite: staged like the other fields, written on Save. -->
				<button
					type="button"
					class="flex h-[40px] w-[40px] items-center justify-center rounded-full text-xl transition-colors {favorited ? 'text-amber-300' : 'text-surface-500 hover:text-surface-300'}"
					aria-pressed={favorited}
					aria-label={favorited ? m.catalog_remove_from_favorites() : m.catalog_add_to_favorites()}
					onclick={() => (favorited = !favorited)}
					data-volume-favorite-toggle
				>{favorited ? '★' : '☆'}</button>
			</div>

			<!-- Volume info header -->
			<div class="mb-5 flex items-start gap-3">
				{#if thumbnailUrl}
					<img
						src={thumbnailUrl}
						alt=""
						class="h-20 w-14 shrink-0 rounded object-cover"
					/>
				{/if}
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium text-surface-100">{volume.title}</p>
					<p class="mt-0.5 text-[10px] text-surface-500">
						{m.catalog_volume_pages_meta({ count: volume.page_count, direction: effectiveDirection.toUpperCase() })}{direction === 'default' ? '' : ` ${m.catalog_pinned()}`}
					</p>
					<p class="mt-0.5 text-[10px] text-surface-500">
						{m.catalog_added_on({ date: formatDate(volume.created_at) })}
					</p>
					<p class="mt-0.5 truncate text-[10px] text-surface-600" title={volume.filename}>
						{volume.filename}
					</p>
				</div>
			</div>

			<!-- Author -->
			<div class="mb-4">
				<label for="vol-author" class="mb-1.5 block text-sm font-medium text-surface-300">
					{m.reader_info_author()}
				</label>
				<input
					id="vol-author"
					type="text"
					bind:value={author}
					placeholder={m.catalog_author_name()}
					class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder-surface-600 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
				/>
			</div>

			<!-- Reading direction -->
			<div class="mb-4">
				<span class="mb-1.5 block text-sm font-medium text-surface-300">{m.settings_display_reading_direction()}</span>
				<div class="flex overflow-hidden rounded-lg border border-surface-700" role="radiogroup" aria-label={m.reader_reading_direction()}>
					{#each [
						{ value: 'default' as const, label: m.catalog_direction_default() },
						{ value: 'rtl' as const, label: m.settings_display_right_to_left() },
						{ value: 'ltr' as const, label: m.settings_display_left_to_right() }
					] as option, index (option.value)}
						<button
							role="radio"
							aria-checked={direction === option.value}
							data-volume-direction={option.value}
							onclick={() => (direction = option.value)}
							class="flex-1 px-3 py-2 text-xs transition-colors {index > 0 ? 'border-l border-surface-700' : ''} {direction === option.value
								? 'bg-primary-600 font-medium text-white'
								: 'bg-surface-800 text-surface-400 active:bg-surface-700'}"
						>
							{option.label}
						</button>
					{/each}
				</div>
				<p class="mt-1 text-[10px] text-surface-600">
					{#if direction === 'default'}
						{m.catalog_direction_follows_app({ direction: effectiveDirection })}
					{:else}
						{m.catalog_pinned_for_this_comic()}
					{/if}
				</p>
			</div>

			<!-- Actions -->
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-surface-200"
				>
					{m.common_cancel()}
				</button>
				<button
					onclick={save}
					class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
				>
					{m.catalog_save()}
				</button>
			</div>
		</div>
	</div>
{/if}

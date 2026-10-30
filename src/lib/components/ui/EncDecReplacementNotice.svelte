<script lang="ts">
	/**
	 * The one-time offer of FumetoTranslate to someone still translating with the
	 * model it replaced (encdec-handoff.ts). Floats above the dock like a toast but
	 * holds two choices, so it is a card of its own. Download starts the download
	 * and opens Settings at the model list, where its progress shows; the old
	 * model keeps translating until the new one is ready.
	 */
	import { get } from 'svelte/store';
	import { fly } from 'svelte/transition';
	import * as m from '$lib/paraglide/messages.js';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { encdecReplacementOffer } from '$lib/translation/encdec-handoff.js';
	import { downloadEncDecModel } from '$lib/translation/encdec-model-manager.js';
	import { appView } from '$lib/stores/reader-state.js';
	import { settingsInitialAnchor, settingsInitialTab, settingsLoading, settingsReturnView, settingsViewMounted } from '$lib/stores/ui-state.js';

	function later(): void {
		encdecReplacementOffer.set(null);
	}

	function download(): void {
		const offer = get(encdecReplacementOffer);
		if (!offer) return;
		encdecReplacementOffer.set(null);
		// Progress and any failure show on the model's card in Settings.
		void downloadEncDecModel(offer.successor).catch(() => undefined);
		if (get(appView) !== 'settings') settingsReturnView.set(get(appView));
		settingsInitialTab.set('translation');
		settingsInitialAnchor.set({ anchor: `model-${offer.successor}`, subTab: 'on-device' });
		if (!get(settingsViewMounted)) settingsLoading.set(true);
		appView.set('settings');
	}
</script>

{#if $encdecReplacementOffer}
	<div
		class="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4"
		style="bottom: calc(var(--app-bottom-clearance) + 10px);"
	>
		<div
			role="dialog"
			aria-labelledby="encdec-replacement-title"
			class="pointer-events-auto w-full max-w-sm rounded-[var(--radius-card)] bg-surface-container-highest p-4 text-surface-200 shadow-dock"
			in:fly={{ y: 12, duration: motionDuration(180) }}
			out:fly={{ y: 12, duration: motionDuration(exitDuration(180)) }}
			data-encdec-replacement-notice
		>
			<p id="encdec-replacement-title" class="text-sm font-semibold">{m.encdec_replacement_notice_title()}</p>
			<p class="mt-1 text-xs text-surface-300">{m.encdec_replacement_notice_body({ size: $encdecReplacementOffer.sizeLabel })}</p>
			<div class="mt-3 flex justify-end gap-2">
				<button
					type="button"
					class="h-11 rounded-full px-4 text-xs font-medium text-surface-300 active:bg-surface-700"
					onclick={later}
					data-testid="encdec-replacement-later"
				>
					{m.encdec_replacement_notice_later()}
				</button>
				<button
					type="button"
					class="h-11 rounded-full bg-primary-600 px-4 text-xs font-semibold text-white active:bg-primary-700"
					onclick={download}
					data-testid="encdec-replacement-download"
				>
					{m.encdec_replacement_notice_download()}
				</button>
			</div>
		</div>
	</div>
{/if}

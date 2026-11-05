<script lang="ts">
	/**
	 * Shown in the reader when the site of the web chapter on screen refused a page until the person passes a check
	 * in the browser (a Cloudflare challenge). The app never answers such checks itself: it shows the person the site,
	 * where the browser shows the check, and the pages fetched after it carry the clearance. The chapter waits meanwhile.
	 */
	import * as m from '$lib/paraglide/messages.js';
	import { currentVolume } from '$lib/stores/reader-state.js';
	import { openSiteForCheck } from '$lib/web-browser/browser-controller.js';
	import { webChallenge } from '$lib/reader/web-page-source.js';

	const shown = $derived(!!$webChallenge && $webChallenge.volumeUuid === $currentVolume?.volume_uuid);

	function openSite(): void {
		webChallenge.set(null);
		if ($currentVolume) openSiteForCheck($currentVolume);
	}
</script>

{#if shown}
	<div
		class="fixed inset-x-3 z-[46] flex items-center gap-3 rounded-2xl bg-surface-container-highest px-4 py-3 shadow-dock"
		style="top: calc(var(--sat, 0px) + 72px);"
		role="alert"
		data-web-challenge
	>
		<p class="min-w-0 flex-1 text-xs text-surface-200">{m.browser_challenge()}</p>
		<button type="button" class="h-10 shrink-0 rounded-full bg-primary-600 px-4 text-xs font-semibold text-white active:bg-primary-700" onclick={openSite}>
			{m.browser_challenge_open()}
		</button>
	</div>
{/if}

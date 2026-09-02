<script lang="ts">
	/**
	 * ToastHost — renders the toast stack floating above the dock. Fixed
	 * layer: appearing and disappearing toasts never reflow the content
	 * behind them. aria-live lets screen readers hear what sighted users
	 * see slide in.
	 */
	import { fly } from 'svelte/transition';
	import { motionDuration, exitDuration } from '$lib/util/motion.js';
	import { toasts, dismissToast, dismissToastByUser } from '$lib/stores/toasts.js';
	import { renderUserMessage } from '$lib/i18n/user-messages.js';
	import * as m from '$lib/paraglide/messages.js';
</script>

<div
	class="pointer-events-none fixed inset-x-0 z-[45] flex flex-col items-center gap-1.5 px-6"
	style="bottom: calc(var(--app-bottom-clearance) + 10px);"
	aria-live="polite"
	data-toast-host
>
	{#each $toasts as toast (toast.id)}
		<div
			class="pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-full py-2 pl-4 pr-2 text-xs shadow-dock {toast.tone === 'error' ? 'bg-red-950 text-red-200' : 'bg-surface-container-highest text-surface-200'}"
			in:fly={{ y: 12, duration: motionDuration(180) }}
			out:fly={{ y: 12, duration: motionDuration(exitDuration(180)) }}
			role={toast.tone === 'error' ? 'alert' : 'status'}
			data-toast
		>
			<p class="min-w-0 flex-1 break-words">{renderUserMessage(toast.message)}</p>
			{#if toast.action}
				<button
					type="button"
					class="h-8 shrink-0 rounded-full bg-primary-600 px-3 text-[11px] font-semibold text-white active:bg-primary-700"
					onclick={() => { toast.action?.run(); dismissToast(toast.id); }}
				>
					{renderUserMessage(toast.action.label)}
				</button>
			{/if}
			<button
				type="button"
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-surface-400 active:bg-surface-700"
				aria-label={m.common_dismiss()}
				onclick={() => dismissToastByUser(toast.id)}
			>×</button>
		</div>
	{/each}
</div>

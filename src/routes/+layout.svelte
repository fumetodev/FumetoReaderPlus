<script lang="ts">
	// First, before any message can render: installs the locale into Paraglide.
	import '$lib/i18n';
	import * as m from '$lib/paraglide/messages.js';
	import '../app.css';
	import { recordError } from '$lib/diagnostics/error-ring.js';
	import { collectDiagnosticReport } from '$lib/diagnostics/collect-diagnostics.js';

	let { children } = $props();

	// A fault that kills the Svelte tree leaves a blank screen. A tester cannot
	// reach Settings from there, so recovery and the report have to live here.
	let report = $state<string | null>(null);
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

	function handleBoundaryError(error: unknown) {
		recordError('svelte', error);
	}

	async function buildReport() {
		try {
			report = await collectDiagnosticReport();
		} catch (error) {
			report = m.shell_diagnostic_report_could_not({ error: String(error) });
		}
	}

	async function copyReport() {
		if (report === null) await buildReport();
		try {
			await navigator.clipboard.writeText(report ?? '');
			copyState = 'copied';
		} catch {
			// The Android WebView denies clipboard writes in some contexts. The
			// text is on screen and selectable, so this is a downgrade rather
			// than a dead end.
			copyState = 'failed';
		}
	}
</script>

<svelte:boundary onerror={handleBoundaryError}>
	{@render children()}

	{#snippet failed(error, reset)}
		<div
			data-app-error-boundary
			class="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-950 px-6 py-10 text-center"
			role="alert"
		>
			<p class="text-4xl">😵</p>
			<p class="text-lg text-surface-200">{m.shell_crash_title()}</p>
			<p class="w-full max-w-md text-sm text-surface-400">{m.shell_crash_body()}</p>
			<p class="w-full max-w-md break-words font-mono text-xs text-surface-500">
				{error instanceof Error ? error.message : String(error)}
			</p>

			<div class="flex flex-wrap items-center justify-center gap-2">
				<button
					data-app-error-reload
					onclick={reset}
					class="min-h-11 rounded-lg bg-primary-600 px-6 text-sm font-medium text-white transition-colors hover:bg-primary-700"
				>{m.shell_crash_reload()}</button>
				<button
					data-app-error-copy
					onclick={copyReport}
					class="min-h-11 rounded-lg border border-surface-600 px-5 text-sm text-surface-200 transition-colors active:bg-surface-700"
				>
					{copyState === 'copied'
						? m.shell_crash_copied()
						: copyState === 'failed'
							? m.shell_crash_copy_failed()
							: m.shell_crash_copy_report()}
				</button>
				{#if report === null}
					<button
						data-app-error-show
						onclick={buildReport}
						class="min-h-11 rounded-lg px-4 text-sm text-primary-400 transition-colors hover:text-primary-300"
					>{m.shell_crash_show_report()}</button>
				{/if}
			</div>

			{#if report !== null}
				<!-- Shown, not just copied: the report is assembled from device and
				     error data, and a tester should be able to read exactly what
				     they are about to send. -->
				<pre
					data-app-error-report
					class="allow-select max-h-64 w-full max-w-md overflow-auto rounded-lg bg-surface-900 p-3 text-left font-mono text-[10px] leading-relaxed text-surface-300"
				>{report}</pre>
				<p class="w-full max-w-md text-[11px] text-surface-600">
					{m.shell_crash_report_note()}
				</p>
			{/if}
		</div>
	{/snippet}
</svelte:boundary>

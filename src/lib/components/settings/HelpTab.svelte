<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { uiLocale } from '$lib/i18n/locale.js';
	import RichMessage from '$lib/components/ui/RichMessage.svelte';
	import { motionDuration } from '$lib/util/motion.js';
	import { slide } from 'svelte/transition';
	import { APP_DEVELOPER, APP_GITHUB, APP_NAME, APP_RELEASE, APP_VERSION, SAMPLE_MANGA_AUTHOR, SAMPLE_MANGA_TITLE } from '$lib/version.js';
	import { formatBuildLine, getBuildInfo, isNonProductionBuild } from '$lib/build-info.js';
	import { DEFAULT_OPENROUTER_MODEL } from '$lib/settings/settings.js';
	import { openExternal } from '$lib/util/external-links.js';
	import { get } from 'svelte/store';
	import { helpInitialSection, settingsDialogOpen } from '$lib/stores/ui-state.js';
	import { isAndroid, isMobile } from '$lib/util/platform.js';
	import { onboardingTourOpen } from '$lib/onboarding/onboarding.js';
	import HelpFigureReaderTopBar from './help/HelpFigureReaderTopBar.svelte';
	import HelpFigureReaderBottomBar from './help/HelpFigureReaderBottomBar.svelte';
	import HelpFigureTranslateMenu from './help/HelpFigureTranslateMenu.svelte';
	import HelpFigureMoreMenu from './help/HelpFigureMoreMenu.svelte';
	import HelpFigureCatalogCard from './help/HelpFigureCatalogCard.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { settingsDraft as draft, applyDraftNow } from './settings-state.svelte.js';
	import { cachedUpdateState, checkForDesktopUpdate, type LatestRelease } from '$lib/update/update-check.js';

	// Build provenance for the About footer. The Android bridge is installed
	// before the WebView loads, and this component only ever mounts client-side,
	// so a plain const reads the real build type.
	const buildInfo = getBuildInfo();
	const buildLine = formatBuildLine(buildInfo);
	const buildIsNonProduction = isNonProductionBuild(buildInfo);

	// Desktop only: the new-version line, seeded from the cache so a check that
	// ran at startup shows here without another request. The button asks the
	// release feed regardless of the daily interval and of the switch below it.
	type UpdateFooterState =
		| { status: 'idle' | 'checking' | 'failed' }
		| { status: 'update' | 'current'; latest: LatestRelease };
	let updateState = $state<UpdateFooterState>(
		isMobile ? { status: 'idle' } : (cachedUpdateState(buildInfo.version) ?? { status: 'idle' })
	);

	async function runManualUpdateCheck(): Promise<void> {
		updateState = { status: 'checking' };
		const outcome = await checkForDesktopUpdate({ manual: true });
		updateState = outcome.status === 'update' || outcome.status === 'current'
			? { status: outcome.status, latest: outcome.latest }
			: { status: 'failed' };
	}

	function toggleAutomaticUpdateCheck(): void {
		draft.desktopUpdateCheck = !draft.desktopUpdateCheck;
		void applyDraftNow();
	}

	// Top-level accordion
	let expandedSection = $state<string | null>(null);
	// Nested accordion for Translations sub-sections
	let expandedTranslationSub = $state<string | null>(null);

	// In-app licenses viewer (target=_blank links are no-ops in the Android
	// WebView — review B8)
	let licensesOpen = $state(false);
	let licensesText = $state<string | null>(null);
	let licensesError = $state(false);

	async function toggleLicenses() {
		licensesOpen = !licensesOpen;
		if (licensesOpen && licensesText === null && !licensesError) {
			try {
				const response = await fetch('/licenses/OVERLAY_THIRD_PARTY_NOTICES.txt');
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				licensesText = await response.text();
			} catch {
				licensesError = true;
			}
		}
	}

	// Section registry powers the Help search box and deep links.
	const HELP_SECTIONS: Array<{ id: string; title: () => string; keywords: () => string; keywordsEn: string[] }> = [
		{ id: 'overview', title: () => m.help_overview(), keywords: () => m.help_keywords_overview(), keywordsEn: ['about', 'features', 'what is'] },
		{ id: 'getting-started', title: () => m.help_getting_started(), keywords: () => m.help_keywords_getting_started(), keywordsEn: ['setup', 'first', 'import', 'add library', 'remote'] },
		{ id: 'library-view', title: () => m.settings_display_library_view(), keywords: () => m.help_keywords_library_view(), keywordsEn: ['catalog', 'search', 'sort', 'folders', 'tags', 'move'] },
		{ id: 'reader-view', title: () => m.help_reader_view(), keywords: () => m.help_keywords_reader_view(), keywordsEn: ['pages', 'zoom', 'navigation', 'regions', 'draw', 'controls', 'filmstrip', 'go to page', 'long-press', 'info'] },
		{ id: 'translations', title: () => m.sidebar_translations(), keywords: () => m.help_keywords_translations(), keywordsEn: ['openrouter', 'api key', 'provider', 'on-device', 'modes', 'overlay', 'revisions', 'cost', 'price'] },
		{ id: 'whats-new', title: () => m.help_what_s_new(), keywords: () => m.help_keywords_whats_new(), keywordsEn: ['changelog', 'release', 'version', 'updates'] },
		{ id: 'tips', title: () => m.help_tips_troubleshooting(), keywords: () => m.help_keywords_tips(), keywordsEn: ['problem', 'error', 'connection', 'slow', 'faq', 'fix'] },
		{ id: 'storage-data', title: () => m.help_storage_data(), keywords: () => m.help_keywords_storage_data(), keywordsEn: ['backup', 'export', 'delete', 'files', 'space', 'where'] },
		{ id: 'privacy', title: () => m.help_privacy_policy(), keywords: () => m.help_keywords_privacy(), keywordsEn: ['data collection', 'permissions', 'tracking'] }
	];
	let helpQuery = $state('');
	function sectionVisible(id: string): boolean {
		const q = helpQuery.trim().toLowerCase();
		if (q.length < 2) return true;
		const section = HELP_SECTIONS.find((candidate) => candidate.id === id);
		if (!section) return true;
		return (
			section.title().toLowerCase().includes(q) ||
			section.keywords().toLowerCase().split(',').some((keyword) => keyword.trim().includes(q)) ||
			section.keywordsEn.some((keyword) => keyword.includes(q))
		);
	}
	// Auto-expand a lone search match; collapse a filtered-out open section.
	$effect(() => {
		const q = helpQuery.trim().toLowerCase();
		if (q.length < 2) return;
		const matches = HELP_SECTIONS.filter((section) => sectionVisible(section.id));
		if (matches.length === 1) expandedSection = matches[0].id;
		else if (expandedSection && !matches.some((section) => section.id === expandedSection)) {
			expandedSection = null;
		}
	});

	// Deep link (one-shot): expand the requested section on mount.
	$effect(() => {
		const target = get(helpInitialSection);
		if (target) {
			expandedSection = target;
			helpInitialSection.set(null);
		}
	});

	function toggleSection(id: string) {
		expandedSection = expandedSection === id ? null : id;
		// Reset nested accordion when switching top-level sections
		if (expandedSection !== 'translations') {
			expandedTranslationSub = null;
		}
	}

	function toggleTranslationSub(id: string) {
		expandedTranslationSub = expandedTranslationSub === id ? null : id;
	}

</script>

<div class="space-y-2" data-settings-anchor="help-root">
	{#if $uiLocale !== 'en'}
		<p class="rounded-lg border border-surface-700 bg-surface-900/60 px-3 py-2 text-[11px] text-surface-400" data-help-screenshots-note>{m.help_screenshots_english_note()}</p>
	{/if}
	<input
		type="search"
		bind:value={helpQuery}
		placeholder={m.help_search_help_topics()}
		aria-label={m.help_search_help_topics_2()}
		class="mb-1 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-xs text-surface-100 placeholder-surface-500 focus:border-primary-500 focus:outline-none"
	/>
	<!-- ============================================================ -->
	<!-- Section 1: Overview -->
	<!-- ============================================================ -->
	<button
		data-help-section="overview" onclick={() => toggleSection('overview')}
		aria-expanded={expandedSection === 'overview'}
		class:hidden={!sectionVisible('overview')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_overview()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'overview' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'overview'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p>
				{isMobile ? m.help_intro({ app: APP_NAME }) : m.help_intro_desktop({ app: APP_NAME })}
			</p>
			<p class="mt-2 font-medium text-surface-200">{m.help_read_comics_from()}</p>
				<ul class="mt-1 list-disc space-y-1 pl-4">
					<li>{m.help_local_device_storage_zip()}</li>
					<li>{m.help_self_hosted_servers_yacreader()}</li>
				</ul>
			<p class="mt-2 font-medium text-surface-200">{m.help_translate_comics()}</p>
			<ul class="mt-1 list-disc space-y-1 pl-4">
				<li>{m.help_off_device_cloud_llms()}</li>
				<li>{m.help_on_device_models_hy()}</li>
			</ul>
			<p class="mt-2">
				{m.help_best_results_come_from()}
			</p>
			<p class="mt-2 font-medium text-surface-200">{m.help_customize_the_look()}</p>
			<p class="mt-1">
				{m.help_choose_from_12_color()}
			</p>
			<img src="/help/overview-main.png" alt={m.help_main_catalog_view_with()} class="mx-auto mb-1 mt-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
			<p class="mb-3 text-center text-[11px] text-surface-500">
				<RichMessage message={m.help_screenshots_credit({ title: SAMPLE_MANGA_TITLE, author: SAMPLE_MANGA_AUTHOR })} emClass="text-surface-400" />
			</p>
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section 2: Getting Started -->
	<!-- ============================================================ -->
	<button
		data-help-section="getting-started" onclick={() => toggleSection('getting-started')}
		aria-expanded={expandedSection === 'getting-started'}
		class:hidden={!sectionVisible('getting-started')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_getting_started()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'getting-started' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'getting-started'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<button
				data-help-replay-tour
				onclick={() => {
					// Mobile: the Settings view simply persists beneath the tour
					// (it is a keep-alive destination, so nothing strands). Desktop
					// closes the modal dialog first, as before.
					if (!isMobile) settingsDialogOpen.set(false);
					onboardingTourOpen.set(true);
				}}
				class="mb-3 w-full rounded-lg border border-primary-600/40 bg-primary-600/10 px-4 py-2.5 text-xs font-medium text-primary-300 transition-colors hover:bg-primary-600/20"
			>
				{m.help_replay_the_intro_tour()}
			</button>
			<p class="font-medium text-surface-200">{m.help_local_library()}</p>
			<p class="mt-1">
				{m.help_a_local_comics_library()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_adding_a_remote_library()}</p>
			<p class="mt-1">
				{m.help_open_settings_libraries_tab()}
			</p>
			<img src="/help/getting-started-add-remote.png" alt={m.help_settings_libraries_tab_with()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_setting_up_translation()}</p>
			<p class="mt-1">
				{m.help_see_the_translations_section()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.onboarding_start_reading()}</p>
			<p class="mt-1">
					{m.help_tap_any_volume_in()}
			</p>
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section 3: Library View -->
	<!-- ============================================================ -->
	<button
		data-help-section="library-view" onclick={() => toggleSection('library-view')}
		aria-expanded={expandedSection === 'library-view'}
		class:hidden={!sectionVisible('library-view')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.settings_display_library_view()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'library-view' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'library-view'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p class="font-medium text-surface-200">{m.help_switching_libraries()}</p>
			<p class="mt-1">
					{m.help_use_the_library_dropdown()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_view_modes()}</p>
			<p class="mt-1">
				{m.help_toggle_between_grid_view()}
			</p>
			<HelpFigureCatalogCard />
			<img src="/help/library-grid-view.png" alt={m.help_catalog_view_in_grid()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
			<img src="/help/library-list-view.png" alt={m.help_catalog_view_in_list()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_comic_actions()}</p>
			<p class="mt-1">
				{m.help_tap_the_button_on()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_searching()}</p>
			<p class="mt-1">
				{m.help_tap_the_search_icon()}
			</p>
			<img src="/help/library-search.png" alt={m.help_search_bar_open_with()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_sorting()}</p>
			<p class="mt-1">
				{m.help_tap_the_sort_button()}
			</p>
			<img src="/help/library-sort-menu.png" alt={m.help_sort_dropdown_showing_sort()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_tag_filtering()}</p>
			<p class="mt-1">
				{m.help_filter_volumes_by_tags()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_folders_local_libraries_only()}</p>
			<p class="mt-1">
				{m.help_navigate_into_subfolders_via()}
			</p>
			<img src="/help/library-folder-management.png" alt={m.help_folder_context_menu_and()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_select_move_local_libraries()}</p>
			<p class="mt-1">
				{m.help_tap_the_checkmark_button()}
			</p>
			<img src="/help/library-select-move.png" alt={m.help_selection_mode_with_two()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_recently_read()}</p>
			<p class="mt-1">
				{m.help_when_at_the_root()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_remote_server_folders()}</p>
			<p class="mt-1">
				{m.help_yacreader_komga_and_kavita()}
			</p>
			</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section 4: Reader View -->
	<!-- ============================================================ -->
	<button
		data-help-section="reader-view" onclick={() => toggleSection('reader-view')}
		aria-expanded={expandedSection === 'reader-view'}
		class:hidden={!sectionVisible('reader-view')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_reader_view()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'reader-view' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'reader-view'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p class="font-medium text-surface-200">{m.help_reader_controls()}</p>
			<p class="mt-1">
				{m.help_the_top_row_contains()}
			</p>
			<HelpFigureReaderTopBar />
			<HelpFigureReaderBottomBar />
			<p class="mt-3 font-medium text-surface-200">{m.help_the_menu()}</p>
			<p class="mt-1">
				{m.help_zoom_presets_reading_direction()}
			</p>
			<HelpFigureMoreMenu />

			<p class="mt-3 font-medium text-surface-200">{m.help_reader_modes()}</p>
			<p class="mt-1">
				<RichMessage message={m.help_reader_modes_text({ paged: m.settings_display_paged(), longStrip: m.settings_display_long_strip() })} emClass="text-surface-200" />
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_page_navigation()}</p>
			<p class="mt-1">
					{m.help_in_paged_mode_swipe()}
			</p>
			<img src="/help/reader-single-page.png" alt={m.help_reader_view_showing_a()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

			<p class="mt-3 font-medium text-surface-200">{m.help_zoom_pan()}</p>
			<p class="mt-1">
				{m.help_in_paged_mode_pinch()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.shell_reader_tools()}</p>
			<p class="mt-1">
				{m.help_the_bottom_bar_s()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_drawing_regions()}</p>
			<p class="mt-1">
				{m.help_open_the_globe_menu()}
			</p>
			<img src="/help/reader-draw-region.png" alt={m.help_region_drawing_mode_with()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section 5: Translations (with nested accordions) -->
	<!-- ============================================================ -->
	<button
		data-help-section="translations" onclick={() => toggleSection('translations')}
		aria-expanded={expandedSection === 'translations'}
		class:hidden={!sectionVisible('translations')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.sidebar_translations()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'translations' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'translations'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p class="mb-3">
				{m.help_translations_intro({ app: APP_NAME })}
			</p>

			<div class="space-y-1.5">
				<!-- 5a: How It Works -->
				<button
					onclick={() => toggleTranslationSub('trans-overview')}
					aria-expanded={expandedTranslationSub === 'trans-overview'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_how_it_works()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-overview' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-overview'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p>
							{m.help_two_steps({ app: APP_NAME })}
						</p>
						<p class="mt-2">
							{m.help_results_display_as_an()}
						</p>
						<p class="mt-2">
							{m.help_two_main_pipelines()}
						</p>
						<ul class="mt-1 list-disc space-y-1 pl-4">
							<li><RichMessage message={m.help_off_device_li({ offDevice: m.settings_translation_off_device() })} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_on_device_li({ onDevice: m.settings_translation_on_device() })} emClass="text-surface-300" /></li>
						</ul>
					</div>
				{/if}

				<!-- 5b: OpenRouter Setup (Recommended) -->
				<button
					onclick={() => toggleTranslationSub('trans-openrouter')}
					aria-expanded={expandedTranslationSub === 'trans-openrouter'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_openrouter_setup_recommended()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-openrouter' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-openrouter'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p>
							{m.help_openrouter_provides_access_to()}
						</p>
						<p class="mt-2 text-surface-300">{m.help_getting_an_api_key()}</p>
						<ol class="mt-1 list-decimal space-y-1 pl-4">
							<li>
								<RichMessage message={m.help_open_openrouter_li()} links={{ openrouter: () => void openExternal('https://openrouter.ai') }} linkClass="font-medium text-primary-400 underline underline-offset-2 hover:text-primary-300" />
							</li>
							<li>{m.help_tap_get_api_key()}</li>
							<li>{m.help_add_a_small_amount()}</li>
						</ol>
						<img src="/help/openrouter-home.png" alt={m.help_the_openrouter_ai_homepage()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
						<p class="mt-1 text-surface-500">
							{m.help_key_like_password({ app: APP_NAME })}
						</p>
						<p class="mt-2 text-surface-300">{m.help_setup()}</p>
						<p class="mt-1">
							<RichMessage message={m.help_openrouter_setup_path({ defaultOpenrouterModel: DEFAULT_OPENROUTER_MODEL })} />
						</p>
						<img src="/help/translation-off-device-setup.png" alt={m.help_settings_translation_tab_showing()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
						<p class="mt-2 text-surface-300">{m.help_vision_mode_default_for()}</p>
						<p class="mt-1">
							{m.help_the_llm_receives_the()}
						</p>
						<p class="mt-1 text-amber-400/90">
							{m.help_privacy_note_in_vision()}
						</p>
						<p class="mt-2 text-surface-300">{m.help_cost()}</p>
						<p class="mt-1">
							{m.help_pay_per_use_via()}
						</p>
					</div>
				{/if}

				<!-- 5b2: What does it cost? -->
				<button
					onclick={() => toggleTranslationSub('trans-costs')}
					aria-expanded={expandedTranslationSub === 'trans-costs'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_what_does_it_cost()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-costs' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-costs'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p>
							{m.help_off_device_translation_is()}
						</p>
						<p class="mt-2">
							{m.help_as_a_rough_order()}
						</p>
						<ul class="mt-2 list-disc space-y-1 pl-4">
							<li>{m.help_mode_2_3_add()}</li>
							<li>{m.help_the_review_pass_roughly()}</li>
							<li>{m.help_on_device_translation_is()}</li>
						</ul>
					</div>
				{/if}

				<!-- 5c: Other Cloud APIs -->
				<button
					onclick={() => toggleTranslationSub('trans-cloud')}
					aria-expanded={expandedTranslationSub === 'trans-cloud'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_other_cloud_apis()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-cloud' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-cloud'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<ul class="list-disc space-y-2 pl-4">
							<li><RichMessage message={m.help_provider_claude_li()} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_provider_openai_li()} emClass="text-surface-300" /></li>
						</ul>
					</div>
				{/if}

				<!-- 5d: Local LLM Servers -->
				<button
					onclick={() => toggleTranslationSub('trans-local')}
					aria-expanded={expandedTranslationSub === 'trans-local'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_local_llm_servers()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-local' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-local'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<ul class="list-disc space-y-2 pl-4">
							<li><RichMessage message={m.help_provider_ollama_li()} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_provider_lmstudio_li()} emClass="text-surface-300" /></li>
						</ul>
						<p class="mt-2">
							{m.help_local_servers_run_the()}
						</p>
					</div>
				{/if}

				<!-- 5e: On-Device Translation -->
				<button
					onclick={() => toggleTranslationSub('trans-ondevice')}
					aria-expanded={expandedTranslationSub === 'trans-ondevice'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_on_device_translation()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-ondevice' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-ondevice'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p>
							{m.help_runs_entirely_on_your()}
						</p>
						<p class="mt-2 text-surface-300">{m.help_text_recognition()}</p>
						<p class="mt-1">{m.help_pp_ocrv6_native_onnx()}</p>
						<p class="mt-2 text-surface-300">{m.help_translation()}</p>
						<p class="mt-1"><RichMessage message={m.help_hy_mt2_blurb({ hyMt218b: m.settings_translation_hy_mt2_1_8b() })} emClass="text-surface-300" /></p>
						<p class="mt-2 text-surface-300">{m.help_setup_for_hy_mt2()}</p>
						<p class="mt-1">
							{m.help_settings_translation_on_device()}
					</p>
					<img src="/help/translation-on-device-setup.png" alt={m.help_settings_translation_tab_showing_2()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
					</div>
				{/if}

				<!-- 5f: Translation Modes -->
				<button
					onclick={() => toggleTranslationSub('trans-modes')}
					aria-expanded={expandedTranslationSub === 'trans-modes'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_translation_modes()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-modes' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-modes'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<ul class="list-disc space-y-2 pl-4">
							<li><RichMessage message={m.help_mode_1_li({ mode1Isolated: m.settings_translation_mode_1_isolated() })} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_mode_2_li({ mode2PageContext: m.settings_translation_mode_2_page_context() })} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_mode_3_li({ mode3FullContext: m.settings_translation_mode_3_full_context() })} emClass="text-surface-300" /></li>
						</ul>
						<img src="/help/translation-modes.png" alt={m.help_settings_showing_the_three()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
					</div>
				{/if}

				<!-- 5g: Using Translations -->
				<button
					onclick={() => toggleTranslationSub('trans-usage')}
					aria-expanded={expandedTranslationSub === 'trans-usage'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_using_translations()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-usage' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-usage'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p class="text-surface-300">{m.help_the_globe_menu_is()}</p>
						<HelpFigureTranslateMenu />

						<p class="mt-2 text-surface-300">{m.help_translate_a_region()}</p>
						<p class="mt-1">
							{m.help_open_the_reader_s()}
						</p>
						<img src="/help/reader-draw-region.png" alt={m.help_region_drawing_mode_with()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

						<p class="mt-2 text-surface-300">{m.help_translate_full_page()}</p>
						<p class="mt-1">
							{m.help_tap_the_translate_action()}
						</p>
						<img src="/help/translation-page-result.png" alt={m.help_fully_translated_page_with()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

						<p class="mt-2 text-surface-300">{m.help_translate_entire_volume_batch()}</p>
						<p class="mt-1">
							{m.help_tap_the_get_full()}
						</p>
						<img src="/help/translation-batch-progress.png" alt={m.help_batch_translation_progress_indicator()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />

						{#if isAndroid}
							<!-- The keep-alive service is an Android feature; a desktop window simply keeps running. -->
							<p class="mt-2 text-surface-300">{m.help_background_translation_android()}</p>
							<p class="mt-1">
								{m.help_enable_keep_translating_in()}
							</p>
						{/if}

						<p class="mt-2 text-surface-300">{m.help_export_translated_cbz()}</p>
						<p class="mt-1">
							{m.help_after_translating_a_volume()}
						</p>
					</div>
				{/if}

				<!-- 5h: Translation Overlay -->
				<button
					onclick={() => toggleTranslationSub('trans-overlay')}
					aria-expanded={expandedTranslationSub === 'trans-overlay'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_translation_overlay()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-overlay' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-overlay'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p class="text-surface-300">{m.help_how_overlays_are_placed()}</p>
						<p class="mt-1">
							{m.help_a_bubble_detection_model()}
						</p>
						<p class="mt-2">
							{m.help_drawn_sound_effects_are()}
						</p>

						<p class="mt-2 text-surface-300">{m.help_overlay_settings()}</p>
						<p class="mt-1">
							{m.help_settings_overlay_enable_disable()}
						</p>

						<p class="mt-2 text-surface-300">{m.help_editing_overlay_boxes()}</p>
						<p class="mt-1">
							{m.help_on_mobile_long_press()}
						</p>
						<ul class="mt-1 list-disc space-y-1 pl-4">
							<li>{m.help_edit_the_translated_text()}</li>
							<li>{m.help_move_the_box_by()}</li>
							<li>{m.help_resize_the_box_using()}</li>
							<li>{m.help_adjust_font_size_per()}</li>
							<li>{m.help_choose_auto_horizontal_or()}</li>
							<li>{m.help_hide_a_box_makes()}</li>
							<li><RichMessage message={m.help_delete_a_box_li({ undo: m.common_undo() })} emClass="text-surface-200" /></li>
						</ul>
						<p class="mt-2">
							<RichMessage message={m.help_boxes_sheet_blurb({ boxesOnThisPageMenu: m.reader_boxes_on_this_page_menu() })} emClass="text-surface-200" />
						</p>
						<p class="mt-2">
							<RichMessage message={m.help_edits_survive_blurb({ reTranslatePage: m.reader_re_translate_page() })} emClass="text-surface-200" />
						</p>

						<p class="mt-2 text-surface-300">{m.help_overlay_badges_states()}</p>
						<ul class="mt-1 list-disc space-y-1 pl-4">
							<li><RichMessage message={m.help_teal_balloon_li()} emClass="text-teal-300" /></li>
							<li><RichMessage message={m.help_unplaced_marker_li()} emClass="rounded bg-surface-800 px-1 text-surface-200" /></li>
						</ul>
						<img src="/help/translation-overlay-edit.png" alt={m.help_overlay_box_selected_for()} class="mx-auto my-3 w-full max-w-[300px] rounded-lg border border-surface-700" />
					</div>
				{/if}

				<!-- 5i: Revisions -->
				<button
					onclick={() => toggleTranslationSub('trans-revisions')}
					aria-expanded={expandedTranslationSub === 'trans-revisions'}
					class="flex w-full items-center justify-between rounded-md bg-surface-900 px-3 py-2 text-left transition-colors hover:bg-surface-800"
				>
					<span class="text-xs font-medium text-surface-300">{m.help_revisions()}</span>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-surface-500 transition-transform duration-200 {expandedTranslationSub === 'trans-revisions' ? 'rotate-180' : ''}"
						viewBox="0 0 20 20" fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
					</svg>
				</button>
				{#if expandedTranslationSub === 'trans-revisions'}
					<div class="px-3 pb-3 pt-1 text-xs leading-relaxed text-surface-400" transition:slide={{ duration: motionDuration(150) }}>
						<p>
							{m.help_translations_use_a_non()}
						</p>
						<ul class="mt-2 list-disc space-y-2 pl-4">
							<li><RichMessage message={m.help_fix_single_box_li()} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_revise_page_li()} emClass="text-surface-300" /></li>
							<li><RichMessage message={m.help_revise_volume_li()} emClass="text-surface-300" /></li>
						</ul>
						<p class="mt-2">
							{m.help_each_revision_creates_a()}
						</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section: What's New -->
	<!-- ============================================================ -->
	<button
		data-help-section="whats-new" onclick={() => toggleSection('whats-new')}
		aria-expanded={expandedSection === 'whats-new'}
		class:hidden={!sectionVisible('whats-new')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_what_s_new()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'whats-new' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'whats-new'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p class="font-medium text-surface-200">{m.help_version_line({ version: APP_VERSION })}</p>
			<ul class="mt-1 list-disc space-y-1 pl-4">
				<li>{m.help_the_on_device_manga_translation()}</li>
				<li>{m.help_if_v4_was_your_on()}</li>
				<li>{m.help_turn_the_phone_sideways()}</li>
				<li>{m.help_scan_progress_messages_can_be()}</li>
				<li>{m.help_fixed_an_api_key_typed()}</li>
				<li>{m.help_the_app_downloads_its_vision()}</li>
				<li>{m.help_the_whole_app_is()}</li>
				<li>{m.help_0_7_0_starts_fresh()}</li>
				<li>{m.help_app_speaks_your_language()}</li>
				<li>{m.help_translucent_text_over_art()}</li>
				<li>{m.help_manga_v5_on_device_model()}</li>
				<li>{m.help_on_device_speed_from_cores()}</li>
				<li>{m.help_long_strip_reader_mode()}</li>
				<li>{m.help_upgraded_translation_model_v3()}</li>
				<li>{m.help_persian_is_selectable_as()}</li>
				<li>{m.help_custom_on_device_model()}</li>
				<li>{m.help_upgraded_on_device_translation()}</li>
				<li>{m.help_pp_ocrv6_is_the()}</li>
				<li>{m.help_interactive_help_tap_the()}</li>
				<li>{m.help_library_polish_library_names()}</li>
				<li>{m.help_redesigned_reader_the_expandable()}</li>
				<li>{m.help_guided_region_translation_draw()}</li>
				<li>{m.help_cleaner_library_comic_names()}</li>
				<li>{m.help_long_press_the_reader()}</li>
				<li>{m.help_redesigned_settings_changes_apply()}</li>
				<li>{m.help_new_remote_server_form()}</li>
				<li>{m.help_settings_backup_export_and()}</li>
				<li>{m.help_overlay_text_size_has()}</li>
				<li>{m.help_dialogue_is_never_dropped()}</li>
				<li>{m.help_sound_effects_now_stay()}</li>
				<li>{m.help_sharper_text_detection_on()}</li>
			</ul>
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section: Storage &amp; Data -->
	<!-- ============================================================ -->
	<button
		data-help-section="storage-data" onclick={() => toggleSection('storage-data')}
		aria-expanded={expandedSection === 'storage-data'}
		class:hidden={!sectionVisible('storage-data')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_storage_data()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'storage-data' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'storage-data'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p class="font-medium text-surface-200">{m.help_where_your_data_lives()}</p>
			<p class="mt-1">
				{m.help_everything_imported_comics_translations()}
			</p>
			<p class="mt-3 font-medium text-surface-200">{m.help_what_deletes_what()}</p>
			<ul class="mt-1 list-disc space-y-1 pl-4">
				<li><RichMessage message={m.help_remove_library_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_erase_rescan_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_deleting_model_li()} emClass="text-surface-200" /></li>
			</ul>
			<p class="mt-3 font-medium text-surface-200">{m.help_backup()}</p>
			<p class="mt-1">
				{m.help_settings_libraries_settings_backup()}
			</p>
			<p class="mt-3 font-medium text-surface-200">{m.help_freeing_space()}</p>
			<p class="mt-1">
				{m.help_the_storage_card_and()}
			</p>
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section 6: Tips & Troubleshooting -->
	<!-- ============================================================ -->
	<button
		data-help-section="tips" onclick={() => toggleSection('tips')}
		aria-expanded={expandedSection === 'tips'}
		class:hidden={!sectionVisible('tips')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_tips_troubleshooting()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'tips' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'tips'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<ul class="list-disc space-y-2 pl-4">
				<li><RichMessage message={m.help_tip_quality_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_text_size_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_slow_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_interrupted_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_boxes_wrong_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_cant_see_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_background_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_cant_connect_li()} emClass="text-surface-200" /></li>
				<li><RichMessage message={m.help_tip_server_moved_li()} emClass="text-surface-200" /></li>
			</ul>
		</div>
	{/if}

	<!-- ============================================================ -->
	<!-- Section 7: Privacy Policy -->
	<!-- ============================================================ -->
	<button
		data-help-section="privacy" onclick={() => toggleSection('privacy')}
		aria-expanded={expandedSection === 'privacy'}
		class:hidden={!sectionVisible('privacy')}
		class="flex w-full items-center justify-between rounded-lg bg-surface-800 px-4 py-3 text-left transition-colors hover:bg-surface-700"
	>
		<span class="text-sm font-medium text-surface-200">{m.help_privacy_policy()}</span>
		<svg
			class="h-4 w-4 shrink-0 text-surface-400 transition-transform duration-200 {expandedSection === 'privacy' ? 'rotate-180' : ''}"
			viewBox="0 0 20 20" fill="currentColor"
		>
			<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
		</svg>
	</button>
	{#if expandedSection === 'privacy'}
		<div class="px-4 pb-4 pt-2 text-xs leading-relaxed text-surface-300" transition:slide={{ duration: motionDuration(200) }}>
			<p class="font-medium text-surface-200">{m.help_data_collection()}</p>
			<p class="mt-1">
				{m.help_privacy_no_collection({ app: APP_NAME })}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_advertising()}</p>
			<p class="mt-1">
				{m.help_the_app_is_ad()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_local_storage_only()}</p>
			<p class="mt-1">
				{m.help_all_your_data_imported()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_user_configured_network_access()}</p>
			<p class="mt-1">{m.help_the_app_only_connects()}</p>
				<ul class="mt-1 list-disc space-y-1 pl-4">
					<li>{m.help_connect_to_a_self()}</li>
					<li>{m.help_send_translation_requests_to()}</li>
				<li>{m.help_download_the_on_device()}</li>
			</ul>

			<p class="mt-3 font-medium text-surface-200">{m.help_api_key_security()}</p>
			<p class="mt-1">
				{m.help_api_keys_you_enter()}
			</p>

			<p class="mt-3 font-medium text-surface-200">{m.help_permissions_used()}</p>
			<ul class="mt-1 list-disc space-y-1 pl-4">
					<li><RichMessage message={m.help_perm_internet_li()} emClass="text-surface-200" /></li>
				{#if isAndroid}
					<!-- The remaining permissions belong to the Android manifest; the desktop asks for none of them. -->
					<li><RichMessage message={m.help_perm_foreground_li()} emClass="text-surface-200" /></li>
					<li><RichMessage message={m.help_perm_wake_lock_li()} emClass="text-surface-200" /></li>
					<li><RichMessage message={m.help_perm_notifications_li()} emClass="text-surface-200" /></li>
				{/if}
			</ul>

			<p class="mt-3 font-medium text-surface-200">{m.help_third_party_services()}</p>
			<p class="mt-1">
					{m.help_third_party_blurb({ app: APP_NAME })}
			</p>
		</div>
	{/if}
</div>

<!-- ============================================================ -->
<!-- About Footer (always visible) -->
<!-- ============================================================ -->
<div class="mt-6 border-t border-surface-800 pt-4 text-center">
	<p class="text-sm font-medium text-surface-200">{APP_NAME}</p>
	<p class="mt-1 text-xs text-surface-500">{m.help_about_version({ version: APP_VERSION })}</p>
	<p class="text-xs text-surface-500">{m.help_about_released({ release: APP_RELEASE })}</p>
	<!-- Build provenance: the line a tester screenshots so the exact artifact
	     behind a bug report can be identified. Tinted when this is anything
	     other than a clean consumer release. -->
	<p
		data-help-build-info
		class="mt-1 font-mono text-[11px] {buildIsNonProduction ? 'text-amber-400' : 'text-surface-600'}"
	>
		{buildLine}
	</p>
	{#if !isMobile}
		<!-- New-version check (desktop): the AppImage has no store to tell it
		     about a release, so About can ask, and the switch turns the daily
		     automatic check off for anyone who would rather it never asked. -->
		<div class="mt-3 flex flex-col items-center gap-2" data-help-update-check>
			{#if updateState.status === 'update'}
				{@const latest = updateState.latest}
				<p class="text-xs text-primary-300">{m.help_about_update_available({ version: latest.version })}</p>
				<button
					type="button"
					onclick={() => void openExternal(latest.assetUrl ?? latest.releaseUrl)}
					class="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
				>
					{m.shell_update_download()}
				</button>
			{:else if updateState.status === 'current'}
				<p class="text-xs text-surface-500">{m.help_about_up_to_date()}</p>
			{:else if updateState.status === 'failed'}
				<p class="text-xs text-red-400">{m.help_about_update_check_failed()}</p>
			{/if}
			<button
				type="button"
				onclick={runManualUpdateCheck}
				disabled={updateState.status === 'checking'}
				class="rounded-lg border border-surface-700 px-3 py-1.5 text-xs text-surface-300 transition-colors hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{m.help_about_check_updates()}
			</button>
			<div class="w-full max-w-xs text-left">
				<Switch checked={draft.desktopUpdateCheck} onchange={toggleAutomaticUpdateCheck} label={m.help_about_update_check_automatic()} />
			</div>
		</div>
	{/if}
	<p class="mt-2 text-xs text-surface-400">
		<RichMessage message={m.help_developed_by({ developer: APP_DEVELOPER })} links={{ developer: () => void openExternal(APP_GITHUB) }} linkClass="text-primary-400 underline hover:text-primary-300" />
	</p>
	<p class="mt-3 text-[11px] leading-relaxed text-surface-500">
		<RichMessage message={m.help_sample_pages_credit({ title: SAMPLE_MANGA_TITLE, author: SAMPLE_MANGA_AUTHOR })} emClass="text-surface-400" />
	</p>
	<p class="mt-2 text-xs">
		<button
			onclick={toggleLicenses}
			aria-expanded={licensesOpen}
			class="text-primary-400 underline hover:text-primary-300"
		>
			{m.help_font_library_and_artwork()}
		</button>
	</p>
	{#if licensesOpen}
		<div class="mx-auto mt-2 max-w-full rounded-lg border border-surface-700 bg-surface-800/60 p-2 text-left" transition:slide={{ duration: motionDuration(150) }}>
			{#if licensesError}
				<p class="text-[11px] text-red-400">{m.help_could_not_load_the()}</p>
			{:else if licensesText === null}
				<p class="text-[11px] text-surface-500">{m.reader_loading()}</p>
			{:else}
				<pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-surface-400">{licensesText}</pre>
			{/if}
		</div>
	{/if}
</div>

/**
 * Passive new-version check for the Linux desktop build.
 *
 * The AppImage has no store to tell it about a newer release, so the app
 * asks the project's release feed itself — at most once a day, only on the
 * Linux desktop shell, and only while the user leaves the switch in
 * Help → About on. Nothing is downloaded or installed: a newer version is
 * announced once, with a button that opens the release in the browser.
 *
 * The cache lives in localStorage under its own key rather than in settings
 * so it is never exported with them. Everything that can be reasoned about
 * without a network is a pure function here, so it can be exercised alone.
 */

import { get } from 'svelte/store';
import { getBuildInfo } from '$lib/build-info.js';
import { settings } from '$lib/settings/settings.js';
import { pushToast } from '$lib/stores/toasts.js';
import { openExternal } from '$lib/util/external-links.js';
import { desktopLog } from '$lib/util/perf.js';
import { isLinuxDesktop } from '$lib/util/platform.js';

export const RELEASES_API_URL = 'https://api.github.com/repos/fumetodev/FumetoReaderPlus/releases/latest';
export const UPDATE_CHECK_STORAGE_KEY = 'fumeto-update-check-v1';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** The Linux asset; anything else on the release is not what this build should offer. */
const LINUX_ASSET_NAME = /^fumeto-\d+\.\d+\.\d+-x86_64\.AppImage$/u;

export interface LatestRelease {
	/** Plain `major.minor.patch`. */
	version: string;
	/** The release page. */
	releaseUrl: string;
	/** Direct download of the Linux asset, when the release carries one. */
	assetUrl: string | null;
}

export interface UpdateCheckCache {
	/** Epoch ms of the last attempt, successful or not. */
	checkedAt: number;
	latestVersion: string | null;
	releaseUrl: string | null;
	assetUrl: string | null;
	/** The version the toast was last shown for; it is shown once per version. */
	dismissedVersion: string | null;
}

export type UpdateCheckOutcome =
	| { status: 'skipped'; reason: 'not-linux-desktop' | 'disabled' | 'not-due' }
	| { status: 'failed'; detail: string }
	| { status: 'current'; latest: LatestRelease }
	| { status: 'update'; latest: LatestRelease };

/** `v0.8.0-vc8000` → `0.8.0`; null when there is no `major.minor.patch` to find. */
export function normalizeVersion(tag: string): string | null {
	const match = /^\s*v?(\d+\.\d+\.\d+)/u.exec(tag);
	return match ? match[1] : null;
}

/**
 * Reads the release feed's "latest" document. Only the fields used are
 * looked at, and a payload missing any of them is rejected rather than
 * half-read.
 */
export function parseLatestRelease(json: unknown): LatestRelease | null {
	if (!json || typeof json !== 'object') return null;
	const release = json as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
	if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') return null;
	const version = normalizeVersion(release.tag_name);
	if (!version) return null;
	let assetUrl: string | null = null;
	if (Array.isArray(release.assets)) {
		for (const asset of release.assets as { name?: unknown; browser_download_url?: unknown }[]) {
			if (
				typeof asset?.name === 'string'
				&& typeof asset.browser_download_url === 'string'
				&& LINUX_ASSET_NAME.test(asset.name)
			) {
				assetUrl = asset.browser_download_url;
				break;
			}
		}
	}
	return { version, releaseUrl: release.html_url, assetUrl };
}

/** Numeric comparison of two versions (tags accepted); an unparseable side counts as 0.0.0. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	const parse = (value: string) => (normalizeVersion(value) ?? '0.0.0').split('.').map(Number);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < 3; i += 1) {
		if (left[i] > right[i]) return 1;
		if (left[i] < right[i]) return -1;
	}
	return 0;
}

/** Due when never checked, when the interval has passed, or when the clock has gone backwards. */
export function isDue(cache: UpdateCheckCache | null, now: number, intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
	if (!cache || !Number.isFinite(cache.checkedAt)) return true;
	return cache.checkedAt > now || now - cache.checkedAt >= intervalMs;
}

function emptyCache(): UpdateCheckCache {
	return { checkedAt: 0, latestVersion: null, releaseUrl: null, assetUrl: null, dismissedVersion: null };
}

export function readUpdateCheckCache(): UpdateCheckCache | null {
	try {
		const raw = localStorage.getItem(UPDATE_CHECK_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<UpdateCheckCache> | null;
		if (!parsed || typeof parsed !== 'object') return null;
		return {
			checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
			latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : null,
			releaseUrl: typeof parsed.releaseUrl === 'string' ? parsed.releaseUrl : null,
			assetUrl: typeof parsed.assetUrl === 'string' ? parsed.assetUrl : null,
			dismissedVersion: typeof parsed.dismissedVersion === 'string' ? parsed.dismissedVersion : null
		};
	} catch {
		return null;
	}
}

export function writeUpdateCheckCache(cache: UpdateCheckCache): void {
	try {
		localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, JSON.stringify(cache));
	} catch {
		// No storage means the check simply runs again next launch.
	}
}

/** Marks a version as announced so the toast is not shown for it again. */
export function rememberAnnouncedVersion(version: string): void {
	writeUpdateCheckCache({ ...(readUpdateCheckCache() ?? emptyCache()), dismissedVersion: version });
}

/** The endpoint, or a page-level override used when testing against a mock feed. */
export function releasesApiUrl(): string {
	const override = (globalThis as { __fumeto_releases_api?: unknown }).__fumeto_releases_api;
	return typeof override === 'string' && override.length > 0 ? override : RELEASES_API_URL;
}

/** What the Help → About footer can say from the cache alone, before any request. */
export function cachedUpdateState(currentVersion: string): { status: 'update' | 'current'; latest: LatestRelease } | null {
	const cache = readUpdateCheckCache();
	if (!cache?.latestVersion || !cache.releaseUrl) return null;
	const latest = { version: cache.latestVersion, releaseUrl: cache.releaseUrl, assetUrl: cache.assetUrl };
	return { status: compareSemver(latest.version, currentVersion) > 0 ? 'update' : 'current', latest };
}

/**
 * Asks the release feed. The automatic path (the default) honours the
 * setting and the daily interval; `manual` (the button in Help → About)
 * ignores both. Never throws: a failed request is an outcome.
 */
export async function checkForDesktopUpdate(options: { manual?: boolean } = {}): Promise<UpdateCheckOutcome> {
	if (!isLinuxDesktop) return { status: 'skipped', reason: 'not-linux-desktop' };
	const cache = readUpdateCheckCache();
	if (!options.manual) {
		if (get(settings).desktopUpdateCheck === false) return { status: 'skipped', reason: 'disabled' };
		if (!isDue(cache, Date.now())) return { status: 'skipped', reason: 'not-due' };
	}
	const current = getBuildInfo().version;
	const startedAt = performance.now();
	let latest: LatestRelease;
	try {
		const { fetch } = await import('@tauri-apps/plugin-http');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(releasesApiUrl(), {
				method: 'GET',
				headers: { Accept: 'application/vnd.github+json' },
				signal: controller.signal,
				connectTimeout: REQUEST_TIMEOUT_MS
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const parsed = parseLatestRelease(await response.json());
			if (!parsed) throw new Error('unrecognised release payload');
			latest = parsed;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		writeUpdateCheckCache({ ...(cache ?? emptyCache()), checkedAt: Date.now() });
		desktopLog(`[update] check failed manual=${options.manual === true} detail=${detail}`);
		return { status: 'failed', detail };
	}
	writeUpdateCheckCache({
		checkedAt: Date.now(),
		latestVersion: latest.version,
		releaseUrl: latest.releaseUrl,
		assetUrl: latest.assetUrl,
		dismissedVersion: cache?.dismissedVersion ?? null
	});
	const newer = compareSemver(latest.version, current) > 0;
	desktopLog(
		`[update] check result=${newer ? 'update' : 'current'} latest=${latest.version} current=${current}`
			+ ` manual=${options.manual === true} ms=${Math.round(performance.now() - startedAt)}`
	);
	return newer ? { status: 'update', latest } : { status: 'current', latest };
}

/**
 * The startup path: run the automatic check and, if a newer release has
 * not been announced yet, show it once as a toast whose action opens the
 * download. Marked as announced when shown, so a launch tomorrow that
 * finds the same version stays quiet.
 */
export async function announceDesktopUpdateIfAvailable(): Promise<void> {
	const outcome = await checkForDesktopUpdate();
	if (outcome.status !== 'update') return;
	const { latest } = outcome;
	if (readUpdateCheckCache()?.dismissedVersion === latest.version) return;
	rememberAnnouncedVersion(latest.version);
	desktopLog(`[update] announce version=${latest.version}`);
	pushToast({
		message: { code: 'shell_update_available', params: { version: latest.version } },
		action: {
			label: { code: 'shell_update_download' },
			run: () => {
				void openExternal(latest.assetUrl ?? latest.releaseUrl);
			}
		}
	});
}

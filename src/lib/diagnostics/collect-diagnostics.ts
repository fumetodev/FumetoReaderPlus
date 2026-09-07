/**
 * Gathers the live values the pure report builder needs.
 *
 * Every probe is individually guarded. This runs on the recovery screen after
 * the app has already faulted, so any single reading may be broken — a report
 * that throws while being assembled is worth nothing to anyone.
 */

import { getBuildInfo } from '$lib/build-info.js';
import { desktopSystemInfo } from '$lib/device/desktop-system-info.js';
import { isAndroid, isTauriHost } from '$lib/util/platform.js';
import { getCapturedErrors } from './error-ring.js';
import {
	buildDiagnosticReport,
	makeReportId,
	parseAndroidVersion,
	parseWebKitVersion,
	parseWebViewVersion,
	type DiagnosticDevice,
	type DiagnosticJobSummary
} from './diagnostic-report.js';

/**
 * Named so the report says which capability was missing, not just "a bridge".
 * On the desktop the llama path is a Rust command rather than a window
 * object, so "a Tauri host that is not Android" is the probe there — kept
 * inline on purpose: importing the translation module into the recovery
 * screen would drag in exactly the code that may have faulted.
 */
const BRIDGE_PROBES: Record<string, (target: Record<string, unknown>) => boolean> = {
	android: (target) => typeof target.__fumeto_android === 'object' && target.__fumeto_android !== null,
	'rtmdet-native': (target) =>
		(target.__fumeto_rtmdet_native as { isAvailable?: () => boolean } | undefined)?.isAvailable?.() === true,
	'ppocr-native': (target) => typeof target.__fumeto_ppocr_native === 'object' && target.__fumeto_ppocr_native !== null,
	llama: (target) =>
		(typeof target.__fumeto_llama === 'object' && target.__fumeto_llama !== null) || (isTauriHost && !isAndroid)
};

/** The host, as far as the page can tell: Android by UA, the desktop shell by its system-info command. */
function describeHost(userAgent: string): Pick<DiagnosticDevice, 'platform' | 'totalMemoryBytes' | 'availableMemoryBytes' | 'appImage'> {
	const android = parseAndroidVersion(userAgent);
	if (android) return { platform: `Android ${android}` };
	if (!isTauriHost) return {};
	try {
		const info = desktopSystemInfo();
		if (!info) return { platform: 'desktop' };
		return {
			platform: `${info.os} ${info.arch} desktop`,
			totalMemoryBytes: info.totalMemoryBytes,
			availableMemoryBytes: info.availableMemoryBytes,
			appImage: info.appImagePath !== null
		};
	} catch {
		return { platform: 'desktop' };
	}
}

function probeBridges(): Record<string, boolean | null> {
	const target = globalThis as unknown as Record<string, unknown>;
	const result: Record<string, boolean | null> = {};
	for (const [name, probe] of Object.entries(BRIDGE_PROBES)) {
		try {
			result[name] = probe(target);
		} catch {
			// A bridge that throws on probe is itself a finding worth reporting.
			result[name] = null;
		}
	}
	return result;
}

/**
 * The most recent translation job, reduced to counts and categories.
 * Deliberately loads the db lazily: on the recovery screen the module graph may
 * be exactly what broke.
 */
async function lastJobSummary(): Promise<DiagnosticJobSummary | null> {
	try {
		const { db } = await import('$lib/db/index.js');
		const jobs = await db.volume_translation_jobs.toArray();
		if (jobs.length === 0) return null;
		const latest = jobs.reduce((newest, job) =>
			(job.updated_at ?? job.started_at ?? '') > (newest.updated_at ?? newest.started_at ?? '') ? job : newest
		);
		return {
			status: String(latest.status),
			failureCategory: latest.diagnostics?.last_error_category,
			attempts: latest.diagnostics?.request_attempts,
			failedPageCount: latest.failed_pages?.length
		};
	} catch {
		return null;
	}
}

export async function collectDiagnosticReport(): Promise<string> {
	const userAgent = (() => {
		try {
			return navigator.userAgent;
		} catch {
			return 'unknown';
		}
	})();

	const screenInfo = (() => {
		try {
			return { width: screen.width, height: screen.height, dpr: window.devicePixelRatio };
		} catch {
			return { width: 0, height: 0, dpr: 0 };
		}
	})();

	const viewport = (() => {
		try {
			return { width: window.innerWidth, height: window.innerHeight };
		} catch {
			return { width: 0, height: 0 };
		}
	})();

	return buildDiagnosticReport({
		reportId: makeReportId(),
		at: new Date().toISOString(),
		build: getBuildInfo(),
		device: {
			userAgent,
			webViewVersion: parseWebViewVersion(userAgent),
			androidVersion: parseAndroidVersion(userAgent),
			webKitVersion: parseWebKitVersion(userAgent),
			...describeHost(userAgent),
			language: (() => {
				try {
					return navigator.language;
				} catch {
					return 'unknown';
				}
			})(),
			screen: screenInfo,
			viewport
		},
		bridges: probeBridges(),
		errors: getCapturedErrors(),
		lastJob: await lastJobSummary()
	});
}

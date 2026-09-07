/**
 * The paste-ready diagnostic report.
 *
 * A tester can say "translation didn't work". They cannot say which build they
 * ran, whether the native bridges resolved, or what the fault actually was —
 * and no external feedback dashboard can capture those, because until now the
 * app never recorded them.
 *
 * **Privacy is enforced by the input type, not by discipline.** There is no
 * field here for comic titles, filenames, folder paths, library names, page
 * images, OCR text, translated dialogue, API keys, or server URLs, so a caller
 * cannot pass them even by accident. The one residual channel is an error
 * message that happens to quote a title; that is why the UI shows the report
 * before it is copied rather than sending it silently.
 */

import type { BuildInfo } from '$lib/build-info.js';
import { formatBuildLine } from '$lib/build-info.js';
import type { CapturedError } from './error-ring.js';

export interface DiagnosticDevice {
	userAgent: string;
	/** Parsed out of the UA when present — the WebView build is the thing that varies. */
	webViewVersion?: string;
	androidVersion?: string;
	/** The WebKit build, which is what varies on the desktop (WebKitGTK). */
	webKitVersion?: string;
	/** `Android 14`, `linux x86_64 desktop`; only when the host is known. */
	platform?: string;
	/** Bytes, from the desktop shell; absent where the page cannot know. */
	totalMemoryBytes?: number | null;
	availableMemoryBytes?: number | null;
	/** Whether the desktop build runs from an AppImage — the fact, never the path. */
	appImage?: boolean;
	language: string;
	screen: { width: number; height: number; dpr: number };
	viewport: { width: number; height: number };
}

/** Counts and categories only — never a title, filename, or any page content. */
export interface DiagnosticJobSummary {
	status: string;
	failureCategory?: string;
	attempts?: number;
	failedPageCount?: number;
}

export interface DiagnosticInput {
	reportId: string;
	at: string;
	build: BuildInfo;
	device: DiagnosticDevice;
	/** Bridge name → resolved. `null` means the probe itself failed. */
	bridges: Record<string, boolean | null>;
	errors: readonly CapturedError[];
	lastJob?: DiagnosticJobSummary | null;
}

/** `Chrome/139.0.7258.62` is the WebView build; everything else in the UA is noise. */
export function parseWebViewVersion(userAgent: string): string | undefined {
	return /Chrome\/([\d.]+)/u.exec(userAgent)?.[1];
}

export function parseAndroidVersion(userAgent: string): string | undefined {
	return /Android\s+([\d.]+)/u.exec(userAgent)?.[1];
}

/** `AppleWebKit/605.1.15` — on the desktop the WebKitGTK build behind the page. */
export function parseWebKitVersion(userAgent: string): string | undefined {
	return /AppleWebKit\/([\d.]+)/u.exec(userAgent)?.[1];
}

/** One line naming the engine: an Android WebView is a Chrome build, a desktop shell a WebKit one. */
export function describeWebView(device: Pick<DiagnosticDevice, 'webViewVersion' | 'webKitVersion' | 'platform'>): string {
	if (device.webViewVersion) return `Chrome/${device.webViewVersion}`;
	if (device.webKitVersion) {
		const desktop = device.platform?.endsWith('desktop');
		return `${desktop ? 'WebKitGTK ' : ''}AppleWebKit/${device.webKitVersion}`;
	}
	return 'unknown';
}

function formatGiB(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Short, human-typeable, and unique enough to match a report to a conversation. */
export function makeReportId(random: () => number = Math.random): string {
	return `r-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function bridgeSummary(bridges: Record<string, boolean | null>): string {
	const names = Object.keys(bridges).sort();
	if (names.length === 0) return 'none probed';
	return names
		.map((name) => `${name}=${bridges[name] === null ? 'probe-failed' : bridges[name] ? 'yes' : 'no'}`)
		.join(' ');
}

export function buildDiagnosticReport(input: DiagnosticInput): string {
	const { device } = input;
	const lines: string[] = [
		'FumetoReaderPlus diagnostic report',
		`id:       ${input.reportId}`,
		`at:       ${input.at}`,
		`build:    ${formatBuildLine(input.build)}`,
		`platform: ${device.platform ?? (device.androidVersion ? `Android ${device.androidVersion}` : 'unknown')}`,
		`webview:  ${describeWebView(device)}`,
		`screen:   ${device.screen.width}x${device.screen.height} @${device.screen.dpr}`
			+ ` · viewport ${device.viewport.width}x${device.viewport.height}`,
		`locale:   ${device.language}`,
		`bridges:  ${bridgeSummary(input.bridges)}`
	];

	if (typeof device.totalMemoryBytes === 'number') {
		const parts = [`${formatGiB(device.totalMemoryBytes)} total`];
		if (typeof device.availableMemoryBytes === 'number') parts.push(`${formatGiB(device.availableMemoryBytes)} available`);
		lines.push(`memory:   ${parts.join(' · ')}`);
	}
	if (device.appImage !== undefined) {
		lines.push(`appimage: ${device.appImage ? 'yes' : 'no'}`);
	}

	if (input.lastJob) {
		const job = input.lastJob;
		const parts = [job.status];
		if (job.failureCategory) parts.push(`category=${job.failureCategory}`);
		if (job.attempts !== undefined) parts.push(`attempts=${job.attempts}`);
		if (job.failedPageCount !== undefined) parts.push(`failedPages=${job.failedPageCount}`);
		lines.push(`job:      ${parts.join(' · ')}`);
	}

	lines.push('', `ua:       ${device.userAgent}`, '');

	if (input.errors.length === 0) {
		lines.push('errors:   none captured');
	} else {
		lines.push(`errors (${input.errors.length}):`);
		input.errors.forEach((error, index) => {
			lines.push(`[${index + 1}] ${error.at} ${error.kind}`);
			lines.push(`    ${error.message}`);
			if (error.source) lines.push(`    at ${error.source}`);
			if (error.stack) {
				for (const frame of error.stack.split('\n').slice(0, 12)) {
					lines.push(`    ${frame.trim()}`);
				}
			}
		});
	}

	return lines.join('\n');
}

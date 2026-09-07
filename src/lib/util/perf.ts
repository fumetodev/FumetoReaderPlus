/**
 * Desktop-only timing and decision lines.
 *
 * The desktop shell forwards these to its process log (stderr, or a log file
 * when FUMETO_LOG names a level), where a terminal or a bug report can read
 * them. Every call is a no-op in a browser and on Android, which keeps its
 * own debug buffer. Lines are grep-friendly on purpose:
 *   [perf] <stage> <ms>ms key=value …
 */

import { isDesktopTauri } from './platform.js';

type Extra = Record<string, string | number | boolean | undefined>;

function formatExtra(extra?: Extra): string {
	if (!extra) return '';
	return Object.entries(extra)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` ${k}=${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
		.join('');
}

/** Sends one line to the desktop process log; swallowed when the command is absent. */
export function desktopLog(line: string): void {
	if (!isDesktopTauri) return;
	void import('@tauri-apps/api/core')
		.then(({ invoke }) => invoke('perf_log', { line }))
		.catch(() => {
			// Older desktop binaries without the command: the line is simply lost.
		});
}

/** Records one timed stage, e.g. perfMark('ocr.detect', 812, { page: 3 }). */
export function perfMark(stage: string, ms: number, extra?: Extra): void {
	if (!isDesktopTauri) return;
	desktopLog(`[perf] ${stage} ${Math.round(ms)}ms${formatExtra(extra)}`);
}

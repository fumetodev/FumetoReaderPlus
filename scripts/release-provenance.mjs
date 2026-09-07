/**
 * Provenance facts recorded beside every collected release artifact, shared by
 * the Android and Linux collectors: the commit a build came from and whether
 * the worktree was clean, what the build environment said about the debug
 * fixture flag, and which UI locales ship. Pure reads — nothing here touches
 * the artifact itself.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The trimmed output of one git command run at `root`, or '' when git or the checkout is absent. */
export function gitValue(root, arguments_) {
	try {
		return execFileSync('git', arguments_, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

/**
 * The fixture flag is a build-time env var, and the frontend it controls is
 * embedded inside the app binary rather than shipped as a loose asset, so it
 * cannot be read back out of the artifact cheaply. Report what the environment
 * said and label it as such — the release scripts pin the var to '0' for the
 * builds that matter, and the About line inside the app is the runtime proof.
 */
export function readFixtureClaim() {
	const value = process.env.VITE_FUMETO_DEBUG_UI_FIXTURES;
	if (value === undefined) return { fixtures: null, fixturesSource: 'unknown' };
	return { fixtures: value === '1', fixturesSource: 'build-env' };
}

/** The UI locales this build ships (en + the drafted ones), with each draft's process status, for the ledger. */
export function uiLocalesOf(root) {
	try {
		const locales = JSON.parse(fs.readFileSync(path.join(root, 'messages/locales.json'), 'utf8')).locales;
		return { en: 'source', ...Object.fromEntries(Object.entries(locales).map(([tag, info]) => [tag, info.status ?? 'machine'])) };
	} catch {
		return { en: 'source' };
	}
}

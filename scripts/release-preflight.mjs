#!/usr/bin/env node
/**
 * Refuses to start a release build that Play would reject or that could not be
 * traced back to a commit.
 *
 * Google permanently retires a versionCode once it has been uploaded. During a
 * 14-day testing cycle with only two or three update slots, burning one on a
 * duplicate is expensive, and the mistake is invisible until Play rejects the
 * upload. These checks are cheap and run before the ~20-minute build.
 *
 * Deliberately not wired into `build:android` — the daily debug loop stays
 * fast and unchecked.
 *
 * Shared by both release ladders (`release:android` and `release:linux`): the
 * version and the tag are the same on both, so every check applies to both.
 *
 *   node scripts/release-preflight.mjs
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
	LEDGER_FILE,
	deriveVersionCode,
	findLedgerConflict,
	findVersionDisagreement,
	readLedger,
	readTauriProperties,
	readVersionSources
} from './release-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');

function git(arguments_, { trimStart = true } = {}) {
	const output = execFileSync('git', arguments_, {
		cwd: root,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// `git status --porcelain` encodes the staged/unstaged distinction in the
	// first two columns, so trimming the front would corrupt the first line.
	return trimStart ? output.trim() : output.trimEnd();
}

const failures = [];
const pass = (message) => console.log(`  ✓ ${message}`);
const fail = (message, remedy) => {
	console.log(`  ✗ ${message}`);
	failures.push({ message, remedy });
};

console.log('Release preflight\n');

// 1 — the three hand-maintained version files must agree.
const sources = readVersionSources(root);
const disagreement = findVersionDisagreement(sources);
if (disagreement) {
	fail(
		`version files disagree: ${disagreement}`,
		'npm run version:set -- <semver>   # writes all three at once'
	);
} else {
	pass(`${sources.map((source) => source.label).join(' / ')} all ${sources[0].version}`);
}

// 2 — the versionCode this build will carry must be new to Play.
const versionName = sources[0].version;
let versionCode = null;
try {
	versionCode = deriveVersionCode(versionName);
} catch (error) {
	fail(error.message, 'Choose a version whose minor and patch are each below 1000');
}

if (versionCode !== null) {
	const ledger = readLedger(root);
	const conflict = findLedgerConflict(ledger, versionCode);
	if (conflict) {
		fail(
			conflict.reason,
			`npm run version:set -- <semver above ${versionName}>   # then re-run`
		);
	} else if (ledger.length === 0) {
		pass(`versionCode ${versionCode} (${LEDGER_FILE} is empty — nothing uploaded yet)`);
	} else {
		const highest = Math.max(...ledger.map((entry) => entry.versionCode));
		pass(`versionCode ${versionCode} is above the highest recorded upload (${highest})`);
	}
}

// 3 — the artifact must be traceable to a commit.
let commit = null;
try {
	commit = git(['rev-parse', 'HEAD']);
	const status = git(['status', '--porcelain=v1', '--untracked-files=all'], { trimStart: false });
	if (status === '') {
		pass(`clean worktree at ${commit.slice(0, 7)}`);
	} else {
		const lines = status.split('\n');
		const preview = lines.slice(0, 5).map((line) => `      ${line}`).join('\n');
		fail(
			`worktree has ${lines.length} uncommitted change(s)`,
			`commit or stash them so the artifact is traceable:\n${preview}`
				+ (lines.length > 5 ? `\n      … and ${lines.length - 5} more` : '')
		);
	}
} catch {
	fail('not a git checkout, so this build could not be traced to a commit', 'run release builds from a git clone');
}

// Informational: Tauri regenerates tauri.properties during the build, so a
// stale value here is expected and is not a failure — but a surprise is worth
// naming before a 20-minute build rather than after it.
const properties = readTauriProperties(root);
if (properties && versionCode !== null && properties.versionCode !== versionCode) {
	console.log(
		`  · tauri.properties still says ${properties.versionName} (vc${properties.versionCode});`
		+ ' the build will regenerate it'
	);
}

// The version/ledger/worktree checks above say the build is TRACEABLE. Nothing
// said it WORKS: preflight ran no tests and no typecheck, and the release
// scripts run none either, so the whole ladder could ship a red suite — or a
// locale whose draft is behind its English source, which the draft check
// refuses unless the staleness is acknowledged. These are seconds against a
// ~20-minute build, and they are the difference between an artifact that is
// merely traceable and one that is known to be good.

for (const [label, script] of [['i18n drafts', 'i18n:draft:check'], ['typecheck', 'check']]) {
	try {
		execFileSync('npm', ['run', script], { cwd: root, stdio: 'pipe' });
		pass(`${label} green`);
	} catch (error) {
		const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
		const tail = output.split('\n').filter(Boolean).slice(-3).join(' / ');
		fail(`${label} failed`, `run \`npm run ${script}\` and fix it${tail ? ` — ${tail}` : ''}`);
	}
}

console.log('');
if (failures.length > 0) {
	console.error(`Preflight failed (${failures.length} problem${failures.length === 1 ? '' : 's'}):\n`);
	for (const { message, remedy } of failures) console.error(`  ${message}\n    ${remedy}\n`);
	process.exit(1);
}

console.log(`Ready: ${versionName} (versionCode ${versionCode}) at ${commit?.slice(0, 7) ?? 'unknown'}`);

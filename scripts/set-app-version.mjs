#!/usr/bin/env node
/**
 * Writes the app version to all three files that carry it, so they cannot
 * drift. They did once already (review B7), and a drift means the version in
 * Settings disagrees with the versionName Play sees.
 *
 *   npm run version:set -- 0.2.1
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	VERSION_SOURCES,
	deriveVersionCode,
	parseCargoVersion,
	parseSemver,
	withCargoLockVersion
} from './release-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');
const requested = process.argv[2];

if (!requested || requested.startsWith('-')) {
	console.error('usage: npm run version:set -- <MAJOR.MINOR.PATCH>');
	process.exit(1);
}

try {
	parseSemver(requested, 'Requested version');
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

const versionCode = deriveVersionCode(requested);

for (const { label, file } of VERSION_SOURCES) {
	const resolved = path.join(root, file);
	const before = fs.readFileSync(resolved, 'utf-8');
	let after;

	if (file.endsWith('.toml')) {
		const current = parseCargoVersion(before);
		// Anchored to the exact current value so only the [package] version is
		// touched — dependency version pins elsewhere in the file are left alone.
		after = before.replace(
			new RegExp(`^(\\s*version\\s*=\\s*)"${current.replace(/\./gu, '\\.')}"`, 'mu'),
			`$1"${requested}"`
		);
	} else {
		// Textual replacement rather than JSON.stringify, to preserve the file's
		// existing key order, indentation, and trailing newline exactly.
		const current = JSON.parse(before).version;
		after = before.replace(
			new RegExp(`("version"\\s*:\\s*)"${current.replace(/\./gu, '\\.')}"`, 'u'),
			`$1"${requested}"`
		);
	}

	if (after === before) {
		console.log(`  = ${label} already ${requested}`);
		continue;
	}
	fs.writeFileSync(resolved, after);
	console.log(`  ✓ ${label} → ${requested}`);
}

// Keeps the lockfile from being rewritten by the build's first cargo call,
// which would land after the version commit and dirty the artifact.
const lockFile = path.join(root, 'src-tauri/Cargo.lock');
try {
	const before = fs.readFileSync(lockFile, 'utf-8');
	const after = withCargoLockVersion(before, requested);
	if (after !== before) {
		fs.writeFileSync(lockFile, after);
		console.log(`  ✓ Cargo.lock → ${requested}`);
	}
} catch (error) {
	// A missing or unexpected lockfile is not worth failing a version bump over;
	// the build regenerates it, at the cost of one dirty artifact.
	console.warn(`  ! Cargo.lock not updated (${error.message})`);
}

console.log(`\nVersion set to ${requested}; this build will carry versionCode ${versionCode}.`);
console.log('Commit these before a release build — the preflight requires a clean worktree.');
console.log("Then update What's New in the Help tab (HelpTab.svelte, whats-new section) and run `npm run i18n:draft` —");
console.log('the preflight blocks a release whose drafted locales are behind the English text.');

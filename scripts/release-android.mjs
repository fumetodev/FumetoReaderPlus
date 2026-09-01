#!/usr/bin/env node
/**
 * The release build: preflight, build, collect.
 *
 *   npm run release:android                          # default targets, APK
 *   npm run release:android -- --target aarch64      # one ABI
 *   npm run release:android -- --aab                 # bundle for Play
 *
 * Extra arguments are forwarded verbatim to `tauri android build`, which is
 * why this is a script rather than an npm script chain: npm appends `--` args
 * to the last command in a chain, not the middle one.
 *
 * The fixture flag is pinned off here. A release build that silently carried
 * the debug UI fixture host would be indistinguishable from a clean one by
 * size or filename — the failure this whole change exists to prevent.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const forwarded = process.argv.slice(2);
const wantsBundle = forwarded.includes('--aab');

function step(label, executable, arguments_, extraEnvironment = {}) {
	console.log(`\n=== ${label} ===`);
	const result = spawnSync(executable, arguments_, {
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, ...extraEnvironment }
	});
	if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`${label} failed with exit code ${result.status ?? 'signal ' + result.signal}`);
	}
}

// A release artifact must never carry the debug fixture host. Pinned rather
// than merely unset, so an exported shell variable cannot leak into the build.
// Both flags fold dead branches out of the bundle: the debug fixture host and
// the layout gate's pseudolocale (en-XA). audit-overlay-release.mjs proves it.
const releaseEnvironment = { VITE_FUMETO_DEBUG_UI_FIXTURES: '0', VITE_FUMETO_PSEUDOLOCALE: '0' };

try {
	step('Preflight', process.execPath, [path.join(root, 'scripts/release-preflight.mjs')]);
	step(
		'Build',
		'npm',
		['exec', '--', 'tauri', 'android', 'build', ...(wantsBundle ? [] : ['--apk']), ...forwarded],
		releaseEnvironment
	);
	step(
		'Collect',
		process.execPath,
		[path.join(root, 'scripts/collect-android-artifact.mjs')],
		releaseEnvironment
	);
	console.log('\nRelease build complete.');
} catch (error) {
	console.error(`\nrelease:android: ${error.message}`);
	process.exit(1);
}

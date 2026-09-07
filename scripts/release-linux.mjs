#!/usr/bin/env node
/**
 * The Linux release build: preflight, build, audit, collect.
 *
 *   npm run release:linux                      # x86_64 AppImage into dist/linux/
 *   npm run release:linux -- --verbose         # extra arguments reach `tauri build`
 *
 * Extra arguments are forwarded verbatim to `tauri build`, which is why this is
 * a script rather than an npm script chain: npm appends `--` args to the last
 * command in a chain, not the middle one.
 *
 * A build from this ladder is a smoke artifact, not the one that ships. An
 * AppImage inherits the glibc and WebKitGTK of the machine that bundled it, and
 * only the CI job, which bundles inside an Ubuntu 22.04 container, meets the
 * release's compatibility floor. The collector records the build host's glibc
 * in the sidecar so the two cannot be confused.
 *
 * The fixture flag is pinned off here, as in the Android ladder: a release
 * build that silently carried the debug UI fixture host would be
 * indistinguishable from a clean one by size or filename.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const forwarded = process.argv.slice(2);

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

/**
 * The bundler fetches linuxdeploy's GTK plugin script from its upstream branch
 * head whenever its cache lacks one, so a build would otherwise depend on
 * whatever that file says on the day. The tree vendors a reviewed copy, with
 * the display-backend line patched so a user's own GDK_BACKEND is honoured;
 * placing it in the cache before the build is what pins the build to it.
 */
function installVendoredGtkHook() {
	console.log('\n=== GTK hook ===');
	const source = path.join(root, 'src-tauri/linuxdeploy/linuxdeploy-plugin-gtk.sh');
	if (!fs.existsSync(source)) {
		console.warn(`  ! ${path.relative(root, source)} is not in the tree; the bundler will download the upstream script`);
		return;
	}
	// The bundler resolves its cache through the XDG cache directory, so an
	// override has to be honoured here too or the copy lands where nothing looks.
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	const cacheHome = xdgCacheHome && path.isAbsolute(xdgCacheHome) ? xdgCacheHome : path.join(os.homedir(), '.cache');
	const destination = path.join(cacheHome, 'tauri', 'linuxdeploy-plugin-gtk.sh');
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	fs.chmodSync(destination, 0o755);
	console.log(`  -> ${destination}`);
}

try {
	step('Preflight', process.execPath, [path.join(root, 'scripts/release-preflight.mjs')]);
	installVendoredGtkHook();
	step(
		'Build',
		'npm',
		['exec', '--', 'tauri', 'build', '--bundles', 'appimage', ...forwarded],
		releaseEnvironment
	);
	// The web half of the audit: the embedded build/ must carry no development-only marker.
	step('Audit', process.execPath, [path.join(root, 'scripts/audit-overlay-release.mjs')]);
	step(
		'Collect',
		process.execPath,
		[path.join(root, 'scripts/collect-linux-artifact.mjs')],
		releaseEnvironment
	);
	console.log('\nRelease build complete.');
} catch (error) {
	console.error(`\nrelease:linux: ${error.message}`);
	process.exit(1);
}

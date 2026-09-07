#!/usr/bin/env node
/**
 * Copies a freshly built AppImage out of the bundler's output tree into
 * `dist/linux/` under the release name, and writes a checksum file and a
 * sidecar manifest beside it.
 *
 * Why this exists: the bundler names its output after the product and the
 * version it read from the config, so a stale build left in the output tree
 * looks exactly like a fresh one. The collector cross-checks that version
 * against package.json, hashes what it copies, and records where the build
 * came from — the same provenance the Android collector writes — so the file
 * a release carries can be traced back to a commit.
 *
 * The checksum file uses the `sha256sum` layout, so a downloader verifies with
 * `sha256sum -c fumeto-<version>-x86_64.AppImage.sha256`.
 *
 * Copy, never rename in place: the source lives inside Cargo's `target/` tree.
 *
 *   node scripts/collect-linux-artifact.mjs [--artifact <path>] [--force]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './ppocr-candidate-artifact.mjs';
import { gitValue, readFixtureClaim, uiLocalesOf } from './release-provenance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const bundleRoot = path.join(root, 'src-tauri/target/release/bundle/appimage');
const destinationRoot = path.join(root, 'dist/linux');

const USAGE = 'node scripts/collect-linux-artifact.mjs [--artifact <path>] [--force]';
const ARCH = 'x86_64';
/** The oldest glibc a released AppImage supports: the CI job bundles inside Ubuntu 22.04. */
const GLIBC_FLOOR = '2.35';

/** The bundler's own naming: `<productName>_<version>_<Debian arch>.AppImage`. */
const BUNDLER_NAME = /^FumetoReaderPlus_(\d+\.\d+\.\d+)_amd64\.AppImage$/u;
/** The release name, accepted so an already-renamed file can be re-collected through --artifact. */
const RELEASE_NAME = /^fumeto-(\d+\.\d+\.\d+)-x86_64\.AppImage$/u;

function parseArguments(argv) {
	const options = { artifact: null, force: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') options.help = true;
		else if (argument === '--force') options.force = true;
		else if (argument === '--artifact') {
			options.artifact = argv[index + 1];
			index += 1;
			if (!options.artifact || options.artifact.startsWith('--')) {
				throw new Error('--artifact requires a path');
			}
		} else throw new Error(`Unknown argument ${argument}\n  Usage: ${USAGE}`);
	}
	return options;
}

/** Every AppImage the bundler left behind, newest first. */
function discoverArtifacts() {
	if (!fs.existsSync(bundleRoot)) return [];
	return fs.readdirSync(bundleRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.AppImage'))
		.map((entry) => {
			const file = path.join(bundleRoot, entry.name);
			return { file, mtimeMs: fs.statSync(file).mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The version the bundler stamped into the filename. A file named any other
 * way carries no version claim that could be checked, so it is refused rather
 * than collected under whatever package.json happens to say.
 */
function versionFromFileName(name) {
	const match = BUNDLER_NAME.exec(name) ?? RELEASE_NAME.exec(name);
	if (!match) {
		throw new Error(
			`${name} does not follow the bundler's naming (FumetoReaderPlus_<version>_amd64.AppImage), `
			+ 'so its version cannot be checked'
		);
	}
	return match[1];
}

function packageVersion() {
	return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;
}

/**
 * The glibc this machine bundled against, from the first line of
 * `ldd --version` (e.g. `ldd (GNU libc) 2.44` → `2.44`). The line itself is
 * kept when it carries no version; null when there is no ldd to ask.
 */
function buildHostGlibc() {
	try {
		const output = execFileSync('ldd', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
		const firstLine = output.split('\n')[0].trim();
		return /(\d+\.\d+)\s*$/u.exec(firstLine)?.[1] ?? (firstLine || null);
	} catch {
		return null;
	}
}

function compareVersions(a, b) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

function collect(sourceFile, options) {
	const resolved = path.resolve(sourceFile);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`Not a file: ${resolved}`);
	}
	console.log(`\n${path.relative(root, resolved)}`);

	const versionName = versionFromFileName(path.basename(resolved));
	const expected = packageVersion();
	if (versionName !== expected) {
		throw new Error(
			`${path.basename(resolved)} was built as ${versionName} but package.json says ${expected}.\n`
			+ '  The bundle is stale or the version moved after the build — rebuild with\n'
			+ '  `npm run tauri:linux-build`.'
		);
	}

	const name = `fumeto-${versionName}-${ARCH}.AppImage`;
	const destination = path.join(destinationRoot, name);
	const digest = sha256File(resolved);
	if (fs.existsSync(destination)) {
		const existing = sha256File(destination);
		if (existing === digest) {
			console.log(`  = dist/linux/${name} (identical, nothing to do)`);
			return { name, skipped: true };
		}
		if (!options.force) {
			throw new Error(
				`dist/linux/${name} already exists with different contents `
				+ `(${existing.slice(0, 12)} vs ${digest.slice(0, 12)}).\n`
				+ '  Two different builds are claiming the same version. Bump the version with\n'
				+ '  `npm run version:set -- <semver>`, or pass --force to overwrite.'
			);
		}
		console.warn('  ! overwriting a different artifact at the same name (--force)');
	}

	fs.mkdirSync(destinationRoot, { recursive: true });
	fs.copyFileSync(resolved, destination);
	// An AppImage is executed directly; the mode is set explicitly rather than
	// trusted to survive the copy.
	fs.chmodSync(destination, 0o755);
	// `sha256sum -c` expects `<hex>  <name>`: two spaces, the file's own name, a newline.
	fs.writeFileSync(`${destination}.sha256`, `${digest}  ${name}\n`);

	const commit = gitValue(root, ['rev-parse', 'HEAD']);
	const hostGlibc = buildHostGlibc();
	const manifest = {
		kind: 'fumeto-linux-artifact',
		schemaVersion: 1,
		file: name,
		sha256: digest,
		sizeBytes: fs.statSync(resolved).size,
		arch: ARCH,
		os: 'linux',
		glibcFloor: GLIBC_FLOOR,
		versionName,
		buildType: 'release',
		...readFixtureClaim(),
		commit: commit || null,
		commitDirty: commit ? gitValue(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '' : null,
		bundlerSource: path.relative(root, resolved),
		buildHostGlibc: hostGlibc,
		uiLocales: uiLocalesOf(root)
	};
	fs.writeFileSync(`${destination}.json`, `${JSON.stringify(manifest, null, '\t')}\n`);

	console.log(`  -> dist/linux/${name}`);
	console.log(
		`     ${versionName} · release · ${ARCH} · ${digest.slice(0, 12)} · ${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB`
	);
	if (hostGlibc && compareVersions(hostGlibc, GLIBC_FLOOR) > 0) {
		console.log(
			`     bundled against glibc ${hostGlibc}, above the ${GLIBC_FLOOR} floor — a smoke artifact;`
			+ ' the CI build is the one to release'
		);
	}
	return { name, skipped: false, manifest };
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		console.log(`Usage: ${USAGE}`);
		return;
	}

	let target;
	if (options.artifact) {
		target = options.artifact;
	} else {
		const discovered = discoverArtifacts();
		if (discovered.length === 0) {
			throw new Error(
				`No AppImage found under ${path.relative(root, bundleRoot)} — build one first with \`npm run tauri:linux-build\``
			);
		}
		target = discovered[0].file;
		if (discovered.length > 1) {
			const age = Math.round((Date.now() - discovered[0].mtimeMs) / 60_000);
			console.log(`Newest of ${discovered.length} AppImages (${age} min old). Pass --artifact <path> to pick another.`);
		}
	}

	const result = collect(target, options);
	console.log(`\nCollected dist/linux/${result.name}${result.skipped ? '' : ' with its .sha256 and .json sidecars'}.`);
	if (!result.skipped) console.log(`Verify a copy with: cd dist/linux && sha256sum -c ${result.name}.sha256`);
}

try {
	main();
} catch (error) {
	// These are operator-facing failures with actionable messages; a Node stack
	// trace buries the remedy under noise.
	console.error(`\ncollect-linux-artifact: ${error.message}`);
	process.exit(1);
}

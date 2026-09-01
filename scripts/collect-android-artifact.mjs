#!/usr/bin/env node
/**
 * Copies a freshly built Android artifact out of Gradle's output tree into
 * `dist/android/` under a name that states what it actually is, and writes a
 * sidecar manifest beside it.
 *
 * Why this exists: every release target Gradle builds lands at the same path,
 * `apk/universal/release/app-universal-release.apk`, regardless of `--target`.
 * Building aarch64 and then x86_64 silently replaces the first artifact with
 * the second, and nothing in the filename distinguishes them — verified: that
 * "universal" APK contains only `lib/x86_64/`.
 *
 * Copy, never rename in place: the source lives inside Gradle's `build/` tree,
 * which is cleaned and incrementally managed.
 *
 *   node scripts/collect-android-artifact.mjs [--artifact <path>] [--all] [--force]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { inspectPpocrCandidateArtifact, sha256File } from './ppocr-candidate-artifact.mjs';
import { artifactFileName, detectAbi, readTauriProperties } from './release-metadata.mjs';

/** The UI locales this build ships (en + the drafted ones), with each draft's process status, for the ledger. */
function uiLocalesOf(root) {
	try {
		const locales = JSON.parse(fs.readFileSync(path.join(root, 'messages/locales.json'), 'utf8')).locales;
		return { en: 'source', ...Object.fromEntries(Object.entries(locales).map(([tag, info]) => [tag, info.status ?? 'machine'])) };
	} catch {
		return { en: 'source' };
	}
}

const root = path.resolve(import.meta.dirname, '..');
const outputsRoot = path.join(root, 'src-tauri/gen/android/app/build/outputs');
const destinationRoot = path.join(root, 'dist/android');

function parseArguments(argv) {
	const options = { artifact: null, all: false, force: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--all') options.all = true;
		else if (argument === '--force') options.force = true;
		else if (argument === '--artifact') {
			options.artifact = argv[index + 1];
			index += 1;
			if (!options.artifact || options.artifact.startsWith('--')) {
				throw new Error('--artifact requires a path');
			}
		} else throw new Error(`Unknown argument ${argument}`);
	}
	return options;
}

function discoverArtifacts() {
	const found = [];
	const walk = (directory) => {
		if (!fs.existsSync(directory)) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const resolved = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(resolved);
			else if (/\.(?:apk|aab)$/u.test(entry.name) && !entry.name.includes('androidTest')) {
				found.push({ file: resolved, mtimeMs: fs.statSync(resolved).mtimeMs });
			}
		}
	};
	walk(path.join(outputsRoot, 'apk'));
	walk(path.join(outputsRoot, 'bundle'));
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readArchiveEntryNames(file) {
	// openAsBlob keeps this lazy — zip.js reads only the central directory, so
	// a 250 MB APK is inspected in single-digit milliseconds.
	const zip = new ZipReader(new BlobReader(await fs.openAsBlob(file)));
	try {
		return (await zip.getEntries()).map((entry) => entry.filename);
	} finally {
		await zip.close();
	}
}

/**
 * Prefers the APK's own manifest, which is what Play reads, and falls back to
 * the versions Tauri generated. The fallback is reported rather than hidden:
 * an unverified artifact must not look like a verified one.
 */
function readArtifactIdentity(file) {
	if (path.extname(file).toLowerCase() === '.apk') {
		try {
			const inspected = inspectPpocrCandidateArtifact(file);
			return {
				source: 'apk-manifest',
				packageName: inspected.packageName,
				versionName: inspected.versionName,
				versionCode: inspected.versionCode,
				buildType: inspected.debuggable ? 'debug' : 'release',
				signingCertificateSha256: inspected.signingCertificateSha256
			};
		} catch (error) {
			console.warn(`  ! APK manifest unreadable (${error.message}); falling back to tauri.properties`);
		}
	}
	const properties = readTauriProperties(root);
	if (!properties) throw new Error('Neither the artifact manifest nor tauri.properties could supply a version');
	return {
		source: 'tauri.properties',
		packageName: null,
		versionName: properties.versionName,
		versionCode: properties.versionCode,
		// Not knowable from tauri.properties; the output path is the only hint.
		buildType: /(?:^|[/\\])(?:release|.*Release)[/\\]/u.test(file) ? 'release' : 'debug',
		signingCertificateSha256: null
	};
}

function gitValue(arguments_) {
	try {
		return execFileSync('git', arguments_, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

/**
 * The fixture flag is a build-time env var, and the frontend it controls is
 * embedded inside libapp_lib.so rather than shipped as a loose asset, so it
 * cannot be read back out of the artifact cheaply. Report what the environment
 * said and label it as such — release-android.mjs pins the var to '0' for the
 * builds that matter, and the About line inside the app is the runtime proof.
 */
function readFixtureClaim() {
	const value = process.env.VITE_FUMETO_DEBUG_UI_FIXTURES;
	if (value === undefined) return { fixtures: null, fixturesSource: 'unknown' };
	return { fixtures: value === '1', fixturesSource: 'build-env' };
}

async function collect(sourceFile, options) {
	const resolved = path.resolve(sourceFile);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`Not a file: ${resolved}`);
	}
	console.log(`\n${path.relative(root, resolved)}`);

	const identity = readArtifactIdentity(resolved);
	const abi = detectAbi(await readArchiveEntryNames(resolved));
	const name = artifactFileName({
		versionName: identity.versionName,
		versionCode: identity.versionCode,
		buildType: identity.buildType,
		abi,
		extension: path.extname(resolved).slice(1)
	});

	const destination = path.join(destinationRoot, name);
	const digest = sha256File(resolved);
	if (fs.existsSync(destination)) {
		const existing = sha256File(destination);
		if (existing === digest) {
			console.log(`  = dist/android/${name} (identical, nothing to do)`);
			return { name, skipped: true };
		}
		if (!options.force) {
			throw new Error(
				`dist/android/${name} already exists with different contents `
				+ `(${existing.slice(0, 12)} vs ${digest.slice(0, 12)}).\n`
				+ '  Two different builds are claiming the same version + ABI. Bump the version with\n'
				+ '  `npm run version:set -- <semver>`, or pass --force to overwrite.'
			);
		}
		console.warn('  ! overwriting a different artifact at the same name (--force)');
	}

	fs.mkdirSync(destinationRoot, { recursive: true });
	fs.copyFileSync(resolved, destination);

	const commit = gitValue(['rev-parse', 'HEAD']);
	const manifest = {
		kind: 'fumeto-android-artifact',
		schemaVersion: 1,
		file: name,
		sha256: digest,
		sizeBytes: fs.statSync(resolved).size,
		abi,
		packageName: identity.packageName,
		versionName: identity.versionName,
		versionCode: identity.versionCode,
		buildType: identity.buildType,
		identitySource: identity.source,
		signingCertificateSha256: identity.signingCertificateSha256,
		...readFixtureClaim(),
		commit: commit || null,
		commitDirty: commit ? gitValue(['status', '--porcelain=v1', '--untracked-files=all']) !== '' : null,
		gradleSource: path.relative(root, resolved),
		uiLocales: uiLocalesOf(root)
	};
	fs.writeFileSync(path.join(destinationRoot, `${name}.json`), `${JSON.stringify(manifest, null, '\t')}\n`);

	console.log(`  -> dist/android/${name}`);
	console.log(
		`     ${identity.versionName} (vc${identity.versionCode}) · ${identity.buildType} · ${abi} · ${digest.slice(0, 12)}`
	);
	if (identity.source !== 'apk-manifest') {
		console.log(`     identity from ${identity.source} — signing certificate NOT verified`);
	}
	return { name, skipped: false, manifest };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	let targets;
	if (options.artifact) {
		targets = [options.artifact];
	} else {
		const discovered = discoverArtifacts();
		if (discovered.length === 0) {
			throw new Error(`No .apk or .aab found under ${path.relative(root, outputsRoot)} — build one first`);
		}
		targets = options.all ? discovered.map((entry) => entry.file) : [discovered[0].file];
		if (!options.all && discovered.length > 1) {
			const age = Math.round((Date.now() - discovered[0].mtimeMs) / 60_000);
			console.log(`Newest of ${discovered.length} artifacts (${age} min old). Pass --all to collect every one.`);
		}
	}

	const collected = [];
	for (const target of targets) collected.push(await collect(target, options));
	console.log(`\nCollected ${collected.length} artifact(s) into dist/android/.`);

	const fresh = collected.find((entry) => !entry.skipped);
	if (fresh) {
		console.log('After uploading to Play, record it so the next preflight knows:');
		console.log(`  npm run release:record -- --artifact dist/android/${fresh.name} --track closed-testing`);
	}
}

try {
	await main();
} catch (error) {
	// These are operator-facing failures with actionable messages; a Node stack
	// trace buries the remedy under noise.
	console.error(`\ncollect-android-artifact: ${error.message}`);
	process.exit(1);
}

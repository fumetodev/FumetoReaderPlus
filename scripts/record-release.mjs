#!/usr/bin/env node
/**
 * Appends an uploaded artifact to the release ledger, so the next preflight
 * knows that versionCode is spent.
 *
 * Run this *after* a successful Play upload, not after a build — the ledger
 * records what Google has seen, which is what determines whether the next
 * versionCode is accepted. It doubles as the "what shipped when" record the
 * production-access form asks for.
 *
 *   npm run release:record -- --artifact dist/android/<name>.apk --track closed-testing
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_FILE, readLedger, releaseTagName } from './release-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');
const TRACKS = ['internal', 'closed-testing', 'open-testing', 'production'];

function parseArguments(argv) {
	const options = { artifact: null, track: null, uploadedAt: null };
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
			throw new Error(`Invalid argument ${key ?? '<missing>'}`);
		}
		const name = key.slice(2);
		if (!(name in options)) throw new Error(`Unknown argument ${key}`);
		options[name] = value;
	}
	if (!options.artifact) throw new Error('--artifact <path to the collected artifact> is required');
	if (!options.track) throw new Error(`--track <${TRACKS.join('|')}> is required`);
	if (!TRACKS.includes(options.track)) throw new Error(`--track must be one of ${TRACKS.join(', ')}`);
	if (options.uploadedAt && !/^\d{4}-\d{2}-\d{2}$/u.test(options.uploadedAt)) {
		throw new Error('--uploadedAt must be YYYY-MM-DD');
	}
	return options;
}

function main() {
	const options = parseArguments(process.argv.slice(2));

	// The sidecar is the source of truth: it was written from the artifact
	// itself, so the ledger cannot record a version the artifact does not have.
	const sidecar = path.resolve(root, `${options.artifact}.json`);
	if (!fs.existsSync(sidecar)) {
		throw new Error(
			`No sidecar manifest at ${path.relative(root, sidecar)}.\n`
			+ '  Record artifacts collected by `npm run release:android` / collect-android-artifact.mjs.'
		);
	}
	const manifest = JSON.parse(fs.readFileSync(sidecar, 'utf-8'));

	const ledger = readLedger(root);
	const duplicate = ledger.find((entry) => entry.versionCode === manifest.versionCode);
	if (duplicate) {
		throw new Error(
			`versionCode ${manifest.versionCode} is already in the ledger `
			+ `(uploaded ${duplicate.uploadedAt ?? 'on an unrecorded date'}).`
		);
	}

	const entry = {
		versionName: manifest.versionName,
		versionCode: manifest.versionCode,
		uploadedAt: options.uploadedAt ?? new Date().toISOString().slice(0, 10),
		track: options.track,
		abi: manifest.abi,
		buildType: manifest.buildType,
		commit: manifest.commit ? manifest.commit.slice(0, 7) : null,
		sha256: manifest.sha256,
		...(manifest.uiLocales ? { uiLocales: manifest.uiLocales } : {})
	};
	ledger.push(entry);
	ledger.sort((a, b) => a.versionCode - b.versionCode);
	fs.writeFileSync(path.join(root, LEDGER_FILE), `${JSON.stringify(ledger, null, '\t')}\n`);

	console.log(`Recorded ${entry.versionName} (vc${entry.versionCode}) on ${entry.track}, ${entry.uploadedAt}.`);
	console.log(`${LEDGER_FILE} now holds ${ledger.length} upload(s). Commit it.`);
	if (manifest.buildType !== 'release') {
		console.warn(`\n! This artifact is a ${manifest.buildType} build — Play only accepts release builds.`);
	}
	tagRelease(entry, manifest);
}

/**
 * Tags the commit the artifact was BUILT from, which is rarely HEAD: recording
 * happens after the upload, by which time main has usually moved on. Tagging
 * HEAD would quietly point the tag at source that never shipped.
 *
 * Never fails the recording — the ledger is the authoritative record and is
 * already written by this point.
 */
function tagRelease(entry, manifest) {
	const tag = releaseTagName(entry);
	if (!manifest.commit) {
		console.warn(`\n! No commit in the sidecar; skipped tag ${tag}.`);
		return;
	}
	if (manifest.commitDirty) {
		// The commit does not describe the artifact, so the tag would be a lie.
		console.warn(
			`\n! Artifact was built from a dirty worktree; skipped tag ${tag}.`
			+ '\n  Commit before building so the release is reproducible from its tag.'
		);
		return;
	}
	const git = (arguments_) => spawnSync('git', arguments_, { cwd: root, encoding: 'utf-8' });

	if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) {
		console.warn(`\n! Tag ${tag} already exists; left as is.`);
		return;
	}
	const message =
		`Fumeto Reader Plus ${entry.versionName} (versionCode ${entry.versionCode})\n\n`
		+ `Track:    ${entry.track}\n`
		+ `Artifact: ${path.basename(manifest.file ?? '')}\n`
		+ `sha256:   ${entry.sha256}\n`
		+ `Uploaded: ${entry.uploadedAt}\n`;
	const result = git(['tag', '-a', tag, manifest.commit, '-m', message]);
	if (result.status === 0) {
		console.log(`Tagged ${tag} at ${manifest.commit.slice(0, 7)} — push it: git push origin ${tag}`);
	} else {
		console.warn(`\n! Could not create tag ${tag}: ${(result.stderr || '').trim()}`);
	}
}

try {
	main();
} catch (error) {
	console.error(`record-release: ${error.message}`);
	process.exit(1);
}

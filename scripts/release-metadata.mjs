/**
 * Shared, side-effect-free release metadata: version parsing, the Play
 * versionCode derivation, ledger comparison, and artifact naming.
 *
 * The CLIs on top of this (release-preflight, collect-android-artifact,
 * release-android, set-app-version, record-release) stay thin so this logic can
 * be unit-tested without touching the filesystem or invoking Gradle.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Play's hard ceiling, and Tauri's own documented limit for versionCode. */
export const MAX_VERSION_CODE = 2_100_000_000;

export const VERSION_SOURCES = Object.freeze([
	Object.freeze({ label: 'package.json', file: 'package.json' }),
	Object.freeze({ label: 'tauri.conf.json', file: 'src-tauri/tauri.conf.json' }),
	Object.freeze({ label: 'Cargo.toml', file: 'src-tauri/Cargo.toml' })
]);

export const LEDGER_FILE = 'release-ledger.json';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export function parseSemver(value, label = 'Version') {
	const match = SEMVER.exec(String(value ?? '').trim());
	if (!match) throw new Error(`${label} must be a plain MAJOR.MINOR.PATCH semver, got ${JSON.stringify(value)}`);
	const [major, minor, patch] = match.slice(1).map(Number);
	if (minor > 999 || patch > 999) {
		throw new Error(`${label} ${value} cannot be encoded: Tauri's formula reserves 3 digits each for minor and patch`);
	}
	return { major, minor, patch };
}

/**
 * Tauri's derivation, quoted from its config schema:
 *   versionCode = major * 1000000 + minor * 1000 + patch
 * Reproduced here so the preflight can predict what the build will emit
 * without having to run the build first.
 */
export function deriveVersionCode(version) {
	const { major, minor, patch } = typeof version === 'string' ? parseSemver(version) : version;
	const code = major * 1_000_000 + minor * 1_000 + patch;
	if (code < 1 || code > MAX_VERSION_CODE) {
		throw new Error(`Derived versionCode ${code} is outside Play's accepted range 1..${MAX_VERSION_CODE}`);
	}
	return code;
}

/** Pulls `version = "x.y.z"` out of Cargo.toml's `[package]` table only. */
export function parseCargoVersion(contents) {
	const packageSection = /^\[package\]\s*$/mu.exec(contents);
	if (!packageSection) throw new Error('Cargo.toml has no [package] section');
	const rest = contents.slice(packageSection.index + packageSection[0].length);
	const nextSection = /^\[/mu.exec(rest);
	const body = nextSection ? rest.slice(0, nextSection.index) : rest;
	const version = /^\s*version\s*=\s*"([^"]+)"/mu.exec(body);
	if (!version) throw new Error('Cargo.toml [package] has no version key');
	return version[1];
}

/**
 * Git tag for an upload, matching the artifact filename's version segment so a
 * tag, a ledger row, and a file on disk are visibly the same release.
 */
export function releaseTagName({ versionName, versionCode }) {
	parseSemver(versionName, 'versionName');
	if (!Number.isInteger(versionCode) || versionCode <= 0) {
		throw new Error(`versionCode must be a positive integer, got ${versionCode}`);
	}
	return `v${versionName}-vc${versionCode}`;
}

/** The workspace crate whose own version Cargo.lock records. */
export const CARGO_LOCK_CRATE = 'fumeto-reader-plus';

/**
 * Rewrites this crate's version inside a Cargo.lock, leaving every other
 * package's block untouched. Returns the contents unchanged when the version
 * already matches or the crate is absent.
 *
 * Without this the first cargo invocation of a release build rewrites the
 * lockfile after the version commit, so the artifact gets collected from a
 * dirty worktree and its provenance record has to admit it.
 */
export function withCargoLockVersion(contents, version) {
	const pattern = new RegExp(
		`(\\[\\[package\\]\\]\\nname = "${CARGO_LOCK_CRATE}"\\nversion = )"[^"]+"`,
		'u'
	);
	return contents.replace(pattern, `$1"${version}"`);
}

export function readVersionSources(root) {
	return VERSION_SOURCES.map(({ label, file }) => {
		const contents = fs.readFileSync(path.join(root, file), 'utf-8');
		const version = file.endsWith('.toml') ? parseCargoVersion(contents) : JSON.parse(contents).version;
		return { label, file, version };
	});
}

/**
 * All three hand-maintained version files must agree. They drifted once
 * already (review B7), and a drift here means the APK's versionName and the
 * version shown in Settings disagree.
 */
export function findVersionDisagreement(sources) {
	const distinct = [...new Set(sources.map((source) => source.version))];
	if (distinct.length <= 1) return null;
	return sources.map((source) => `${source.label}=${source.version}`).join(', ');
}

export function readLedger(root) {
	const file = path.join(root, LEDGER_FILE);
	if (!fs.existsSync(file)) return [];
	const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
	if (!Array.isArray(parsed)) throw new Error(`${LEDGER_FILE} must contain a JSON array`);
	for (const entry of parsed) {
		if (!Number.isSafeInteger(entry?.versionCode)) {
			throw new Error(`${LEDGER_FILE} has an entry without an integer versionCode`);
		}
	}
	return parsed;
}

/**
 * Play permanently retires a versionCode once it has been uploaded — a
 * duplicate is rejected and the upload slot is wasted. An empty ledger passes,
 * so the very first release is not blocked by its own bookkeeping.
 */
export function findLedgerConflict(ledger, versionCode) {
	const highest = ledger.reduce((max, entry) => Math.max(max, entry.versionCode), 0);
	if (versionCode > highest) return null;
	const exact = ledger.find((entry) => entry.versionCode === versionCode);
	return {
		highest,
		conflict: exact ?? null,
		reason: exact
			? `versionCode ${versionCode} was already uploaded on ${exact.uploadedAt ?? 'an unrecorded date'}`
			: `versionCode ${versionCode} is not above the highest recorded upload (${highest})`
	};
}

const ABI_ENTRY = /^(?:base\/)?lib\/([^/]+)\//u;

/**
 * Reads the ABI from the archive's own native-library entries rather than from
 * its path or filename. Gradle writes every release target to the flavor
 * directory `universal/`, so `app-universal-release.apk` routinely contains a
 * single ABI and the name says nothing about which.
 */
export function detectAbi(entryNames) {
	const abis = new Set();
	for (const name of entryNames) {
		const match = ABI_ENTRY.exec(name);
		if (match) abis.add(match[1]);
	}
	if (abis.size === 0) return 'noarch';
	if (abis.size > 1) return 'universal';
	return [...abis][0];
}

/** `fumeto-0.2.1-vc2001-release-arm64-v8a.apk` */
export function artifactFileName({ versionName, versionCode, buildType, abi, extension }) {
	for (const [label, value] of Object.entries({ versionName, buildType, abi, extension })) {
		if (typeof value !== 'string' || value === '' || /[/\\\s]/u.test(value)) {
			throw new Error(`Artifact ${label} is missing or unsafe for a filename: ${JSON.stringify(value)}`);
		}
	}
	if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
		throw new Error(`Artifact versionCode is invalid: ${JSON.stringify(versionCode)}`);
	}
	return `fumeto-${versionName}-vc${versionCode}-${buildType}-${abi}.${extension.replace(/^\./u, '')}`;
}

/** Reads the versionName/versionCode Tauri generated for the last build. */
export function readTauriProperties(root) {
	const file = path.join(root, 'src-tauri/gen/android/app/tauri.properties');
	if (!fs.existsSync(file)) return null;
	const contents = fs.readFileSync(file, 'utf-8');
	const versionName = /^tauri\.android\.versionName=(.+)$/mu.exec(contents)?.[1]?.trim();
	const versionCode = /^tauri\.android\.versionCode=(\d+)$/mu.exec(contents)?.[1];
	if (!versionName || !versionCode) return null;
	return { versionName, versionCode: Number(versionCode) };
}

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function sha256File(file) {
	const digest = crypto.createHash('sha256');
	const descriptor = fs.openSync(file, 'r');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		for (;;) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			digest.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		fs.closeSync(descriptor);
	}
	return digest.digest('hex');
}

export function resolveApkAnalyzer(environment = process.env) {
	const candidates = [
		environment.APKANALYZER,
		environment.ANDROID_SDK_ROOT && path.join(environment.ANDROID_SDK_ROOT, 'cmdline-tools/latest/bin/apkanalyzer'),
		environment.ANDROID_HOME && path.join(environment.ANDROID_HOME, 'cmdline-tools/latest/bin/apkanalyzer'),
		environment.HOME && path.join(environment.HOME, 'Android/Sdk/cmdline-tools/latest/bin/apkanalyzer')
	].filter(Boolean);
	const analyzer = candidates.find((file) => fs.existsSync(file));
	if (!analyzer) throw new Error('Android SDK apkanalyzer is required to inspect the candidate APK');
	return analyzer;
}

export function resolveApkSigner(environment = process.env) {
	const sdk = environment.ANDROID_SDK_ROOT ?? environment.ANDROID_HOME
		?? (environment.HOME ? path.join(environment.HOME, 'Android/Sdk') : null);
	const buildTools = sdk && fs.existsSync(path.join(sdk, 'build-tools'))
		? fs.readdirSync(path.join(sdk, 'build-tools')).sort().reverse().map((version) =>
			path.join(sdk, 'build-tools', version, 'apksigner'))
		: [];
	const candidates = [environment.APKSIGNER, ...buildTools].filter(Boolean);
	const signer = candidates.find((file) => fs.existsSync(file));
	if (!signer) throw new Error('Android SDK apksigner is required to verify the candidate APK');
	return signer;
}

export function resolveZipAlign(environment = process.env) {
	const sdk = environment.ANDROID_SDK_ROOT ?? environment.ANDROID_HOME
		?? (environment.HOME ? path.join(environment.HOME, 'Android/Sdk') : null);
	const buildTools = sdk && fs.existsSync(path.join(sdk, 'build-tools'))
		? fs.readdirSync(path.join(sdk, 'build-tools')).sort().reverse().map((version) =>
			path.join(sdk, 'build-tools', version, process.platform === 'win32' ? 'zipalign.exe' : 'zipalign'))
		: [];
	const candidates = [environment.ZIPALIGN, ...buildTools].filter(Boolean);
	const aligner = candidates.find((file) => fs.existsSync(file));
	if (!aligner) throw new Error('Android SDK zipalign is required to produce the candidate APK');
	return aligner;
}

export function verifiedSigningCertificateSha256(artifactFile, environment = process.env) {
	let output;
	try {
		output = execFileSync(resolveApkSigner(environment), [
			'verify', '--verbose', '--print-certs', artifactFile
		], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		throw new Error(`Candidate APK signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const certificates = [...output.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9:]{64,95})/giu)]
		.map((match) => match[1].replaceAll(':', '').toLowerCase());
	const unique = [...new Set(certificates)];
	if (unique.length !== 1 || !/^[a-f0-9]{64}$/u.test(unique[0])) {
		throw new Error('Candidate APK must have exactly one verified signing-certificate SHA-256 identity');
	}
	return unique[0];
}

export function inspectPpocrCandidateArtifact(artifactFile, environment = process.env) {
	const resolved = path.resolve(artifactFile);
	const stat = fs.statSync(resolved);
	if (!stat.isFile() || path.extname(resolved).toLowerCase() !== '.apk') {
		throw new Error('Candidate artifact must be an existing APK file');
	}
	const analyzer = resolveApkAnalyzer(environment);
	const manifest = (command) => execFileSync(analyzer, ['manifest', command, resolved], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
	const versionCode = Number(manifest('version-code'));
	if (!Number.isSafeInteger(versionCode) || versionCode < 0) {
		throw new Error('Candidate APK contains an invalid version code');
	}
	return Object.freeze({
		kind: 'android-apk',
		sha256: sha256File(resolved),
		sizeBytes: stat.size,
		packageName: manifest('application-id'),
		versionCode,
		versionName: manifest('version-name'),
		debuggable: manifest('debuggable') === 'true',
		signingCertificateSha256: verifiedSigningCertificateSha256(resolved, environment)
	});
}

export function verifyPpocrCandidateArtifact(expected, artifactFile, environment = process.env) {
	const actual = inspectPpocrCandidateArtifact(artifactFile, environment);
	for (const key of [
		'kind', 'sha256', 'sizeBytes', 'packageName', 'versionCode', 'versionName',
		'debuggable', 'signingCertificateSha256'
	]) {
		if (actual[key] !== expected[key]) {
			throw new Error(`Candidate APK ${key} does not match its canonical identity`);
		}
	}
	return actual;
}

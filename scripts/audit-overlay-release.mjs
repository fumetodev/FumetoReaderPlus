import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const build = path.join(root, 'build');
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const forbidden = [
	// Development-only surfaces that are compiled in behind build flags and must
	// never reach a shipped build: the layout gate's pseudolocale
	// (VITE_FUMETO_PSEUDOLOCALE=1) and the debug UI fixture host
	// (VITE_FUMETO_DEBUG_UI_FIXTURES=1).
	'en-xa',
	'__fumeto_mobile_ui_fixture', '__fumeto_ui_fixture__', 'mobile-ui-fixture-host'
];
const forbiddenBytes = forbidden.map((marker) => [marker, Buffer.from(marker.toLowerCase())]);
const remoteFontHosts = ['fonts.googleapis.com', 'fonts.gstatic.com'].map((host) => Buffer.from(host));
const maximumMarkerBytes = Math.max(
	...forbiddenBytes.map(([, bytes]) => bytes.length),
	...remoteFontHosts.map((bytes) => bytes.length)
);
const MAX_APK_ENTRIES = 100_000;
const MAX_APK_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_APK_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

export function auditOverlayReleaseBytes(bytes, label) {
	const lowerAscii = Buffer.from(bytes.toString('latin1').toLowerCase(), 'latin1');
	for (const [marker, markerBytes] of forbiddenBytes) {
		if (lowerAscii.includes(markerBytes)) throw new Error(`Release contains a development-only marker ${marker}: ${label}`);
	}
	if (remoteFontHosts.some((host) => lowerAscii.includes(host))) {
		throw new Error(`Release contains a remote font URL: ${label}`);
	}
}

export function auditOverlayWebBuild(buildDirectory = build) {
	if (!fs.existsSync(buildDirectory)) throw new Error('Run npm run build before the overlay release audit');
	const files = walk(buildDirectory);
	for (const file of files) auditOverlayReleaseBytes(fs.readFileSync(file), path.relative(root, file));
	for (const notice of ['OVERLAY_THIRD_PARTY_NOTICES.txt', 'overlay-font-assets.json']) {
		if (!fs.existsSync(path.join(buildDirectory, 'licenses', notice))) {
			throw new Error(`Release is missing licenses/${notice}`);
		}
	}
	return files.length;
}

function readCommand(command, arguments_, maximumBytes, label) {
	const result = spawnSync(command, arguments_, {
		cwd: root,
		encoding: null,
		maxBuffer: maximumBytes,
		windowsHide: true
	});
	if (result.error || result.status !== 0) {
		throw new Error(`${label} failed: ${result.error?.message ?? result.stderr?.toString('utf8').trim() ?? result.status}`);
	}
	return result.stdout;
}

async function auditApkEntry(apkFile, entry) {
	const child = spawn('unzip', ['-p', apkFile, entry], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});
	const completion = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	let tail = Buffer.alloc(0);
	let bytesRead = 0;
	let stderr = '';
	child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
	try {
		for await (const chunk of child.stdout) {
			bytesRead += chunk.length;
			if (bytesRead > MAX_APK_ENTRY_BYTES) {
				child.kill('SIGKILL');
				throw new Error(`APK entry exceeds its expanded byte budget: ${entry}`);
			}
			const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
			auditOverlayReleaseBytes(window, `${path.basename(apkFile)}!/${entry}`);
			tail = window.subarray(Math.max(0, window.length - maximumMarkerBytes + 1));
		}
	} catch (error) {
		child.kill('SIGKILL');
		await completion.catch(() => undefined);
		throw error;
	}
	const status = await completion;
	if (status !== 0) throw new Error(`APK entry ${entry} failed to extract: ${stderr.trim() || status}`);
	return bytesRead;
}

export async function auditOverlayApk(apkFile) {
	const resolved = path.resolve(root, apkFile);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()
		|| path.extname(resolved).toLowerCase() !== '.apk') {
		throw new Error('--apk must identify an existing APK file');
	}
	const listing = readCommand('zipinfo', ['-1', resolved], 16 * 1024 * 1024, 'APK inventory')
		.toString('utf8')
		.split(/\r?\n/u)
		.filter(Boolean);
	if (listing.length > MAX_APK_ENTRIES) throw new Error('APK inventory exceeds its entry budget');
	let expandedBytes = 0;
	for (const entry of listing) {
		if (entry.length > 1_024 || entry.startsWith('/') || entry.includes('\\')
			|| /[\u0000-\u001f\u007f]/u.test(entry) || entry.split('/').includes('..')) {
			throw new Error(`APK contains an unsafe entry name: ${entry.slice(0, 120)}`);
		}
		if (/(?:^|\/)(?:tests?|private|reports?|artifacts?)(?:\/|$)/iu.test(entry)) {
			throw new Error(`APK contains a development-only entry: ${entry}`);
		}
		if (entry.endsWith('/')) continue;
		expandedBytes += await auditApkEntry(resolved, entry);
		if (expandedBytes > MAX_APK_TOTAL_BYTES) throw new Error('APK expanded content exceeds its total byte budget');
	}
	return listing.length;
}

export async function auditOverlayRelease(arguments_ = process.argv.slice(2)) {
	const webFiles = auditOverlayWebBuild();
	let apkEntries = 0;
	if (arguments_.length) {
		if (arguments_.length !== 2 || arguments_[0] !== '--apk') {
			throw new Error('Usage: node scripts/audit-overlay-release.mjs [--apk <candidate.apk>]');
		}
		apkEntries = await auditOverlayApk(arguments_[1]);
	}
	return { webFiles, apkEntries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await auditOverlayRelease();
	console.log(`Overlay release audit passed across ${result.webFiles} web files${result.apkEntries ? ` and ${result.apkEntries} APK entries` : ''}`);
}

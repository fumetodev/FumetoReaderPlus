#!/usr/bin/env node
/**
 * Stream (or query) the app WebView's JS console from a debug build on device.
 *
 * Tauri's WebChromeClient does not forward console output to logcat, so a
 * `adb logcat | grep chromium` shows nothing from the app's own code. The only
 * way to see console messages, uncaught exceptions and unhandled rejections
 * from a running debug build is to attach to the WebView's DevTools socket.
 * Every live verification in the 0.4.0 remediation campaign depends on this.
 *
 * Release builds are not debuggable and expose no socket — use
 * scripts/android-release-webview-harness.mjs for those.
 *
 *   node scripts/android-webview-console.mjs                     # follow the console
 *   node scripts/android-webview-console.mjs --eval "location.href"
 *   node scripts/android-webview-console.mjs --serial emulator-5554 --out run.jsonl
 *
 * Options:
 *   --serial <s>   adb device serial (default: the only attached device)
 *   --package <p>  app package (default com.fumeto.reader)
 *   --port <n>     local port to forward the DevTools socket to (default 9222)
 *   --eval <expr>  evaluate one expression, print the JSON result, exit
 *   --eval-file <p> same, reading the expression from a file — for payloads too
 *                  large or too quote-heavy to pass on a command line
 *   --out <path>   append events as JSONL in addition to printing them
 *   --timeout <s>  exit after N seconds (default: run until interrupted)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};

const SERIAL = flag('serial');
const PACKAGE = flag('package', 'com.fumeto.reader');
const PORT = Number(flag('port', '9222'));
const EVAL_FILE = flag('eval-file');
const EVAL_EXPRESSION = EVAL_FILE ? fs.readFileSync(EVAL_FILE, 'utf8') : flag('eval');
const OUT_PATH = flag('out');
const TIMEOUT_SECONDS = Number(flag('timeout', '0'));

const adb = (...adbArgs) => {
	const result = spawnSync('adb', [...(SERIAL ? ['-s', SERIAL] : []), ...adbArgs], {
		encoding: 'utf8'
	});
	if (result.error) throw result.error;
	return (result.stdout ?? '').trim();
};

function resolveDebuggerUrl() {
	const pid = adb('shell', 'pidof', PACKAGE).split(/\s+/)[0];
	if (!pid) {
		throw new Error(
			`${PACKAGE} is not running. Launch it first:\n` +
				`  adb shell monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`
		);
	}
	// The socket name is per-process, so it has to be re-resolved after every
	// app restart — a stale forward silently points at a dead process.
	adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
	return new Promise((resolve, reject) => {
		http
			.get(`http://127.0.0.1:${PORT}/json`, (response) => {
				let body = '';
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () => {
					let targets;
					try {
						targets = JSON.parse(body);
					} catch (err) {
						reject(new Error(`DevTools returned non-JSON: ${body.slice(0, 200)}`));
						return;
					}
					const page =
						targets.find((target) => String(target.url).includes('tauri.localhost')) ?? targets[0];
					if (!page?.webSocketDebuggerUrl) {
						reject(
							new Error(
								'No debuggable WebView. Release builds are not debuggable — install the debug APK.'
							)
						);
						return;
					}
					resolve(page.webSocketDebuggerUrl);
				});
			})
			.on('error', reject);
	});
}

function emit(event) {
	const line = JSON.stringify({ at: new Date().toISOString(), ...event });
	console.log(line);
	if (OUT_PATH) fs.appendFileSync(OUT_PATH, `${line}\n`);
}

/** Flatten a CDP RemoteObject list into something greppable. */
function describeArgs(remoteObjects = []) {
	return remoteObjects
		.map((arg) => (arg.value !== undefined ? arg.value : (arg.description ?? arg.type)))
		.join(' ');
}

const debuggerUrl = await resolveDebuggerUrl();
// `ws` ships with the repo's dev dependencies; there is no runtime dependency
// on it in the app itself.
const { default: WebSocket } = await import('ws');
const socket = new WebSocket(debuggerUrl, { perMessageDeflate: false });

let nextId = 1;
const send = (method, params) => socket.send(JSON.stringify({ id: nextId++, method, params }));

socket.on('open', () => {
	if (EVAL_EXPRESSION) {
		send('Runtime.evaluate', {
			expression: EVAL_EXPRESSION,
			returnByValue: true,
			awaitPromise: true
		});
		return;
	}
	send('Runtime.enable');
	send('Log.enable');
	emit({ kind: 'attached', target: debuggerUrl.replace(/\/devtools\/.*/, '/devtools/…') });
});

socket.on('message', (raw) => {
	const message = JSON.parse(raw);

	if (EVAL_EXPRESSION && message.id === 1) {
		const details = message.result?.exceptionDetails;
		if (details) {
			console.error(JSON.stringify(details.exception ?? details, null, 2));
			process.exit(3);
		}
		console.log(JSON.stringify(message.result?.result?.value ?? null, null, 2));
		process.exit(0);
	}

	switch (message.method) {
		case 'Runtime.consoleAPICalled':
			emit({
				kind: 'console',
				level: message.params.type,
				text: describeArgs(message.params.args).slice(0, 2000)
			});
			break;
		case 'Runtime.exceptionThrown': {
			const details = message.params.exceptionDetails;
			emit({
				kind: 'exception',
				text: `${details.text ?? ''} ${details.exception?.description ?? ''}`.trim().slice(0, 4000)
			});
			break;
		}
		case 'Log.entryAdded':
			emit({
				kind: 'log',
				level: message.params.entry.level,
				text: String(message.params.entry.text).slice(0, 2000)
			});
			break;
		default:
			break;
	}
});

socket.on('error', (err) => {
	console.error(`[android-webview-console] socket error: ${err.message}`);
	process.exit(4);
});

// A closed socket means the WebView went away (app killed, or a renderer
// crash) — that is itself a result worth reporting rather than hanging.
socket.on('close', () => {
	emit({ kind: 'detached' });
	process.exit(0);
});

if (TIMEOUT_SECONDS > 0) {
	setTimeout(() => {
		emit({ kind: 'timeout', seconds: TIMEOUT_SECONDS });
		process.exit(0);
	}, TIMEOUT_SECONDS * 1000).unref();
}

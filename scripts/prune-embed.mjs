#!/usr/bin/env node
// Removes files from the SvelteKit build output that no packaged build loads,
// so they are not embedded into the app binary. Both packaged targets — the
// Android APK and the Linux desktop AppImage — download the vision models on
// first use through the in-app model manager, so the ONNX copies under
// static/models/ only serve `npm run dev` in a plain browser, and the
// onnxruntime-web variants below are never imported by the shipping reader
// path on any target. The base ORT WASM runtime stays: it runs rtmdet layout
// on the desktop and is the fallback tier behind the native engine on Android
// (see layout-detector.ts). Invoked by `npm run build:android` and
// `npm run build:desktop`, the beforeBuildCommands that
// tauri.android.conf.json and tauri.linux.conf.json select; a plain
// `npm run build` keeps the full payload for browser development.
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build');

const PRUNE = [
	// PP-OCR det/rec run natively on Android. The WASM fallback still works
	// without these embedded copies: ppocr-wasm-model-loader.ts detects the
	// SPA-fallback response and materializes the APK's native asset copy
	// through the PP-OCR bridge instead (no 83 MB double-bundle).
	'models/ppocr-det-v6-medium.onnx',
	'models/ppocr-rec-v6-small.onnx',
	// onnxruntime-web variants never imported by the shipping reader path.
	'wasm/ort-wasm-simd-threaded.jsep.wasm',
	'wasm/ort-wasm-simd-threaded.jsep.mjs',
	'wasm/ort-wasm-simd-threaded.asyncify.wasm',
	'wasm/ort-wasm-simd-threaded.asyncify.mjs',
	'wasm/ort-wasm-simd-threaded.jspi.wasm',
	'wasm/ort-wasm-simd-threaded.jspi.mjs'
];

// The ORT WASM runtime backs the rtmdet-wasm fallback tier — a prune that
// removed it would leave a failed native engine with nowhere to demote to.
// (`models/bubble-seg.onnx` used to be kept here too; the model was deleted on
// 2026-07-24 — it was an unused Ultralytics/AGPL-3.0 artifact.)
const KEEP = [
	'models/ppocrv6_dict.txt',
	'wasm/ort-wasm-simd-threaded.wasm',
	'wasm/ort-wasm-simd-threaded.mjs'
];

let saved = 0;
for (const rel of PRUNE) {
	const target = path.join(buildDir, rel);
	try {
		const info = await stat(target);
		await rm(target);
		saved += info.size;
		console.log(`pruned ${rel} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
	} catch (err) {
		if (err?.code !== 'ENOENT') throw err;
	}
}

const missing = [];
for (const rel of KEEP) {
	try {
		await stat(path.join(buildDir, rel));
	} catch {
		missing.push(rel);
	}
}
if (missing.length > 0) {
	console.error(`prune-embed: required files missing from build/: ${missing.join(', ')}`);
	process.exit(1);
}

console.log(`prune-embed: saved ${(saved / 1024 / 1024).toFixed(1)} MB from the embedded app`);

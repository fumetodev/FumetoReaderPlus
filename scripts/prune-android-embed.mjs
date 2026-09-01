#!/usr/bin/env node
// Removes files from the SvelteKit build output that the Android WebView never
// uses, so they are not embedded into libapp_lib.so. Android runs PP-OCR
// det/rec natively from APK assets (see generatePpocrNativeAssets in
// build.gradle.kts) and rtmdet layout natively through the ORT bridge; the base
// ORT WASM runtime is still kept because rtmdet-wasm is the tier-2 fallback when
// the native engine fails (see layout-detector.ts). Invoked by
// `npm run build:android`, which src-tauri/tauri.android.conf.json selects as
// the Android beforeBuildCommand. Desktop/dev builds keep the full payload.
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
	console.error(`prune-android-embed: required files missing from build/: ${missing.join(', ')}`);
	process.exit(1);
}

console.log(`prune-android-embed: saved ${(saved / 1024 / 1024).toFixed(1)} MB from the Android embed`);

#!/usr/bin/env node
// Removes files from the SvelteKit build output that a target never uses, so
// they are not embedded into the app binary. Usage:
//
//   node scripts/prune-embed.mjs android   # `npm run build:android`
//   node scripts/prune-embed.mjs macos     # `npm run build:macos`
//
// Each target's Tauri config selects its script as the beforeBuildCommand
// (src-tauri/tauri.android.conf.json, src-tauri/tauri.macos.conf.json).
// Windows, Linux and dev builds keep the full payload.
//
// Android runs PP-OCR det/rec natively from APK assets (see
// generatePpocrNativeAssets in build.gradle.kts) and rtmdet layout natively
// through the ORT bridge; the base ORT WASM runtime is still kept because
// rtmdet-wasm is the tier-2 fallback when the native engine fails (see
// layout-detector.ts).
//
// macOS has no native OCR engine: PP-OCR and rtmdet both run on the base ORT
// WASM runtime, reading the PP-OCR models bundled in static/models. Only the
// onnxruntime-web variants the shipping path never imports are dropped.
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build');

// onnxruntime-web variants never imported by the shipping reader path, which
// loads `onnxruntime-web/wasm` (ort-wasm-simd-threaded.{wasm,mjs}) only.
const UNUSED_ORT_VARIANTS = [
	'wasm/ort-wasm-simd-threaded.jsep.wasm',
	'wasm/ort-wasm-simd-threaded.jsep.mjs',
	'wasm/ort-wasm-simd-threaded.asyncify.wasm',
	'wasm/ort-wasm-simd-threaded.asyncify.mjs',
	'wasm/ort-wasm-simd-threaded.jspi.wasm',
	'wasm/ort-wasm-simd-threaded.jspi.mjs'
];

// The ORT WASM runtime backs the rtmdet-wasm tier on every target — a prune
// that removed it would leave layout detection with nowhere to run.
const ORT_RUNTIME = ['wasm/ort-wasm-simd-threaded.wasm', 'wasm/ort-wasm-simd-threaded.mjs'];

const TARGETS = {
	android: {
		label: 'the Android embed',
		prune: [
			// PP-OCR det/rec run natively on Android. The WASM fallback still works
			// without these embedded copies: ppocr-wasm-model-loader.ts detects the
			// SPA-fallback response and materializes the APK's native asset copy
			// through the PP-OCR bridge instead (no 83 MB double-bundle).
			'models/ppocr-det-v6-medium.onnx',
			'models/ppocr-rec-v6-small.onnx',
			...UNUSED_ORT_VARIANTS
		],
		// (`models/bubble-seg.onnx` used to be kept here too; the model was deleted
		// on 2026-07-24 — it was an unused Ultralytics/AGPL-3.0 artifact.)
		keep: ['models/ppocrv6_dict.txt', ...ORT_RUNTIME]
	},
	macos: {
		label: 'the macOS bundle',
		prune: [...UNUSED_ORT_VARIANTS],
		// The WASM PP-OCR detector and recognizer read these from the bundle;
		// ocr-model-manager.ts does not download them outside Android.
		keep: [
			'models/ppocr-det-v6-medium.onnx',
			'models/ppocr-rec-v6-small.onnx',
			'models/ppocrv6_dict.txt',
			...ORT_RUNTIME
		]
	}
};

const targetName = process.argv[2];
const target = TARGETS[targetName];
if (!target) {
	console.error(`prune-embed: expected one of ${Object.keys(TARGETS).join(', ')}; got ${targetName ?? 'nothing'}`);
	process.exit(1);
}

let saved = 0;
for (const rel of target.prune) {
	const file = path.join(buildDir, rel);
	try {
		const info = await stat(file);
		await rm(file);
		saved += info.size;
		console.log(`pruned ${rel} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
	} catch (err) {
		if (err?.code !== 'ENOENT') throw err;
	}
}

const missing = [];
for (const rel of target.keep) {
	try {
		await stat(path.join(buildDir, rel));
	} catch {
		missing.push(rel);
	}
}
if (missing.length > 0) {
	console.error(`prune-embed ${targetName}: required files missing from build/: ${missing.join(', ')}`);
	process.exit(1);
}

console.log(`prune-embed ${targetName}: saved ${(saved / 1024 / 1024).toFixed(1)} MB from ${target.label}`);

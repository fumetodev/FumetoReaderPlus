/**
 * Color-scheme generator — the single source of truth for the app's tonal palettes.
 *
 * Every dark scheme is derived from one seed color through Material's content-based
 * pipeline (Hct → tonal palettes), so all schemes share identical structure and
 * contrast relationships; only hue/chroma differ. Outputs are written in place
 * between @generated-schemes markers in:
 *   - src/lib/settings/color-schemes.generated.ts  (whole file)
 *   - src/app.html                                 (pre-paint inline table)
 *   - src/app.css                                  (@theme default = Synthesis)
 *
 * Run via `npm run schemes:generate`. The npm script bundles this file with esbuild
 * first because @material/material-color-utilities ships extensionless ESM imports
 * that Node cannot resolve directly.
 *
 * The legacy primary/surface ramps (--color-primary-N, --color-surface-N) are kept
 * and mapped onto tonal-palette tones so every existing component renders tonally
 * without edits:
 *
 *   surface-950 → N6 (base)          surface-500 → NV60 (min caption tone)
 *   surface-900 → N10 (cont-low)     surface-400 → NV70
 *   surface-800 → N12 (container)    surface-300 → NV80
 *   surface-700 → N17 (cont-high)    surface-200 → N90 (on-surface)
 *   surface-600 → N24 (outline-var)  surface-100 → N95 / surface-50 → N98
 *   primary-400 → P80 (interactive)  primary-600 → P48 (filled strong)
 *   primary-500 → P70               (full table in rampFromPalettes below)
 *
 * The Black scheme is the one special case: same neutral structure, but the base
 * is forced to pure #000000 for OLED and containers compress toward it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Hct, TonalPalette, hexFromArgb, argbFromHex } from '@material/material-color-utilities';

// Resolved from the invocation cwd (the package root via npm run) — the script
// executes as an esbuild bundle out of node_modules/.cache, so import.meta.url
// would point at the cache, not this source file.
const ROOT = `${process.cwd()}/`;

/** Seed table — ids are stable; legacy ids are normalized in color-schemes.ts. */
const SCHEMES = [
	{ id: 'synthesis', name: 'Synthesis', seed: '#29A449' },
	{ id: 'graphite', name: 'Graphite', seed: '#6b7280', neutralAccent: true },
	{ id: 'black', name: 'Black', seed: '#71717a', neutralAccent: true, oled: true },
	{ id: 'blue', name: 'Blue', seed: '#3b82f6' },
	{ id: 'red', name: 'Red', seed: '#ef4444' },
	{ id: 'purple', name: 'Purple', seed: '#a855f7' }
];

function palettesFor(seedHex, { neutralAccent = false } = {}) {
	const hct = Hct.fromInt(argbFromHex(seedHex));
	const hue = hct.hue;
	const chroma = hct.chroma;
	// Content-scheme flavor: primary keeps the seed's chroma (floored), neutrals
	// carry a whisper of it so surfaces feel tinted rather than gray.
	const primary = TonalPalette.fromHueAndChroma(hue, neutralAccent ? Math.min(chroma, 8) : Math.max(chroma, 42));
	const neutral = TonalPalette.fromHueAndChroma(hue, neutralAccent ? 2 : Math.min(10, chroma / 6 + 4));
	const neutralVariant = TonalPalette.fromHueAndChroma(hue, neutralAccent ? 3 : Math.min(14, chroma / 4 + 6));
	return { primary, neutral, neutralVariant };
}

const tone = (palette, t) => hexFromArgb(palette.tone(t));

function rampFromPalettes({ primary, neutral, neutralVariant }, { oled = false } = {}) {
	const surfaceTones = oled
		? { 950: 0, 900: 4, 800: 7, 700: 12, 600: 20 }
		: { 950: 6, 900: 10, 800: 12, 700: 17, 600: 24 };
	return {
		primary: {
			50: tone(primary, 98), 100: tone(primary, 95), 200: tone(primary, 90),
			300: tone(primary, 85), 400: tone(primary, 80), 500: tone(primary, 70),
			600: tone(primary, 48), 700: tone(primary, 40), 800: tone(primary, 30),
			900: tone(primary, 20)
		},
		surface: {
			50: tone(neutral, 98), 100: tone(neutral, 95), 200: tone(neutral, 90),
			300: tone(neutralVariant, 80), 400: tone(neutralVariant, 70),
			500: tone(neutralVariant, 60), 600: tone(neutralVariant, surfaceTones[600] + 6),
			700: tone(neutral, surfaceTones[700]), 800: tone(neutral, surfaceTones[800]),
			900: tone(neutral, surfaceTones[900]), 950: oled ? '#000000' : tone(neutral, surfaceTones[950])
		}
	};
}

function semanticTokens(palettes, ramp, { oled = false } = {}) {
	const { primary, neutral, neutralVariant } = palettes;
	return {
		'surface-base': ramp.surface[950],
		'surface-container-lowest': oled ? '#000000' : tone(neutral, 4),
		'surface-container-low': ramp.surface[900],
		'surface-container': ramp.surface[800],
		'surface-container-high': ramp.surface[700],
		'surface-container-highest': tone(neutral, oled ? 17 : 22),
		'on-surface': tone(neutral, 90),
		'on-surface-variant': tone(neutralVariant, 80),
		outline: tone(neutralVariant, 60),
		'outline-variant': tone(neutralVariant, 30),
		accent: tone(primary, 80),
		'accent-strong': tone(primary, 48),
		'on-accent': tone(primary, 20),
		'on-accent-strong': tone(primary, 95),
		'accent-container': tone(primary, 30),
		'on-accent-container': tone(primary, 90)
	};
}

const built = SCHEMES.map((def) => {
	const palettes = palettesFor(def.seed, def);
	const ramp = rampFromPalettes(palettes, def);
	const tokens = semanticTokens(palettes, ramp, def);
	return {
		id: def.id,
		name: def.name,
		seed: def.seed,
		preview: { bg: ramp.surface[950], accent: ramp.primary[400], text: ramp.surface[200] },
		colors: { primary: ramp.primary, surface: ramp.surface, tokens }
	};
});

/* ── 1. generated TS ─────────────────────────────────────────────────────── */
const ts = `/**
 * @generated by scripts/generate-color-schemes.src.mjs — do not edit by hand.
 * Run \`npm run schemes:generate\` after changing seeds or tone mappings.
 */
export interface GeneratedScheme {
	id: string;
	name: string;
	seed: string;
	preview: { bg: string; accent: string; text: string };
	colors: {
		primary: Record<string, string>;
		surface: Record<string, string>;
		tokens: Record<string, string>;
	};
}

export const GENERATED_SCHEMES: GeneratedScheme[] = ${JSON.stringify(built, null, '\t')};
`;
writeFileSync(`${ROOT}src/lib/settings/color-schemes.generated.ts`, ts);

/* ── 2. app.html pre-paint table (skip the default synthesis — CSS owns it) ─ */
const compact = {};
for (const scheme of built.filter((s) => s.id !== 'synthesis')) {
	compact[scheme.id] = { p: scheme.colors.primary, s: scheme.colors.surface, t: scheme.colors.tokens };
}
const htmlPath = `${ROOT}src/app.html`;
const html = readFileSync(htmlPath, 'utf8');
const htmlBlock = `\t\t\t\t\t\t\t// @generated-schemes:start (npm run schemes:generate)\n\t\t\t\t\t\t\tvar T = ${JSON.stringify(compact)};\n\t\t\t\t\t\t\t// @generated-schemes:end`;
const htmlOut = html.replace(/\t*\/\/ @generated-schemes:start[\s\S]*?\/\/ @generated-schemes:end/, htmlBlock);
if (htmlOut === html) throw new Error('app.html markers not found — add // @generated-schemes:start/end around the T table');
writeFileSync(htmlPath, htmlOut);

/* ── 3. app.css @theme default values (Synthesis) ───────────────────────── */
const synthesis = built[0];
const cssLines = [];
for (const [stop, value] of Object.entries(synthesis.colors.primary)) cssLines.push(`\t--color-primary-${stop}: ${value};`);
for (const [stop, value] of Object.entries(synthesis.colors.surface)) cssLines.push(`\t--color-surface-${stop}: ${value};`);
for (const [name, value] of Object.entries(synthesis.colors.tokens)) cssLines.push(`\t--color-${name}: ${value};`);
const cssPath = `${ROOT}src/app.css`;
const css = readFileSync(cssPath, 'utf8');
const cssBlock = `\t/* @generated-schemes:start — Synthesis defaults (npm run schemes:generate) */\n${cssLines.join('\n')}\n\t/* @generated-schemes:end */`;
const cssOut = css.replace(/\t\/\* @generated-schemes:start[\s\S]*?@generated-schemes:end \*\//, cssBlock);
if (cssOut === css) throw new Error('app.css markers not found — add /* @generated-schemes:start */ ... /* @generated-schemes:end */ inside @theme');
writeFileSync(cssPath, cssOut);

console.log('generated', built.map((s) => `${s.id}(${s.seed})`).join(' '));
console.log('synthesis check: accent', synthesis.colors.tokens.accent, 'surface', synthesis.colors.tokens['surface-base'], 'container-high', synthesis.colors.surface[700]);

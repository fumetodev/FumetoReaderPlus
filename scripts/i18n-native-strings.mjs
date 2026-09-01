#!/usr/bin/env node
/**
 * Android notification strings from the message catalogues.
 *
 * The `notif_*` keys in messages/<locale>.json are the source of truth; this
 * writes them into res/values/strings.xml and res/values-<qualifier>/strings.xml
 * with Android's positional placeholders (%1$s in the English order of the
 * placeholders), so Kotlin's getString(R.string.notif_x, arg) reads the same
 * text the app shows. `--check` fails when the XML on disk is not what the
 * catalogues would produce, which is how a re-draft cannot leave the
 * notifications behind.
 *
 *   node scripts/i18n-native-strings.mjs           # write
 *   node scripts/i18n-native-strings.mjs --check   # verify, no writes
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RES_DIR = 'src-tauri/gen/android/app/src/main/res';
/** BCP-47 tag → Android resource qualifier (Indonesian keeps the legacy `in`; regions take `r`). */
export const QUALIFIERS = { de: 'de', es: 'es', fr: 'fr', id: 'in', it: 'it', 'pt-BR': 'pt-rBR', ru: 'ru' };
/** Resources that stay in values/ untouched: product names, not prose. */
const KEEP = ['app_name', 'main_activity_title'];

export function escapeXml(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/@/g, '\\@').replace(/\?/g, (match, offset) => (offset === 0 ? '\\?' : match));
}

/** `{volume}` → `%1$s`, numbered by the placeholder's first appearance in the ENGLISH text. */
export function toAndroidFormat(text, order) {
	return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
		const index = order.indexOf(name);
		if (index === -1) throw new Error(`placeholder {${name}} is not in the English source`);
		return `%${index + 1}$s`;
	}).replace(/%(?![0-9]+\$s)/g, '%%');
}

export function placeholderOrder(text) {
	const order = [];
	for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!order.includes(match[1])) order.push(match[1]);
	return order;
}

export function renderStringsXml({ source, catalogue, keep = {} }) {
	const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Generated from messages/*.json by scripts/i18n-native-strings.mjs; edit the catalogue, not this file. -->', '<resources>'];
	for (const [name, value] of Object.entries(keep)) lines.push(`    <string name="${name}">${escapeXml(value)}</string>`);
	for (const key of Object.keys(source).filter((name) => name.startsWith('notif_')).sort()) {
		const text = catalogue[key];
		if (typeof text !== 'string') continue;
		lines.push(`    <string name="${key}">${escapeXml(toAndroidFormat(text, placeholderOrder(source[key])))}</string>`);
	}
	lines.push('</resources>', '');
	return lines.join('\n');
}

function readCatalogue(locale) {
	const file = path.join(ROOT, 'messages', `${locale}.json`);
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function keepFromExisting(file) {
	if (!existsSync(file)) return { app_name: 'FumetoReaderPlus', main_activity_title: 'FumetoReaderPlus' };
	const xml = readFileSync(file, 'utf8');
	const keep = {};
	for (const name of KEEP) {
		const match = new RegExp(`<string name="${name}">([^<]*)</string>`).exec(xml);
		if (match) keep[name] = match[1];
	}
	return keep;
}

export function plan() {
	const source = readCatalogue('en');
	const locales = JSON.parse(readFileSync(path.join(ROOT, 'messages/locales.json'), 'utf8')).locales;
	const files = [];
	const base = path.join(ROOT, RES_DIR, 'values/strings.xml');
	files.push({ file: base, content: renderStringsXml({ source, catalogue: source, keep: keepFromExisting(base) }) });
	for (const locale of Object.keys(locales)) {
		const catalogue = readCatalogue(locale);
		if (!catalogue) continue;
		const qualifier = QUALIFIERS[locale];
		if (!qualifier) throw new Error(`no Android qualifier for ${locale}`);
		const missing = Object.keys(source).filter((key) => key.startsWith('notif_') && typeof catalogue[key] !== 'string');
		if (missing.length > 0) { files.push({ file: path.join(ROOT, RES_DIR, `values-${qualifier}/strings.xml`), skipped: `${locale} lacks ${missing.join(', ')}` }); continue; }
		files.push({ file: path.join(ROOT, RES_DIR, `values-${qualifier}/strings.xml`), content: renderStringsXml({ source, catalogue }) });
	}
	return files;
}

export function main(argv = process.argv.slice(2), log = console.log) {
	const check = argv.includes('--check');
	const problems = [];
	for (const entry of plan()) {
		const relative = path.relative(ROOT, entry.file);
		if (entry.skipped) { if (check) problems.push(`${relative}: ${entry.skipped}`); else log(`skip ${relative}: ${entry.skipped}`); continue; }
		const current = existsSync(entry.file) ? readFileSync(entry.file, 'utf8') : null;
		if (current === entry.content) continue;
		if (check) { problems.push(`${relative} is not what the catalogues produce — run \`npm run i18n:native\``); continue; }
		mkdirSync(path.dirname(entry.file), { recursive: true });
		writeFileSync(entry.file, entry.content);
		log(`wrote ${relative}`);
	}
	for (const problem of problems) log(`problem: ${problem}`);
	return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

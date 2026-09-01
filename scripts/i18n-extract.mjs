/**
 * The extraction codemod: move the mechanical majority of a component's
 * strings into messages/en.json and call them through `m.<key>()`.
 *
 *   node scripts/i18n-extract.mjs --prefix reader src/lib/components/reader/Foo.svelte [more.svelte] [--dry-run]
 *
 * It rewrites exactly two shapes, because they are the only two that are
 * safe without a person looking:
 *   1. a translatable attribute whose value is one literal — `title="Save all"`
 *      becomes `title={m.reader_save_all()}`;
 *   2. a text node that is its element's only non-whitespace child —
 *      `<button>Save changes</button>` becomes `<button>{m.reader_save_changes()}</button>`.
 * Everything else (text beside an expression, ternaries, template literals,
 * script strings) is reported with its line for hand migration.
 *
 * Keys are `<prefix>_<slug>`; identical text within a run shares one key,
 * identical text already in the catalogue is reused (`common_cancel`),
 * and a slug collision gets a numeric suffix. The catalogue stays sorted.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseSvelte } from 'svelte/compiler';
import { DETAIL_PROPERTIES, TRANSLATABLE_ATTRIBUTES, looksLikeCodePhrase, looksLikeTemplateText } from './i18n-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = path.join(ROOT, 'messages/en.json');

const ENTITIES = { '&mdash;': '—', '&ndash;': '–', '&rarr;': '→', '&larr;': '←', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&hellip;': '…', '&times;': '×', '&middot;': '·' };

export function decodeEntities(text) {
	return text.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (entity) => {
		if (ENTITIES[entity]) return ENTITIES[entity];
		const dec = /^&#(\d+);$/.exec(entity);
		if (dec) return String.fromCodePoint(Number(dec[1]));
		const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
		if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
		return entity;
	});
}

export function slugOf(text, words = 4) {
	const cleaned = text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean)
		.slice(0, words)
		.join('_');
	return cleaned || 'text';
}

/** Choose a key for `text`: reuse an identical catalogue entry, else prefix + slug (+ suffix on collision). */
export function chooseKey(text, prefix, catalogue, allocated) {
	for (const [key, value] of Object.entries(catalogue)) {
		if (typeof value === 'string' && value === text && !key.startsWith('$')) return { key, reused: true };
	}
	for (const [key, value] of allocated) if (value === text) return { key, reused: true };
	const base = `${prefix}_${slugOf(text)}`;
	let key = base;
	let n = 2;
	while (key in catalogue || allocated.has(key)) key = `${base}_${n++}`;
	return { key, reused: false };
}

function walkAll(node, visit, parent = null) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) walkAll(child, visit, parent);
		return;
	}
	if (typeof node.type !== 'string') return;
	visit(node, parent);
	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent' || key === 'loc') continue;
		if (value && typeof value === 'object') walkAll(value, visit, node);
	}
}

const SILENT = /^(super|\w+\.failures\.push|console\.\w+|recordError|debugLog|log\w*|logger\.\w+|warn|localStorage\.\w+|sessionStorage\.\w+|Symbol|require|fetch|new Error|new URL|new RegExp|new CustomEvent|Intl\.\w+|new Intl\.\w+|Object\.\w+|JSON\.\w+|Math\.\w+|document\.\w+|\w+\.(startsWith|endsWith|includes|indexOf|replace|replaceAll|split|match|matchAll|test|getAttribute|setAttribute|hasAttribute|querySelector|querySelectorAll|addEventListener|removeEventListener|dispatchEvent|set|get|has))$/;

function calleeName(node) {
	if (!node) return '';
	if (node.type === 'Super') return 'super';
	if (node.type === 'Identifier') return node.name;
	if (node.type === 'MemberExpression') return `${calleeName(node.object)}.${node.property?.name ?? ''}`;
	return '';
}

/** Why a literal must be left alone, or null when it may become a message. */
function literalBlocked(ancestors) {
	for (let index = ancestors.length - 2; index >= 0; index -= 1) {
		const node = ancestors[index];
		const child = ancestors[index + 1];
		if (node.type === 'CallExpression' || node.type === 'NewExpression') {
			const name = (node.type === 'NewExpression' ? 'new ' : '') + calleeName(node.callee);
			if (SILENT.test(name) || /Error$/.test(name)) return 'silenced call';
		}
		if (node.type === 'ThrowStatement') return 'thrown';
		if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') return 'import';
		if (node.type === 'BinaryExpression') return 'comparison';
		if (node.type === 'Property' && node.key === child && !node.computed) return 'object key';
		if (node.type === 'Property' && node.value === child && DETAIL_PROPERTIES.has(node.key?.name ?? node.key?.value)) return 'detail property';
		if (node.type === 'TSLiteralType' || node.type === 'TSEnumMember') return 'type';
		if (node.type === 'Attribute' && !TRANSLATABLE_ATTRIBUTES.has(node.name)) return `attribute ${node.name}`;
		if (node.type === 'SwitchCase' && node.test === child) return 'case label';
	}
	return null;
}

function* literalsIn(node, ancestors = []) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) yield* literalsIn(child, ancestors);
		return;
	}
	if (typeof node.type !== 'string') return;
	const chain = [...ancestors, node];
	if (node.type === 'Literal' && typeof node.value === 'string') {
		yield { node, ancestors: chain, kind: 'literal' };
		return;
	}
	if (node.type === 'TemplateLiteral') {
		yield { node, ancestors: chain, kind: 'template' };
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === 'loc' || key === 'parent' || key === 'leadingComments' || key === 'trailingComments') continue;
		if (value && typeof value === 'object') yield* literalsIn(value, chain);
	}
}

/** `SERVER_TYPE_LABELS[serverType]` → serverType, `lib.name` → name, `n + 1` → value. */
function paramNameFor(expression, source, used) {
	let name = 'value';
	const text = source.slice(expression.start, expression.end);
	const identifiers = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
	const candidate = [...identifiers].reverse().find((id) => !/^(String|Number|Math|length|toFixed|round|min|max)$/.test(id));
	if (candidate) name = candidate.replace(/^\$/, '');
	let unique = name;
	let n = 2;
	while (used.has(unique)) unique = `${name}${n++}`;
	used.add(unique);
	return unique;
}


export function planComponent(source, { prefix, catalogue, allocated = new Map(), expressions = false }) {
	const options = { expressions };
	const ast = parseSvelte(source, { modern: true });
	const edits = [];
	const skips = [];
	const lineOf = (offset) => source.slice(0, offset).split('\n').length;
	const claim = (text) => {
		const decoded = decodeEntities(text.replace(/\s+/g, ' ').trim());
		const { key, reused } = chooseKey(decoded, prefix, catalogue, allocated);
		if (!reused) allocated.set(key, decoded);
		return key;
	};
	walkAll(ast.fragment, (node, parent) => {
		if (node.type === 'Attribute' && Array.isArray(node.value) && node.value.length === 1 && node.value[0].type === 'Text') {
			if (!TRANSLATABLE_ATTRIBUTES.has(node.name)) return;
			const chunk = node.value[0];
			if (!looksLikeTemplateText(chunk.data)) return;
			const key = claim(chunk.data);
			// Replace the whole attribute: name="…" → name={m.key()}
			edits.push({ start: node.start, end: node.end, text: `${node.name}={m.${key}()}`, line: lineOf(node.start), key });
			return;
		}
		if (node.type === 'Text' && parent && parent.type === 'Fragment' && Array.isArray(parent.nodes)) {
			if (!looksLikeTemplateText(node.data)) return;
			const siblings = parent.nodes.filter((sibling) => !(sibling.type === 'Text' && sibling.data.trim() === '') && sibling.type !== 'Comment');
			if (siblings.length !== 1 || siblings[0] !== node) {
				skips.push({ line: lineOf(node.start), reason: 'text has siblings (expression or element) — needs a message with placeholders', text: node.data.replace(/\s+/g, ' ').trim().slice(0, 60) });
				return;
			}
			const leading = node.data.match(/^\s*/)[0].length;
			const trailing = node.data.match(/\s*$/)[0].length;
			const key = claim(node.data);
			edits.push({ start: node.start + leading, end: node.end - trailing, text: `{m.${key}()}`, line: lineOf(node.start), key });
		}
	});
	if (options.expressions) {
		const roots = [ast.fragment, ast.instance?.content, ast.module?.content].filter(Boolean);
		for (const root of roots) {
			for (const { node, ancestors, kind } of literalsIn(root)) {
				const inTemplate = root === ast.fragment;
				const text = kind === 'literal' ? node.value : node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
				const conditional = ancestors.length >= 2 && ancestors[ancestors.length - 2].type === 'ConditionalExpression';
				const wanted = looksLikeCodePhrase(text) || (inTemplate && conditional && looksLikeTemplateText(text));
				if (!wanted) continue;
				const blocked = literalBlocked(ancestors);
				if (blocked) {
					if (looksLikeCodePhrase(text)) skips.push({ line: lineOf(node.start), reason: `left alone: ${blocked}`, text: text.slice(0, 60) });
					continue;
				}
				if (kind === 'literal') {
					const key = claim(node.value);
					edits.push({ start: node.start, end: node.end, text: `m.${key}()`, line: lineOf(node.start), key });
				} else {
					if (node.expressions.length === 0) {
						const key = claim(text);
						edits.push({ start: node.start, end: node.end, text: `m.${key}()`, line: lineOf(node.start), key });
						continue;
					}
					const used = new Set();
					const params = node.expressions.map((expression) => ({ name: paramNameFor(expression, source, used), code: source.slice(expression.start, expression.end) }));
					let message = '';
					node.quasis.forEach((quasi, index) => {
						message += quasi.value.cooked ?? quasi.value.raw;
						if (index < params.length) message += `{${params[index].name}}`;
					});
					const key = claim(message);
					const args = params.map((param) => (param.name === param.code ? param.name : `${param.name}: ${param.code}`)).join(', ');
					edits.push({ start: node.start, end: node.end, text: `m.${key}({ ${args} })`, line: lineOf(node.start), key });
				}
			}
		}
	}
	// Report literals the gate would still flag but this tool will not touch.
	walkAll(ast.fragment, (node) => {
		if (node.type === 'ExpressionTag') {
			const snippet = source.slice(node.start, Math.min(node.end, node.start + 80)).replace(/\s+/g, ' ');
			if (/['"`][^'"`]*\p{Lu}[^'"`]*['"`]/u.test(snippet)) skips.push({ line: lineOf(node.start), reason: 'expression with a literal', text: snippet });
		}
	});
	return { edits: edits.sort((a, b) => a.start - b.start), skips };
}

export function applyEdits(source, edits) {
	let out = '';
	let cursor = 0;
	for (const edit of edits) {
		if (edit.start < cursor) throw new Error(`overlapping edit at ${edit.start}`);
		out += source.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return out + source.slice(cursor);
}

const IMPORT_LINE = "import * as m from '$lib/paraglide/messages.js';";

export function ensureMessagesImport(source) {
	if (source.includes(IMPORT_LINE)) return source;
	const script = /<script[^>]*>\n?/.exec(source);
	if (!script) return `<script lang="ts">\n\t${IMPORT_LINE}\n</script>\n\n${source}`;
	const at = script.index + script[0].length;
	return `${source.slice(0, at)}\t${IMPORT_LINE}\n${source.slice(at)}`;
}

export function runExtract({ files, prefix, dryRun, expressions = false }) {
	const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
	const allocated = new Map();
	const report = [];
	for (const file of files) {
		const full = path.resolve(ROOT, file);
		if (!existsSync(full)) throw new Error(`no such file: ${file}`);
		const source = readFileSync(full, 'utf8');
		const { edits, skips } = planComponent(source, { prefix, catalogue, allocated, expressions });
		report.push({ file, edits: edits.length, skips });
		if (!dryRun && edits.length) writeFileSync(full, ensureMessagesImport(applyEdits(source, edits)));
	}
	if (!dryRun && allocated.size) {
		for (const [key, text] of allocated) catalogue[key] = text;
		const sorted = {};
		for (const key of Object.keys(catalogue).sort()) sorted[key] = catalogue[key];
		writeFileSync(CATALOGUE, `${JSON.stringify(sorted, null, '\t')}\n`);
	}
	return { report, added: [...allocated.keys()] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	const prefixIndex = argv.indexOf('--prefix');
	if (prefixIndex === -1) {
		process.stderr.write('usage: node scripts/i18n-extract.mjs --prefix <area> <file.svelte>... [--dry-run]\n');
		process.exit(2);
	}
	const prefix = argv[prefixIndex + 1];
	const dryRun = argv.includes('--dry-run');
	const expressions = argv.includes('--expressions');
	const files = argv.filter((arg, index) => !arg.startsWith('--') && index !== prefixIndex + 1);
	const { report, added } = runExtract({ files, prefix, dryRun, expressions });
	for (const entry of report) {
		process.stdout.write(`${entry.file}: ${entry.edits} edits${dryRun ? ' (dry run)' : ''}\n`);
		for (const skip of entry.skips) process.stdout.write(`  skip :${skip.line} ${skip.reason} — ${JSON.stringify(skip.text)}\n`);
	}
	process.stdout.write(`${added.length} new keys${dryRun ? ' would be' : ''} added\n`);
}

/**
 * The localization gate: no user-visible string may be born outside
 * `messages/`, and the catalogue must stay whole.
 *
 * Usage:
 *   node scripts/i18n-gate.mjs --check [--paths <path>...]   fail on any finding
 *   node scripts/i18n-gate.mjs --report                       list findings, exit 0
 *   node scripts/i18n-gate.mjs --baseline                     print the file allowlist for tests/i18n/gate-baseline.json
 *
 * What it checks (each has a unit test in i18n-gate.test.mjs):
 *  1. Svelte templates: text nodes, translatable attributes and string
 *     literals inside template expressions (never class/style/data-* ).
 *  2. Script blocks and declared .ts modules: capitalised multi-word string
 *     literals, except console/Error/recordError arguments, prompt modules,
 *     tests, vendor and generated code.
 *  3. Burn-down baseline: findings in a listed file are tolerated while the
 *     extraction lands — and a listed file with no findings FAILS, so the
 *     list only ever shrinks.
 *  4. Literal exemptions with a reason; an exemption whose literal is gone fails.
 *  5. Positive fixtures under tests/i18n/fixtures: the scanner must find the
 *     known count, or the gate is dead code.
 *  6. Catalogue integrity across messages/*.json: key parity with en,
 *     placeholder parity, plural categories per Intl.PluralRules, canonical
 *     formatting, every en key used somewhere, every used key defined, no
 *     dynamic `m[` access, the runtime imported only under src/lib/i18n/.
 *  7. app.html's generated tag block equals the shipped locale list.
 *  8. Native values-*\/strings.xml (once they exist) carry every notif_* name and never app_name.
 *  9. The toolchain's engines.node ranges include the CI pin.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse as parseSvelte } from 'svelte/compiler';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const semver = require('semver');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = 'tests/i18n/gate-baseline.json';
const EXEMPTIONS_FILE = 'tests/i18n/gate-exemptions.json';
const FIXTURES_DIR = 'tests/i18n/fixtures';
/** Fixture findings the scanner must report, or it is not scanning. */
export const FIXTURE_EXPECTATIONS = { 'hardcoded.svelte': 7, 'hardcoded.ts': 3 };

export const TRANSLATABLE_ATTRIBUTES = new Set([
	'title',
	'aria-label',
	'aria-description',
	'aria-roledescription',
	'aria-placeholder',
	'placeholder',
	'alt',
	'label',
	'sublabel',
	'description',
	'hint',
	'message'
]);
const NON_TEXT_ATTRIBUTES = /^(class|style|href|src|id|name|type|role|for|key|lang|dir|action|method|rel|target|download|width|height|viewBox|d|fill|stroke|transform|points|cx|cy|r|x|y|x1|x2|y1|y2|data-.*|aria-(hidden|expanded|selected|checked|pressed|current|controls|labelledby|describedby|live|atomic|busy|haspopup|orientation|valuemin|valuemax|valuenow|modal|disabled|invalid|multiselectable|readonly|required|sort|level|posinset|setsize|owns|activedescendant|autocomplete|colindex|rowindex|colcount|rowcount|keyshortcuts|relevant|roledescription))$/;

/** Modules outside components whose strings are user-facing (grown by every extraction card). */
/** Vendored, generated, dev-only (fixture host, benchmarks, diagnostic dumps) and log-formatting modules: nothing a person reads in the product. */
const SKIP_DIRS = ['src/lib/vendor/', 'src/lib/paraglide/', 'src/lib/debug/', 'src/lib/benchmark/', 'src/lib/diagnostics/', 'src/lib/translation/debug-log.ts', 'src/lib/util/redact.ts'];
/** Prompt text is English by contract (see getLanguagePromptName); never a finding. */
const PROMPT_MODULES = /src\/lib\/(translation\/(prompt-builder|text-only-prompts|revision-prompts|full-page-prompt|volume-prompts|language-utils|context-manager)|settings\/language-prompt-names)\.ts$/;

const LETTERS = /\p{L}{2,}/u;
/** A capitalised phrase of at least two words: what a label or a sentence looks like, what an id or a CSS class does not. */
const PHRASE = /^[\p{Lu}][^\n]*\s\p{Ll}/u;
const IDENTIFIER_LIKE = /^\/?[a-z][a-zA-Z0-9_./:-]*$/;
const CSS_TOKEN = /^[a-z0-9:\-\[\]/.%#(),!]+$/;

/** "text-sm font-bold", "px-2", "sm:hidden": lowercase utility tokens with a dash or colon somewhere. */
function cssLike(text) {
	const tokens = text.split(/\s+/);
	return tokens.every((token) => CSS_TOKEN.test(token)) && tokens.some((token) => /[-:\[\]]/.test(token));
}

export function looksLikeTemplateText(text) {
	const trimmed = text.replace(/\s+/g, ' ').trim();
	if (!LETTERS.test(trimmed)) return false;
	if (IDENTIFIER_LIKE.test(trimmed) || cssLike(trimmed)) return false;
	return true;
}

export function looksLikeCodePhrase(text) {
	return PHRASE.test(text.trim());
}

function rel(file) {
	return path.relative(ROOT, file).split(path.sep).join('/');
}

function lineOf(source, offset) {
	let line = 1;
	for (let index = 0; index < offset && index < source.length; index += 1) if (source[index] === '\n') line += 1;
	return line;
}

// ── Svelte ────────────────────────────────────────────────────────────────

function* estreeStrings(node, ancestors = []) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) yield* estreeStrings(child, ancestors);
		return;
	}
	if (typeof node.type !== 'string') return;
	const chain = [...ancestors, node];
	if (node.type === 'Literal' && typeof node.value === 'string') {
		yield { text: node.value, start: node.start, ancestors: chain };
		return;
	}
	if (node.type === 'TemplateLiteral') {
		const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('{…}');
		yield { text, start: node.start, ancestors: chain };
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'parent') continue;
		if (value && typeof value === 'object') yield* estreeStrings(value, chain);
	}
}

function calleeName(node) {
	if (!node) return '';
	if (node.type === 'Super') return 'super';
	if (node.type === 'Identifier') return node.name;
	if (node.type === 'MemberExpression') return `${calleeName(node.object)}.${node.property?.name ?? ''}`;
	return '';
}

const SILENT_CALLEES = /^(super|\w+\.failures\.push|console\.\w+|recordError|debugLog\w*|log\w*|invokeCallback|registerCallback|logger\.\w+|warn|trace|performance\.mark|performance\.measure|localStorage\.(get|set|remove)Item|sessionStorage\.(get|set|remove)Item|new Error|Symbol|require|import|fetch|Intl\.\w+|new Intl\.\w+|document\.(querySelector|querySelectorAll|getElementById|createElement)|\w+\.(querySelector|querySelectorAll|getAttribute|setAttribute|hasAttribute|classList\.\w+|addEventListener|removeEventListener|dispatchEvent|startsWith|endsWith|includes|indexOf|replace|replaceAll|split|match|matchAll|test)|new CustomEvent|new URL|new RegExp|Object\.\w+|Array\.\w+|JSON\.\w+|Math\.\w+)$/;

/**
 * Properties that hold developer detail by convention — the raw text next to
 * a `message`/`*_message` code (see UserMessage): never shown as-is, kept
 * English for logs and bug reports.
 */
export const DETAIL_PROPERTIES = new Set(['error', 'raw', 'detail', 'cause', 'stack', 'coverRetryError', 'recoverableError', 'recoverable_error', 'reason', 'operation', 'migration_error']);

/**
 * Properties whose string value is a label by definition, however short:
 * `{ value: 'rtl', label: 'Right to Left' }` tables, `title:`/`hint:` rows.
 * A single capitalised word ('Custom', 'Off-Device') is text here even
 * though it is not a phrase anywhere else.
 */
export const LABEL_PROPERTIES = new Set(['label', 'title', 'placeholder', 'description', 'hint', 'sublabel', 'subtitle', 'heading', 'caption', 'tooltip', 'text', 'body', 'footnote', 'summary', 'name']);

function labelPropertyValue(ancestors) {
	const parent = ancestors[ancestors.length - 2];
	const node = ancestors[ancestors.length - 1];
	return Boolean(parent && parent.type === 'Property' && parent.value === node && !parent.computed && LABEL_PROPERTIES.has(parent.key?.name ?? parent.key?.value));
}

function silencedByAncestors(ancestors) {
	for (let index = ancestors.length - 2; index >= 0; index -= 1) {
		const node = ancestors[index];
		const child = ancestors[index + 1];
		if (node.type === 'CallExpression' || node.type === 'NewExpression') {
			const name = (node.type === 'NewExpression' ? 'new ' : '') + calleeName(node.callee);
			if (SILENT_CALLEES.test(name) || /(Error|Exception)$/.test(name)) return true;
		}
		if (node.type === 'ThrowStatement') return true;
		if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration' && node.source) return true;
		if (node.type === 'Property' && node.key === child && !node.computed) return true;
		if (node.type === 'Property' && node.value === child && !node.computed && DETAIL_PROPERTIES.has(node.key?.name ?? node.key?.value)) return true;
		if (node.type === 'TSLiteralType' || node.type === 'TSEnumMember') return true;
		if (node.type === 'ImportExpression') return true;
	}
	return false;
}

function attributeName(attribute) {
	return attribute.name ?? '';
}

function scanBlockExpression(expression, source, file, findings) {
	if (!expression) return;
	for (const literal of estreeStrings(expression)) {
		const wanted = looksLikeCodePhrase(literal.text) || (labelPropertyValue(literal.ancestors) && looksLikeTemplateText(literal.text) && /\p{Lu}/u.test(literal.text));
		if (wanted && !silencedByAncestors(literal.ancestors)) findings.push({ file, line: lineOf(source, literal.start), kind: 'block-expression', text: literal.text });
	}
}

function walkFragment(fragment, source, file, findings) {
	if (!fragment) return;
	const nodes = Array.isArray(fragment) ? fragment : fragment.nodes ?? [];
	for (const node of nodes) walkNode(node, source, file, findings);
}

function walkNode(node, source, file, findings) {
	if (!node || typeof node !== 'object') return;
	switch (node.type) {
		case 'Text': {
			if (looksLikeTemplateText(node.data)) {
				findings.push({ file, line: lineOf(source, node.start), kind: 'text', text: node.data.replace(/\s+/g, ' ').trim() });
			}
			return;
		}
		case 'ExpressionTag':
		case 'HtmlTag': {
			for (const literal of estreeStrings(node.expression)) {
				if (looksLikeTemplateText(literal.text) && looksLikeCodePhrase(literal.text) || looksLikeTemplateText(literal.text) && /^[\p{Lu}]/u.test(literal.text.trim()) && !silencedByAncestors(literal.ancestors)) {
					if (!silencedByAncestors(literal.ancestors)) findings.push({ file, line: lineOf(source, literal.start), kind: 'expression', text: literal.text });
				}
			}
			return;
		}
		case 'RegularElement':
		case 'Component':
		case 'SvelteElement':
		case 'SvelteComponent':
		case 'SvelteSelf':
		case 'TitleElement':
		case 'SlotElement': {
			for (const attribute of node.attributes ?? []) {
				if (attribute.type !== 'Attribute') continue;
				const name = attributeName(attribute);
				if (NON_TEXT_ATTRIBUTES.test(name)) continue;
				const translatable = TRANSLATABLE_ATTRIBUTES.has(name) || node.type === 'Component' && /^(label|title|subtitle|heading|caption|text|hint|helper|footnote|body|summary|empty|error|prompt|cta)$/i.test(name);
				if (attribute.value === true) continue;
				const chunks = Array.isArray(attribute.value) ? attribute.value : [attribute.value];
				for (const chunk of chunks) {
					if (chunk.type === 'Text') {
						if (translatable && looksLikeTemplateText(chunk.data)) {
							findings.push({ file, line: lineOf(source, chunk.start), kind: `attr:${name}`, text: chunk.data.trim() });
						}
					} else if (chunk.type === 'ExpressionTag') {
						for (const literal of estreeStrings(chunk.expression)) {
							if ((translatable || looksLikeCodePhrase(literal.text)) && looksLikeTemplateText(literal.text) && !silencedByAncestors(literal.ancestors)) {
								findings.push({ file, line: lineOf(source, literal.start), kind: `attr:${name}`, text: literal.text });
							}
						}
					}
				}
			}
			walkFragment(node.fragment, source, file, findings);
			return;
		}
		case 'SnippetBlock':
		case 'KeyBlock':
			scanBlockExpression(node.expression, source, file, findings);
			walkFragment(node.body, source, file, findings);
			return;
		case 'IfBlock':
			scanBlockExpression(node.test, source, file, findings);
			walkFragment(node.consequent, source, file, findings);
			walkFragment(node.alternate, source, file, findings);
			return;
		case 'EachBlock':
			// `{#each [{ label: 'Off-Device' }, …] as tab}` — an inline table.
			scanBlockExpression(node.expression, source, file, findings);
			walkFragment(node.body, source, file, findings);
			walkFragment(node.fallback, source, file, findings);
			return;
		case 'AwaitBlock':
			walkFragment(node.pending, source, file, findings);
			walkFragment(node.then, source, file, findings);
			walkFragment(node.catch, source, file, findings);
			return;
		case 'RenderTag':
		case 'ConstTag':
		case 'DebugTag':
		case 'Comment':
			return;
		default: {
			// Anything else with child fragments.
			for (const key of ['fragment', 'body', 'consequent', 'alternate', 'fallback', 'pending', 'then', 'catch']) {
				if (node[key]) walkFragment(node[key], source, file, findings);
			}
		}
	}
}

function scanScriptProgram(program, source, file, findings) {
	if (!program) return;
	for (const literal of estreeStrings(program)) {
		const wanted = looksLikeCodePhrase(literal.text) || (labelPropertyValue(literal.ancestors) && looksLikeTemplateText(literal.text) && /\p{Lu}/u.test(literal.text));
		if (wanted && !silencedByAncestors(literal.ancestors)) {
			findings.push({ file, line: lineOf(source, literal.start), kind: 'script', text: literal.text });
		}
	}
}

export function scanSvelteSource(source, file = 'inline.svelte') {
	const findings = [];
	let ast;
	try {
		ast = parseSvelte(source, { modern: true, filename: file });
	} catch (error) {
		// A file that does not parse is svelte-check's failure to report; the
		// gate only notes it and moves on rather than dying mid-scan.
		findings.push({ file, line: error?.start?.line ?? 0, kind: 'parse-error', text: `does not parse: ${error?.message?.split('\n')[0] ?? error}` });
		return findings;
	}
	walkFragment(ast.fragment, source, file, findings);
	scanScriptProgram(ast.instance?.content, source, file, findings);
	scanScriptProgram(ast.module?.content, source, file, findings);
	return findings;
}

// ── TypeScript ────────────────────────────────────────────────────────────

const TS_SILENT_CALLEE = /^(super|\w+\.failures\.push|console\.\w+|recordError|debugLog\w*|log\w*|invokeCallback|registerCallback|logger\.\w+|warn|localStorage\.\w+|sessionStorage\.\w+|Symbol|require|fetch|new Error|new URL|new RegExp|new CustomEvent|new Intl\.\w+|Intl\.\w+|Object\.\w+|JSON\.\w+|Math\.\w+|document\.\w+|\w+\.(startsWith|endsWith|includes|indexOf|replace|replaceAll|split|match|matchAll|test|getAttribute|setAttribute|hasAttribute|querySelector|querySelectorAll|addEventListener|removeEventListener|dispatchEvent))$/;

function tsCalleeText(expression) {
	if (expression.kind === ts.SyntaxKind.SuperKeyword) return 'super';
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return `${tsCalleeText(expression.expression)}.${expression.name.text}`;
	return '';
}

function tsSilenced(node) {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
			const name = (ts.isNewExpression(current) ? 'new ' : '') + tsCalleeText(current.expression);
			if (TS_SILENT_CALLEE.test(name) || /(Error|Exception)$/.test(name)) return true;
		}
		if (ts.isThrowStatement(current)) return true;
		if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isImportTypeNode(current)) return true;
		if (ts.isPropertyAssignment(current) && current.name === node) return true;
		if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name) && DETAIL_PROPERTIES.has(current.name.text)) return true;
		if (ts.isLiteralTypeNode(current) || ts.isEnumMember(current)) return true;
		if (ts.isJSDoc(current)) return true;
	}
	return false;
}

export function scanTsSource(source, file = 'inline.ts') {
	const findings = [];
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const visit = (node) => {
		let text = null;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
		else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('{…}');
		if (text !== null) {
			const labelValue = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) && LABEL_PROPERTIES.has(node.parent.name.text);
			const wanted = looksLikeCodePhrase(text) || (labelValue && looksLikeTemplateText(text) && /\p{Lu}/u.test(text));
			if (wanted && !tsSilenced(node)) {
				findings.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, kind: 'ts', text });
			}
			if (!ts.isTemplateExpression(node)) return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return findings;
}

// ── Files ────────────────────────────────────────────────────────────────

function listFiles(dir, predicate, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stats = statSync(full);
		if (stats.isDirectory()) listFiles(full, predicate, out);
		else if (predicate(full)) out.push(full);
	}
	return out;
}

function scannableSvelteFiles() {
	return listFiles(path.join(ROOT, 'src'), (file) => file.endsWith('.svelte')).filter((file) => !SKIP_DIRS.some((dir) => rel(file).startsWith(dir)));
}

/** Every production .ts module under src/ — no declared list to fall behind; tests, typings, vendor, generated and prompt modules are the only skips. */
function scannableTsFiles() {
	return listFiles(path.join(ROOT, 'src'), (file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts'))
		.filter((file) => !SKIP_DIRS.some((dir) => rel(file).startsWith(dir)) && !/\/__tests__\//.test(rel(file)) && !PROMPT_MODULES.test(rel(file)));
}

export function scanProject({ paths } = {}) {
	const filter = paths && paths.length ? (file) => paths.some((p) => rel(file) === p || rel(file).startsWith(p.replace(/\/?$/, '/'))) : () => true;
	const findings = [];
	for (const file of scannableSvelteFiles().filter(filter)) {
		findings.push(...scanSvelteSource(readFileSync(file, 'utf8'), rel(file)));
	}
	for (const file of scannableTsFiles().filter(filter)) {
		if (PROMPT_MODULES.test(rel(file))) continue;
		findings.push(...scanTsSource(readFileSync(file, 'utf8'), rel(file)));
	}
	return findings;
}

// ── Baseline & exemptions ────────────────────────────────────────────────

function readJson(file, fallback) {
	const full = path.join(ROOT, file);
	if (!existsSync(full)) return fallback;
	const raw = readFileSync(full, 'utf8').trim();
	return raw ? JSON.parse(raw) : fallback;
}

/**
 * Apply the burn-down baseline and the literal exemptions.
 * Returns the findings that remain, plus the problems the lists themselves have.
 */
export function applyAllowances(findings, baseline, exemptions, { scannedFiles = null } = {}) {
	const problems = [];
	const baselineSet = new Set(baseline);
	const remaining = [];
	const seenExemptions = new Set();
	const filesWithFindings = new Set(findings.map((finding) => finding.file));
	for (const finding of findings) {
		const exemption = exemptions.find((entry) => entry.file === finding.file && entry.literal === finding.text);
		if (exemption) {
			seenExemptions.add(exemption);
			continue;
		}
		if (baselineSet.has(finding.file)) continue;
		remaining.push(finding);
	}
	for (const file of baseline) {
		if (scannedFiles && !scannedFiles.has(file)) continue;
		if (!filesWithFindings.has(file)) problems.push(`stale baseline entry: ${file} has no hardcoded strings left — remove it from ${BASELINE_FILE}`);
	}
	for (const exemption of exemptions) {
		if (!exemption.reason || !exemption.reason.trim()) problems.push(`exemption without a reason: ${exemption.file} "${exemption.literal}"`);
		if (scannedFiles && !scannedFiles.has(exemption.file)) continue;
		if (!seenExemptions.has(exemption)) problems.push(`stale exemption: ${exemption.file} no longer contains "${exemption.literal}"`);
	}
	return { remaining, problems };
}

// ── Catalogue ────────────────────────────────────────────────────────────

export function messagePlaceholders(value) {
	const names = new Set();
	const tags = new Set();
	const collect = (text) => {
		for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
		for (const match of text.matchAll(/<\/?(em|code|br|link)\b/g)) tags.add(match[1]);
	};
	if (typeof value === 'string') collect(value);
	else if (Array.isArray(value)) {
		for (const variant of value) {
			for (const declaration of variant.declarations ?? []) {
				const input = /^input\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(declaration);
				if (input) names.add(input[1]);
			}
			for (const text of Object.values(variant.match ?? {})) collect(String(text));
		}
	}
	return { names: [...names].sort(), tags: [...tags].sort() };
}

/** Plural selector categories a variant message provides, keyed by selector name. */
export function pluralCategories(value) {
	if (!Array.isArray(value)) return {};
	const out = {};
	for (const variant of value) {
		const pluralSelectors = new Set();
		for (const declaration of variant.declarations ?? []) {
			const match = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*plural/.exec(declaration);
			if (match) pluralSelectors.add(match[1]);
		}
		for (const key of Object.keys(variant.match ?? {})) {
			for (const part of key.split(',')) {
				const [selector, category] = part.trim().split('=');
				if (pluralSelectors.has(selector)) (out[selector] ??= new Set()).add(category);
			}
		}
	}
	return Object.fromEntries(Object.entries(out).map(([selector, set]) => [selector, [...set].sort()]));
}

/** Categories a locale must and may use. `many` is CLDR's compact-number form for the Romance locales; not required. */
export function pluralRequirements(locale) {
	let allowed;
	try {
		allowed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
	} catch {
		allowed = ['other'];
	}
	const optionalMany = ['es', 'pt', 'fr', 'it', 'ca'].includes(locale.toLowerCase().split('-')[0]);
	const required = allowed.filter((category) => !(optionalMany && category === 'many'));
	if (!required.includes('other')) required.push('other');
	return { required: required.sort(), allowed: [...allowed].sort() };
}

export function canonicalCatalogue(parsed) {
	const sorted = {};
	for (const key of Object.keys(parsed).sort()) sorted[key] = parsed[key];
	return `${JSON.stringify(sorted, null, '\t')}\n`;
}

function projectLocales() {
	const settings = readJson('project.inlang/settings.json', { locales: ['en'] });
	return settings.locales;
}

export function checkCatalogues({ locales, catalogues, usedKeys, dynamicAccessFiles, runtimeImportOffenders }) {
	const problems = [];
	const en = catalogues.en;
	if (!en) return ['messages/en.json is missing'];
	const enKeys = Object.keys(en).filter((key) => !key.startsWith('$'));
	for (const [locale, raw] of Object.entries(catalogues)) {
		if (raw.__canonical !== undefined && raw.__canonical === false) problems.push(`messages/${locale}.json is not in canonical form (sorted keys, tab indent, trailing newline)`);
	}
	for (const locale of locales) {
		const catalogue = catalogues[locale];
		if (!catalogue) {
			problems.push(`messages/${locale}.json is missing`);
			continue;
		}
		if (locale === 'en') continue;
		const keys = new Set(Object.keys(catalogue).filter((key) => !key.startsWith('$')));
		for (const key of enKeys) if (!keys.has(key)) problems.push(`${locale}: missing key ${key}`);
		for (const key of keys) if (!enKeys.includes(key)) problems.push(`${locale}: orphan key ${key} (not in en)`);
		for (const key of enKeys) {
			if (!keys.has(key)) continue;
			const source = messagePlaceholders(en[key]);
			const target = messagePlaceholders(catalogue[key]);
			if (source.names.join() !== target.names.join()) problems.push(`${locale}: ${key} placeholders {${target.names}} differ from en {${source.names}}`);
			if (source.tags.join() !== target.tags.join()) problems.push(`${locale}: ${key} markup tags <${target.tags}> differ from en <${source.tags}>`);
		}
	}
	for (const locale of locales) {
		const catalogue = catalogues[locale];
		if (!catalogue) continue;
		const { required, allowed } = pluralRequirements(locale);
		for (const key of Object.keys(catalogue)) {
			const categories = pluralCategories(catalogue[key]);
			for (const [selector, present] of Object.entries(categories)) {
				const plain = present.filter((category) => !/^\d+$/.test(category));
				for (const category of required) if (!plain.includes(category)) problems.push(`${locale}: ${key} plural ${selector} lacks "${category}" (required: ${required.join('/')})`);
				for (const category of plain) if (!allowed.includes(category)) problems.push(`${locale}: ${key} plural ${selector} uses "${category}", not a category of ${locale}`);
			}
		}
	}
	// notif_* keys are consumed by scripts/i18n-native-strings.mjs (Android notification strings) and listing_* by the
	// store listing test and generator; neither is read by src.
	for (const key of enKeys) if (!usedKeys.has(key) && !key.startsWith('notif_') && !key.startsWith('listing_')) problems.push(`unused message key: ${key} (no m.${key}( in src)`);
	for (const key of usedKeys) if (!enKeys.includes(key)) problems.push(`undefined message key used: m.${key}(`);
	for (const file of dynamicAccessFiles) problems.push(`dynamic message access (m[...]) in ${file}; use the UserMessage registry`);
	for (const file of runtimeImportOffenders) problems.push(`${file} imports $lib/paraglide/runtime — only src/lib/i18n/ may`);
	return problems;
}

function loadCatalogues(locales) {
	const catalogues = {};
	for (const locale of locales) {
		const file = path.join(ROOT, 'messages', `${locale}.json`);
		if (!existsSync(file)) continue;
		const raw = readFileSync(file, 'utf8');
		const parsed = JSON.parse(raw);
		Object.defineProperty(parsed, '__canonical', { value: canonicalCatalogue(parsed) === raw, enumerable: false });
		catalogues[locale] = parsed;
	}
	return catalogues;
}

function collectUsage() {
	const usedKeys = new Set();
	const dynamicAccessFiles = [];
	const runtimeImportOffenders = [];
	const files = listFiles(path.join(ROOT, 'src'), (file) => /\.(ts|svelte)$/.test(file) && !/\.test\.ts$/.test(file)).filter((file) => !SKIP_DIRS.some((dir) => rel(file).startsWith(dir)));
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		// Comment lines are prose about messages, not uses of them.
		const codeLines = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
		for (const line of codeLines) for (const match of line.matchAll(/\bm\.([a-z][a-z0-9_]*)\s*\(/g)) usedKeys.add(match[1]);
		// `m[...]` outside comments, and not a regex-match array (`m[1]`).
		if (codeLines.some((line) => /\bm\[(?!\d)/.test(line))) dynamicAccessFiles.push(rel(file));
		if (/\$lib\/paraglide\/runtime(\.js)?['"]/.test(source) && !rel(file).startsWith('src/lib/i18n/')) runtimeImportOffenders.push(rel(file));
	}
	return { usedKeys, dynamicAccessFiles, runtimeImportOffenders };
}

// ── app.html marker, native, engines ─────────────────────────────────────

export function shippedLocaleTagsFromSource(localesSource) {
	const block = /const SHIPPED_UI_LOCALES = \[([\s\S]*?)\] as const/.exec(localesSource);
	if (!block) throw new Error('src/lib/i18n/locales.ts: SHIPPED_UI_LOCALES block not found');
	return [...block[1].matchAll(/tag:\s*'([^']+)'/g)].map((match) => match[1]);
}

export function appHtmlTags(appHtml) {
	const block = /@generated-ui-locales:start[^\n]*\n\s*var TAGS = (\[[^\]]*\]);/.exec(appHtml);
	if (!block) throw new Error('src/app.html: @generated-ui-locales block not found');
	return JSON.parse(block[1]);
}

function checkAppHtml() {
	const tags = shippedLocaleTagsFromSource(readFileSync(path.join(ROOT, 'src/lib/i18n/locales.ts'), 'utf8'));
	const html = appHtmlTags(readFileSync(path.join(ROOT, 'src/app.html'), 'utf8'));
	return JSON.stringify(tags) === JSON.stringify(html) ? [] : [`src/app.html TAGS ${JSON.stringify(html)} differ from SHIPPED_UI_LOCALES ${JSON.stringify(tags)}`];
}

export function stringNames(xml) {
	return [...xml.matchAll(/<(?:string|plurals)\s+name="([^"]+)"/g)].map((match) => match[1]);
}

function checkNativeStrings() {
	const resDir = path.join(ROOT, 'src-tauri/gen/android/app/src/main/res');
	if (!existsSync(resDir)) return [];
	const base = path.join(resDir, 'values/strings.xml');
	if (!existsSync(base)) return [];
	const notif = stringNames(readFileSync(base, 'utf8')).filter((name) => name.startsWith('notif_'));
	const problems = [];
	for (const entry of readdirSync(resDir)) {
		if (!/^values-/.test(entry)) continue;
		const file = path.join(resDir, entry, 'strings.xml');
		if (!existsSync(file)) continue;
		const names = stringNames(readFileSync(file, 'utf8'));
		for (const name of notif) if (!names.includes(name)) problems.push(`${entry}/strings.xml lacks ${name}`);
		for (const name of names) if (!name.startsWith('notif_')) problems.push(`${entry}/strings.xml translates ${name}; only notif_* is localized (app_name is the product)`);
	}
	return problems;
}

export function checkEngines({ ciPin, packages }) {
	const problems = [];
	const version = semver.coerce(String(ciPin));
	for (const [name, range] of Object.entries(packages)) {
		if (!range) continue;
		if (!semver.satisfies(version, range)) problems.push(`${name} engines.node ${range} rejects the CI Node pin ${ciPin}`);
	}
	return problems;
}

function ciNodePin() {
	const workflow = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
	const match = /node-version:\s*['"]?(\d+)/.exec(workflow);
	return match ? Number(match[1]) : Number(process.versions.node.split('.')[0]);
}

function toolchainEngines() {
	const out = {};
	for (const name of ['@inlang/paraglide-js', '@inlang/sdk', '@inlang/plugin-message-format']) {
		const file = path.join(ROOT, 'node_modules', name, 'package.json');
		if (existsSync(file)) out[name] = JSON.parse(readFileSync(file, 'utf8')).engines?.node ?? null;
	}
	return out;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

export function checkFixtures() {
	const problems = [];
	for (const [file, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
		const full = path.join(ROOT, FIXTURES_DIR, file);
		if (!existsSync(full)) {
			problems.push(`fixture ${FIXTURES_DIR}/${file} is missing`);
			continue;
		}
		const source = readFileSync(full, 'utf8');
		const found = file.endsWith('.svelte') ? scanSvelteSource(source, file) : scanTsSource(source, file);
		if (found.length < expected) problems.push(`fixture ${file}: expected ${expected} findings, scanner reported ${found.length} — the gate is not scanning`);
	}
	return problems;
}

// ── Run ──────────────────────────────────────────────────────────────────

export function runGate({ paths = null } = {}) {
	const findings = scanProject({ paths });
	const baseline = readJson(BASELINE_FILE, []);
	const exemptions = readJson(EXEMPTIONS_FILE, []);
	const scannedFiles = paths ? new Set([...scannableSvelteFiles(), ...scannableTsFiles()].map(rel).filter((file) => paths.some((p) => file === p || file.startsWith(p.replace(/\/?$/, '/'))))) : null;
	const { remaining, problems } = applyAllowances(findings, baseline, exemptions, { scannedFiles });
	const catalogueProblems = paths
		? []
		: checkCatalogues({ locales: projectLocales(), catalogues: loadCatalogues(projectLocales()), ...collectUsage() });
	const other = paths ? [] : [...checkAppHtml(), ...checkNativeStrings(), ...checkEngines({ ciPin: ciNodePin(), packages: toolchainEngines() }), ...checkFixtures()];
	return { findings, remaining, problems: [...problems, ...catalogueProblems, ...other], baselineCandidates: [...new Set(findings.map((finding) => finding.file))].sort() };
}

function main(argv) {
	const args = new Set(argv.filter((arg) => arg.startsWith('--')));
	const pathsIndex = argv.indexOf('--paths');
	const paths = pathsIndex === -1 ? null : argv.slice(pathsIndex + 1).filter((arg) => !arg.startsWith('--'));
	const result = runGate({ paths });
	if (args.has('--baseline')) {
		process.stdout.write(`${JSON.stringify(result.baselineCandidates, null, '\t')}\n`);
		return 0;
	}
	const report = args.has('--report');
	for (const finding of report ? result.findings : result.remaining) {
		process.stdout.write(`${finding.file}:${finding.line} [${finding.kind}] ${JSON.stringify(finding.text)}\n`);
	}
	for (const problem of result.problems) process.stdout.write(`problem: ${problem}\n`);
	const byFile = new Map();
	for (const finding of result.findings) byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
	process.stdout.write(
		`i18n-gate: ${result.findings.length} hardcoded strings in ${byFile.size} files, ${result.remaining.length} outside the baseline, ${result.problems.length} problems\n`
	);
	if (report) return 0;
	return result.remaining.length === 0 && result.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}

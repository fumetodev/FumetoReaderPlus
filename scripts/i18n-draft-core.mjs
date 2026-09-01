/**
 * The drafting pipeline behind `scripts/i18n-draft.mjs`, as pure functions so
 * every rule is testable with a fake fetch and no catalogue on disk.
 *
 * A locale catalogue is drafted key by key from `messages/en.json`. Each
 * written draft records the sha256 of its SOURCE in a sidecar
 * (`messages/<locale>.meta.json`), so a later change to the English text makes
 * the key `stale` and `--check` blocks a release until it is re-drafted (or an
 * acknowledgement with an expiry says why not). A draft that fails validation
 * is never written: placeholder or tag parity, the locale's plural categories,
 * a glossary term dropped, a forbidden register, an untranslated sentence, a
 * length blow-out or lost terminal punctuation each reject it, and the batch
 * gets ONE repair round with the errors spelled out before it is reported.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCatalogue, messagePlaceholders, pluralCategories, pluralRequirements } from './i18n-gate.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** USD per million tokens, for the dry-run ESTIMATE only; the real spend comes from each response's usage. */
export const PRICING_USD_PER_MILLION = {
	'anthropic/claude-sonnet-5': { input: 2, output: 10 },
	'anthropic/claude-opus-5': { input: 5, output: 25 }
};
export const DEFAULT_BATCH = { maxKeys: 40, maxChars: 4000 };
export const MAX_RETRIES = 4;

export function readJson(relative, fallback = undefined) {
	const file = path.join(ROOT, relative);
	if (!existsSync(file)) {
		if (fallback !== undefined) return fallback;
		throw new Error(`${relative} is missing`);
	}
	return JSON.parse(readFileSync(file, 'utf8'));
}

export function catalogueKeys(catalogue) {
	return Object.keys(catalogue).filter((key) => !key.startsWith('$'));
}

/** Every rendered text of a message: the string itself, or each variant's match values. */
export function messageStrings(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap((variant) => Object.values(variant.match ?? {}).map(String));
	return [];
}

export function isVariantMessage(value) {
	return Array.isArray(value);
}

/** Deterministic identity of a source message: NFC text, canonical JSON, first 16 hex chars of sha256. */
export function sourceHash(value) {
	const normalised = JSON.stringify(value, (_key, item) => (typeof item === 'string' ? item.normalize('NFC') : item));
	return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

export function namespaceOf(key) {
	return key.split('_')[0];
}

/**
 * What each key needs: `missing` (no draft), `stale` (drafted from an older
 * source), `orphan` (drafted, no longer in en), `fresh` (drafted from this
 * source). `reviewed` keys are fresh-or-stale like any other; the CLI just
 * refuses to overwrite them without --force-reviewed.
 */
export function classify({ source, target = {}, meta = {} }) {
	const out = { fresh: [], stale: [], missing: [], orphan: [] };
	const sourceKeys = catalogueKeys(source);
	const targetKeys = new Set(catalogueKeys(target));
	for (const key of sourceKeys) {
		if (!targetKeys.has(key)) out.missing.push(key);
		else if (meta[key]?.sourceHash !== sourceHash(source[key])) out.stale.push(key);
		else out.fresh.push(key);
	}
	for (const key of targetKeys) if (!(key in source)) out.orphan.push(key);
	return out;
}

/** Namespace order from namespaces.json; unknown namespaces after the known ones, help always last. */
export function orderKeys(keys, namespaces) {
	const order = namespaces.order ?? [];
	const rank = (key) => {
		const ns = namespaceOf(key);
		if (ns === 'help') return Number.MAX_SAFE_INTEGER;
		const index = order.indexOf(ns);
		return index === -1 ? order.length : index;
	};
	return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Batches never mix namespaces and stay under both caps, so one bad response spoils little. */
export function makeBatches(keys, { source, namespaces, maxKeys = DEFAULT_BATCH.maxKeys, maxChars = DEFAULT_BATCH.maxChars } = {}) {
	const batches = [];
	let current = null;
	for (const key of orderKeys(keys, namespaces)) {
		const ns = namespaceOf(key);
		const chars = messageStrings(source[key]).join(' ').length;
		if (!current || current.namespace !== ns || current.keys.length >= maxKeys || current.chars + chars > maxChars) {
			current = { namespace: ns, keys: [], chars: 0 };
			batches.push(current);
		}
		current.keys.push(key);
		current.chars += chars;
	}
	return batches;
}

/** The plural categories a locale's variant must carry, spelled out for the prompt. */
export function pluralCategoriesFor(locale) {
	return pluralRequirements(locale).required;
}

function sourceShape(value) {
	if (typeof value === 'string') return { kind: 'text', text: value };
	return {
		kind: 'variants',
		declarations: value[0]?.declarations ?? [],
		selectors: value[0]?.selectors ?? [],
		match: value.map((variant) => variant.match ?? {})
	};
}

/** Plural selectors of a variant message (`local nPlural = n: plural`). */
function pluralSelectorsOf(value) {
	const names = new Set();
	for (const variant of value) {
		for (const declaration of variant.declarations ?? []) {
			const match = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*plural/.exec(declaration);
			if (match) names.add(match[1]);
		}
	}
	return names;
}

/**
 * The match keys a locale's draft of a variant message must provide: select
 * keys verbatim, plural keys expanded to the locale's required categories.
 */
export function expectedMatchKeys(sourceValue, locale) {
	const plural = pluralSelectorsOf(sourceValue);
	const keys = new Set();
	for (const variant of sourceValue) {
		for (const matchKey of Object.keys(variant.match ?? {})) {
			const parts = matchKey.split(',').map((part) => part.trim());
			const expanded = parts.map((part) => {
				const [selector] = part.split('=');
				return plural.has(selector) ? pluralCategoriesFor(locale).map((category) => `${selector}=${category}`) : [part];
			});
			const combine = (index, prefix) => {
				if (index === expanded.length) { keys.add(prefix.join(', ')); return; }
				for (const option of expanded[index]) combine(index + 1, [...prefix, option]);
			};
			combine(0, []);
		}
	}
	return [...keys];
}

export const SYSTEM_PROMPT_VERSION = 1;

/** The stable system prompt: the same bytes for every batch of a locale, so prompt caching can help. */
export function systemPrompt({ locale, localeInfo, brief, glossary }) {
	const required = pluralCategoriesFor(locale);
	return [
		`You translate the user interface of FumetoReaderPlus, an Android manga reader and translator, from English into ${localeInfo.endonym} (${locale}).`,
		`Register: ${localeInfo.register}. Follow the style brief exactly.`,
		'',
		'Rules:',
		'- Keep every placeholder like {name} exactly as written: same spelling, same braces. Never translate, rename, add or drop one.',
		'- Keep markup tags exactly as written: <em>…</em>, <code>…</code>, <link name="x">…</link>, <br/>. Translate only the text between tags; text inside <code> stays verbatim.',
		`- Never translate these names: ${glossary.neverTranslate.join(', ')}.`,
		'- Keep the terminal punctuation of the source (a trailing period, colon, ellipsis or question mark maps to its equivalent); do not add a period where the source has none.',
		'- Keep leading/trailing spaces and the capitalisation pattern (Title Case buttons stay short imperatives; sentences stay sentences).',
		'- Control names quoted in the source ("Scan", “Boxes on this page…”) must match how you translate that control elsewhere; the referenceLabels in the request show your own earlier translations — reuse them verbatim.',
		'- No markdown, no quotation marks around the whole translation, no explanations.',
		`- Plural messages: this locale requires exactly these plural categories: ${required.join(', ')}. For every source match key whose selector is a plural (e.g. "nPlural=one"), return one entry per required category ("nPlural=few", …); for select keys (e.g. "direction=rtl", "mode=*") return the same key verbatim.`,
		'- Return JSON only, matching the schema: { "drafts": [ { "key": "…", "text": "…", "match": [ { "category": "<match key>", "text": "…" } ] } ] }. Use "text" for plain messages (then "match" is an empty array); use "match" for variant messages (then "text" is an empty string).',
		'',
		'Style brief:',
		brief.trim(),
		'',
		`(prompt v${SYSTEM_PROMPT_VERSION})`
	].join('\n');
}

export function userPrompt({ locale, namespace, hint, items, referenceLabels }) {
	return JSON.stringify({
		locale,
		namespace,
		screen: hint,
		referenceLabels,
		items: items.map((item) => ({
			key: item.key,
			source: sourceShape(item.source),
			...(item.previous !== undefined ? { previousDraft: sourceShape(item.previous), note: 'The English changed; update this earlier draft rather than starting over.' } : {})
		}))
	});
}

export function responseFormat() {
	return {
		type: 'json_schema',
		json_schema: {
			name: 'ui_drafts',
			strict: true,
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['drafts'],
				properties: {
					drafts: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['key', 'text', 'match'],
							properties: {
								key: { type: 'string' },
								text: { type: 'string' },
								match: {
									type: 'array',
									items: {
										type: 'object',
										additionalProperties: false,
										required: ['category', 'text'],
										properties: { category: { type: 'string' }, text: { type: 'string' } }
									}
								}
							}
						}
					}
				}
			}
		}
	};
}

/** Build the request body. Deliberately no temperature: the provider default is what the drafts were tuned against. */
export function buildRequest({ model, locale, localeInfo, brief, glossary, namespace, hint, items, referenceLabels, previousErrors = null, maxTokens = 16384 }) {
	const messages = [
		{ role: 'system', content: systemPrompt({ locale, localeInfo, brief, glossary }) },
		{ role: 'user', content: userPrompt({ locale, namespace, hint, items, referenceLabels }) }
	];
	if (previousErrors) {
		messages.push({ role: 'user', content: `Your previous drafts for these keys were rejected. Fix exactly the problems listed and return the full set again:\n${JSON.stringify(previousErrors)}` });
	}
	// Reasoning is off: on OpenRouter its tokens count against max_tokens, which
	// is how a 40-key Help batch came back cut off at 6 kB with 8192 allowed.
	return { model, messages, max_tokens: maxTokens, response_format: responseFormat(), reasoning: { enabled: false } };
}

/** Three-step JSON recovery: as-is, fenced, then the outermost braces. */
export function parseDraftResponse(text) {
	const attempts = [text, (/```(?:json)?\s*([\s\S]*?)```/.exec(text) ?? [])[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
	for (const candidate of attempts) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && Array.isArray(parsed.drafts)) return parsed.drafts;
		} catch {
			// next form
		}
	}
	throw new Error('response is not the expected JSON');
}

/** Turn one response entry back into a catalogue value with the source's declarations and selectors. */
export function draftToValue(entry, sourceValue) {
	if (!isVariantMessage(sourceValue)) return typeof entry.text === 'string' ? entry.text : null;
	const pairs = Array.isArray(entry.match) ? entry.match : [];
	if (pairs.length === 0) return null;
	const match = {};
	for (const pair of pairs) if (typeof pair.category === 'string' && typeof pair.text === 'string') match[pair.category] = pair.text;
	return [{ declarations: [...(sourceValue[0].declarations ?? [])], selectors: [...(sourceValue[0].selectors ?? [])], match }];
}

function terminalClass(text) {
	const trimmed = text.replace(/[\s»”"')\]]+$/u, '');
	if (/(\.\.\.|…)$/u.test(trimmed)) return '…';
	if (/[?？]$/u.test(trimmed)) return '?';
	if (/[!！]$/u.test(trimmed)) return '!';
	if (/[:：]$/u.test(trimmed)) return ':';
	if (/[.。]$/u.test(trimmed)) return '.';
	return '';
}

function wordCount(text) {
	return (text.match(/\p{L}+/gu) ?? []).length;
}

/**
 * Validate one draft against its source. Returns the list of problems; an
 * empty list means the draft may be written.
 */
export function validateDraft({ key, source, draft, locale, glossary, namespaces }) {
	const errors = [];
	if (draft === null || draft === undefined) return ['no draft returned'];
	if (isVariantMessage(source) !== isVariantMessage(draft)) return ['shape differs from the source (plain text vs variants)'];
	const sourceTexts = messageStrings(source);
	const draftTexts = messageStrings(draft);
	if (draftTexts.some((text) => text.trim().length === 0)) errors.push('empty text');

	// Placeholders and tags: same set overall, and no invented ones anywhere.
	const sourceNames = new Set(messagePlaceholders(source).names);
	const draftNames = new Set();
	for (const text of draftTexts) for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) draftNames.add(match[1]);
	for (const name of draftNames) if (!sourceNames.has(name)) errors.push(`placeholder {${name}} is not in the source`);
	const usedInSource = new Set();
	for (const text of sourceTexts) for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) usedInSource.add(match[1]);
	for (const name of usedInSource) if (!draftNames.has(name)) errors.push(`placeholder {${name}} was dropped`);
	const tagCounts = (texts) => {
		const counts = {};
		for (const text of texts) for (const match of text.matchAll(/<(\/?)(em|code|link|br)\b/g)) counts[`${match[1]}${match[2]}`] = (counts[`${match[1]}${match[2]}`] ?? 0) + 1;
		return counts;
	};
	if (!isVariantMessage(source)) {
		const sourceTags = tagCounts(sourceTexts);
		const draftTags = tagCounts(draftTexts);
		for (const tag of new Set([...Object.keys(sourceTags), ...Object.keys(draftTags)])) {
			if ((sourceTags[tag] ?? 0) !== (draftTags[tag] ?? 0)) errors.push(`tag <${tag}> count ${draftTags[tag] ?? 0} differs from the source's ${sourceTags[tag] ?? 0}`);
		}
		for (const match of String(source).matchAll(/<link name="([^"]+)">/g)) {
			if (!draftTexts.some((text) => text.includes(`<link name="${match[1]}">`))) errors.push(`link name "${match[1]}" changed`);
		}
		for (const codeMatch of String(source).matchAll(/<code>([^<]*)<\/code>/g)) {
			if (!draftTexts.some((text) => text.includes(`<code>${codeMatch[1]}</code>`))) errors.push(`code fragment <code>${codeMatch[1]}</code> changed`);
		}
	}

	// Variants: the locale's categories exactly; select keys verbatim.
	if (isVariantMessage(source)) {
		const expected = new Set(expectedMatchKeys(source, locale));
		const got = new Set(Object.keys(draft[0]?.match ?? {}));
		for (const matchKey of expected) if (!got.has(matchKey)) errors.push(`missing variant "${matchKey}"`);
		const { allowed } = pluralRequirements(locale);
		const plural = pluralSelectorsOf(source);
		for (const matchKey of got) {
			if (expected.has(matchKey)) continue;
			const parts = matchKey.split(',').map((part) => part.trim());
			const tolerated = parts.every((part) => {
				const [selector, category] = part.split('=');
				return plural.has(selector) && allowed.includes(category);
			});
			if (!tolerated) errors.push(`unexpected variant "${matchKey}"`);
		}
		const categories = pluralCategories(draft);
		for (const [selector, list] of Object.entries(categories)) {
			for (const category of list) if (!allowed.includes(category)) errors.push(`plural category "${category}" does not exist in ${locale} (selector ${selector})`);
		}
	}

	// Glossary: names present in the source survive; forbidden register never appears.
	const sourceJoined = sourceTexts.join('\n');
	const draftJoined = draftTexts.join('\n');
	for (const term of glossary.neverTranslate ?? []) {
		const present = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'u');
		// A declined or possessive form (Fumetos, OpenRouters, Kavitas) keeps the name; three trailing letters is the allowance.
		const kept = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}\\p{L}{0,3}(?![\\p{L}\\p{N}])`, 'u');
		if (present.test(sourceJoined) && !kept.test(draftJoined)) errors.push(`glossary term "${term}" was not kept`);
	}
	for (const pattern of glossary.locales?.[locale]?.forbidden ?? []) {
		const regex = new RegExp(unicodeBoundaries(pattern), 'u');
		const hit = regex.exec(draftJoined);
		if (hit) errors.push(`forbidden form "${hit[0]}" (pattern ${pattern})`);
	}

	// Untranslated: identical to the source when the source is real prose.
	const translatable = sourceTexts.some((text) => wordCount(stripVerbatim(text, glossary)) >= 3);
	if (translatable && draftJoined.normalize('NFC') === sourceJoined.normalize('NFC')) errors.push('identical to the English source');

	// Length: a ratio per namespace, plus slack for short labels.
	const ratio = namespaces.namespaces?.[namespaceOf(key)]?.maxLengthRatio ?? namespaces.defaults?.maxLengthRatio ?? 2;
	const sourceLength = Math.max(...sourceTexts.map((text) => text.length));
	const draftLength = Math.max(...draftTexts.map((text) => text.length));
	if (draftLength > sourceLength * ratio + 10) errors.push(`too long: ${draftLength} chars for a ${sourceLength}-char source (limit ${Math.floor(sourceLength * ratio + 10)})`);

	// Punctuation and whitespace parity, per rendered text where the shapes align.
	if (!isVariantMessage(source)) {
		const sourceText = sourceTexts[0];
		const draftText = draftTexts[0];
		if (terminalClass(sourceText) !== terminalClass(draftText)) errors.push(`terminal punctuation "${terminalClass(draftText) || 'none'}" differs from the source's "${terminalClass(sourceText) || 'none'}"`);
		const lead = (text) => (/^\s*/.exec(text) ?? [''])[0];
		const trail = (text) => (/\s*$/.exec(text) ?? [''])[0];
		if (lead(sourceText) !== lead(draftText) || trail(sourceText) !== trail(draftText)) errors.push('leading/trailing whitespace differs from the source');
	}
	for (const text of draftTexts) {
		if ((text.match(/\(/g) ?? []).length !== (text.match(/\)/g) ?? []).length) errors.push('unbalanced parentheses');
		if (/```|\*\*/.test(text)) errors.push('markdown in the draft');
	}
	return errors;
}

/** JavaScript's \b knows ASCII letters only; a forbidden «Вы» or «ficheiro» needs a boundary that sees Cyrillic and accents. */
export function unicodeBoundaries(pattern) {
	return pattern.replace(/\\b/g, '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))');
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripVerbatim(text, glossary) {
	let out = text;
	for (const pattern of glossary.verbatimPatterns ?? []) out = out.replace(new RegExp(pattern, 'gu'), ' ');
	for (const term of glossary.neverTranslate ?? []) out = out.split(term).join(' ');
	return out;
}

/** Rough token count for the dry-run: prose averages ~3.6 chars per token across these scripts. */
export function estimateTokens(text) {
	return Math.ceil(text.length / 3.6);
}

export function estimateBatchCost({ request, model, pricing = PRICING_USD_PER_MILLION }) {
	const price = pricing[model] ?? pricing[DEFAULT_MODEL];
	const input = request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
	// Drafts run about 1.2× the source JSON; the schema wrapper adds a little.
	const userChars = request.messages.find((message) => message.role === 'user')?.content.length ?? 0;
	const output = Math.ceil((userChars * 1.2) / 3.6) + 50;
	return { inputTokens: input, outputTokens: output, usd: (input * price.input + output * price.output) / 1_000_000 };
}

export function usageCost({ usage, model, pricing = PRICING_USD_PER_MILLION }) {
	const price = pricing[model] ?? pricing[DEFAULT_MODEL];
	return ((usage?.prompt_tokens ?? 0) * price.input + (usage?.completion_tokens ?? 0) * price.output) / 1_000_000;
}

function isUnsupportedResponseFormat(status, message) {
	return status === 400
		&& /response[_ -]?format|structured output|json (?:object|mode|schema)/i.test(message)
		&& /unsupported|not supported|does not support|unknown|unrecognized|invalid parameter|invalid/i.test(message);
}

/**
 * One chat completion with the repo's OpenRouter conventions: retry 429/5xx
 * with backoff honouring Retry-After, retry once WITHOUT response_format when
 * the route rejects it, never send a temperature. `fetchImpl` and `sleep` are
 * injectable so the tests never touch the network.
 */
export async function requestCompletion({ apiKey, body, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetries = MAX_RETRIES, url = OPENROUTER_URL }) {
	let requestBody = { ...body };
	let fallbackUsed = false;
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/fumetodev', 'X-Title': 'FumetoReaderPlus UI drafts' },
			body: JSON.stringify(requestBody)
		});
		if (response.ok) {
			const json = await response.json();
			const choice = json?.choices?.[0];
			const text = choice?.message?.content;
			if (typeof text !== 'string') throw new Error(`response has no message content (finish ${choice?.finish_reason ?? '?'}${json?.error ? `, error: ${JSON.stringify(json.error).slice(0, 200)}` : ''})`);
			return { text, usage: json.usage ?? null, model: json.model ?? requestBody.model, fallbackUsed, finishReason: choice?.finish_reason ?? null };
		}
		const errorText = await response.text().catch(() => '');
		let message = errorText;
		try { message = JSON.parse(errorText)?.error?.message ?? errorText; } catch { /* plain text */ }
		if (!fallbackUsed && requestBody.response_format !== undefined && isUnsupportedResponseFormat(response.status, message)) {
			fallbackUsed = true;
			const { response_format: _dropped, ...rest } = requestBody;
			requestBody = rest;
			continue;
		}
		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt === maxRetries) throw new Error(`OpenRouter ${response.status}: ${message}`);
		const retryAfter = Number(response.headers?.get?.('retry-after'));
		const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1500 * 2 ** attempt);
		await sleep(delay);
	}
	throw new Error('unreachable');
}

function compareSemver(a, b) {
	const pa = String(a).split('.').map(Number);
	const pb = String(b).split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * An acknowledgement lets a stale/missing key ship: `{ locale | '*', keys | '*',
 * reason, expiresBefore }` — valid only while the app version is BELOW
 * `expiresBefore`, so a forgotten one fails the next release rather than
 * hiding the drift forever.
 */
export function acknowledgementFor({ acknowledgements, locale, key, version }) {
	for (const entry of acknowledgements) {
		if (!entry.reason?.trim() || !entry.expiresBefore) throw new Error(`stale-acknowledgements.json: every entry needs a reason and an expiresBefore version: ${JSON.stringify(entry)}`);
		const localeMatches = entry.locale === '*' || entry.locale === locale;
		const keyMatches = entry.keys === '*' || (Array.isArray(entry.keys) && entry.keys.includes(key));
		if (!localeMatches || !keyMatches) continue;
		if (compareSemver(version, entry.expiresBefore) >= 0) return { entry, expired: true };
		return { entry, expired: false };
	}
	return null;
}

/** The release check: nothing stale, missing or orphaned in any drafted locale, unless acknowledged and unexpired. */
export function checkDrafts({ source, locales, targets, metas, acknowledgements = [], version }) {
	const problems = [];
	const summary = {};
	for (const locale of locales) {
		const target = targets[locale];
		if (!target) {
			problems.push(`${locale}: messages/${locale}.json is missing`);
			continue;
		}
		const groups = classify({ source, target, meta: metas[locale] ?? {} });
		summary[locale] = { fresh: groups.fresh.length, stale: groups.stale.length, missing: groups.missing.length, orphan: groups.orphan.length };
		for (const [kind, keys] of [['stale', groups.stale], ['missing', groups.missing]]) {
			for (const key of keys) {
				const acknowledgement = acknowledgementFor({ acknowledgements, locale, key, version });
				if (acknowledgement && !acknowledgement.expired) continue;
				problems.push(acknowledgement ? `${locale}: ${key} is ${kind} and its acknowledgement ("${acknowledgement.entry.reason}") expired at ${acknowledgement.entry.expiresBefore}` : `${locale}: ${key} is ${kind}`);
			}
		}
		for (const key of groups.orphan) problems.push(`${locale}: ${key} is an orphan (not in en)`);
	}
	return { problems, summary };
}

/** Merge validated drafts into a catalogue and its sidecar; returns the canonical file contents. */
export function applyDrafts({ source, target, meta, drafts, model, now }) {
	const nextTarget = { ...target };
	const nextMeta = { ...meta };
	for (const [key, value] of Object.entries(drafts)) {
		nextTarget[key] = value;
		nextMeta[key] = { sourceHash: sourceHash(source[key]), model, draftedAt: now, ...(meta[key]?.reviewed ? {} : {}) };
	}
	for (const key of Object.keys(nextTarget)) if (!key.startsWith('$') && !(key in source)) { delete nextTarget[key]; delete nextMeta[key]; }
	if (source.$schema && !nextTarget.$schema) nextTarget.$schema = source.$schema;
	return { target: nextTarget, meta: nextMeta, targetText: canonicalCatalogue(nextTarget), metaText: canonicalCatalogue(nextMeta) };
}

/** Labels already drafted in the reference namespaces, for the prompt's consistency table. */
export function referenceLabels({ namespace, namespaces, source, target, limit = 120 }) {
	const refs = namespaces.namespaces?.[namespace]?.referenceNamespaces ?? [];
	const out = {};
	let count = 0;
	for (const key of catalogueKeys(target)) {
		if (!refs.includes(namespaceOf(key))) continue;
		if (typeof source[key] !== 'string' || typeof target[key] !== 'string') continue;
		if (source[key].length > 40) continue;
		out[source[key]] = target[key];
		count += 1;
		if (count >= limit) break;
	}
	return out;
}

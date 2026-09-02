#!/usr/bin/env node
/**
 * Draft, re-draft and check the UI locales in messages/.
 *
 *   node scripts/i18n-draft.mjs --locale de [--only-missing|--only-stale|--all]
 *                               [--namespace catalog] [--key catalog_x,...]
 *                               [--model anthropic/claude-sonnet-5] [--budget-usd 5]
 *                               [--concurrency 4] [--allow-partial] [--report path]
 *                               [--force-reviewed]
 *   node scripts/i18n-draft.mjs --dry-run [--locale de]      # plan + cost estimate, NO network
 *   node scripts/i18n-draft.mjs --check                       # release gate, NO network
 *   node scripts/i18n-draft.mjs --mark-reviewed key1,key2 --locale de
 *
 * The key comes from OPENROUTER_API_KEY, or .env when that is unset.
 * A draft that fails validation is never written; the run exits 1 unless
 * --allow-partial. See scripts/i18n-draft-core.mjs for every rule.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DEFAULT_MODEL,
	ROOT,
	applyDrafts,
	buildRequest,
	checkDrafts,
	classify,
	draftToValue,
	estimateBatchCost,
	makeBatches,
	parseDraftResponse,
	readJson,
	referenceLabels,
	requestCompletion,
	usageCost,
	validateDraft
} from './i18n-draft-core.mjs';

function parseArgs(argv) {
	const options = { locales: null, mode: 'draft', selection: 'due', namespaces: null, keys: null, model: DEFAULT_MODEL, budgetUsd: null, concurrency: 4, allowPartial: false, report: null, forceReviewed: false, markReviewed: null };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const next = () => argv[++index];
		switch (argument) {
			case '--locale': options.locales = next().split(',').map((item) => item.trim()).filter(Boolean); break;
			case '--dry-run': options.mode = 'dry-run'; break;
			case '--check': options.mode = 'check'; break;
			case '--only-missing': options.selection = 'missing'; break;
			case '--only-stale': options.selection = 'stale'; break;
			case '--all': options.selection = 'all'; break;
			case '--namespace': options.namespaces = next().split(',').map((item) => item.trim()); break;
			case '--key': options.keys = next().split(',').map((item) => item.trim()); break;
			case '--model': options.model = next(); break;
			case '--budget-usd': options.budgetUsd = Number(next()); break;
			case '--concurrency': options.concurrency = Math.max(1, Number(next()) || 1); break;
			case '--allow-partial': options.allowPartial = true; break;
			case '--report': options.report = next(); break;
			case '--force-reviewed': options.forceReviewed = true; break;
			case '--mark-reviewed': options.mode = 'mark-reviewed'; options.markReviewed = next().split(',').map((item) => item.trim()); break;
			case '--help': case '-h': options.mode = 'help'; break;
			default: throw new Error(`unknown argument ${argument}`);
		}
	}
	return options;
}

/** .env is the repo's home for the OpenRouter key; only read when the environment has none. */
export function loadEnvFile(file = path.join(ROOT, '.env'), env = process.env) {
	if (env.OPENROUTER_API_KEY || !existsSync(file)) return env;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!match || match[1] in env) continue;
		env[match[1]] = match[2].replace(/^["']|["']$/g, '');
	}
	return env;
}

function catalogueFile(locale) {
	return path.join(ROOT, 'messages', `${locale}.json`);
}
function metaFile(locale) {
	return path.join(ROOT, 'messages', `${locale}.meta.json`);
}
function loadLocale(locale) {
	return {
		target: existsSync(catalogueFile(locale)) ? JSON.parse(readFileSync(catalogueFile(locale), 'utf8')) : {},
		meta: existsSync(metaFile(locale)) ? JSON.parse(readFileSync(metaFile(locale), 'utf8')) : {}
	};
}

function selectKeys({ groups, selection, namespaces, keys, meta, forceReviewed }) {
	let selected = selection === 'all' ? [...groups.fresh, ...groups.stale, ...groups.missing]
		: selection === 'missing' ? groups.missing
			: selection === 'stale' ? groups.stale
				: [...groups.stale, ...groups.missing];
	if (namespaces) selected = selected.filter((key) => namespaces.includes(key.split('_')[0]));
	if (keys) selected = selected.filter((key) => keys.includes(key));
	const skippedReviewed = forceReviewed ? [] : selected.filter((key) => meta[key]?.reviewed);
	if (!forceReviewed) selected = selected.filter((key) => !meta[key]?.reviewed);
	return { selected, skippedReviewed };
}

async function runPool(tasks, concurrency) {
	const results = new Array(tasks.length);
	let cursor = 0;
	async function worker() {
		while (cursor < tasks.length) {
			const index = cursor++;
			results[index] = await tasks[index]();
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, log = console.log, env = process.env, envFile = undefined, now = () => new Date().toISOString() } = {}) {
	const options = parseArgs(argv);
	if (options.mode === 'help') { log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return 0; }
	const source = readJson('messages/en.json');
	const localesConfig = readJson('messages/locales.json');
	const glossary = readJson('messages/glossary.json');
	const namespaces = readJson('messages/namespaces.json');
	const acknowledgements = readJson('messages/stale-acknowledgements.json', []);
	const version = readJson('package.json').version;
	const allLocales = Object.keys(localesConfig.locales);
	const locales = options.locales ?? allLocales;
	for (const locale of locales) if (!localesConfig.locales[locale]) throw new Error(`${locale} is not in messages/locales.json`);

	if (options.mode === 'check') {
		const targets = {}; const metas = {};
		for (const locale of locales) { const loaded = loadLocale(locale); if (existsSync(catalogueFile(locale))) targets[locale] = loaded.target; metas[locale] = loaded.meta; }
		const { problems, summary } = checkDrafts({ source, locales, targets, metas, acknowledgements, version });
		for (const [locale, counts] of Object.entries(summary)) log(`${locale}: ${counts.fresh} fresh, ${counts.stale} stale, ${counts.missing} missing, ${counts.orphan} orphan`);
		for (const problem of problems.slice(0, 40)) log(`problem: ${problem}`);
		if (problems.length > 40) log(`… and ${problems.length - 40} more`);
		log(problems.length === 0 ? 'i18n-draft: every locale is current' : `i18n-draft: ${problems.length} problems — run \`npm run i18n:draft\`, or acknowledge in messages/stale-acknowledgements.json with a reason and an expiresBefore version`);
		return problems.length === 0 ? 0 : 1;
	}

	if (options.mode === 'mark-reviewed') {
		if (!options.locales || options.locales.length !== 1) throw new Error('--mark-reviewed needs exactly one --locale');
		const locale = options.locales[0];
		const { meta } = loadLocale(locale);
		for (const key of options.markReviewed) {
			if (!meta[key]) throw new Error(`${locale}: ${key} has no draft to mark`);
			meta[key] = { ...meta[key], reviewed: true, reviewedAt: now() };
		}
		writeFileSync(metaFile(locale), `${JSON.stringify(Object.fromEntries(Object.keys(meta).sort().map((key) => [key, meta[key]])), null, '\t')}\n`);
		log(`${locale}: ${options.markReviewed.length} key(s) marked reviewed`);
		return 0;
	}

	const report = { startedAt: now(), model: options.model, mode: options.mode, locales: {} };
	let spentUsd = 0;
	let anyFailure = false;
	let apiKey = null;
	if (options.mode === 'draft') {
		apiKey = loadEnvFile(envFile, env).OPENROUTER_API_KEY;
		if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (environment or .env)');
	}

	for (const locale of locales) {
		const localeInfo = localesConfig.locales[locale];
		const brief = readFileSync(path.join(ROOT, 'messages/style', `${locale}.md`), 'utf8');
		let { target, meta } = loadLocale(locale);
		const groups = classify({ source, target, meta });
		const { selected, skippedReviewed } = selectKeys({ groups, selection: options.selection, namespaces: options.namespaces, keys: options.keys, meta, forceReviewed: options.forceReviewed });
		const batches = makeBatches(selected, { source, namespaces });
		const localeReport = { keys: selected.length, batches: batches.length, skippedReviewed: skippedReviewed.length, written: 0, failed: [], estimateUsd: 0, spentUsd: 0, fallbacks: 0 };
		report.locales[locale] = localeReport;

		if (options.mode === 'dry-run') {
			for (const batch of batches) {
				const items = batch.keys.map((key) => ({ key, source: source[key], previous: target[key] }));
				const request = buildRequest({ model: options.model, locale, localeInfo, brief, glossary, namespace: batch.namespace, hint: namespaces.namespaces?.[batch.namespace]?.hint ?? '', items, referenceLabels: referenceLabels({ namespace: batch.namespace, namespaces, source, target }) });
				localeReport.estimateUsd += estimateBatchCost({ request, model: options.model }).usd;
			}
			log(`${locale}: ${groups.missing.length} missing, ${groups.stale.length} stale, ${groups.fresh.length} fresh → ${selected.length} keys in ${batches.length} batches, ≈ $${localeReport.estimateUsd.toFixed(2)} (${skippedReviewed.length} reviewed keys skipped)`);
			continue;
		}

		log(`${locale}: drafting ${selected.length} keys in ${batches.length} batches with ${options.model}`);
		// Namespaces are drafted in order so later batches see earlier labels;
		// within a namespace, batches run concurrently.
		const byNamespace = [];
		for (const batch of batches) {
			const last = byNamespace[byNamespace.length - 1];
			if (last && last.namespace === batch.namespace) last.batches.push(batch); else byNamespace.push({ namespace: batch.namespace, batches: [batch] });
		}
		for (const group of byNamespace) {
			if (options.budgetUsd !== null && spentUsd >= options.budgetUsd) { log(`budget of $${options.budgetUsd} reached; stopping before ${group.namespace}`); anyFailure = true; break; }
			const refs = referenceLabels({ namespace: group.namespace, namespaces, source, target });
			const hint = namespaces.namespaces?.[group.namespace]?.hint ?? '';
			const tasks = group.batches.map((batch) => async () => {
				const items = batch.keys.map((key) => ({ key, source: source[key], previous: target[key] }));
				const accepted = {};
				const failed = [];
				let batchSpend = 0;
				let fallbacks = 0;
				// One request for a set of items; a reply cut off by the token limit
				// (finish=length) is retried as two halves, twice deep, before it counts
				// as a failure — long Help paragraphs are where that happens.
				const ask = async (subset, previousErrors, depth) => {
					const request = buildRequest({ model: options.model, locale, localeInfo, brief, glossary, namespace: group.namespace, hint, items: subset, referenceLabels: refs, previousErrors });
					let completion;
					try {
						completion = await requestCompletion({ apiKey, body: request, fetchImpl });
					} catch (error) {
						if (env.I18N_DRAFT_DEBUG) log(`  [debug] ${locale}/${group.namespace}: request failed: ${error.message}`);
						return { entries: [], errors: subset.map((item) => ({ key: item.key, errors: [String(error.message ?? error)] })) };
					}
					if (completion.fallbackUsed) fallbacks += 1;
					batchSpend += usageCost({ usage: completion.usage, model: options.model });
					try {
						return { entries: parseDraftResponse(completion.text), errors: [] };
					} catch (error) {
						if (env.I18N_DRAFT_DEBUG) log(`  [debug] ${locale}/${group.namespace}: ${error.message}; finish=${completion.finishReason ?? '?'}; ${completion.text.length} chars`);
						if (completion.finishReason === 'length' && subset.length > 1 && depth < 2) {
							const half = Math.ceil(subset.length / 2);
							const first = await ask(subset.slice(0, half), previousErrors, depth + 1);
							const second = await ask(subset.slice(half), previousErrors, depth + 1);
							return { entries: [...first.entries, ...second.entries], errors: [...first.errors, ...second.errors] };
						}
						return { entries: [], errors: subset.map((item) => ({ key: item.key, errors: [`${error.message} (${completion.text.length} chars, finish ${completion.finishReason ?? '?'})`] })) };
					}
				};
				let pending = items;
				let previousErrors = null;
				for (let round = 0; round < 2 && pending.length > 0; round += 1) {
					const { entries, errors } = await ask(pending, previousErrors, 0);
					const byKey = new Map(entries.map((entry) => [entry.key, entry]));
					const transport = new Map(errors.map((entry) => [entry.key, entry.errors]));
					const rejected = [];
					for (const item of pending) {
						if (transport.has(item.key)) { rejected.push({ key: item.key, errors: transport.get(item.key) }); continue; }
						const draft = byKey.has(item.key) ? draftToValue(byKey.get(item.key), item.source) : null;
						const problems = validateDraft({ key: item.key, source: item.source, draft, locale, glossary, namespaces });
						if (problems.length === 0) accepted[item.key] = draft; else rejected.push({ key: item.key, errors: problems });
					}
					pending = rejected.map((entry) => items.find((item) => item.key === entry.key));
					previousErrors = rejected;
					if (round === 1) failed.push(...rejected);
				}
				return { accepted, failed, spend: batchSpend, fallbacks };
			});
			const results = await runPool(tasks, options.concurrency);
			const drafts = {};
			for (const result of results) {
				Object.assign(drafts, result.accepted);
				localeReport.failed.push(...result.failed);
				spentUsd += result.spend; localeReport.spentUsd += result.spend; localeReport.fallbacks += result.fallbacks;
			}
			const applied = applyDrafts({ source, target, meta, drafts, model: options.model, now: now() });
			target = applied.target; meta = applied.meta;
			writeFileSync(catalogueFile(locale), applied.targetText);
			writeFileSync(metaFile(locale), applied.metaText);
			localeReport.written += Object.keys(drafts).length;
			log(`  ${group.namespace}: ${Object.keys(drafts).length} written, ${results.reduce((sum, result) => sum + result.failed.length, 0)} failed, $${localeReport.spentUsd.toFixed(2)} so far`);
		}
		if (localeReport.failed.length > 0) {
			anyFailure = true;
			log(`${locale}: ${localeReport.failed.length} keys rejected after repair:`);
			for (const failure of localeReport.failed.slice(0, 25)) log(`  ${failure.key}: ${failure.errors.join('; ')}`);
		}
		const after = classify({ source, target, meta });
		log(`${locale}: ${localeReport.written} written, ${localeReport.failed.length} failed, $${localeReport.spentUsd.toFixed(2)} — now ${after.fresh.length} fresh / ${after.stale.length} stale / ${after.missing.length} missing`);
	}

	report.finishedAt = now();
	report.spentUsd = spentUsd;
	if (options.mode === 'dry-run') {
		const total = Object.values(report.locales).reduce((sum, entry) => sum + entry.estimateUsd, 0);
		log(`dry-run total ≈ $${total.toFixed(2)} with ${options.model} (list-price estimate; the real spend is read from each response)`);
		return 0;
	}
	const reportPath = options.report ?? path.join(ROOT, 'artifacts/i18n-drafts', `${report.startedAt.replace(/[:.]/g, '-')}.json`);
	mkdirSync(path.dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, `${JSON.stringify(report, null, '\t')}\n`);
	log(`report: ${path.relative(ROOT, reportPath)} — total $${spentUsd.toFixed(2)}`);
	return anyFailure && !options.allowPartial ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => process.exit(code)).catch((error) => { console.error(`i18n-draft: ${error.message}`); process.exit(2); });
}

/**
 * Compile `messages/*.json` into `src/lib/paraglide/` outside the Vite plugin.
 *
 * `npm run prepare`, `npm run check` and `npm run test:unit` all need the
 * generated modules to exist before svelte-check / vitest import them, and
 * none of those runs the Vite plugin. This script is the same compile with
 * the same options (`i18n-compile-options.mjs`).
 *
 * Paraglide "successfully compiles" a project whose plugin failed to import —
 * it just emits zero messages and a warning (measured 2026-08-27 with a wrong
 * module path). That would let every `m.x()` call in the app become a type
 * error at best and an empty screen at worst, so this script checks the
 * output: the registry must export every key in `messages/en.json`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@inlang/paraglide-js';
import { OUTDIR, PSEUDOLOCALE_TAG, paraglideOptions, pseudolocaleRequested } from './i18n-compile-options.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sourceMessageKeys(messagesPath = path.join(root, 'messages/en.json')) {
	const parsed = JSON.parse(readFileSync(messagesPath, 'utf8'));
	return Object.keys(parsed).filter((key) => !key.startsWith('$'));
}

export function compiledMessageKeys(outdir = path.join(root, OUTDIR)) {
	const dir = path.join(outdir, 'messages');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith('.js') && !file.startsWith('_'))
		.map((file) => file.slice(0, -3));
}

/** Keys the source has that the compiled output lacks. Empty means a faithful compile. */
export function missingCompiledKeys(source, compiled) {
	const have = new Set(compiled);
	return source.filter((key) => !have.has(key));
}

export async function compileMessages({ pseudolocale = pseudolocaleRequested() } = {}) {
	if (pseudolocale) {
		const { writePseudolocale } = await import('./i18n-pseudolocale.mjs');
		writePseudolocale();
	}
	process.chdir(root);
	await compile(paraglideOptions({ pseudolocale }));
	const missing = missingCompiledKeys(sourceMessageKeys(), compiledMessageKeys());
	if (missing.length > 0) {
		throw new Error(
			`i18n-compile: ${missing.length} message key(s) from messages/en.json did not compile ` +
				`(first: ${missing.slice(0, 3).join(', ')}). The message-format plugin probably failed to load — ` +
				`check the "modules" path in project.inlang/settings.json.`
		);
	}
	return { pseudolocale: pseudolocale ? PSEUDOLOCALE_TAG : null, keys: compiledMessageKeys().length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	compileMessages()
		.then((result) => {
			process.stdout.write(`i18n-compile: ${result.keys} messages${result.pseudolocale ? ` + ${result.pseudolocale}` : ''}\n`);
		})
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		});
}

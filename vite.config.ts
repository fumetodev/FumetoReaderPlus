import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paraglideOptions, pseudolocaleRequested } from './scripts/i18n-compile-options.mjs';
import { writePseudolocale } from './scripts/i18n-pseudolocale.mjs';

// The pseudolocale project reads messages/en-XA.json; generate it before the
// plugin compiles (the CLI script does the same).
if (pseudolocaleRequested()) writePseudolocale();

// Single source of truth for the user-visible version (review B7 — the
// hand-maintained constant in version.ts had drifted from package.json).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };
const now = new Date();
const buildMonth = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Reads one value out of git, or `''` when git is unavailable, the directory
 * is not a checkout, or the command fails. Provenance is best-effort by
 * design: a tarball build or a CI clone without history must still build.
 */
function gitValue(arguments_: string[]): string {
	try {
		return execFileSync('git', arguments_, {
			cwd: repositoryRoot,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return '';
	}
}

const commitSha = gitValue(['rev-parse', '--short', 'HEAD']);
const worktreeDirty =
	commitSha !== '' && gitValue(['status', '--porcelain=v1', '--untracked-files=all']) !== '';
const appCommit = commitSha === '' ? 'unknown' : worktreeDirty ? `${commitSha}-dirty` : commitSha;
// The committer date rather than the build clock, so a given commit always
// reports the same value regardless of when it happens to be compiled.
const appCommitDate = (commitSha === '' ? '' : gitValue(['log', '-1', '--format=%cI'])) || 'unknown';

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__APP_BUILD_MONTH__: JSON.stringify(buildMonth),
		// NOTE: every global added here must also be stubbed in vitest.config.ts,
		// or unit tests that transitively import build-info.ts fail to compile.
		__APP_COMMIT__: JSON.stringify(appCommit),
		__APP_COMMIT_DATE__: JSON.stringify(appCommitDate),
		// Pinned so the flag is ALWAYS a compile-time constant, whether or not
		// the environment sets it. Left undefined, Vite has nothing to replace,
		// `INCLUDES_DEBUG_UI_FIXTURES` never folds to false, and the dead branch
		// that dynamically imports the mobile UI fixture host survives into the
		// bundle — which `audit:overlay-release` correctly rejects. The shipped
		// release was never affected (release:android sets it to '0' explicitly),
		// but a plain `npm run build` produced an output the audit failed, which
		// makes the audit untrustworthy exactly when someone reaches for it.
		'import.meta.env.VITE_FUMETO_DEBUG_UI_FIXTURES': JSON.stringify(
			process.env.VITE_FUMETO_DEBUG_UI_FIXTURES ?? '0'
		),
		// Same rule: the pseudolocale (en-XA, the layout gate's locale) must fold
		// out of every bundle that did not ask for it. release-android.mjs pins
		// this to '0' and audit-overlay-release.mjs forbids the `en-xa` marker.
		'import.meta.env.VITE_FUMETO_PSEUDOLOCALE': JSON.stringify(
			process.env.VITE_FUMETO_PSEUDOLOCALE ?? '0'
		)
	},
	plugins: [
		// Compiles messages/*.json into src/lib/paraglide/ on dev start and on
		// every change; scripts/i18n-compile.mjs does the same for the
		// plugin-less entry points (prepare, check, test:unit).
		paraglideVitePlugin(paraglideOptions({ pseudolocale: pseudolocaleRequested() })),
		sveltekit(),
		tailwindcss()
	],
	worker: {
		format: 'es'
	},
	resolve: {
		conditions: ['browser']
	},
	optimizeDeps: {
		exclude: ['onnxruntime-web']
	}
});

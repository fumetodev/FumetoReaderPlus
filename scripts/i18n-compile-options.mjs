/**
 * The one description of how the UI message catalogue is compiled.
 *
 * Both the Vite plugin (dev server + `vite build`) and `scripts/i18n-compile.mjs`
 * (`npm run prepare`, `check`, `test:unit`, where no Vite plugin runs) read
 * this, so the generated `src/lib/paraglide/` can never differ by entry point.
 *
 * Two inlang projects share one `messages/` directory: `project.inlang` lists
 * the shipped locales, `project.pseudolocale.inlang` adds `en-XA`, the
 * pseudolocale the layout gate runs under. Paraglide inlines every listed
 * locale into every message function, so the only way to keep the
 * pseudolocale out of a release bundle is to compile a project that does not
 * list it — selected by `VITE_FUMETO_PSEUDOLOCALE`, which `release-android.mjs`
 * pins to '0' and `audit-overlay-release.mjs` guards with the `en-xa` marker.
 */
export const PSEUDOLOCALE_ENV = 'VITE_FUMETO_PSEUDOLOCALE';
export const PSEUDOLOCALE_TAG = 'en-XA';
export const OUTDIR = './src/lib/paraglide';

export function pseudolocaleRequested(env = process.env) {
	return env[PSEUDOLOCALE_ENV] === '1';
}

/** @param {{ pseudolocale: boolean }} options */
export function paraglideOptions({ pseudolocale }) {
	return {
		project: pseudolocale ? './project.pseudolocale.inlang' : './project.inlang',
		outdir: OUTDIR,
		// The runtime's own strategies are inert: `src/lib/i18n/locale.ts`
		// overwrites getLocale() with the settings-backed store. `baseLocale`
		// keeps the compiled strategy list honest about the fallback.
		strategy: ['baseLocale'],
		outputStructure: 'message-modules',
		// The repo .gitignore carries the entry (with the generator named);
		// neither prettier nor eslint exist here.
		emitGitIgnore: false,
		emitPrettierIgnore: false,
		includeEslintDisableComment: false,
		emitReadme: false,
		// One bundle, one environment: never a server.
		isServer: 'false',
		disableAsyncLocalStorage: true
	};
}

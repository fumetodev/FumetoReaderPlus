/**
 * Build provenance — what this artifact actually is.
 *
 * A tester's bug report is only useful if the build behind it can be
 * identified. Version alone is not enough: the same version number ships as a
 * debug build, a release build, and (worse) a release build that silently had
 * the debug UI fixtures compiled in.
 *
 * Two kinds of fact live here and they are gathered differently:
 *
 *  - **Build-time** (`__APP_COMMIT__`, `__APP_COMMIT_DATE__`) — injected by
 *    Vite `define`. The commit *date* is used rather than the build clock so a
 *    given commit always reports the same value.
 *  - **Runtime** (`buildType`) — read from the Android bridge, because the Vite
 *    build genuinely does not know which Gradle build type will wrap it. A
 *    build-time constant here would be a guess, and a guess that is wrong
 *    exactly when it matters.
 *
 * `formatBuildLine` is shared by Settings → About and any diagnostics payload,
 * so the two can never disagree about what the build is.
 */

export type BuildType = 'debug' | 'release' | 'unknown';

export interface BuildInfo {
	/** Semver from package.json, e.g. `0.2.1`. */
	version: string;
	/** Short commit SHA, `-dirty` when the tree had changes, or `unknown`. */
	commit: string;
	/** Committer date (ISO 8601), or `unknown`. */
	commitDate: string;
	/** Gradle build type, resolved at runtime. `unknown` off-Android. */
	buildType: BuildType;
	/** Whether the debug UI fixture host was compiled into this bundle. */
	fixtures: boolean;
	/** Whether the layout gate's pseudolocale was compiled into this bundle. */
	pseudolocale: boolean;
}

/**
 * Single definition of the fixture-flag check. Vite statically replaces the
 * `import.meta.env` read, so this stays a compile-time constant.
 */
export const INCLUDES_DEBUG_UI_FIXTURES =
	import.meta.env?.VITE_FUMETO_DEBUG_UI_FIXTURES === '1';

/** Same shape for the pseudolocale: `scripts/i18n-compile.mjs` compiles it in only on this flag. */
export const INCLUDES_PSEUDOLOCALE = import.meta.env?.VITE_FUMETO_PSEUDOLOCALE === '1';

function resolveBuildType(): BuildType {
	try {
		const debug = globalThis.window?.__fumeto_android?.isDebugBuild?.();
		if (typeof debug === 'boolean') return debug ? 'debug' : 'release';
	} catch {
		// The bridge is a JS interface into Kotlin; a throw here must not take
		// the About screen down with it.
	}
	return 'unknown';
}

export function getBuildInfo(): BuildInfo {
	return {
		version: __APP_VERSION__,
		commit: __APP_COMMIT__,
		commitDate: __APP_COMMIT_DATE__,
		buildType: resolveBuildType(),
		fixtures: INCLUDES_DEBUG_UI_FIXTURES,
		pseudolocale: INCLUDES_PSEUDOLOCALE
	};
}

/** `0.2.1 · a1b2c3d · release` — plus ` · fixtures` when they are present. */
export function formatBuildLine(info: BuildInfo): string {
	const parts = [info.version, info.commit, info.buildType];
	if (info.fixtures) parts.push('fixtures');
	if (info.pseudolocale) parts.push('pseudolocale');
	return parts.join(' · ');
}

/**
 * True when the build is anything other than a clean consumer release. The
 * About line is tinted on this so a debug or fixture-carrying build announces
 * itself instead of looking identical to a shippable one.
 */
export function isNonProductionBuild(info: BuildInfo): boolean {
	return info.buildType !== 'release' || info.fixtures || info.pseudolocale || info.commit.endsWith('-dirty');
}

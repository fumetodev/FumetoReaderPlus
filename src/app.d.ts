// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/** Injected by Vite define from package.json (see vite.config.ts). */
	const __APP_VERSION__: string;
	/** Injected by Vite define at build time, MM/YYYY. */
	const __APP_BUILD_MONTH__: string;
	/** Short commit SHA, `-dirty` suffixed, or `unknown` (see vite.config.ts). */
	const __APP_COMMIT__: string;
	/** Committer date of __APP_COMMIT__ (ISO 8601), or `unknown`. */
	const __APP_COMMIT_DATE__: string;
	interface Window {
		__fumeto_android?: {
			getDisplayName(contentUri: string): string;
			/** JSON: {"totalBytes":number,"availBytes":number,"lowMemory":boolean}, or "{}" on failure. */
			getMemoryInfo?(): string;
			getWindowInsets(): string;
			isDebugBuild(): boolean;
			/** App-private external comics directory (implemented in MainActivity.kt; was missing here). */
			getExternalComicsDir?(): string;
			/** The UI locale the WebView renders in, restated at boot and on change, for notification text. Arrives with the native localization step. */
			setUiLocale?(tag: string): void;
			/**
			 * `'user'` lets the device's auto-rotate setting decide (fullUser);
			 * anything else restores the manifest's portrait lock. The reader
			 * holds `'user'` while it is on screen (`reader-orientation.ts`).
			 */
			setOrientationPolicy?(policy: 'portrait' | 'user'): void;
		};
		__fumeto_back_handler?: () => boolean;
	}
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

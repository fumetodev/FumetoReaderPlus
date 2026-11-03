/**
 * What the browser's address field does with what was typed: a web address is opened, anything else is searched for
 * with the engine chosen in Settings. Nothing else is built in — no start sites, no suggestions.
 */

export type BrowserSearchEngine = 'duckduckgo' | 'google' | 'bing' | 'startpage';

export const BROWSER_SEARCH_ENGINES: readonly BrowserSearchEngine[] = ['duckduckgo', 'google', 'bing', 'startpage'];

const SEARCH_URL: Record<BrowserSearchEngine, string> = {
	duckduckgo: 'https://duckduckgo.com/?q=',
	google: 'https://www.google.com/search?q=',
	bing: 'https://www.bing.com/search?q=',
	startpage: 'https://www.startpage.com/do/search?query='
};

export function isBrowserSearchEngine(value: unknown): value is BrowserSearchEngine {
	return typeof value === 'string' && (BROWSER_SEARCH_ENGINES as readonly string[]).includes(value);
}

/** The engine's own name, which is never translated. */
export function searchEngineName(engine: BrowserSearchEngine): string {
	return { duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing', startpage: 'Startpage' }[engine];
}

// A host the way people type one: dotted labels ending in a letter TLD, or localhost / an IPv4 address, with an
// optional port and path.
const HOSTLIKE = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/u;

/** The address to load for `input`, or null for an empty field. */
export function resolveBrowserInput(input: string, engine: BrowserSearchEngine): string | null {
	const text = input.trim();
	if (!text) return null;
	if (/^https?:\/\//i.test(text)) {
		try {
			return new URL(text).href;
		} catch {
			// Not a valid address after all: search for it.
		}
	} else if (!/\s/.test(text) && HOSTLIKE.test(text)) {
		try {
			return new URL(`https://${text}`).href;
		} catch {
			// Fall through to a search.
		}
	}
	return SEARCH_URL[engine] + encodeURIComponent(text);
}

/** The address as the field shows it while not being edited: the host and path, without the scheme. */
export function displayAddress(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname === '/' ? '' : u.pathname;
		return `${u.host}${path}${u.search}`;
	} catch {
		return url;
	}
}

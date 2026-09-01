/**
 * Ambient typings for the vendored foliate-js modules the app imports.
 * The vendor dir is excluded from svelte-check (untyped upstream JS); every
 * name here was pinned against upstream source at the commit recorded in
 * src/lib/vendor/foliate-js/PROVENANCE.md:
 *   - EPUB loader constructor shape: epub.js:936
 *   - book.getCover(): epub.js:1066
 *   - view.open(book)/goLeft/goRight: view.js:233/:519/:522
 *   - renderer.setStyles usage: upstream reader.js:120
 */

declare module '$lib/vendor/foliate-js/view.js' {
	// Side-effect module: registers the <foliate-view> custom element.
}

declare module '$lib/vendor/foliate-js/epub.js' {
	export interface EpubLoader {
		loadText: (name: string) => Promise<string | undefined> | string | undefined;
		loadBlob: (name: string) => Promise<Blob | undefined> | Blob | undefined;
		getSize: (name: string) => number;
		/** Optional SHA-1 for IDPF font deobfuscation; Web Crypto by default. */
		sha1?: (data: unknown) => Promise<unknown>;
	}
	export class EPUB {
		constructor(loader: EpubLoader);
		init(): Promise<unknown>;
	}
}

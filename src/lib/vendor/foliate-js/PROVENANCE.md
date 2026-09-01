# foliate-js (vendored subset)

Upstream: https://github.com/johnfactotum/foliate-js
Commit: `78914aef4466eb960965702401634c2cb348e9b1` (cloned 2026-08-05)
License: MIT (see `LICENSE`, copied verbatim from upstream)

## Why vendored

foliate-js has no npm release; upstream recommends vendoring. It is pure ESM
with no build step and no hard dependencies. Only the reflowable-EPUB reading
path is vendored — the app's ebook reader for `media_kind: 'book'` volumes.
Fixed-layout/comic EPUBs deliberately do NOT use foliate: they route through
the native comic import pipeline (spine-ordered page extraction) so OCR
translation works on them.

## Upstream files (unmodified except one prepended line)

Each carries a single prepended `// @ts-nocheck` banner — the ONLY
modification. It is required because the app's adapter imports pull these
files into the TypeScript program via the module graph, where `checkJs`
would flood the check with ~750 errors; `tsconfig.check.json`'s exclude
only prevents glob inclusion, not import-graph inclusion. When updating
from upstream, re-prepend the banner (diff against upstream should show
exactly that one line per file).

- `view.js` — the `<foliate-view>` element; `open(book)` object path is the
  only entry the app uses (its `File` sniffing path is never called)
- `paginator.js` — reflowable renderer (`flow` = paginated|scrolled via
  attributes; `renderer.setStyles?.(css)` injects content CSS — see upstream
  `reader.js:120` for the reference usage)
- `epub.js` — `new EPUB({ loadText, loadBlob, getSize, sha1 }).init()`;
  `book.getCover()` at `epub.js:1066`
- `epubcfi.js`, `progress.js`, `overlayer.js`, `text-walker.js` — static
  imports of view.js

Note (security, verified in source): the content iframe carries
`sandbox="allow-same-origin allow-scripts"` (`paginator.js:244`) — the
WebKit-bug workaround upstream documents. Script blocking for EPUB content
therefore comes from the app CSP (`script-src` without `blob:`), which the
device spike must verify.

## Stub files (ours, replace unvendored upstream modules)

`fixed-layout.js`, `comic-book.js`, `fb2.js`, `pdf.js`, `mobi.js`,
`search.js`, `tts.js`, `vendor/zip.js`, `vendor/fflate.js` — view.js
references these via literal dynamic imports, which the bundler must be able
to resolve even though the app's book-object path never reaches them (the
zip loader is the app's own `@zip.js/zip.js` via `src/lib/book/
foliate-loader.ts`, so upstream's vendored zip/fflate are dead paths too).
Each stub throws on module evaluation so an accidentally-reached path fails
loudly instead of half-working.

## Updating

Re-clone upstream at a new commit, re-copy the seven real files, keep the
stubs, and update the commit hash here. If upstream adds new dynamic imports
to view.js, add matching stubs (the bundler will point them out).

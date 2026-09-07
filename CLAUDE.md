# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FumetoReaderPlus is a manga/comic reader with library management (local imports + YACReader/Komga/Kavita servers) and AI translation (off-device LLM providers, or fully on-device). It is a SvelteKit 5 + TypeScript SPA running inside a Tauri v2 Android WebView, with native Kotlin/C++ accelerators and a thin Rust layer. **Android is the product**; Linux (x86_64 AppImage) is a beta desktop target that shares the whole frontend and runs llama.cpp through the Rust bridge. macOS and Windows are not built. Offline-first: SSR is disabled and the static adapter emits a single `index.html` for Tauri to load.

The architecture deep-dives are being re-published gradually after the open-sourcing cleanup; until then, this file is the canonical orientation.

## Commands

```bash
npm run dev              # Vite dev server (frontend only, in a browser)
npm run build            # Static SPA build → build/
npm run check            # i18n compile → svelte-check over src/ → native-strings check

npm run tauri:android-build -- --debug   # Android debug APK (for device testing)
npm run tauri:android-build              # Release build (requires signing)
npm run build:android    # SPA build + prune-embed (used by android builds)
npm run build:desktop    # SPA build + the same prune (used by the Linux build)
npm run tauri:linux-build  # Linux AppImage → src-tauri/target/release/bundle/appimage/
npm run release:linux    # preflight → AppImage → overlay audit → dist/linux/ (AppImage + .sha256 + sidecar)
```

Android builds need `ANDROID_HOME`/`NDK_HOME` exported and **JDK 21** (newer JDKs are not supported by this Gradle). Node: `.npmrc` sets `engine-strict=true`, and the dependency tree's `engines` ranges admit Node 22/24/26 but reject 20, 23 and 25 — `npm ci` fails outright on those (CI pins 24 for exactly this reason; see the comment in `.github/workflows/release.yml`).

`src-tauri/gen/android/` is Tauri's generated project, but the Kotlin sources under `app/src/main/java/com/fumeto/reader/`, `app/build.gradle.kts` and `proguard-rules.pro` are git-tracked customizations — re-running `tauri android init` overwrites them; restore with `git checkout -- src-tauri/gen/android/`. `src-tauri/tauri.android.conf.json` swaps the Android `beforeBuildCommand` to `npm run build:android`, and `build.gradle.kts` drives the llama-bridge CMake build (the OpenCL ICD stub is linked from `llama-bridge/opencl-lib/` and excluded from the APK; the vendor driver loads at runtime).

The only CI (`.github/workflows/release.yml`) runs on a `v*` tag push: a first job creates one draft GitHub release from the tag's annotation, then an `apk` job (arm64 APK) and an `appimage` job (Linux x86_64, built inside an `ubuntu:22.04` container so the glibc floor stays at 2.35) run in parallel and upload into it. A manual dispatch with an empty `release_tag` builds release-candidate artefacts only (workflow artefacts, no release); with an existing tag it re-uploads into that release. CI runs no tests. `release:record` creates `v<version>-vc<code>` tags, so pushing one triggers it.

### Release

`npm run version:set -- X.Y.Z` writes the version to all three carriers (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`; `versionCode` = major·1 000 000 + minor·1 000 + patch) — never bump one by hand. `npm run release:android -- --aab` wraps the whole build: `release:preflight` (the three versions agree, the versionCode is not already in the ledger, clean worktree, `i18n:draft:check`, then `check`), `tauri android build` with `VITE_FUMETO_DEBUG_UI_FIXTURES=0`/`VITE_FUMETO_PSEUDOLOCALE=0` pinned, and `release:collect` into `dist/android/`. The default is an APK; Play needs `--aab`. `npm run release:record -- --artifact dist/android/<name> --track <internal|closed-testing|open-testing|production>` runs **after the Play upload, not after the build** — it appends to `release-ledger.json` (which is what marks that versionCode spent) and creates the `v<version>-vc<code>` tag. Keystore and `key.properties` are gitignored. `npm run release:linux` runs the same preflight, builds the AppImage, runs the overlay audit on the embedded web build and collects `dist/linux/fumeto-<version>-x86_64.AppImage` with a `.sha256` and a JSON sidecar; a locally built AppImage embeds the host's WebKitGTK and glibc floor and is a test artefact — the release AppImage is CI's. One tag ships both artefacts; the ledger stays Play-only (the AppImage burns no versionCode). Workflow is trunk-based on `main` with short-lived branches.

## Architecture

### Big picture

One route (`src/routes/+page.svelte`); `appView` switches between `catalog | tabs | reader | settings`. All product state and business logic live in the WebView (TypeScript). Native code is **stateless accelerators plus lifecycle services** — nothing durable lives in Kotlin/Rust. Durable data is in Dexie/IndexedDB (DB name `fumetoreaderplus`, kept for user-data preservation) plus app-private files for downloaded models.

Kotlin bridges injected into the WebView (`src-tauri/gen/android/.../MainActivity.kt`):

- `__fumeto_android` — insets, content-URI display names
- `__fumeto_back_handler` — not an injected object but a JS global the frontend defines; the Kotlin back-press callback calls it and only exits the app when it returns `true`
- `__fumeto_ppocr_native` — PP-OCR det/rec via onnxruntime-android (preferred over WASM)
- `__fumeto_rtmdet_native` — rtmdet-manga layout detection
- `__fumeto_llama` — Hy-MT2 GGUF inference via `libfumeto_llama.so` (vendored llama.cpp under `src-tauri/llama-bridge/llama.cpp` — a plain checkout, NOT a submodule; pinned SHA in `llama.cpp-version.txt`)
- `__fumeto_service` — foreground services (background batch translation keep-alive, model residency); the JS translation loop keeps running unchanged, no logic moves to Kotlin

Each native bridge has a WASM/JS fallback path so the app still works in a plain browser (`npm run dev`).

### Key invariants (violating these is a bug)

#### Core

- **Overlay data is schema V2 only** (`PageOverlayDataV2`, content-hashed IDs, deterministic render plans — ADR-0006). Legacy records are purged on read, never rendered.
- **All remote/CPU work goes through `WorkCoordinator` lanes** (`src/lib/work-coordination/`, ADR-0001). YACReader transport is single-flight per server — the Qt server crashes on concurrent connections.
- **Cancellation is a first-class contract**: `AbortSignal` threads through detection → translation → layout; the reader controller distinguishes user-cancel from supersession.
- **Dexie migrations are append-only**: add new versions in `src/lib/db/schema.ts`, never edit existing ones.
- **Tabs are explicit-only**: opening/reading a volume never mutates the tab list; the Continue Reading strip is derived from `last_read_at` via one global query (`src/lib/catalog/continue-reading.ts`).
- **Book reader navigates in whole-book pages**, not spine sections; sections are persistence-only. Never navigate by writing `currentPageIndex`.

#### Catalog and remote libraries

- **No auto re-sync of remote libraries**: after initial indexing, manual Scan is the only refresh. The gate is `catalog_index_state.remote_index_completed_at`, stamped only by a crawl that finished with zero failures, and read through `remoteStartupSyncPlan` by all three providers. Deliberately NOT `completeness`, which the catalog migration writes as `'ready'` for any library that has rows.
- **A folder's freshness lives on `contentsFetchedAt`, never `lastFetched`.** `lastFetched` records when a folder ROW was written — i.e. when it appeared in its parent's listing. Only `contentsFetchedAt` means "this folder's own contents were fetched".
- **Server-side deletions are propagated on manual Scan only, and only on positive confirmation.** Absence from a listing merely nominates; deletion requires the server to answer `not_found` for that exact item (`src/lib/catalog/remote-prune.ts`). Any other outcome — a 200, a network error, a 5xx, an auth failure — leaves the row alone.
- **A library being deleted is fenced, and every provider must check the fence** (`src/lib/catalog/remote-library-fence.ts`). `assertLibraryWritable` before any write, in the crawl loop as well as at the entry point — a crawl runs for minutes and the delete is a tap. A volume written after `deleteLibraryData` has read its volume list survives under a `library_id` nothing lists: it renders nowhere, no delete path reaches it, and nothing sweeps in that direction.
- **A crawl that resolved is not a crawl that succeeded.** Report the outcome through `reportRemoteSyncOutcome(libraryId, failures)`, never `reportRemoteSyncSuccess` unconditionally — clearing the failure entry is the user's only sign anything went wrong, and for Komga/Kavita a failed crawl also withholds the completion stamp, so the next launch silently re-crawls.
- **Deleting a volume goes through `deleteVolumeRowsInTransaction`** with `volumeScopedTables()` as the transaction scope (`src/lib/catalog/catalog-repository.ts`). Never hand-roll the cascade: Dexie throwing on an undeclared table is what keeps the scope and the deletes from drifting apart.
- **A remote sync never overwrites a user-owned field.** Guard on record EXISTENCE, not `existing?.field ?? …` — the reader's quick toggle writes `undefined` to mean "follow the global default", so a `??` chain re-pins a volume the user deliberately un-pinned.

#### Overlay layout: geometry and rendering

- **A shared region is carved by usable AREA, not by height** (`partitionByDemand` in `src/lib/overlay-layout/geometry.ts`). Two utterances in one balloon, or several vertical columns in one bubble, get bands proportioned by the ink each can actually hold — a band across a waist or a taper holds a fraction of what a mid-body band of the same height does. Boundaries snap onto necks, and the neck itself is given to neither utterance. Where a container has as many lobes as utterances, each is matched to the lobe its own SOURCE sits in; source position is ground truth and needs no assumption about reading direction.
- **"Two bubbles drawn conjoined" has one definition**: `polygonLobeSplit`. `polygonWaistSplit` is a two-lobe wrapper over it. A waist is narrow from BOTH sides — a notch, narrow from one, is a dent and must not split.
- **Hyphenation is English-only, and `'und'` is not English.** The patterns are hyph-en-us and the document's locale is the translation TARGET. `overlayTargetLocale` is the single resolution point — the adapter's `'und'` fallback would silently stop hyphenating for English readers, and `validate:overlay-layout` fails if a construction bypasses it.
- **`tailPolygon` is dead code in production.** Nothing in `src/lib` writes it, so no document the app builds carries one and the planner's tail-exclusion never runs on a real page. A development bench re-attaches it after the adapter, deliberately and visibly, so the probe survives without reading as something production does.
- **`'unknown'` is not "not dialogue" — it is "we do not know".** The adapter launders both `borderless` (unenclosed narration, classifier confidence 0.66) and a genuine classification failure (0.45) onto that one type. Only SFX may be suppressed from the reader's review affordances; suppressing `'unknown'` gave the least help to the text most likely to be laid out badly. `OverlayItemV2.classificationConfidence` separates the two, is quantized to 0.01 because it enters the layout input hash, and is written only when the production classifier decided the type — a provider label is not a measurement, and absent confidence means "not uncertain".
- **A stacked band is exempt from every score term that asks about the item's own source.** `displacement`, `sourceUncovered` and `hyphenatedBreaks` all do, and a band's position, extent and width are the shared REGION's — charging a member for them measures someone else's decision. Each was worth measurable damage when left in: 2–4 points, 15 points, and one member of a stack dropping 33.5px/1 hyphen to 28.25px/2.
- **An unbounded item's ERASURE is sized by the source; its CARD stays sized by the ink.** They are separate shapes for a reason. A card tightened onto horizontal English cannot cover the tall narrow run of vertical Japanese it replaces, and widening the card instead would inflate `boxGrowth` (weight 12 for free layout), protected-art scoring and collision — making exactly the placements we want look expensive. The erasure is one rectangle per detected column, never one over their union: the gutters between a run's columns are artwork and are usually more than half its width.
- **A soft edge on an erasure ramps OUTWARD.** Feathering inward puts the translucent bands over the lettering they exist to erase, and fragments of the original show back through around the edge of the block. Peak coverage is reached at the source's own boundary; the ramp lands on the paper beyond it. Since policy-31 the peak is deliberately translucent (0.8, fading to 0.05 at the fringe — `FEATHER_CORE_COVERAGE`/`FEATHER_EDGE_COVERAGE` in `presentation.ts`): an unbounded whitewash sits on artwork, and the art ghosting through at 20% is the intended look, not a compositing bug.
- **The feather is a fixed step count with explicit alphas, never a blur.** SVG `fill-opacity` and canvas `globalAlpha` composite source-over with identical arithmetic; an SVG filter and `ctx.filter` do not match, and three surfaces paint the same plan.
- **Any pass that re-lays text out must re-tighten an ink-derived card.** `renderedRect` for a free item is `tightInkRect` measured at the size assignment chose; `maximizeSelectedFonts` then grows the font at the same window, and the ink outgrows the card. The fuzz gate catches it as a clipping violation, which is what it is.
- **A surface that cannot offer the translation must not erase the source** (the reveal contract). Paged and long-strip both offer tap-to-reveal; CBZ export cannot, so export leaves the original readable rather than whitewashing it.

#### Detection and balloon grouping

- **Two balloon instances for one balloon are resolved by CONFIDENCE, not size.** rtmdet's box-IoU NMS keeps a lobe of a conjoined balloon (box IoU ≈ 0.3 against the whole), usually at a score just above the 0.35 threshold; `assignBubble` then calls every column inside both "ambiguous" and refuses to group any of them. `suppressNestedBalloonInstances` (≥ 0.9 inside, area within 4× — the same scale `assignBubble` uses) keeps the more confident instance, and runs in both segmenters AND at the grouper's entry so cached replays see it. Measured on real pages: in 3 of 16 nested pairs the LARGER instance is the ghost, so "drop the small one" is wrong.
- **One balloon is one utterance; the balloon is the grouping evidence, not the gaps between its columns.** Two components well inside the same detected balloon (`BALLOON_MEMBER_OVERLAP`, ≥ 0.5) merge on direction, orientation and the column pitch alone (`xGap ≤ 2.1` glyphs — within-utterance columns measure ≤ 1.75, two speakers sharing a conjoined balloon 2.93): a staggered column that starts below where its neighbour ended still joins, emphasis set up to 3.5× larger still joins, and no bbox-area cap, span cap or row split applies inside a balloon — the balloon bounds the text. A reader's device had 31 same-speaker balloons cut in two by exactly those four gates, and the reviewed labels put every one of those quantities on the one-group side. A component only leaning into a balloon (overlap < 0.5, a sigh drawn across the rim) never joins its members (`balloon-rim`). Rows of columns are one group read row by row: `COLUMN_ROW_GAP_GLYPHS` (0.85; column-cuts ≤ 0.5, rows ≥ 1.20) decides READING ORDER only — a split on it shipped for one day and contradicted every reviewed label it touched.

#### On-device models

- **The manga guidance blocks are generated, never hand-edited** (`scripts/generate-manga-guidance.mjs` → `llama-bridge/manga_guidance.h`, `src-tauri/src/manga_guidance.rs`). They are the exact per-target terminology the Hy-MT2 v3 fine-tune trained on; editing one moves the prompt off its training distribution. `--check` re-derives them from the frozen machine-local fine-tune config (`FUMETO_DATASET_CONFIG`) and fails on drift. Guidance is keyed on the language **code**, so "zh-Hans" and "Simplified Chinese" cannot disagree.
- **Every language the on-device picker offers must exist in both native name tables.** `getLangName` falls back to the raw code, so a missing entry ships a prompt reading "into zh-Hans" with nothing failing. The C++ and Rust language tables must stay in sync.
- **The llama worker count is one thread per fast core (clamp 4..6), read from `MIDR_EL1` at bridge init — never a per-SoC table and never an affinity mask** (`src-tauri/llama-bridge/cpu_topology.h`). ggml's per-op barrier runs at the slowest worker's pace, so a sixth thread on a Snapdragon 8 Gen 2's five fast cores cost 10 % and made throughput unstable; pinning the right count to the fast cores measured identical to leaving the scheduler alone, and the Snapdragon 8 Elite has no little cores at all, so any SoC-name rule is wrong in both directions. Unknown and unreadable cores count as fast (degrades to the old fixed 6, never below). Six is the cap on measurement, not on the old trial: on the Snapdragon 8 Elite's eight fast cores generation is flat from 4 threads up and 8 threads buys 11 % prompt speed — about 5 ms of a bubble — for every core the WebView and OCR would otherwise have.
- **The bundled models' load path is checked first and must stay byte-identical.** `nativeLoadModel` resolves a template mode — Hunyuan-dense, then the model's own embedded template, then a user-supplied prefix/suffix, then rejection. Only a model that fails the Hunyuan check reaches the newer branches, and BOS is force-prepended only for Hunyuan (others honour `llama_vocab_get_add_bos`).
- **A user-imported model is stored under a fixed filename, never the picked display name**, which is untrusted text from the document picker. Deleting it clears the settings record as well as the file: `activeHyMT2Variant()` degrades a `'custom'` selection to stock only while no record exists.

#### Localization

- **Two language axes, never coupled after first run.** `settings.uiLocale` is what the menus say; `targetLanguage`/`onDeviceTargetLang` is what the manga becomes. A fresh install seeds the target from the UI locale ONCE (`pt-BR`→`pt`); changing the UI later never touches it. `getLanguagePromptName` (in `settings/language-prompt-names.ts`, a prompt module the gate skips) is frozen English because the Hy-MT2 fine-tune saw those names — pickers use `getLanguageDisplayName` from `$lib/i18n`.
- **Every user-facing string is a message; stores and records hold codes.** Components call `m.<key>()` from `$lib/paraglide/messages.js` (generated, gitignored; `npm run i18n:compile`); persisted/store text is a `UserMessage { code, params }` rendered by the component, and every code has a `RENDERERS` entry.
- **A drafted locale that is behind its English source never ships.** Each draft carries the sha256 of the source it was made from (`messages/<locale>.meta.json`); `npm run i18n:draft:check` (offline, run by `release:preflight`) fails on stale/missing/orphan keys unless `messages/stale-acknowledgements.json` names a reason and an `expiresBefore` version. `npm run i18n:draft` re-drafts only what changed and writes only what the validator accepts (placeholders, tags, the locale's plural categories, glossary, register, length, punctuation). Never-translate terms are `messages/glossary.json`, not prose in a prompt; a hand correction is marked `reviewed` so a re-draft cannot overwrite it.

#### Linux build

- **llama.cpp on desktop is built for a fixed x86-64 baseline, never for the build host.** `build.rs` sets `GGML_NATIVE=OFF` and pins SSE4.2/AVX/AVX2/FMA/F16C/BMI2 on and every AVX-512 flag off; ggml's own defaults flip to "no ISA at all" when `SOURCE_DATE_EPOCH` is set and to "whatever this CPU has" otherwise, so every flag is explicit. `desktop.rs::cpu_missing_features` is the matching runtime gate (a `cpu-unsupported:` error instead of SIGILL) and its list must change together with the defines.
- **Prune parity.** `build:desktop` and `build:android` run the same `scripts/prune-embed.mjs`; Linux downloads the PP-OCR and layout models on first use exactly like Android (`ocr-model-manager.ts` gates on a Tauri host, not on Android). A desktop build that embeds the ONNX models is a regression, not a convenience.
- **Capability split.** `capabilities/default.json` is the Android permission set and is never widened; Linux additions (fs watch, file handles, fullscreen, the any-path fs scope) live in `capabilities/linux.json` under `platforms: ["linux"]`. The broad scope is justified by the native folder picker being the gate; `requireLiteralLeadingDot: false` is Linux-only config in `tauri.linux.conf.json`.
- **No Cargo profile changes for desktop performance.** Profiles are global and would alter the Android library; linuxdeploy strips the binary anyway, and llama.cpp's optimisation level comes from the `cmake` crate's profile mapping. Desktop-only crate features (`tauri-plugin-fs` `watch`, `tauri` `devtools`) go in the `cfg(not(any(target_os = "android", target_os = "ios")))` dependency table, never in the shared one — a global `devtools` feature would enable WebView debugging on release APKs.
- **The WebKitGTK DMA-BUF workaround is opt-out, not forced.** It is applied only when an NVIDIA kernel module is loaded and `WEBKIT_DISABLE_DMABUF_RENDERER` is unset; `FUMETO_NVIDIA_WORKAROUND=off` disables it. It runs before the Tauri builder because GTK reads the variable at init.
- **The linuxdeploy GTK hook is vendored** (`src-tauri/linuxdeploy/`) and copied into the bundler's cache before a build. Its only change from upstream keeps `GDK_BACKEND=x11` as the default while letting a user opt into Wayland; the AppImage is an X11 client by construction.

### Domain map (src/lib/)

- `db/` — Dexie schema + singleton. `catalog/` — catalog projection, Continue Reading, virtual windowing. `library/`, `yacreader/`, `komga/`, `kavita/` — sources and server clients. `import/` — ZIP/RAR/PDF extraction into IndexedDB.
- `reader/` — `PageSource` abstraction (local/remote/prefetched implementations via `page-source-factory.ts`), LRU image cache, page-mode detection. `book/` — EPUB reader on vendored `foliate-js` (`src/lib/vendor/foliate-js`); `media_kind` absent ≡ comic, `'book'` ≡ EPUB (`book/media-kind.ts`). `panzoom/` — gesture handling with explicit content dimensions.
- `detection/` — PP-OCRv6 detection + CTC recognition (ONNX), YOLO bubble segmentation, spatial merge. Detection and recognition use **different image normalizations** — mixing them fails silently. Raw regions feed the recognizer; merged regions feed the overlay.
- `translation/` — provider adapters (OpenRouter/Claude/OpenAI-compat/local) behind `llm-client.ts`; region/full-page/2-pass volume translation (checkpointed per page, resumable); non-destructive revision; Mode 1/2/3 context (isolated / page / rolling work context). On-device pipeline is PP-OCR + Hy-MT2 only — ML Kit was removed and both settings axes are hard-pinned (`onDeviceOCRProvider: 'ppocr'`, `onDeviceTranslationBackend: 'translategemma'`; the `translategemma` literal is kept for settings-migration stability and means Hy-MT2).
- `overlay-layout/` — V2 canonical render-plan engine (placement, fills, bidi, baked cache). `export/` — CBZ export rendering overlays via the same canonical plans.
- `tabs/`, `controllers/`, `navigation/`, `stores/` — UI state machines. Components use Svelte 5 runes; `stores/` uses classic `writable`/`derived`.
- `regions/` — guided regions (user-drawn boxes: draw session, cropper, per-region translation run). `billing/` — Play Billing bridge, entitlement policy, `PRO_FEATURES`. `i18n/` — locale tables, `getLanguageDisplayName`, `UserMessage` renderers; `paraglide/` — generated message functions (gitignored). `diagnostics/` — always-on error ring, boundary and report. `benchmark/` — the in-app PP-OCR/model-candidate benchmark host that the e2e specs drive. `work-coordination/` — the lanes.
- There is no feature flag for overlay v2 — it is the only overlay system. Desktop-only paths (Rust llama commands, `src-tauri/src/desktop.rs`, `library-watcher`, the GitHub update check) are inert on Android.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) in components; classic store API in `stores/`. `$lib` → `src/lib/`. No SSR (`+layout.ts` sets `ssr = false`, `prerender = false`).
- **Tailwind CSS v4** via `@tailwindcss/vite`. 12 color schemes override `--color-primary-*`/`--color-surface-*` at runtime (`settings/color-schemes.ts`; regenerate with `npm run schemes:generate`). Safe-area CSS vars: `--sat`, `--sab`, `--viewport-height` (Android reports `env(safe-area-*)` as 0 — use the vars).
- **ONNX models** live in `static/models/`, ONNX Runtime WASM in `static/wasm/` — loaded at runtime, never imported; ONNX Runtime is excluded from `optimizeDeps`, workers use `format: 'es'`.
- **API keys** are AES-256-GCM encrypted via Web Crypto (`settings/secure-storage.ts`); settings use localStorage with filesystem fallback. Two rules here are load-bearing, because breaking either loses every stored secret *silently*:
  - **The device key may be generated only on positive proof it is absent** (an `exists()` check). "I could not read it" must never be treated as "there is none" — generating over a key that is merely unreadable orphans every ciphertext, and decrypt failures surface as an empty string, so the user is told their key is unset and re-entering it makes the loss permanent. On an unreadable key `secure-storage` fails closed and says so. Fail-closed applies only where a filesystem exists: the Tauri fs plugin imports cleanly in a browser and only its *calls* fail, so no Tauri host means "absent" by construction.
  - **The Pro entitlement cache and every encrypted secret are mirrored to `$APPDATA/secure-store.json`** (`settings/durable-store.ts`), because Android can evict WebView localStorage. The mirror's three-state status (`loaded` / `unreadable` / `unavailable`) is the safety mechanism — `unreadable` must never be read as "empty", and the entitlement restore is upgrade-only so a failed check can never revoke Pro.
- `.npmrc` sets `engine-strict=true` (Node version constraints are under Commands).

# Fumeto Reader Plus

A manga and comic reader for Android that **translates the page you're
looking at — entirely on your device if you want**. Speech bubbles are
detected, read, translated, and re-lettered inside the original balloons;
one tap flips back to the untranslated page.

<p align="center"><img src=".github/demo/hero.webp" width="420" alt="A manga page being translated on-device: speech bubbles are detected and re-lettered in English inside the original balloons"></p>

Free, no ads, no accounts, no analytics. GPL-3.0.

[**Get it on Google Play**](https://play.google.com/store/apps/details?id=com.fumeto.reader) ·
[GitHub releases](https://github.com/fumetodev/FumetoReaderPlus/releases) (APK, works with [Obtainium](https://github.com/ImranR98/Obtainium))

## What it does

- **Read** CBZ/CBR/PDF archives and EPUB books, imported locally or served from
  your own **Komga / Kavita / YACReaderLibraryServer** — credentials stay on
  the device and only ever go to your server.
- **Translate** two ways, both free and unmetered:
  - **On-device**: PP-OCR text detection/recognition + a Hy-MT2 1.8B model
    fine-tuned specifically for manga (ONNX Runtime + llama.cpp, no network,
    no key). Around 6–16 s per page on a current flagship.
  - **Bring your own key**: OpenRouter or any OpenAI-compatible endpoint,
    including LM Studio / Ollama on your LAN.
- **Letter it properly**: translations are laid out inside the detected
  balloons by a deterministic layout engine — conjoined balloons are split at
  their necks, shared balloons are carved by usable area, unbounded vertical
  runs get translucent feathered erasures, English gets real hyphenation.
  Every box can be dragged or edited, and edits persist.
- Whole-volume batch translation (resumable, with an optional 2-pass
  consistency review), revision passes, translated-CBZ export, guided-region
  translation, webtoon long-strip mode, right-to-left paging, tabs, and a UI
  drafted into 8 languages.

## Building

Prerequisites: **JDK 21** (exactly — newer JDKs are not supported by this
Gradle), Android SDK + **NDK 29.0.13846066** (`ANDROID_HOME`, `NDK_HOME`
exported), Rust stable, and Node 22/24/26 (`engine-strict` rejects 20/23/25).

```bash
npm ci
npm run dev                              # frontend only, in a browser (WASM fallbacks)
npm run tauri:android-build -- --debug   # debug APK
npm run tauri:android-build              # release (needs a signing keystore + key.properties, both gitignored)
```

The first Android build compiles the vendored llama.cpp for each ABI
(~20 minutes). The rtmdet layout model (~43 MB) is fetched from Hugging Face
during the Gradle build.

## Tests

The test and evaluation suites (unit, UI, device journeys, and the
overlay/OCR evaluation harnesses) are maintained privately, together with the
licensed evaluation corpora they run against. `npm run check` covers the
static gates that ship here.

## Project notes

- SvelteKit 5 SPA running inside a Tauri v2 Android WebView; Kotlin/C++
  accelerators (ONNX Runtime, llama.cpp) behind injected JS bridges; all
  product state lives in the WebView (Dexie/IndexedDB). Desktop builds exist
  but are experimental and unsupported.
- `CLAUDE.md` is the contributor orientation: commands, architecture map, and
  the invariants the test gates enforce.
- This repository is a **cleaned import**: the app was developed privately for
  several months and the history was reset when it was open-sourced.
  Development continues here.

## Licence

GPL-3.0-only (`LICENSE`). Third-party components and models keep their own
licences — see `THIRD-PARTY-NOTICES.md`. Sample imagery in the Help pages and
fixtures is from *Give My Regards to Black Jack* © SHUHO SATO, used under the
publisher's free secondary-use terms (attribution ships in `static/licenses/`).

Questions, bugs, requests: **fumetoreaderdev@gmail.com** or the issue tracker.

# Third-party notices

FumetoReaderPlus is licensed under GPL-3.0-only (see `LICENSE`). It builds on
the third-party work below. Every component keeps its own licence; the upstream
licence files vendored into this repository are the authoritative texts.

## Vendored source

| Component | Where | Licence |
|---|---|---|
| llama.cpp + ggml | `src-tauri/llama-bridge/llama.cpp/` (flat copy of the upstream tree; pinned commit in `src-tauri/llama-bridge/llama.cpp-version.txt`) | MIT (`llama.cpp/LICENSE`) |
| — cpp-httplib | `…/llama.cpp/vendor/cpp-httplib/` | MIT |
| — nlohmann/json | `…/llama.cpp/vendor/nlohmann/` | MIT |
| — stb_image | `…/llama.cpp/vendor/stb/` | public domain / MIT dual |
| — subprocess.h (sheredom) | `…/llama.cpp/vendor/sheredom/` | Unlicense |
| — miniaudio | `…/llama.cpp/vendor/miniaudio/` | MIT-0 / public-domain dual |
| — gguf-py | `…/llama.cpp/gguf-py/` | MIT |
| foliate-js | `src/lib/vendor/foliate-js/` (John Factotum; pinned commit in its `PROVENANCE.md`) | MIT (`foliate-js/LICENSE`) |
| — `vendor/fflate.js`, `vendor/zip.js` inside foliate-js | project-authored fail-loud stubs (see their headers and `PROVENANCE.md`) — **no upstream fflate/zip.js code is vendored there** | GPL-3.0 (this project) |
| Khronos OpenCL headers | `src-tauri/llama-bridge/opencl-headers/` | Apache-2.0 |
| Khronos OpenCL ICD Loader (link-time stub, not shipped in the APK) | `src-tauri/llama-bridge/opencl-lib/` — see its `README.md` for provenance and rebuild steps | Apache-2.0 |
| TeX hyphenation patterns (hyph-en-us, Gerard D.C. Kuiken) | inlined in `src/lib/overlay-layout/hyphenation.ts` | TeX hyphenation patterns licence (free use and redistribution in any medium) |
| ONNX Runtime WebAssembly binaries | `static/wasm/` (byte-copies of the `onnxruntime-web` npm package's dist artifacts, same version as `package.json`) | MIT (Microsoft) |

## Bundled and downloaded models

| Model | Where | Licence / terms |
|---|---|---|
| PP-OCRv6 detection + recognition (ONNX) | `static/models/` — converted from PaddleOCR upstream releases | Apache-2.0 (PaddlePaddle/PaddleOCR) |
| rtmdet-manga-layout | downloaded at build/run time from `huggingface.co/fumetodev/rtmdet-manga-layout-onnx` | Apache-2.0 (this project's own fine-tune) |
| Hy-MT2 manga fine-tunes (GGUF) | downloaded by the user in-app from `huggingface.co/fumetodev/…` | This project's fine-tunes of Tencent's Hy-MT2; base-model terms per the upstream Hugging Face model page (`tencent/Hy-MT2-1.8B`), which publishes them as Apache-2.0 |

## npm runtime dependencies (bundled into the app)

`svelte` / `@sveltejs/kit` (MIT) · `onnxruntime-web` (MIT) · `dexie`
(Apache-2.0) · `pdfjs-dist` (Apache-2.0) · `@zip.js/zip.js` (BSD-3-Clause) ·
`panzoom` (MIT) · `@chenglou/pretext` (MIT) ·
`@material/material-color-utilities` (Apache-2.0) · `@fontsource/*` Noto fonts
(SIL OFL 1.1 — the OFL texts and the overlay-typography notices ship in `static/licenses/`).

**`node-unrar-js` (CBR support):** the wrapper is MIT, but it is compiled from
RARLAB's unrar source, whose licence permits free use **except** using the
source to re-create the RAR *compression* algorithm. That restriction is not
GPL-compatible in the strict sense (Debian and Fedora class unrar as
non-free). It is kept as a clearly documented exception for reading CBR
archives; replacing it with a fully free extractor is a welcome contribution.

## Android (Gradle) dependencies

`androidx.*`, `com.google.android.material`, `kotlinx-coroutines-android`,
`okhttp` — Apache-2.0. `com.microsoft.onnxruntime:onnxruntime-android` — MIT.

## Sample imagery (not software)

The Help screenshots use pages from *Give My Regards to
Black Jack* (© SHUHO SATO / 佐藤秀峰), used under the publisher's free
secondary-use terms, which require the title and author to be displayed.
Full attribution: `static/licenses/OVERLAY_THIRD_PARTY_NOTICES.txt` (shipped in the app). These terms are a carve-out — the imagery is
**not** covered by this repository's GPL-3.0 licence.

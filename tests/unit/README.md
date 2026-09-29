# Unit tests

Tests for the iOS-readiness fixes: platform detection, healing stored paths
after the app's data directory moves, and streaming downloads/imports to disk.

The repository has no public test runner, so install one without touching
`package.json`, then run:

```bash
npm install --no-save vitest@3 fake-indexeddb@6
npx vitest run --dir tests/unit
```

`--dir` matters: without it vitest also collects the vendored llama.cpp web
UI's own tests under `src-tauri/llama-bridge/`, which need their own
dependencies.

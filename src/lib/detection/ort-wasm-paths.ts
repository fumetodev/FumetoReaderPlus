/**
 * Where ONNX Runtime Web finds its `.wasm` binaries.
 *
 * The runtime files sit under `/wasm/` in the static bundle and are resolved
 * against the page, never imported. Resolving against the page URL rather
 * than the page origin yields the same absolute URL wherever the origin is a
 * normal `http(s)://` one, and still produces a usable URL where a custom app
 * scheme reports an opaque (`null`) origin.
 */
export function ortWasmBaseUrl(): string {
	return new URL('/wasm/', window.location.href).href;
}

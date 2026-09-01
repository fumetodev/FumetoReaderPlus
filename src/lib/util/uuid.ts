/**
 * UUID v4 with a WebView-compatibility fallback.
 *
 * `crypto.randomUUID` requires Chromium 92+; Android System WebView on older
 * devices (and stock emulator images) throws `TypeError: crypto.randomUUID is
 * not a function`, which silently broke library bootstrap, region creation,
 * and sync on those devices. Always create IDs through this helper.
 */
export function randomUUID(): string {
	const cryptoObject = globalThis.crypto;
	if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
		return cryptoObject.randomUUID();
	}
	const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
	return (
		hex.slice(0, 4).join('') +
		'-' +
		hex.slice(4, 6).join('') +
		'-' +
		hex.slice(6, 8).join('') +
		'-' +
		hex.slice(8, 10).join('') +
		'-' +
		hex.slice(10).join('')
	);
}

const textEncoder = new TextEncoder();

/** Locale-independent UTF-16 ordering for canonical plans and cache tie-breaks. */
export function compareCanonicalText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical overlay values must be finite');
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			if (record[key] !== undefined) result[key] = normalize(record[key]);
		}
		return result;
	}
	throw new TypeError(`Unsupported canonical overlay value: ${typeof value}`);
}

export function canonicalStringify(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function canonicalClone<T>(value: T): T {
	return JSON.parse(canonicalStringify(value)) as T;
}

export function stableHash64(value: unknown): string {
	const bytes = textEncoder.encode(typeof value === 'string' ? value : canonicalStringify(value));
	let hash = 0xcbf29ce484222325n;
	for (const byte of bytes) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, '0');
}

export async function sha256(value: unknown): Promise<string> {
	const bytes = textEncoder.encode(typeof value === 'string' ? value : canonicalStringify(value));
	return sha256Bytes(bytes);
}

/** Hash raw bytes without serializing them as a JSON number array. */
export async function sha256Bytes(bytes: ArrayBuffer | ArrayBufferView): Promise<string> {
	const view = bytes instanceof ArrayBuffer
		? new Uint8Array(bytes)
		: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (globalThis.crypto?.subtle) {
		const digestInput = Uint8Array.from(view).buffer;
		const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
		return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	}
	// Old WebViews are rejected by the runtime feature probe. This fallback is
	// retained only so schema tooling can produce stable diagnostic identities.
	return `${stableHash64(view.length)}${stableHash64([...view])}`.padEnd(64, '0');
}

export function stableOverlayId(kind: 'entry' | 'source' | 'container' | 'item', seed: unknown): string {
	return `ov2_${kind}_${stableHash64(seed)}`;
}

export function quantize(value: number, step = 1 / 64): number {
	if (!Number.isFinite(value)) throw new TypeError('Overlay geometry must be finite');
	return Math.round(value / step) * step;
}

import { sha256Bytes } from './canonical.js';

const cache = new WeakMap<Blob, Promise<{ width: number; height: number; fingerprint: string }>>();

export function inspectOverlaySourceImage(
	image: Blob,
	knownDimensions?: { width: number; height: number }
): Promise<{ width: number; height: number; fingerprint: string }> {
	const cached = cache.get(image);
	if (cached && !knownDimensions) return cached;
	const promise = (async () => {
		const bytes = new Uint8Array(await image.arrayBuffer());
		const fingerprint = await sha256Bytes(bytes);
		if (knownDimensions) return { ...knownDimensions, fingerprint };
		if (typeof createImageBitmap !== 'function') {
			throw new Error('Overlay source dimensions require createImageBitmap');
		}
		const bitmap = await createImageBitmap(image);
		try {
			return { width: bitmap.width, height: bitmap.height, fingerprint };
		} finally {
			bitmap.close();
		}
	})();
	if (!knownDimensions) cache.set(image, promise);
	return promise;
}

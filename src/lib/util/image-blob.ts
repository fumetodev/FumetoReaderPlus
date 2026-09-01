const ascii = (bytes: Uint8Array, start: number, length: number): string =>
	String.fromCharCode(...bytes.subarray(start, start + length));

/** Infer a browser-renderable image MIME type without altering payload bytes. */
export function imageMimeTypeFromHeader(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (
		bytes.length >= 8
		&& bytes[0] === 0x89
		&& ascii(bytes, 1, 3) === 'PNG'
		&& bytes[4] === 0x0d
		&& bytes[5] === 0x0a
		&& bytes[6] === 0x1a
		&& bytes[7] === 0x0a
	) return 'image/png';
	if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
		return 'image/gif';
	}
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
		return 'image/webp';
	}
	if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
	if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
		const brand = ascii(bytes, 8, 4);
		if (brand === 'avif' || brand === 'avis') return 'image/avif';
	}
	return undefined;
}

/**
 * Keep the persisted server Blob byte-for-byte intact while supplying missing
 * image MIME metadata to a transient browser rendering handle. YACReader v10
 * can serve JPEG covers as an untyped/octet-stream response.
 */
export async function renderableImageBlob(blob: Blob): Promise<Blob> {
	if (blob.type.toLowerCase().startsWith('image/')) return blob;
	const mimeType = imageMimeTypeFromHeader(
		new Uint8Array(await blob.slice(0, 16).arrayBuffer())
	);
	return mimeType ? new Blob([blob], { type: mimeType }) : blob;
}

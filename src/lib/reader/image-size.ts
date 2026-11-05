/**
 * How many pixels an image holds, from its header, without decoding it. A web chapter's images are the site's to choose,
 * and decoding one takes about 13 MB of memory per megapixel in the app's own renderer: a page of 16000 × 16000 got that
 * renderer killed for its memory on a 6 GB device, and the app with it.
 */

/** Far above any real page (a 30000 px webtoon strip is 24, a 600 dpi spread about 58), and within reach of small phones. */
export const MAX_PAGE_MEGAPIXELS = 80;

/** The image's width × height, or null where the header does not say or the format is not known here. */
export function imagePixelCount(b: Uint8Array): number | null {
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const ascii = (at: number, text: string) => at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
	try {
		if (b[0] === 0x89 && ascii(1, 'PNG')) return view.getUint32(16) * view.getUint32(20);
		if (ascii(0, 'GIF8')) return view.getUint16(6, true) * view.getUint16(8, true);
		if (ascii(0, 'BM')) return Math.abs(view.getInt32(18, true)) * Math.abs(view.getInt32(22, true));
		if (b[0] === 0xff && b[1] === 0xd8) return jpegPixels(view);
		if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
			if (ascii(12, 'VP8X')) return ((view.getUint32(24, true) & 0xffffff) + 1) * ((view.getUint32(27, true) & 0xffffff) + 1);
			if (ascii(12, 'VP8L')) {
				const bits = view.getUint32(21, true);
				return ((bits & 0x3fff) + 1) * (((bits >> 14) & 0x3fff) + 1);
			}
			if (ascii(12, 'VP8 ')) return (view.getUint16(26, true) & 0x3fff) * (view.getUint16(28, true) & 0x3fff);
			return null;
		}
		if (ascii(4, 'ftyp')) {
			// The largest `ispe` (image spatial extents) box: a file holds one per image, the thumbnail's among them.
			let most: number | null = null;
			for (let at = 8; at + 16 <= Math.min(b.length, 1 << 16); at++) {
				if (b[at] === 0x69 && ascii(at, 'ispe')) {
					const pixels = view.getUint32(at + 8) * view.getUint32(at + 12);
					if (most === null || pixels > most) most = pixels;
				}
			}
			return most;
		}
	} catch {
		// A header cut short: the decoder can say what it is.
	}
	return null;
}

function jpegPixels(view: DataView): number | null {
	let at = 2;
	while (at + 9 < view.byteLength) {
		if (view.getUint8(at) !== 0xff) return null;
		const marker = view.getUint8(at + 1);
		// Fill bytes before a marker.
		if (marker === 0xff) {
			at++;
			continue;
		}
		// Every start-of-frame marker: C0..CF but for DHT, JPG and DAC.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return view.getUint16(at + 5) * view.getUint16(at + 7);
		}
		at += 2 + view.getUint16(at + 2);
	}
	return null;
}

export function tooManyPixels(bytes: Uint8Array): boolean {
	const pixels = imagePixelCount(bytes);
	return pixels !== null && pixels > MAX_PAGE_MEGAPIXELS * 1_000_000;
}

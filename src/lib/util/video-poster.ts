/**
 * Video-page media probes: poster-frame capture and dimension probing.
 *
 * Android WebView has a small pool of hardware video decoders (~2–4), so
 * every operation here runs through a single-slot queue — thumbnail surfaces
 * that map over many pages (filmstrip, scrubber, tab previews) cannot exhaust
 * the pool by probing concurrently. The offscreen <video> elements are
 * released immediately after use; nothing here retains a decoding element.
 *
 * jsdom has no video pipeline, so both operations are override-injectable for
 * unit tests; real behavior is covered by Playwright (webm — bundled Chromium
 * may lack H.264) and the on-device live eval (mp4).
 */

type PosterCapture = (blob: Blob) => Promise<ImageBitmap>;
type DimensionProbe = (blob: Blob) => Promise<{ width: number; height: number }>;

let queueTail: Promise<unknown> = Promise.resolve();

/** Serialize decoder-touching work; failures don't wedge the queue. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
	const run = queueTail.then(op, op);
	queueTail = run.catch(() => undefined);
	return run;
}

/**
 * Backstop for corrupt/truncated containers that neither become ready nor
 * fire `error`: without it, one stalling file would wedge the app-wide
 * serial queue for every future probe/capture this session.
 */
const VIDEO_READY_TIMEOUT_MS = 10_000;

async function withVideoElement<T>(
	blob: Blob,
	readyEvent: 'loadedmetadata' | 'loadeddata',
	use: (video: HTMLVideoElement) => Promise<T> | T
): Promise<T> {
	const url = URL.createObjectURL(blob);
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = readyEvent === 'loadedmetadata' ? 'metadata' : 'auto';
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			timeoutId = setTimeout(
				() => reject(new Error(`Video ${readyEvent} timed out`)),
				VIDEO_READY_TIMEOUT_MS
			);
			video.addEventListener(readyEvent, () => resolve(), { once: true });
			video.addEventListener('error', () => reject(new Error(`Video ${readyEvent} failed`)), {
				once: true
			});
			video.src = url;
		});
		return await use(video);
	} finally {
		clearTimeout(timeoutId);
		// Detach + load() releases the decoder immediately instead of waiting
		// for GC — load-bearing under the small Android decoder pool.
		video.removeAttribute('src');
		video.load();
		URL.revokeObjectURL(url);
	}
}

const defaultCapture: PosterCapture = (blob) =>
	// loadeddata = frame 0 is decodable; createImageBitmap(video) snapshots it.
	withVideoElement(blob, 'loadeddata', (video) => createImageBitmap(video));

const defaultProbe: DimensionProbe = (blob) =>
	withVideoElement(blob, 'loadedmetadata', (video) => ({
		width: video.videoWidth,
		height: video.videoHeight
	}));

let capture: PosterCapture = defaultCapture;
let probe: DimensionProbe = defaultProbe;

/** First-frame snapshot of a video blob, for thumbnails/covers. */
export function captureVideoPosterFrame(blob: Blob): Promise<ImageBitmap> {
	return enqueue(() => capture(blob));
}

/** Intrinsic dimensions of a video blob (metadata only, no frame decode). */
export function probeVideoDimensions(blob: Blob): Promise<{ width: number; height: number }> {
	return enqueue(() => probe(blob));
}

/** Test seam — jsdom has no video pipeline. Pass null to restore defaults. */
export function overrideVideoPosterForTests(
	overrides: { capture?: PosterCapture; probe?: DimensionProbe } | null
): void {
	capture = overrides?.capture ?? defaultCapture;
	probe = overrides?.probe ?? defaultProbe;
}

/**
 * PDF extraction for Fumeto.
 *
 * Renders each PDF page to a JPEG image using pdfjs-dist, producing the same
 * ExtractionResult format as the ZIP and RAR extractors. This allows PDFs to
 * flow through the entire existing pipeline (reader, translation, overlay,
 * export) with zero downstream changes.
 *
 * Key design decisions:
 * - Uses document.createElement('canvas') instead of OffscreenCanvas for
 *   maximum pdf.js compatibility across Android WebView versions.
 * - Renders pages sequentially (not in parallel) to limit memory pressure on
 *   Android — each canvas buffer is ~8–16 MB for a typical manga page at 2x.
 * - Releases canvas memory after each page by resetting dimensions.
 * - Dynamically imported (same pattern as RAR extractor) so the ~300 KB
 *   pdfjs-dist library is only loaded when a PDF is actually imported.
 */

import type { ExtractionResult, StreamedPageHandler } from './archive-extraction.js';

/** Maximum pixel dimension (width or height) for rendered pages. */
const MAX_DIMENSION = 3000;

/** Target scale factor for rendering (2x gives sharp text for OCR). */
const TARGET_SCALE = 2;

/** JPEG quality for rendered pages (higher than thumbnail's 0.7). */
const JPEG_QUALITY = 0.92;

/** Render only page one for cover migration without materializing the PDF. */
export async function extractFirstPdfPage(pdfBlob: Blob): Promise<File | undefined> {
	const pdfjsLib = await import('pdfjs-dist');
	pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
		'pdfjs-dist/build/pdf.worker.min.mjs',
		import.meta.url
	).toString();

	const arrayBuffer = await pdfBlob.arrayBuffer();
	const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
	if (pdfDoc.numPages < 1) {
		await pdfDoc.destroy();
		return undefined;
	}

	const canvas = document.createElement('canvas');
	let page: Awaited<ReturnType<typeof pdfDoc.getPage>> | undefined;
	try {
		page = await pdfDoc.getPage(1);
		const baseViewport = page.getViewport({ scale: 1 });
		const longestSide = Math.max(baseViewport.width, baseViewport.height);
		const scale = Math.min(TARGET_SCALE, MAX_DIMENSION / longestSide);
		const viewport = page.getViewport({ scale });
		canvas.width = Math.round(viewport.width);
		canvas.height = Math.round(viewport.height);
		await page.render({ canvas, viewport }).promise;

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(value) => value ? resolve(value) : reject(new Error('Failed to render PDF cover page')),
				'image/jpeg',
				JPEG_QUALITY,
			);
		});
		return new File([blob], 'page_001.jpg', {
			type: 'image/jpeg',
			lastModified: Date.now(),
		});
	} finally {
		page?.cleanup();
		canvas.width = 1;
		canvas.height = 1;
		await pdfDoc.destroy();
	}
}

/**
 * Extract all pages from a PDF as JPEG images.
 *
 * @param pdfBlob - The PDF file as a Blob
 * @param onProgress - Optional progress callback (rendered, total)
 * @returns Extracted page images and counts
 */
/**
 * Shared sequential render loop: one reusable canvas, one page bitmap alive
 * at a time, `onPage` awaited before the next page renders.
 */
async function renderPdfPages(
	pdfBlob: Blob,
	onPage: (index: number, filename: string, file: File, totalPages: number) => Promise<void>
): Promise<number> {
	// Dynamic import — only load pdfjs-dist when needed
	const pdfjsLib = await import('pdfjs-dist');

	// Configure the pdf.js worker.
	// new URL(specifier, import.meta.url) lets Vite resolve the worker file at
	// build time and copy it to the output directory. This works correctly
	// under Tauri's tauri://localhost/ protocol on both desktop and Android.
	pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
		'pdfjs-dist/build/pdf.worker.min.mjs',
		import.meta.url
	).toString();

	// Load the PDF document
	const arrayBuffer = await pdfBlob.arrayBuffer();
	const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

	const totalPages = pdfDoc.numPages;

	// Pad width for page filenames (e.g., page_001.jpg for < 1000 pages)
	const padWidth = Math.max(3, String(totalPages).length);

	// Create a single reusable canvas element.
	// Use document.createElement('canvas') (not OffscreenCanvas) for maximum
	// pdf.js compatibility across Android WebView versions.
	const canvas = document.createElement('canvas');

	try {
		for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
			const page = await pdfDoc.getPage(pageNum);

			// Compute scale: aim for TARGET_SCALE, but cap at MAX_DIMENSION
			const baseViewport = page.getViewport({ scale: 1 });
			const longestSide = Math.max(baseViewport.width, baseViewport.height);
			const scale = Math.min(TARGET_SCALE, MAX_DIMENSION / longestSide);
			const viewport = page.getViewport({ scale });

			// Size the canvas for this page
			canvas.width = Math.round(viewport.width);
			canvas.height = Math.round(viewport.height);

			// Render the page to canvas (pdfjs-dist v5 uses `canvas` property)
			await page.render({ canvas, viewport }).promise;

			// Convert to JPEG blob
			const blob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(
					(b) => (b ? resolve(b) : reject(new Error(`Failed to render PDF page ${pageNum}`))),
					'image/jpeg',
					JPEG_QUALITY
				);
			});

			// Create a File object with a zero-padded filename for natural sort
			const filename = `page_${String(pageNum).padStart(padWidth, '0')}.jpg`;
			const file = new File([blob], filename, {
				type: 'image/jpeg',
				lastModified: Date.now()
			});

			// Release page resources before handing control to the consumer
			page.cleanup();

			await onPage(pageNum - 1, filename, file, totalPages);
		}
	} finally {
		// Release canvas GPU memory
		canvas.width = 1;
		canvas.height = 1;

		// Clean up the pdf.js document
		await pdfDoc.destroy();
	}

	return totalPages;
}

/**
 * Stream rendered PDF pages one at a time — the streamed-import path used by
 * v17 page-per-row storage. Page order is inherent (PDF page number).
 */
export async function streamPdfArchivePages(
	pdfBlob: Blob,
	onPage: StreamedPageHandler,
	onProgress?: (rendered: number, total: number) => void
): Promise<{ imageCount: number; skippedCount: number }> {
	let rendered = 0;
	await renderPdfPages(pdfBlob, async (index, filename, file, totalPages) => {
		await onPage({ index, filename, file });
		rendered++;
		onProgress?.(rendered, totalPages);
	});
	return { imageCount: rendered, skippedCount: 0 };
}

export async function extractPdfArchive(
	pdfBlob: Blob,
	onProgress?: (rendered: number, total: number) => void
): Promise<ExtractionResult> {
	const files: Record<string, File> = {};
	let rendered = 0;
	await renderPdfPages(pdfBlob, async (_index, filename, file, totalPages) => {
		files[filename] = file;
		rendered++;
		onProgress?.(rendered, totalPages);
	});

	return {
		files,
		imageCount: rendered,
		skippedCount: 0
	};
}

/**
 * One recognized text block in original-image coordinates.
 *
 * This shape originated in the ML Kit bridge, which was removed on 2026-07-24
 *. It outlived that bridge
 * because PP-OCR extraction, the text-only prompt builder, and the OCR benchmark
 * all speak it, so it now lives on its own rather than inside whichever engine
 * happens to produce it.
 */
export interface RecognizedBlock {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	blockIndex: number;
}

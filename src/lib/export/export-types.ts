/** Options for exporting a translated volume as a baked-overlay CBZ. */
export interface ExportOptions {
	/** Image format for exported pages. */
	format: 'jpeg' | 'png';
	/** JPEG quality (0.0–1.0). Ignored for PNG. */
	quality: number;
	/** Suggested filename for the CBZ archive (e.g., "Volume Title [Translated].cbz"). */
	filename: string;
}

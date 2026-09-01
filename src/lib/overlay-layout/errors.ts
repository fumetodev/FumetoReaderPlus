export type OverlayLayoutErrorCode =
	| 'font-timeout'
	| 'font-missing-glyph'
	| 'unsupported-runtime'
	| 'invalid-document'
	| 'manual-constraint-conflict'
	| 'cancelled';

export class OverlayLayoutError extends Error {
	constructor(
		readonly code: OverlayLayoutErrorCode,
		message: string,
		readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'OverlayLayoutError';
	}
}

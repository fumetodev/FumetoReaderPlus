import type { OverlayManualConstraintsV2, Rect } from '$lib/types/index.js';

/** Immutable identity captured from the canonical plan when an editor opens. */
export interface OverlayEditorTarget {
	itemId: string;
	rect: Rect;
	planId: string;
}

export interface OverlayEditorValues {
	text: string;
	fontSize: number;
	width: number;
	height: number;
	hidden: boolean;
	writingMode: 'auto' | 'horizontal-tb' | 'vertical-rl';
}

export function initialOverlayEditorValues(
	manual: Readonly<OverlayManualConstraintsV2>,
	displayedRect: Readonly<Rect>,
	baseTranslation: string
): OverlayEditorValues {
	return {
		text: manual.textOverride ?? baseTranslation,
		fontSize: manual.referenceFontSize ?? 0,
		width: manual.rect?.width ?? displayedRect.width,
		height: manual.rect?.height ?? displayedRect.height,
		hidden: manual.hidden ?? false,
		writingMode: manual.writingMode ?? 'auto'
	};
}

function cloneManual(manual: Readonly<OverlayManualConstraintsV2>): OverlayManualConstraintsV2 {
	const clone = { ...manual };
	if (manual.rect) clone.rect = { ...manual.rect };
	return clone;
}

/**
 * Build the durable manual constraints from the user's effective values.
 *
 * Unchanged fields preserve their exact original representation. In particular,
 * opening and closing an automatically placed item must not turn its winning
 * candidate into a pinned source/container rectangle.
 */
export function buildOverlayEditorManualDraft(input: {
	original: Readonly<OverlayManualConstraintsV2>;
	displayedRect: Readonly<Rect>;
	baseTranslation: string;
	values: Readonly<OverlayEditorValues>;
}): OverlayManualConstraintsV2 {
	const { original, displayedRect, baseTranslation, values } = input;
	const initial = initialOverlayEditorValues(original, displayedRect, baseTranslation);
	const next = cloneManual(original);

	if (values.text !== initial.text) {
		const text = values.text.trim();
		if (text === baseTranslation) delete next.textOverride;
		else next.textOverride = text;
	}

	if (values.fontSize !== initial.fontSize) {
		if (values.fontSize > 0) {
			next.referenceFontSize = values.fontSize;
			next.pinTypography = true;
		} else {
			delete next.referenceFontSize;
			delete next.pinTypography;
		}
	}

	if (values.width !== initial.width || values.height !== initial.height) {
		next.rect = {
			...displayedRect,
			width: values.width,
			height: values.height
		};
		next.pinGeometry = true;
	}

	if (values.hidden !== initial.hidden) {
		if (values.hidden) next.hidden = true;
		else delete next.hidden;
	}

	if (values.writingMode !== initial.writingMode) {
		if (values.writingMode === 'auto') delete next.writingMode;
		else next.writingMode = values.writingMode;
	}

	return next;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)])
		);
	}
	return value;
}

export function overlayManualConstraintsEqual(
	left: Readonly<OverlayManualConstraintsV2>,
	right: Readonly<OverlayManualConstraintsV2>
): boolean {
	return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

/** Scale the displayed font along the writing direction during a manual resize. */
export function scaledOverlayFontSize(input: {
	fontSize: number;
	before: Readonly<Rect>;
	after: Readonly<Rect>;
	writingMode: 'horizontal-tb' | 'vertical-rl';
}): number {
	const beforeAdvance = input.writingMode === 'vertical-rl' ? input.before.height : input.before.width;
	const afterAdvance = input.writingMode === 'vertical-rl' ? input.after.height : input.after.width;
	const factor = beforeAdvance > 0 ? afterAdvance / beforeAdvance : 1;
	const scaled = input.fontSize * factor;
	return Number.isFinite(scaled) ? Math.max(1, Math.round(scaled * 4) / 4) : input.fontSize;
}

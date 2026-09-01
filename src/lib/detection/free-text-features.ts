import type { Rect } from '$lib/types/index.js';
import type {
	PPOcrGroupingDiagnostics,
	PPOcrTextGroup,
	TextGroupClassificationContext
} from './ppocr-grouping.js';

export interface FreeTextPixelBuffer {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

export interface FreeTextFeatureOptions {
	sourceWidth: number;
	sourceHeight: number;
	locale?: string;
	pageMedianGlyphHeight: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
	Math.min(maximum, Math.max(minimum, value));

function luminance(data: Uint8ClampedArray, offset: number): number {
	return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

function axisInterval(value: number, cuts: readonly number[], maximum: number): [number, number] {
	const ordered = [0, ...cuts.filter((cut) => cut > 0 && cut < maximum), maximum]
		.sort((left, right) => left - right);
	for (let index = 0; index + 1 < ordered.length; index += 1) {
		if (value >= ordered[index] && value <= ordered[index + 1]) {
			return [ordered[index], ordered[index + 1]];
		}
	}
	return [0, maximum];
}

export function inferGroupPanelBounds(
	group: Pick<PPOcrTextGroup, 'x' | 'y' | 'width' | 'height'>,
	diagnostics: Pick<PPOcrGroupingDiagnostics, 'inferredVerticalCuts' | 'inferredHorizontalCuts'>,
	sourceWidth: number,
	sourceHeight: number
): Rect {
	const [x, x2] = axisInterval(
		group.x + group.width / 2,
		diagnostics.inferredVerticalCuts,
		sourceWidth
	);
	const [y, y2] = axisInterval(
		group.y + group.height / 2,
		diagnostics.inferredHorizontalCuts,
		sourceHeight
	);
	return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Measure only inexpensive, deterministic visual evidence around an unenclosed
 * text group. The sampler works on a downscaled page while all returned
 * geometry remains in original image coordinates.
 */
export function analyzeFreeTextGroupFeatures(
	image: FreeTextPixelBuffer,
	group: PPOcrTextGroup,
	diagnostics: Pick<PPOcrGroupingDiagnostics, 'inferredVerticalCuts' | 'inferredHorizontalCuts'>,
	options: FreeTextFeatureOptions
): TextGroupClassificationContext {
	const scaleX = image.width / Math.max(1, options.sourceWidth);
	const scaleY = image.height / Math.max(1, options.sourceHeight);
	const glyphPx = Math.max(2, group.trace.glyphScale * Math.min(scaleX, scaleY));
	const margin = Math.max(3, Math.round(glyphPx * 1.5));
	const text = {
		x: clamp(Math.floor(group.x * scaleX), 0, image.width - 1),
		y: clamp(Math.floor(group.y * scaleY), 0, image.height - 1),
		x2: clamp(Math.ceil((group.x + group.width) * scaleX), 1, image.width),
		y2: clamp(Math.ceil((group.y + group.height) * scaleY), 1, image.height)
	};
	const sample = {
		x: Math.max(0, text.x - margin),
		y: Math.max(0, text.y - margin),
		x2: Math.min(image.width, text.x2 + margin),
		y2: Math.min(image.height, text.y2 + margin)
	};

	const values: number[] = [];
	for (let y = sample.y; y < sample.y2; y += 1) {
		for (let x = sample.x; x < sample.x2; x += 1) {
			if (x >= text.x && x < text.x2 && y >= text.y && y < text.y2) continue;
			values.push(luminance(image.data, (y * image.width + x) * 4));
		}
	}
	const mean = values.length
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: 127.5;
	const variance = values.length
		? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
		: 90 ** 2;
	const deviation = Math.sqrt(variance);
	const backgroundUniformity = clamp(1 - deviation / 90, 0, 1);

	let edgePairs = 0;
	let strongEdges = 0;
	for (let y = sample.y; y < sample.y2; y += 1) {
		for (let x = sample.x; x < sample.x2; x += 1) {
			if (x >= text.x && x < text.x2 && y >= text.y && y < text.y2) continue;
			const value = luminance(image.data, (y * image.width + x) * 4);
			if (x + 1 < sample.x2) {
				edgePairs += 1;
				if (Math.abs(value - luminance(image.data, (y * image.width + x + 1) * 4)) >= 36) {
					strongEdges += 1;
				}
			}
			if (y + 1 < sample.y2) {
				edgePairs += 1;
				if (Math.abs(value - luminance(image.data, ((y + 1) * image.width + x) * 4)) >= 36) {
					strongEdges += 1;
				}
			}
		}
	}
	const localEdgeDensity = edgePairs ? strongEdges / edgePairs : 0;

	const darkThreshold = Math.min(180, mean - Math.max(18, deviation * 0.3));
	const rowDarkRatio = (y: number): number => {
		let dark = 0;
		for (let x = sample.x; x < sample.x2; x += 1) {
			if (luminance(image.data, (y * image.width + x) * 4) <= darkThreshold) dark += 1;
		}
		return dark / Math.max(1, sample.x2 - sample.x);
	};
	const columnDarkRatio = (x: number): number => {
		let dark = 0;
		for (let y = sample.y; y < sample.y2; y += 1) {
			if (luminance(image.data, (y * image.width + x) * 4) <= darkThreshold) dark += 1;
		}
		return dark / Math.max(1, sample.y2 - sample.y);
	};
	let topLine = false;
	let bottomLine = false;
	let leftLine = false;
	let rightLine = false;
	for (let y = sample.y; y < Math.max(sample.y, text.y - 1); y += 1) {
		if (rowDarkRatio(y) >= 0.55) topLine = true;
	}
	for (let y = Math.min(sample.y2, text.y2 + 1); y < sample.y2; y += 1) {
		if (rowDarkRatio(y) >= 0.55) bottomLine = true;
	}
	for (let x = sample.x; x < Math.max(sample.x, text.x - 1); x += 1) {
		if (columnDarkRatio(x) >= 0.55) leftLine = true;
	}
	for (let x = Math.min(sample.x2, text.x2 + 1); x < sample.x2; x += 1) {
		if (columnDarkRatio(x) >= 0.55) rightLine = true;
	}
	const hasRectangularFrame = topLine && bottomLine && leftLine && rightLine;

	const panelBounds = inferGroupPanelBounds(
		group,
		diagnostics,
		options.sourceWidth,
		options.sourceHeight
	);
	const distanceToPanelEdge = Math.max(0, Math.min(
		group.x - panelBounds.x,
		group.y - panelBounds.y,
		panelBounds.x + panelBounds.width - (group.x + group.width),
		panelBounds.y + panelBounds.height - (group.y + group.height)
	));
	return {
		locale: options.locale,
		imageWidth: options.sourceWidth,
		imageHeight: options.sourceHeight,
		panelBounds,
		pageMedianGlyphHeight: options.pageMedianGlyphHeight,
		backgroundUniformity,
		localEdgeDensity,
		hasRectangularFrame,
		distanceToPanelEdge
	};
}

export type ReaderHapticEffect =
	| 'selection'
	| 'drag-start'
	| 'drag-step'
	| 'commit'
	| 'cancel'
	| 'error'
	| 'control'
	| 'boundary';

const PATTERNS: Readonly<Record<ReaderHapticEffect, number | readonly number[]>> = {
	selection: 14,
	'drag-start': 9,
	'drag-step': 5,
	commit: [10, 24, 14],
	cancel: 8,
	error: [18, 28, 18],
	control: 7,
	// Two quick pulses: "you hit the end", distinct from single-pulse controls.
	boundary: [8, 30, 12]
};

interface VibrationNavigator {
	vibrate?: (pattern: number | number[]) => boolean;
}

/**
 * Best-effort, deliberately short reader feedback. Unsupported browsers and
 * devices are silent; gesture handling never depends on vibration succeeding.
 */
export function playReaderHaptic(
	effect: ReaderHapticEffect,
	target: VibrationNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator
): boolean {
	if (typeof target?.vibrate !== 'function') return false;
	const configured = PATTERNS[effect];
	const pattern = Array.isArray(configured) ? [...configured] : configured as number;
	try {
		return target.vibrate(pattern);
	} catch {
		return false;
	}
}


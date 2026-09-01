import * as m from '$lib/paraglide/messages.js';
/**
 * Device-memory advice for the on-device translation models.
 *
 * llama.cpp memory-maps the model weights, so what decides success is total
 * device RAM, not the WebView's JS heap. Thresholds are written in GiB as
 * REPORTED by the kernel, which sits below the marketed size: an "8 GB"
 * device reports ~7.2-7.6 GiB, "6 GB" ~5.4-5.6, "4 GB" ~3.6-3.8.
 *
 * The model list uses this to annotate each download; the Pro purchase flow
 * must call it too, BEFORE pitching the purchase — someone on a 4 GB phone
 * should learn their device can't hold the model before paying, not after.
 */

export interface DeviceMemory {
	totalBytes: number;
	availBytes: number;
	lowMemory: boolean;
}

/** Reads the Android bridge's memory snapshot; null anywhere it can't. */
export function readDeviceMemory(): DeviceMemory | null {
	try {
		const raw = window.__fumeto_android?.getMemoryInfo?.();
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<DeviceMemory>;
		if (typeof parsed.totalBytes !== 'number' || !Number.isFinite(parsed.totalBytes) || parsed.totalBytes <= 0) {
			return null;
		}
		return {
			totalBytes: parsed.totalBytes,
			availBytes:
				typeof parsed.availBytes === 'number' && Number.isFinite(parsed.availBytes) ? parsed.availBytes : 0,
			lowMemory: parsed.lowMemory === true
		};
	} catch {
		return null;
	}
}

export type MemoryAdviceLevel = 'ok' | 'tight' | 'low' | 'unknown';

export interface MemoryAdvice {
	level: MemoryAdviceLevel;
	/** Reported total, rounded to one decimal — null when unknown. */
	totalGb: number | null;
	/** Empty for 'ok' and 'unknown'; user-facing sentence otherwise. */
	message: string;
}

const GIB = 1024 ** 3;
/** Above this the model needs large-model headroom (the ~1.1 GB fine-tune). */
const LARGE_MODEL_BYTES = 800 * 1024 * 1024;

export function modelMemoryAdvice(totalBytes: number | null, modelBytes: number): MemoryAdvice {
	if (totalBytes === null || !Number.isFinite(totalBytes) || totalBytes <= 0) {
		return { level: 'unknown', totalGb: null, message: '' };
	}
	const gib = totalBytes / GIB;
	const totalGb = Math.round(gib * 10) / 10;
	const large = modelBytes >= LARGE_MODEL_BYTES;
	// [comfortable, workable) boundaries in reported GiB — see module comment.
	const [okAt, tightAt] = large ? [7.0, 5.3] : [5.3, 3.5];
	if (gib >= okAt) {
		return { level: 'ok', totalGb, message: '' };
	}
	if (gib >= tightAt) {
		return {
			level: 'tight',
			totalGb,
			message: large
				? m.settings_memory_tight_large({ gb: totalGb })
				: m.settings_memory_tight_small({ gb: totalGb })
		};
	}
	return {
		level: 'low',
		totalGb,
		message: large
			? m.settings_memory_low_large({ gb: totalGb })
			: m.settings_memory_low_small({ gb: totalGb })
	};
}

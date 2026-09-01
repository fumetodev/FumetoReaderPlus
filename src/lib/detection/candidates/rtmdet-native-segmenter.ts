/**
 * rtmdet-native candidate: the same bespoke RTMDet-Ins-s fine-tune as
 * `rtmdet-manga`, but executed by native Android ONNX Runtime (XNNPACK)
 * through the `__fumeto_rtmdet_native` WebView bridge at fp32-1024.
 * Preprocessing, inference, and contour tracing all happen native-side;
 * only compact page-space instances cross back as JSON.
 */

import type { BubbleRegion } from '../bubble-geometry.js';
import { suppressNestedBalloonInstances } from '../ppocr-grouping.js';
import type { CandidateAuxBox, CandidateLayoutResult } from './layout-provider-types.js';

const CLASS_BALLOON = 0;
const CLASS_PANEL = 1;
const NATIVE_THREADS = 4;

interface RtmdetNativeBridge {
	isAvailable(): boolean;
	getRuntimeInfo(): string;
	detect(encodedImage: string, threadCount: number, callbackId: string): void;
	release(callbackId: string): void;
}

interface NativeInstance {
	classId: number;
	score: number;
	x: number;
	y: number;
	width: number;
	height: number;
	contour?: number[];
}

interface NativeDetection {
	instances: NativeInstance[];
	inferenceMs: number;
	decodeMs: number;
	preprocessMs: number;
	postprocessMs: number;
}

declare global {
	interface Window {
		__fumeto_rtmdet_native?: RtmdetNativeBridge;
		__rtmdet_native_resolve?: (callbackId: string, resultJson: string) => void;
		__rtmdet_native_reject?: (callbackId: string, message: string) => void;
	}
}

const pending = new Map<string, { resolve: (json: string) => void; reject: (e: Error) => void }>();
let callbackCounter = 0;
let handlersInstalled = false;

function installHandlers(): void {
	if (handlersInstalled) return;
	handlersInstalled = true;
	window.__rtmdet_native_resolve = (callbackId, resultJson) => {
		pending.get(callbackId)?.resolve(resultJson);
		pending.delete(callbackId);
	};
	window.__rtmdet_native_reject = (callbackId, message) => {
		pending.get(callbackId)?.reject(new Error(message));
		pending.delete(callbackId);
	};
}

export function isRtmdetNativeBridgeAvailable(): boolean {
	try {
		return window.__fumeto_rtmdet_native?.isAvailable() === true;
	} catch {
		return false;
	}
}

async function blobToBase64(blob: Blob): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
		reader.readAsDataURL(blob);
	});
	const comma = dataUrl.indexOf(',');
	return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function callNative(encodedImage: string): Promise<string> {
	const bridge = window.__fumeto_rtmdet_native;
	if (!bridge) throw new Error('rtmdet native bridge unavailable');
	installHandlers();
	const callbackId = `rtmdet-${++callbackCounter}-${Date.now()}`;
	return new Promise<string>((resolve, reject) => {
		pending.set(callbackId, { resolve, reject });
		try {
			bridge.detect(encodedImage, NATIVE_THREADS, callbackId);
		} catch (error) {
			pending.delete(callbackId);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export async function detectLayoutWithRtmdetNative(
	imageBlob: Blob,
	options: { signal?: AbortSignal } = {}
): Promise<CandidateLayoutResult> {
	if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
	const encoded = await blobToBase64(imageBlob);
	const started = performance.now();
	const detection = JSON.parse(await callNative(encoded)) as NativeDetection;
	const totalMs = performance.now() - started;

	const detectedBubbles: BubbleRegion[] = [];
	const panels: CandidateAuxBox[] = [];
	const textRegions: CandidateAuxBox[] = [];
	for (const instance of detection.instances) {
		const aux = {
			x: instance.x,
			y: instance.y,
			width: instance.width,
			height: instance.height,
			confidence: instance.score
		};
		if (instance.classId === CLASS_BALLOON && instance.contour && instance.contour.length >= 6) {
			const contour: [number, number][] = [];
			for (let i = 0; i + 1 < instance.contour.length; i += 2) {
				contour.push([instance.contour[i], instance.contour[i + 1]]);
			}
			detectedBubbles.push({ bubbleId: detectedBubbles.length, ...aux, contour });
		} else if (instance.classId === CLASS_PANEL) {
			panels.push(aux);
		} else if (instance.classId !== CLASS_BALLOON) {
			textRegions.push(aux);
		}
	}
	const { bubbles, suppressed } = suppressNestedBalloonInstances(detectedBubbles);
	return {
		providerId: 'rtmdet-native',
		bubbles,
		panels,
		textRegions,
		suppressedBubbles: suppressed,
		// Report native wall-clock (bridge round-trip included) for honesty
		inferenceMs: totalMs
	};
}

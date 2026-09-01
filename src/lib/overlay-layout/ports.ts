import type {
	OverlayDirection,
	OverlayRenderPlanV2,
	OverlayWritingMode,
	PageOverlayDataV2,
	PageTranslationEntry,
	Point,
	Rect,
	SmartSizingData
} from '$lib/types/index.js';

export interface FontRunSpec {
	text: string;
	startUtf16: number;
	endUtf16: number;
	fontKey: string;
	family: string;
	weight: number;
}

export interface FontRegistryDiagnostics {
	fingerprint: string;
	loaded: string[];
	loading: string[];
	failures: Array<{ fontKey: string; reason: string }>;
	assets: Array<{ fontKey: string; package: string; version: string; sha256: string }>;
}

export interface FontRegistryPort {
	ensureReady(fontKeys: string[], sampleText: string): Promise<void>;
	resolveRuns(text: string, locale: string, styleKey: string): FontRunSpec[];
	fingerprint(): string;
	inspect(): FontRegistryDiagnostics;
}

export interface PreparedTextInput {
	scopeId: string;
	text: string;
	locale: string;
	fontKey: string;
	family: string;
	/** Ordered, bundled-only fallback list used by the shaping/measurement pass. */
	families?: string[];
	weight: number;
	fontSize: number;
	lineHeight: number;
	direction: OverlayDirection;
	styleKey: string;
}

export interface PreparedTextHandle {
	key: string;
	scopeId: string;
	text: string;
	fontSize: number;
	lineHeight: number;
	direction: OverlayDirection;
}

export interface LineWidthConstraint {
	width: number;
	intervalStart: number;
	intervalEnd: number;
}

export interface TextLinePlan {
	lines: Array<{
		text: string;
		width: number;
		startUtf16: number;
		endUtf16: number;
		startGrapheme: number;
		endGrapheme: number;
		breakAfter: 'explicit' | 'legal' | 'hyphenated' | 'emergency' | 'end';
		constraint: LineWidthConstraint;
	}>;
	complete: boolean;
}

export interface TextLayoutCacheDiagnostics {
	records: number;
	bytes: number;
	hits: number;
	misses: number;
	evictions: number;
	maxRecords: number;
	maxBytes: number;
}

export interface TextLayoutPort {
	prepare(input: PreparedTextInput): PreparedTextHandle;
	layout(handle: PreparedTextHandle, lines: LineWidthConstraint[]): TextLinePlan;
	measure(input: PreparedTextInput): number;
	disposeScope(scopeId: string): void;
	inspectCache(): TextLayoutCacheDiagnostics;
}

export interface OverlayLayoutSettingsV2 {
	mode: 'bubble-segmentation' | 'auto-fit' | 'text-replacement';
	minimumFontSizeAt1200: number;
	fontScale: number;
	orientationPolicy: 'force-horizontal' | 'preserve-source';
	variableFontSizing: boolean;
	/**
	 * Policy-21: render free-floating SFX items. When false, items typed
	 * 'sfx' whose container is free (or missing) are excluded from planning —
	 * drawn sound effects stay untranslated on the page, official-release
	 * style. Balloon-contained text is never filtered. Translations remain in
	 * the entries list either way.
	 */
	sfxOverlays: boolean;
	paddingRatio: number;
	protectedArtWeight: number;
	maxCandidatesPerItem: number;
	beamWidth: number;
}

export interface ProtectedRegionV2 {
	kind: 'head' | 'face' | 'gutter' | 'art';
	rect?: Rect;
	polygon?: Point[];
	hard: boolean;
}

export interface OverlayLayoutInput {
	scopeId: string;
	document: PageOverlayDataV2;
	translations: PageTranslationEntry[];
	settings: OverlayLayoutSettingsV2;
	protectedRegions?: ProtectedRegionV2[];
	smartSizing?: SmartSizingData;
	writingModeOverride?: OverlayWritingMode;
}

export interface OverlayLayoutDiagnostics {
	algorithmVersion: string;
	requests: number;
	coalesced: number;
	lastPlanId: string | null;
	textCache: TextLayoutCacheDiagnostics;
	fonts: FontRegistryDiagnostics;
}

export interface OverlayLayoutService {
	plan(input: OverlayLayoutInput, signal?: AbortSignal): Promise<OverlayRenderPlanV2>;
	inspect(): OverlayLayoutDiagnostics;
	clearScope(scopeId: string): void;
}

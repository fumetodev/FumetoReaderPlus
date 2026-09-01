import type { FontRegistryDiagnostics, FontRegistryPort, FontRunSpec } from './ports.js';
import { OverlayLayoutError } from './errors.js';
import { stableHash64 } from './canonical.js';

type CssModule = { default: string };
type FontAsset = {
	fontKey: string;
	family: string;
	package: string;
	version: string;
	sha256: string;
	upstreamFamily: string;
	weights?: readonly (400 | 700)[];
	loadCss: (weight: 400 | 700) => Promise<CssModule>;
};

const ASSETS: FontAsset[] = [
	{ fontKey: 'noto-sans', family: 'Fumeto Noto Sans', package: '@fontsource/noto-sans', version: '5.2.10', sha256: '5b16208990cec4387aa53057924905592a05925e7bfe91a8c56dc078c7f7df54', upstreamFamily: 'Noto Sans', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans/700.css?inline') : import('@fontsource/noto-sans/400.css?inline') },
	{ fontKey: 'noto-sans-jp', family: 'Fumeto Noto Sans JP', package: '@fontsource/noto-sans-jp', version: '5.2.9', sha256: '69ad4544dfcca452bbc2619b2ff1d4be5315cdb61bc7903d65ccad0d6d91b023', upstreamFamily: 'Noto Sans JP', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-jp/700.css?inline') : import('@fontsource/noto-sans-jp/400.css?inline') },
	{ fontKey: 'noto-sans-sc', family: 'Fumeto Noto Sans SC', package: '@fontsource/noto-sans-sc', version: '5.2.9', sha256: 'd76fffd4e9d6c88cb762d9699bc7c4ebc2ed79cb573357d798ae3c8fd99f50d1', upstreamFamily: 'Noto Sans SC', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-sc/700.css?inline') : import('@fontsource/noto-sans-sc/400.css?inline') },
	{ fontKey: 'noto-sans-tc', family: 'Fumeto Noto Sans TC', package: '@fontsource/noto-sans-tc', version: '5.2.9', sha256: '02f7f18c039c68b9f3ba3878e11e0c1caa6ad104a6248d4c3f9fb096d1d3f30b', upstreamFamily: 'Noto Sans TC', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-tc/700.css?inline') : import('@fontsource/noto-sans-tc/400.css?inline') },
	{ fontKey: 'noto-sans-kr', family: 'Fumeto Noto Sans KR', package: '@fontsource/noto-sans-kr', version: '5.2.9', sha256: '9d72510ac642c45f9253c58e251e63c1ed0a372948fb1a6c9bedc031bc267212', upstreamFamily: 'Noto Sans KR', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-kr/700.css?inline') : import('@fontsource/noto-sans-kr/400.css?inline') },
	{ fontKey: 'noto-sans-thai', family: 'Fumeto Noto Sans Thai', package: '@fontsource/noto-sans-thai', version: '5.2.8', sha256: '14cdffff5037b87dcdad2d050332778719d07dceb6761567a79cbe95ba4c75a4', upstreamFamily: 'Noto Sans Thai', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-thai/700.css?inline') : import('@fontsource/noto-sans-thai/400.css?inline') },
	{ fontKey: 'noto-sans-devanagari', family: 'Fumeto Noto Sans Devanagari', package: '@fontsource/noto-sans-devanagari', version: '5.2.8', sha256: '61fefd8511e75ea20bccf4b6c39462cbb6e0c86d7c50644fab35a3ce5ff640e0', upstreamFamily: 'Noto Sans Devanagari', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-devanagari/700.css?inline') : import('@fontsource/noto-sans-devanagari/400.css?inline') },
	{ fontKey: 'noto-sans-arabic', family: 'Fumeto Noto Sans Arabic', package: '@fontsource/noto-sans-arabic', version: '5.2.10', sha256: '1bd1a2926fc7e18cc47137fbe6e58e610cd3c413b2e3e026c7150e5bcf73b172', upstreamFamily: 'Noto Sans Arabic', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-sans-arabic/700.css?inline') : import('@fontsource/noto-sans-arabic/400.css?inline') },
	{ fontKey: 'noto-emoji', family: 'Fumeto Noto Emoji', package: '@fontsource/noto-emoji', version: '5.2.11', sha256: '8700675bf2ed5295cb8fe7cf3f4aeb77f44cd3286c0d82fa0ebe87735d8fda94', upstreamFamily: 'Noto Emoji', loadCss: (weight) => weight === 700 ? import('@fontsource/noto-emoji/700.css?inline') : import('@fontsource/noto-emoji/400.css?inline') },
	{ fontKey: 'noto-sans-symbols', family: 'Fumeto Noto Sans Symbols', package: '@fontsource/noto-sans-symbols-2', version: '5.2.8', sha256: 'fcf4d31eaa79273246dcbb5cc2c282e4f19906f2e9fdde87b550ee092997f3c4', upstreamFamily: 'Noto Sans Symbols 2', weights: [400], loadCss: () => import('@fontsource/noto-sans-symbols-2/400.css?inline') }
];

const byKey = new Map(ASSETS.map((asset) => [asset.fontKey, asset]));
const FONT_LOAD_TIMEOUT_MS = 5_000;

export function fontFamilyForKey(fontKey: string): string {
	const asset = byKey.get(fontKey);
	if (!asset) throw new OverlayLayoutError('font-missing-glyph', `Unknown bundled font ${fontKey}`);
	return asset.family;
}

function fontKeyForGrapheme(grapheme: string, locale: string, arabicParagraph: boolean): string {
	const code = grapheme.codePointAt(0) ?? 0;
	const lowerLocale = locale.toLowerCase();
	const cjkLocaleKey = lowerLocale.startsWith('ko')
		? 'noto-sans-kr'
		: lowerLocale.startsWith('zh-hant') || lowerLocale.includes('-tw') || lowerLocale.includes('-hk')
			? 'noto-sans-tc'
			: lowerLocale.startsWith('zh') ? 'noto-sans-sc' : 'noto-sans-jp';
	const conventionallyCjk = /^(ja|zh|ko)(-|$)/i.test(locale);
	if ((code >= 0x0600 && code <= 0x08ff) || (code >= 0xfb50 && code <= 0xfeff)) return 'noto-sans-arabic';
	// The bundled Noto Sans Arabic asset contains its own Latin, numeric,
	// whitespace, currency, and general-punctuation faces. Keep those glyphs in
	// the same named family whenever Arabic is present so a shaped paragraph is
	// measured and painted with identical metrics instead of being split at every
	// space, digit, or full stop.
	if (arabicParagraph && (
		code <= 0x024f
		|| (code >= 0x1e00 && code <= 0x1eff)
		|| (code >= 0x2000 && code <= 0x206f)
		|| (code >= 0x20a0 && code <= 0x20cf)
	)) return 'noto-sans-arabic';
	if ((code >= 0x0900 && code <= 0x097f) || (code >= 0xa8e0 && code <= 0xa8ff)) return 'noto-sans-devanagari';
	if (code >= 0x0e00 && code <= 0x0e7f) return 'noto-sans-thai';
	if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f) || (code >= 0xac00 && code <= 0xd7af)) return 'noto-sans-kr';
	if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x3040 && code <= 0x30ff)) return cjkLocaleKey;
	if (code >= 0xff00 && code <= 0xffef) return cjkLocaleKey;
	if (code >= 0x1f000 && code <= 0x1faff) return 'noto-emoji';
	if (code >= 0x2190 && code <= 0x2bff) return 'noto-sans-symbols';
	if (code >= 0x2000 && code <= 0x218f) return conventionallyCjk ? cjkLocaleKey : 'noto-sans';
	if (code <= 0x052f || (code >= 0x1e00 && code <= 0x1eff) || /\s/u.test(grapheme)) return 'noto-sans';
	throw new OverlayLayoutError('font-missing-glyph', `No bundled overlay font covers U+${code.toString(16).toUpperCase()}`, { grapheme, locale });
}

export class DeterministicFontRegistry implements FontRegistryPort {
	private readonly loaded = new Set<string>();
	private readonly loading = new Map<string, Promise<void>>();
	private readonly failures: Array<{ fontKey: string; reason: string }> = [];
	private readonly weights = new Map<string, Set<number>>();

	fingerprint(): string {
		return `fumeto-fonts-${stableHash64(ASSETS.map(({ fontKey, version, sha256 }) => ({ fontKey, version, sha256 })))}`;
	}

	resolveRuns(text: string, locale: string, styleKey: string): FontRunSpec[] {
		if (typeof Intl.Segmenter !== 'function') {
			throw new OverlayLayoutError('unsupported-runtime', 'Intl.Segmenter is required for overlay layout');
		}
		const requestedWeight = styleKey === 'sfx' ? 700 : 400;
		const segments = [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(text)];
		const arabicParagraph = /\p{Script=Arabic}/u.test(text);
		const result: FontRunSpec[] = [];
		for (const segment of segments) {
			const fontKey = fontKeyForGrapheme(segment.segment, locale, arabicParagraph);
			const asset = byKey.get(fontKey)!;
			const weight = asset.weights?.includes(requestedWeight) === false ? 400 : requestedWeight;
			const previous = result[result.length - 1];
			if (previous?.fontKey === fontKey && previous.weight === weight && previous.endUtf16 === segment.index) {
				previous.text += segment.segment;
				previous.endUtf16 += segment.segment.length;
			} else {
				result.push({
					text: segment.segment,
					startUtf16: segment.index,
					endUtf16: segment.index + segment.segment.length,
					fontKey,
					family: asset.family,
					weight
				});
			}
		}
		return result;
	}

	async ensureReady(fontKeys: string[], sampleText: string): Promise<void> {
		if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
			throw new OverlayLayoutError('unsupported-runtime', 'FontFace and document.fonts are required for overlay layout');
		}
		const unique = [...new Set(fontKeys)];
		await Promise.all(unique.map((key) => this.load(key, sampleText)));
	}

	private load(fontKey: string, sampleText: string): Promise<void> {
		const existing = this.loading.get(fontKey);
		if (existing) return existing;
		const asset = byKey.get(fontKey);
		if (!asset) return Promise.reject(new OverlayLayoutError('font-missing-glyph', `Unknown bundled font ${fontKey}`));
		const promise = (async () => {
			try {
				for (const weight of asset.weights ?? [400, 700] as const) {
					const module = await asset.loadCss(weight);
					const styleId = `fumeto-overlay-font-${fontKey}-${weight}`;
					if (!document.getElementById(styleId)) {
						const style = document.createElement('style');
						style.id = styleId;
						style.dataset.fumetoOverlayFont = fontKey;
						style.textContent = module.default.replaceAll(`'${asset.upstreamFamily}'`, `'${asset.family}'`);
						document.head.appendChild(style);
					}
					let timeout: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							document.fonts.load(`${weight} 16px "${asset.family}"`, sampleText),
							new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new OverlayLayoutError('font-timeout', `Timed out loading ${fontKey}`)), FONT_LOAD_TIMEOUT_MS); })
						]);
					} finally {
						if (timeout) clearTimeout(timeout);
					}
					if (!document.fonts.check(`${weight} 16px "${asset.family}"`, sampleText)) {
						throw new OverlayLayoutError('font-missing-glyph', `Bundled font ${fontKey} did not become ready`);
					}
					const weights = this.weights.get(fontKey) ?? new Set<number>();
					weights.add(weight);
					this.weights.set(fontKey, weights);
				}
				this.loaded.add(fontKey);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.failures.push({ fontKey, reason });
				throw error;
			}
		})();
		this.loading.set(fontKey, promise);
		return promise;
	}

	inspect(): FontRegistryDiagnostics {
		return {
			fingerprint: this.fingerprint(),
			loaded: [...this.loaded].sort(),
			loading: [...this.loading.entries()].filter(([key]) => !this.loaded.has(key)).map(([key]) => key).sort(),
			failures: [...this.failures],
			assets: ASSETS.map(({ fontKey, package: packageName, version, sha256 }) => ({ fontKey, package: packageName, version, sha256 }))
		};
	}
}

export const overlayFontRegistry = new DeterministicFontRegistry();

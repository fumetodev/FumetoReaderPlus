import type { FumetoSettings } from '$lib/settings/settings.js';
import type { OverlayLayoutSettingsV2 } from './ports.js';
import { DEFAULT_OVERLAY_LAYOUT_SETTINGS } from './layout-service.js';

export function overlayLayoutSettingsFromApp(
	settings: Readonly<FumetoSettings>,
	fontScale = 1
): OverlayLayoutSettingsV2 {
	return {
		...DEFAULT_OVERLAY_LAYOUT_SETTINGS,
		mode: settings.overlayMode ?? 'bubble-segmentation',
		minimumFontSizeAt1200: settings.overlayMinFontSize ?? 10,
		fontScale,
		orientationPolicy: settings.overlayVerticalText ? 'preserve-source' : 'force-horizontal',
		variableFontSizing: settings.variableFontSizing ?? false,
		sfxOverlays: settings.overlaySfx ?? false
	};
}

export type ReaderToolMode =
	| 'navigate'
	| 'draw-regions'
	| 'box-editor'
	| 'transform-box'
	| 'move-box'
	| 'resize-box';

/**
 * Every transient reader popover claims this single slot, so mutual
 * exclusivity is structural: opening one surface replaces whatever was open.
 */
export type ReaderDisclosureSurface =
	| 'more'
	| 'translate-options'
	| 'filmstrip'
	| 'page-jump'
	| 'translate-status'
	| 'overlay-reveal'
	| 'overlay-boxes'
	| 'book-toc'
	| 'book-display';

/**
 * Chrome-anchored surfaces hang off the header/bottom bar: they force chrome
 * visible and die with hidden chrome or an active tool. 'overlay-reveal' is
 * canvas-anchored: it must survive immersive (hidden chrome) reveal taps and
 * per-box actions during transform-box.
 */
const CHROME_ANCHORED: ReadonlySet<ReaderDisclosureSurface> = new Set([
	'more',
	'translate-options',
	'filmstrip',
	'page-jump',
	'translate-status',
	'overlay-boxes',
	'book-toc',
	'book-display'
]);

export interface MobileReaderUiSnapshot {
	chrome: 'hidden' | 'visible';
	disclosure: ReaderDisclosureSurface | null;
	toolMode: ReaderToolMode;
}

export type MobileReaderUiCommand =
	| { type: 'toggle-chrome' }
	| { type: 'open-disclosure'; surface: ReaderDisclosureSurface }
	| { type: 'toggle-disclosure'; surface: ReaderDisclosureSurface }
	| { type: 'close-disclosure' }
	| { type: 'close-transient' }
	| { type: 'set-tool-mode'; mode: ReaderToolMode }
	| { type: 'reset-session' };

export type ReaderBackOutcome =
	| 'closed-disclosure'
	| 'closed-tool'
	| 'hid-chrome'
	| 'leave-reader';

export const DEFAULT_MOBILE_READER_UI: Readonly<MobileReaderUiSnapshot> = Object.freeze({
	chrome: 'visible',
	disclosure: null,
	toolMode: 'navigate'
});

function clearChromeAnchored(disclosure: ReaderDisclosureSurface | null): ReaderDisclosureSurface | null {
	return disclosure !== null && CHROME_ANCHORED.has(disclosure) ? null : disclosure;
}

function normalized(snapshot: MobileReaderUiSnapshot): MobileReaderUiSnapshot {
	const next = { ...snapshot };
	if (next.chrome === 'hidden') next.disclosure = clearChromeAnchored(next.disclosure);
	if (next.toolMode !== 'navigate') next.disclosure = clearChromeAnchored(next.disclosure);
	return next;
}

export function reduceMobileReaderUi(
	snapshot: Readonly<MobileReaderUiSnapshot>,
	command: MobileReaderUiCommand
): MobileReaderUiSnapshot {
	switch (command.type) {
		case 'toggle-chrome':
			return normalized({
				...snapshot,
				chrome: snapshot.chrome === 'visible' ? 'hidden' : 'visible',
				disclosure: clearChromeAnchored(snapshot.disclosure)
			});
		case 'open-disclosure':
		case 'toggle-disclosure': {
			const surface = command.type === 'toggle-disclosure' && snapshot.disclosure === command.surface
				? null
				: command.surface;
			if (surface === null) return normalized({ ...snapshot, disclosure: null });
			if (CHROME_ANCHORED.has(surface)) {
				return normalized({ ...snapshot, chrome: 'visible', disclosure: surface });
			}
			return normalized({ ...snapshot, disclosure: surface });
		}
		case 'close-disclosure':
			return normalized({ ...snapshot, disclosure: null });
		case 'close-transient':
			return normalized({ ...snapshot, disclosure: null, toolMode: 'navigate' });
		case 'set-tool-mode':
			return normalized({ ...snapshot, toolMode: command.mode });
		case 'reset-session':
			return { ...DEFAULT_MOBILE_READER_UI };
	}
}

export interface MobileReaderUiController {
	inspect(): MobileReaderUiSnapshot;
	subscribe(listener: (snapshot: MobileReaderUiSnapshot) => void): () => void;
	toggleChrome(): void;
	openDisclosure(surface: ReaderDisclosureSurface): void;
	toggleDisclosure(surface: ReaderDisclosureSurface): void;
	closeDisclosure(): void;
	closeTransient(): void;
	setToolMode(mode: ReaderToolMode): void;
	handleBack(): ReaderBackOutcome;
	resetForReaderSession(): void;
}

export function createMobileReaderUiController(
	initial: MobileReaderUiSnapshot = { ...DEFAULT_MOBILE_READER_UI }
): MobileReaderUiController {
	let state = normalized(initial);
	const listeners = new Set<(snapshot: MobileReaderUiSnapshot) => void>();
	const inspect = () => ({ ...state });
	const publish = () => {
		const value = inspect();
		for (const listener of listeners) {
			// Listener isolation: one throwing subscriber must not starve every
			// subscriber registered after it — that desynchronizes the chrome UI
			// from this state machine until the components remount.
			try {
				listener(value);
			} catch (error) {
				console.error('mobileReaderUi listener failed', error);
			}
		}
	};
	const dispatch = (command: MobileReaderUiCommand) => {
		const next = reduceMobileReaderUi(state, command);
		if (
			next.chrome === state.chrome
			&& next.disclosure === state.disclosure
			&& next.toolMode === state.toolMode
		) return;
		state = next;
		publish();
	};

	return {
		inspect,
		subscribe(listener) {
			listener(inspect());
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		toggleChrome: () => dispatch({ type: 'toggle-chrome' }),
		openDisclosure: (surface) => dispatch({ type: 'open-disclosure', surface }),
		toggleDisclosure: (surface) => dispatch({ type: 'toggle-disclosure', surface }),
		closeDisclosure: () => dispatch({ type: 'close-disclosure' }),
		closeTransient: () => dispatch({ type: 'close-transient' }),
		setToolMode: (mode) => dispatch({ type: 'set-tool-mode', mode }),
		handleBack() {
			if (state.disclosure !== null) {
				dispatch({ type: 'close-disclosure' });
				return 'closed-disclosure';
			}
			if (state.toolMode !== 'navigate') {
				dispatch({ type: 'set-tool-mode', mode: 'navigate' });
				return 'closed-tool';
			}
			if (state.chrome === 'visible') {
				dispatch({ type: 'toggle-chrome' });
				return 'hid-chrome';
			}
			return 'leave-reader';
		},
		resetForReaderSession: () => dispatch({ type: 'reset-session' })
	};
}

export const mobileReaderUi = createMobileReaderUiController();

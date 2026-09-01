export interface ReaderPageJumpSnapshot {
	volumeUuid: string | null;
	returnIndex: number | null;
	expiresAt: number | null;
}

const listeners = new Set<(snapshot: ReaderPageJumpSnapshot) => void>();
let state: ReaderPageJumpSnapshot = { volumeUuid: null, returnIndex: null, expiresAt: null };
let timer: ReturnType<typeof setTimeout> | null = null;

function inspect(): ReaderPageJumpSnapshot { return { ...state }; }
function publish(): void {
	const value = inspect();
	for (const listener of listeners) listener(value);
}
function clear(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	state = { volumeUuid: state.volumeUuid, returnIndex: null, expiresAt: null };
	publish();
}

export const readerPageJump = {
	inspect,
	subscribe(listener: (snapshot: ReaderPageJumpSnapshot) => void): () => void {
		listener(inspect());
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	setVolume(volumeUuid: string | null): void {
		if (state.volumeUuid === volumeUuid) return;
		if (timer) clearTimeout(timer);
		timer = null;
		state = { volumeUuid, returnIndex: null, expiresAt: null };
		publish();
	},
	recordJump(volumeUuid: string, previousIndex: number, nextIndex: number, ttlMs = 6_000): void {
		if (Math.abs(previousIndex - nextIndex) <= 1) {
			state = { ...state, volumeUuid };
			return;
		}
		if (timer) clearTimeout(timer);
		const expiresAt = Date.now() + ttlMs;
		state = { volumeUuid, returnIndex: previousIndex, expiresAt };
		publish();
		timer = setTimeout(clear, ttlMs);
	},
	consume(): number | null {
		const index = state.returnIndex;
		clear();
		return index;
	},
	clear
};


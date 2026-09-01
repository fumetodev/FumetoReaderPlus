export interface OverlayLongPressPoint<T extends string | number = number> {
	pointerId: number;
	x: number;
	y: number;
	boxId: T;
}

export interface OverlayBoxLongPressOptions<T extends string | number = number> {
	delayMs?: number;
	slopPx?: number;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	onRecognized: (boxId: T) => void;
}

export class OverlayBoxLongPressRecognizer<T extends string | number = number> {
	private active: OverlayLongPressPoint<T> | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pointers = new Set<number>();
	private suppressNextClick = false;
	private readonly delayMs: number;
	private readonly slopPx: number;
	private readonly setTimer: NonNullable<OverlayBoxLongPressOptions<T>['setTimer']>;
	private readonly clearTimer: NonNullable<OverlayBoxLongPressOptions<T>['clearTimer']>;

	constructor(private readonly options: OverlayBoxLongPressOptions<T>) {
		this.delayMs = options.delayMs ?? 500;
		this.slopPx = options.slopPx ?? 10;
		this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
	}

	pointerDown(point: OverlayLongPressPoint<T>): void {
		this.pointers.add(point.pointerId);
		if (this.pointers.size !== 1) {
			this.cancelCandidate();
			return;
		}
		this.active = point;
		this.timer = this.setTimer(() => {
			const active = this.active;
			this.timer = null;
			if (!active || this.pointers.size !== 1) return;
			this.suppressNextClick = true;
			this.options.onRecognized(active.boxId);
		}, this.delayMs);
	}

	/** Observe contacts that begin outside the candidate box (for pinch cancellation). */
	pointerContactDown(pointerId: number): void {
		if (this.pointers.has(pointerId)) return;
		this.pointers.add(pointerId);
		if (this.pointers.size > 1) this.cancelCandidate();
	}

	pointerContactUp(pointerId: number): void {
		this.pointerUp(pointerId);
	}

	pointerMove(pointerId: number, x: number, y: number): void {
		if (!this.active || this.active.pointerId !== pointerId) return;
		if (Math.hypot(x - this.active.x, y - this.active.y) > this.slopPx) this.cancelCandidate();
	}

	pointerUp(pointerId: number): void {
		this.pointers.delete(pointerId);
		if (this.active?.pointerId === pointerId) this.cancelCandidate();
	}

	pointerCancel(pointerId?: number): void {
		if (pointerId === undefined) this.pointers.clear();
		else this.pointers.delete(pointerId);
		this.cancelCandidate();
	}

	navigationChanged(): void {
		this.pointers.clear();
		this.cancelCandidate();
	}

	consumeSyntheticClick(): boolean {
		if (!this.suppressNextClick) return false;
		this.suppressNextClick = false;
		return true;
	}

	dispose(): void {
		this.pointerCancel();
		this.suppressNextClick = false;
	}

	private cancelCandidate(): void {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		this.active = null;
	}
}

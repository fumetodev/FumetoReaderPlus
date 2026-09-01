export type DrawGesture =
	| 'idle'
	| 'tentative-draw'
	| 'two-finger-transform'
	| 'blocked-until-all-pointers-release';

export interface DrawPoint { x: number; y: number }
export interface DrawTransform { x: number; y: number; scale: number }
export interface ScreenRectangle { x: number; y: number; width: number; height: number }

export interface RegionDrawGestureUpdate {
	gesture: DrawGesture;
	tentative: ScreenRectangle | null;
	transform: DrawTransform | null;
	commit: ScreenRectangle | null;
}

export class RegionDrawGestureArbiter {
	private pointers = new Map<number, DrawPoint>();
	private gesture: DrawGesture = 'idle';
	private primaryPointer: number | null = null;
	private drawStart: DrawPoint | null = null;
	private tentative: ScreenRectangle | null = null;
	private transform: DrawTransform = { x: 0, y: 0, scale: 1 };
	private transformStart: {
		points: [DrawPoint, DrawPoint];
		transform: DrawTransform;
		centroid: DrawPoint;
		distance: number;
	} | null = null;

	constructor(private readonly minScreenSize = 12) {}

	setTransform(transform: DrawTransform): void {
		this.transform = { ...transform };
	}

	inspect(): RegionDrawGestureUpdate {
		return this.update(null);
	}

	pointerDown(pointerId: number, point: DrawPoint, insidePage: boolean): RegionDrawGestureUpdate {
		this.pointers.set(pointerId, { ...point });
		if (this.gesture === 'blocked-until-all-pointers-release') return this.update(null);
		if (this.pointers.size === 1 && insidePage) {
			this.gesture = 'tentative-draw';
			this.primaryPointer = pointerId;
			this.drawStart = { ...point };
			this.tentative = rectangle(point, point);
			return this.update(null);
		}
		if (this.pointers.size >= 2) {
			this.tentative = null;
			this.drawStart = null;
			this.primaryPointer = null;
			this.gesture = 'two-finger-transform';
			this.beginTransform();
		}
		return this.update(null);
	}

	pointerMove(pointerId: number, point: DrawPoint): RegionDrawGestureUpdate {
		if (!this.pointers.has(pointerId)) return this.update(null);
		this.pointers.set(pointerId, { ...point });
		if (this.gesture === 'tentative-draw' && pointerId === this.primaryPointer && this.drawStart) {
			this.tentative = rectangle(this.drawStart, point);
		} else if (this.gesture === 'two-finger-transform' && this.pointers.size >= 2 && this.transformStart) {
			const [first, second] = firstTwo(this.pointers);
			const centroid = midpoint(first, second);
			const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
			const ratio = distance / this.transformStart.distance;
			const scale = clamp(this.transformStart.transform.scale * ratio, 0.01, 10);
			const scaleRatio = scale / this.transformStart.transform.scale;
			this.transform = {
				x: centroid.x + (this.transformStart.transform.x - this.transformStart.centroid.x) * scaleRatio,
				y: centroid.y + (this.transformStart.transform.y - this.transformStart.centroid.y) * scaleRatio,
				scale
			};
			return this.update(this.transform);
		}
		return this.update(null);
	}

	pointerUp(pointerId: number): RegionDrawGestureUpdate {
		const finishingDraw = this.gesture === 'tentative-draw' && pointerId === this.primaryPointer;
		const commit = finishingDraw && this.tentative
			&& this.tentative.width >= this.minScreenSize
			&& this.tentative.height >= this.minScreenSize
			? { ...this.tentative }
			: null;
		this.pointers.delete(pointerId);
		if (this.gesture === 'two-finger-transform' || this.gesture === 'blocked-until-all-pointers-release') {
			this.gesture = this.pointers.size === 0 ? 'idle' : 'blocked-until-all-pointers-release';
		} else if (finishingDraw) {
			this.gesture = this.pointers.size === 0 ? 'idle' : 'blocked-until-all-pointers-release';
		}
		this.tentative = null;
		this.drawStart = null;
		this.primaryPointer = null;
		this.transformStart = null;
		return this.update(commit, true);
	}

	pointerCancel(pointerId: number): RegionDrawGestureUpdate {
		const wasTransform = this.gesture === 'two-finger-transform'
			|| this.gesture === 'blocked-until-all-pointers-release';
		this.pointers.delete(pointerId);
		this.tentative = null;
		this.drawStart = null;
		this.primaryPointer = null;
		this.transformStart = null;
		this.gesture = this.pointers.size === 0
			? 'idle'
			: (wasTransform ? 'blocked-until-all-pointers-release' : 'idle');
		return this.update(null);
	}

	/** Cancel every active contact, for rotation or target teardown. */
	cancel(): RegionDrawGestureUpdate {
		this.pointers.clear();
		this.tentative = null;
		this.drawStart = null;
		this.primaryPointer = null;
		this.transformStart = null;
		this.gesture = 'idle';
		return this.update(null);
	}

	reset(): RegionDrawGestureUpdate {
		this.pointers.clear();
		this.gesture = 'idle';
		this.tentative = null;
		this.drawStart = null;
		this.primaryPointer = null;
		this.transformStart = null;
		return this.update(null);
	}

	private beginTransform(): void {
		const [first, second] = firstTwo(this.pointers);
		this.transformStart = {
			points: [{ ...first }, { ...second }],
			transform: { ...this.transform },
			centroid: midpoint(first, second),
			distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
		};
	}

	private update(value: DrawTransform | ScreenRectangle | null, valueIsCommit = false): RegionDrawGestureUpdate {
		return {
			gesture: this.gesture,
			tentative: this.tentative ? { ...this.tentative } : null,
			transform: !valueIsCommit && value && 'scale' in value ? { ...value } : null,
			commit: valueIsCommit && value && !('scale' in value) ? { ...value } : null
		};
	}
}

function firstTwo(points: Map<number, DrawPoint>): [DrawPoint, DrawPoint] {
	const iterator = points.values();
	return [iterator.next().value as DrawPoint, iterator.next().value as DrawPoint];
}

function midpoint(first: DrawPoint, second: DrawPoint): DrawPoint {
	return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function rectangle(first: DrawPoint, second: DrawPoint): ScreenRectangle {
	return {
		x: Math.min(first.x, second.x),
		y: Math.min(first.y, second.y),
		width: Math.abs(second.x - first.x),
		height: Math.abs(second.y - first.y)
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

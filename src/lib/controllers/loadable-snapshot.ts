export type LoadablePhase = 'uninitialized' | 'loading' | 'ready' | 'refreshing' | 'error';

export interface LoadableSnapshot<T> {
	phase: LoadablePhase;
	data?: T;
	revision: number;
	error?: Error;
}

export function uninitializedSnapshot<T>(): LoadableSnapshot<T> {
	return { phase: 'uninitialized', revision: 0 };
}

export function beginLoading<T>(previous: LoadableSnapshot<T>): LoadableSnapshot<T> {
	return previous.data === undefined
		? { phase: 'loading', revision: previous.revision }
		: { phase: 'refreshing', data: previous.data, revision: previous.revision };
}

export function readySnapshot<T>(previous: LoadableSnapshot<T>, data: T): LoadableSnapshot<T> {
	return { phase: 'ready', data, revision: previous.revision + 1 };
}

export function errorSnapshot<T>(previous: LoadableSnapshot<T>, error: unknown): LoadableSnapshot<T> {
	return {
		phase: 'error',
		data: previous.data,
		revision: previous.revision,
		error: error instanceof Error ? error : new Error(String(error))
	};
}

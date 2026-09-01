import type { AppView, ReaderReturnView } from '$lib/types/index.js';

export type MobileDestination = 'tabs' | 'catalog' | 'settings';

export function destinationToView(destination: MobileDestination): AppView {
	return destination;
}

export function readerReturnForEntry(origin: ReaderReturnView): ReaderReturnView {
	return origin;
}

export function viewAfterLeavingReader(origin: ReaderReturnView): AppView {
	return origin;
}

export function isMobileDestination(view: AppView): view is MobileDestination {
	return view === 'tabs' || view === 'catalog' || view === 'settings';
}

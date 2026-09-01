import { writable } from 'svelte/store';

export type ReaderDisclosure = 'overflow' | 'overlay' | null;

export function toggleDisclosure(
	current: ReaderDisclosure,
	target: Exclude<ReaderDisclosure, null>
): ReaderDisclosure {
	return current === target ? null : target;
}

export function closeDisclosure(_current: ReaderDisclosure): ReaderDisclosure {
	return null;
}

export const readerDisclosure = writable<ReaderDisclosure>(null);

const focusCallbacks = new Map<Exclude<ReaderDisclosure, null>, () => void>();

export function registerReaderDisclosureTrigger(
	target: Exclude<ReaderDisclosure, null>,
	focus: (() => void) | undefined
): () => void {
	if (focus) focusCallbacks.set(target, focus);
	return () => {
		if (focus && focusCallbacks.get(target) === focus) focusCallbacks.delete(target);
	};
}

export function toggleReaderDisclosure(target: Exclude<ReaderDisclosure, null>): void {
	readerDisclosure.update((current) => toggleDisclosure(current, target));
}

export function dismissReaderDisclosure(
	current: ReaderDisclosure,
	options: { restoreFocus?: boolean } = {}
): boolean {
	if (current === null) return false;
	readerDisclosure.set(null);
	if (options.restoreFocus !== false) {
		requestAnimationFrame(() => focusCallbacks.get(current)?.());
	}
	return true;
}

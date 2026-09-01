/**
 * The live UI locale, and the one place Paraglide learns about it.
 *
 * Every compiled message function ends in `getLocale()`. This module replaces
 * that with a read of a `fromStore(...)` signal, so a message rendered inside
 * a template effect depends on the locale and re-renders when it changes —
 * no `{#key}` remount, no `$locale` read in every template (measured in the
 * 2026-08-27 spike: same element, same text node after the switch). Plain
 * `.ts` services calling a message at event time get the current value.
 *
 * Seeded from localStorage before the settings module loads, so the crash
 * boundary in `+layout.svelte` can speak the right language with a dead app
 * tree. This file must stay a leaf: it must never import `$lib/settings`,
 * because settings imports it for first-run seeding.
 */
import { fromStore, get, writable, type Readable } from 'svelte/store';
import { overwriteGetLocale, type Locale } from '$lib/paraglide/runtime.js';
import { resolveUiLocale, type UiLocale, type UiLocaleSetting } from './locales.js';

/** Mirror of the settings module's storage key; the settings module is not importable here. */
export const SETTINGS_STORAGE_KEY = 'fumetoreaderplus-settings';

function deviceLanguages(): readonly string[] {
	try {
		const navigatorLike = globalThis.navigator;
		if (!navigatorLike) return [];
		const list = navigatorLike.languages;
		if (Array.isArray(list) && list.length > 0) return list;
		return navigatorLike.language ? [navigatorLike.language] : [];
	} catch {
		return [];
	}
}

function storedSetting(): UiLocaleSetting | undefined {
	try {
		const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
		if (!raw) return undefined;
		const value = (JSON.parse(raw) as { uiLocale?: unknown }).uiLocale;
		return typeof value === 'string' ? (value as UiLocaleSetting) : undefined;
	} catch {
		return undefined;
	}
}

const store = writable<UiLocale>(resolveUiLocale(storedSetting(), deviceLanguages()));

/** The locale the UI renders in. Read `$uiLocale` for anything that must follow a switch. */
export const uiLocale: Readable<UiLocale> = { subscribe: store.subscribe };

const reactive = fromStore(uiLocale);
overwriteGetLocale(() => reactive.current as Locale);

export function getUiLocale(): UiLocale {
	return get(store);
}

export function applyHtmlLang(tag: string): void {
	try {
		if (typeof document !== 'undefined') document.documentElement.lang = tag;
	} catch {
		// Nothing to do without a document.
	}
}

function pushToNative(tag: string): void {
	try {
		globalThis.window?.__fumeto_android?.setUiLocale?.(tag);
	} catch {
		// The bridge is a JS interface into Kotlin; a throw must not take the UI down.
	}
}

/**
 * Apply a setting (`'system'` or a tag). Called from the settings binding at
 * boot and on every change, and eagerly from the language picker so the
 * labels swap before the settings debounce lands.
 */
export function setUiLocale(setting: UiLocaleSetting | string | undefined): UiLocale {
	const next = resolveUiLocale(setting, deviceLanguages());
	if (next !== get(store)) store.set(next);
	applyHtmlLang(next);
	pushToNative(next);
	return next;
}

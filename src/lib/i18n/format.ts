/**
 * Number, date and list formatting bound to the UI locale.
 *
 * The app used to hand-roll these: `toFixed(1)`, a private `formatBytes`,
 * `toLocaleDateString(undefined)` (the HOST locale, not the app's), a `$`
 * glued in front of a price. Every helper here takes an optional locale and
 * defaults to the live UI locale; `Intl` instances are cached because
 * constructing one per render is the mistake CatalogView already paid for
 * with its collators.
 *
 * Plurals are deliberately absent: they are messages with a `plural`
 * selector, never a helper that appends "s".
 */
import { getUiLocale } from './locale.js';

const cache = new Map<string, unknown>();

function cached<T>(kind: string, locale: string, options: object, create: () => T): T {
	const key = `${kind}|${locale}|${JSON.stringify(options)}`;
	let instance = cache.get(key) as T | undefined;
	if (instance === undefined) {
		instance = create();
		cache.set(key, instance);
	}
	return instance;
}

function localeOf(locale?: string): string {
	return locale ?? getUiLocale();
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, locale?: string): string {
	try {
		return cached('number', localeOf(locale), options, () => new Intl.NumberFormat(localeOf(locale), options)).format(value);
	} catch {
		return String(value);
	}
}

/** `0.42` → `42%`; digits control the fraction, never a trailing `%` glued on. */
export function formatPercent(ratio: number, digits = 0, locale?: string): string {
	return formatNumber(ratio, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }, locale);
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** `1_234_567` → `1.2 MB` in the locale's own digits, separator and unit. */
export function formatBytes(bytes: number, locale?: string): string {
	const safe = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
	let index = 0;
	let value = safe;
	while (value >= 1024 && index < BYTE_UNITS.length - 1) {
		value /= 1024;
		index += 1;
	}
	const digits = index === 0 ? 0 : value < 10 ? 1 : 0;
	try {
		return formatNumber(
			value,
			{ style: 'unit', unit: BYTE_UNITS[index], unitDisplay: 'short', maximumFractionDigits: digits },
			locale
		);
	} catch {
		return `${value.toFixed(digits)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
	}
}

/** Provider prices are quoted in USD; the locale decides how a dollar amount reads. */
export function formatCurrency(amount: number, currency = 'USD', locale?: string, digits = 2): string {
	return formatNumber(amount, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }, locale);
}

export function formatDate(value: Date | string | number, style: 'short' | 'medium' | 'long' = 'medium', locale?: string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	try {
		return cached('date', localeOf(locale), { dateStyle: style }, () =>
			new Intl.DateTimeFormat(localeOf(locale), { dateStyle: style })
		).format(date);
	} catch {
		return date.toISOString().slice(0, 10);
	}
}

export function formatDateTime(value: Date | string | number, locale?: string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	try {
		return cached('datetime', localeOf(locale), { dateStyle: 'medium', timeStyle: 'short' }, () =>
			new Intl.DateTimeFormat(localeOf(locale), { dateStyle: 'medium', timeStyle: 'short' })
		).format(date);
	} catch {
		return date.toISOString();
	}
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	['year', 365 * 24 * 3600],
	['month', 30 * 24 * 3600],
	['week', 7 * 24 * 3600],
	['day', 24 * 3600],
	['hour', 3600],
	['minute', 60],
	['second', 1]
];

/** "2 days ago", "in 3 hours", "yesterday" — the locale's own words. */
export function formatRelativeTime(value: Date | string | number, now: Date | number = Date.now(), locale?: string): string {
	const date = value instanceof Date ? value : new Date(value);
	const reference = now instanceof Date ? now.getTime() : now;
	if (Number.isNaN(date.getTime())) return '';
	const deltaSeconds = Math.round((date.getTime() - reference) / 1000);
	const [unit, size] = RELATIVE_STEPS.find(([, seconds]) => Math.abs(deltaSeconds) >= seconds) ?? ['second', 1];
	const amount = Math.round(deltaSeconds / size);
	try {
		return cached('relative', localeOf(locale), { numeric: 'auto' }, () =>
			new Intl.RelativeTimeFormat(localeOf(locale), { numeric: 'auto' })
		).format(amount, unit);
	} catch {
		return formatDate(date, 'short', locale);
	}
}

export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction', locale?: string): string {
	try {
		return cached('list', localeOf(locale), { type }, () => new Intl.ListFormat(localeOf(locale), { type })).format(items);
	} catch {
		return items.join(', ');
	}
}

/** A collator for sorting user text in the UI locale; cached, unlike the per-render ones this replaces. */
export function createCollator(options: Intl.CollatorOptions = {}, locale?: string): Intl.Collator {
	return cached('collator', localeOf(locale), options, () => new Intl.Collator(localeOf(locale), options));
}

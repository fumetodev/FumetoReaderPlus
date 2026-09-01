import * as m from '$lib/paraglide/messages.js';
/**
 * Settings backup: export/import as JSON (settings review §7-6).
 *
 * Secrets never travel: the legacy OpenRouter key and per-provider API keys
 * live in encrypted secure storage and are excluded from exports and ignored
 * on import. Server credentials (Komga password, Kavita API key) are likewise
 * stored separately and never part of the settings object.
 */
import {
	DEFAULT_SETTINGS,
	sanitizePersistedLibraries,
	type FumetoSettings
} from './settings.js';

export const SETTINGS_EXPORT_KIND = 'fumeto-settings-export';
export const SETTINGS_EXPORT_FORMAT_VERSION = 1;

export interface SettingsExportEnvelope {
	kind: typeof SETTINGS_EXPORT_KIND;
	formatVersion: number;
	appVersion: string;
	exportedAt: string;
	settings: Record<string, unknown>;
}

/** Keys that must never leave the device (or be accepted from a file). */
const SECRET_KEYS = new Set(['openrouterApiKey']);

export function buildSettingsExport(
	settings: Readonly<FumetoSettings>,
	appVersion: string,
	exportedAt: Date = new Date()
): SettingsExportEnvelope {
	const payload: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof FumetoSettings>) {
		if (SECRET_KEYS.has(key)) continue;
		payload[key] = settings[key];
	}
	return {
		kind: SETTINGS_EXPORT_KIND,
		formatVersion: SETTINGS_EXPORT_FORMAT_VERSION,
		appVersion,
		exportedAt: exportedAt.toISOString(),
		settings: payload
	};
}

export function serializeSettingsExport(
	settings: Readonly<FumetoSettings>,
	appVersion: string,
	exportedAt?: Date
): string {
	return JSON.stringify(buildSettingsExport(settings, appVersion, exportedAt), null, 2);
}

export interface SettingsImportResult {
	/** Sanitized patch, ready for settings.patch(). Secrets are never present. */
	settings: Partial<FumetoSettings>;
	/** Human-readable notes about anything dropped or coerced. */
	warnings: string[];
	appVersion: string | null;
	exportedAt: string | null;
}

export class SettingsImportError extends Error {}

/**
 * Parse and validate an exported settings file. Unknown keys are dropped
 * with a warning; values whose primitive type disagrees with the defaults
 * are dropped; libraries pass the shared sanitizer; secrets are ignored.
 */
export function parseSettingsImport(json: string): SettingsImportResult {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new SettingsImportError('This file is not valid JSON.');
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new SettingsImportError('This file is not a FumetoReaderPlus settings export.');
	}
	const envelope = raw as Record<string, unknown>;
	if (envelope.kind !== SETTINGS_EXPORT_KIND) {
		throw new SettingsImportError('This file is not a FumetoReaderPlus settings export.');
	}
	if (typeof envelope.formatVersion !== 'number' || envelope.formatVersion > SETTINGS_EXPORT_FORMAT_VERSION) {
		throw new SettingsImportError('This settings file was made by a newer app version — update the app first.');
	}
	const stored = envelope.settings;
	if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
		throw new SettingsImportError('The settings section of this file is malformed.');
	}

	const source = stored as Record<string, unknown>;
	const warnings: string[] = [];
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(source)) {
		if (SECRET_KEYS.has(key)) {
			warnings.push(m.settings_transfer_warning_secrets());
			continue;
		}
		if (!(key in DEFAULT_SETTINGS)) {
			warnings.push(m.settings_transfer_warning_unknown_key({ key }));
			continue;
		}
		if (key === 'libraries') {
			const sanitized = sanitizePersistedLibraries(value);
			const inputCount = Array.isArray(value) ? value.length : 0;
			if (sanitized.length !== inputCount) {
				warnings.push(m.settings_transfer_warning_malformed_libraries());
			}
			out.libraries = sanitized;
			continue;
		}
		const defaultValue = DEFAULT_SETTINGS[key as keyof FumetoSettings];
		if (defaultValue !== null && value !== null && typeof value !== typeof defaultValue) {
			warnings.push(m.settings_transfer_warning_unexpected_type({ key }));
			continue;
		}
		out[key] = value;
	}

	return {
		settings: out as Partial<FumetoSettings>,
		warnings,
		appVersion: typeof envelope.appVersion === 'string' ? envelope.appVersion : null,
		exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt : null
	};
}

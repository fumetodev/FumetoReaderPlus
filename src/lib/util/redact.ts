/**
 * Credential and payload redaction.
 *
 * Deliberately dependency-free. This is imported by `diagnostics/error-ring.ts`,
 * which runs from the SvelteKit client entry before anything else in the app —
 * pulling the settings store (or anything that touches it) into that path
 * reorders module initialisation and broke the IndexedDB setup once already.
 * Keep it importing nothing.
 */

/** Redact common credential/data-URI shapes and any caller-supplied exact secret. */
export function sanitizeSensitiveText(value: string, exactSecrets: readonly string[] = []): string {
	let sanitized = value;
	for (const secret of exactSecrets) {
		if (secret.length >= 8) sanitized = sanitized.split(secret).join('[credential omitted]');
	}
	return sanitized
		.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, '[base64 image omitted]')
		.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [credential omitted]')
		.replace(/\bsk-(?:or-v1-|ant-)?[a-z0-9_-]{12,}\b/gi, '[credential omitted]');
}

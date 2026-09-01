/**
 * The hint appended to a provider's 400 text. It rides inside `Error.message`,
 * which the UI shows as raw detail beneath a coded message — so it stays
 * English like the provider text it extends, in one place for all three adapters.
 */
import type { classifyBadRequestMessage } from '../llm-types.js';

export function badRequestGuidance(category: ReturnType<typeof classifyBadRequestMessage>): string {
	switch (category) {
		case 'context_length':
			return 'Request exceeded context length; reduce context or max tokens.';
		case 'payload_too_large':
			return 'Image/payload too large; use a smaller image size.';
		case 'vision_unsupported':
			return 'Selected model does not support image input.';
		case 'invalid_request':
			return 'Invalid request parameters; verify model and settings.';
		default:
			return 'Check model/provider settings and retry.';
	}
}

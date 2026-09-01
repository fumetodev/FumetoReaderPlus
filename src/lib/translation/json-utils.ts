/**
 * JSON extraction and repair helpers for LLM responses.
 */

/**
 * Strip markdown fences if present.
 */
export function stripMarkdownFence(input: string): string {
	const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
	return fenced ? fenced[1].trim() : input.trim();
}

/**
 * Extract balanced JSON object substrings from a string.
 * Ignores braces inside JSON strings.
 */
export function extractBalancedJsonObjects(input: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === '{') {
			if (depth === 0) start = i;
			depth++;
			continue;
		}

		if (ch === '}' && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				out.push(input.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return out;
}

/** Extract balanced top-level JSON arrays while ignoring brackets in strings. */
export function extractBalancedJsonArrays(input: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '[') {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === ']' && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				out.push(input.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return out;
}

/**
 * Collect JSON candidates from both fenced and raw response text.
 */
export function extractJsonCandidates(input: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const pushUnique = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		candidates.push(trimmed);
	};

	for (const source of [stripMarkdownFence(input), input]) {
		for (const obj of extractBalancedJsonObjects(source)) {
			pushUnique(obj);
		}
	}

	return candidates;
}

function removeTrailingCommas(raw: string): string {
	let out = '';
	let inString = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			out += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}

		if (ch === ',') {
			let j = i + 1;
			while (j < raw.length && /\s/.test(raw[j])) j++;
			if (raw[j] === '}' || raw[j] === ']') {
				continue; // drop trailing comma
			}
		}

		out += ch;
	}

	return out;
}

function insertMissingCommasBetweenObjects(raw: string): string {
	let out = '';
	let inString = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		out += ch;

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === '}') {
			let j = i + 1;
			while (j < raw.length && /\s/.test(raw[j])) j++;
			if (raw[j] === '{') {
				out += ',';
			}
		}
	}

	return out;
}

/**
 * Conservative malformed-JSON repair for common LLM mistakes.
 */
export function fixMalformedJson(raw: string): string {
	return insertMissingCommasBetweenObjects(removeTrailingCommas(raw));
}

/**
 * Parse first valid JSON object candidate from response text.
 */
export function parseFirstJsonObject(response: string): Record<string, unknown> | null {
	for (const candidate of extractJsonCandidates(response)) {
		for (const variant of [candidate, fixMalformedJson(candidate)]) {
			try {
				const parsed = JSON.parse(variant);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				// try next candidate
			}
		}
	}
	return null;
}

/** Parse the first JSON object or array in a model response. */
export function parseFirstJsonValue(
	response: string
): Record<string, unknown> | Array<unknown> | null {
	const candidates = [
		stripMarkdownFence(response),
		...extractBalancedJsonArrays(response),
		...extractJsonCandidates(response)
	];
	const seen = new Set<string>();
	for (const raw of candidates) {
		const candidate = raw.trim();
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		for (const variant of [candidate, fixMalformedJson(candidate)]) {
			try {
				const parsed = JSON.parse(variant);
				if (parsed && typeof parsed === 'object') {
					return parsed as Record<string, unknown> | Array<unknown>;
				}
			} catch {
				// try next candidate
			}
		}
	}
	return null;
}

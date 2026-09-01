import type { ProviderConfig } from '$lib/translation/llm-types.js';

/**
 * Stage a provider-key edit without touching encrypted storage. An empty value
 * is an intentional deletion tombstone and must survive until Save.
 */
export function stageProviderKeyDraft(
	drafts: ReadonlyMap<string, string>,
	providerId: string,
	requiresApiKey: boolean,
	value: string
): Map<string, string> {
	return new Map(drafts).set(providerId, requiresApiKey ? value : '');
}

export interface ProviderKeyCommitPlan {
	writes: Map<string, string>;
	removedProviderIds: string[];
}

/**
 * Diff provider IDs at Save time. Drafts for providers removed in the editor
 * are discarded, while encrypted keys belonging to previously saved providers
 * are deleted transactionally with the provider removal.
 */
export function planProviderKeyCommit(
	previousProviders: readonly ProviderConfig[],
	nextProviders: readonly ProviderConfig[],
	drafts: ReadonlyMap<string, string>
): ProviderKeyCommitPlan {
	const retainedIds = new Set(nextProviders.map((provider) => provider.id));
	const writes = new Map(
		Array.from(drafts).filter(([providerId]) => retainedIds.has(providerId))
	);
	const removedProviderIds = previousProviders
		.map((provider) => provider.id)
		.filter((providerId) => !retainedIds.has(providerId));
	return { writes, removedProviderIds };
}

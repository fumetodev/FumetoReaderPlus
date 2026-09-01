import type { RemoteFolder } from '$lib/types/index.js';

export interface KavitaSeriesCoverClient {
	fetchSeriesCover(seriesId: number): Promise<Blob>;
}

/**
 * Fetch Kavita series covers independently so one unavailable cover cannot hide
 * every other folder in the current catalog page.
 */
export async function fetchKavitaFolderCoverBlobs(
	folders: Array<Pick<RemoteFolder, 'id' | 'coverHash'>>,
	client: KavitaSeriesCoverClient,
): Promise<Map<string, Blob>> {
	const covers = new Map<string, Blob>();
	const validFolders = folders.filter((folder) => {
		if (folder.coverHash === null || folder.coverHash.trim() === '') return false;
		const seriesId = Number(folder.coverHash);
		return Number.isSafeInteger(seriesId) && seriesId >= 0;
	});
	const fetchCover = async (folder: Pick<RemoteFolder, 'id' | 'coverHash'>) => {
		try {
			covers.set(folder.id, await client.fetchSeriesCover(Number(folder.coverHash)));
		} catch {
			// A missing/unauthorized series image leaves only that folder on fallback art.
		}
	};

	// Establish the client's cached JWT before issuing parallel image requests.
	// Otherwise a freshly-created Kavita client can authenticate once per folder.
	if (validFolders.length > 0) await fetchCover(validFolders[0]);
	await Promise.all(validFolders.slice(1).map(fetchCover));
	return covers;
}

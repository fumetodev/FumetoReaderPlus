/**
 * A comic another app asked this one to open ("Open with" in a file manager): read in the reader without being added
 * to a library.
 *
 * Android hands over a content:// address whose read grant lasts while the Activity does (MainActivity.kt), so the
 * file is copied at once, natively, into a temporary folder (whole files never cross the IPC), and its pages are
 * stored the way an import stores them, as a volume that nothing lists: `visibility: 'internal'`, under a library id
 * no library has, so no catalog view, count, scan or Continue Reading reaches it. The copy goes as soon as the pages
 * are stored.
 *
 * The volume goes when the reader is left, with whatever was translated on it. Settings is not leaving: the reader's
 * own buttons open it and it returns to the reader. A whole-file translation still running is stopped rather than
 * left to finish, since nothing could ever show what it translates. Nothing survives a restart: leftovers are
 * purged before the next file is opened, and their batches are never resumed.
 *
 * Unless the person adds it to a library from the reader (`addOpenedFileToLibrary`): the original is copied into the
 * library folder and recorded as that volume's file, so the volume itself becomes the library's, with its pages, its
 * translations and its place, and the next scan finds it already known.
 */

import { get, writable } from 'svelte/store';
import { appDataDir, dirname, join } from '@tauri-apps/api/path';
import { mkdir, remove, stat } from '@tauri-apps/plugin-fs';
import * as m from '$lib/paraglide/messages.js';
import { db } from '$lib/db/index.js';
import { appView, currentVolume, leaveReader, openReader } from '$lib/stores/reader-state.js';
import { settingsCommitHandler, settingsNavigationBusy, settingsReturnView } from '$lib/stores/ui-state.js';
import { pushToast } from '$lib/stores/toasts.js';
import { onboardingTourOpen } from '$lib/onboarding/onboarding.js';
import { randomUUID } from '$lib/util/uuid.js';
import { ensureDir, libraryDestinationPath } from '$lib/util/file-utils.js';
import { isLocalLibrary, settings } from '$lib/settings/settings.js';
import { rememberLocalTarget } from '$lib/stores/catalog-state.js';
import { updateVolume } from '$lib/catalog/catalog-repository.js';
import type { UserMessage } from '$lib/i18n/user-messages.js';
import type { ReaderReturnView, VolumeMetadata } from '$lib/types/index.js';
import { deleteVolume, importArchive } from './import-service.js';
import { filePathToFile } from './tauri-file-bridge.js';
import { fileExtension } from './pick-triage.js';

/** The library id opened files sit under. No library has it, so no catalog view, count or scan reaches them. */
export const OPENED_FILE_LIBRARY_ID = '__fumeto_opened__';

/** What the manifest offers to open (AndroidManifest.xml); a name with no extension is tried as a zip. */
const OPENABLE_EXTENSIONS = ['cbz', 'zip'];

export interface OpeningFile {
	name: string;
	/** The import's latest step, or null while the file is still being copied. */
	progress: UserMessage | null;
}

/** The file being opened, while its pages are stored: the sheet over the app shows it (`OpenedFileSheet.svelte`). */
export const openingFile = writable<OpeningFile | null>(null);

let opening: AbortController | null = null;
/** Whether opening a file swapped the browser's page for a still image, to be put back when nothing is opening. */
let coveredBrowser = false;
/** The opened file in the reader, if any. */
let openFile: string | null = null;
/** Where it came from, for adding it to a library: the read grant lasts while the Activity does. */
let openSource: { uri: string; name: string } | null = null;
/** Leftovers of earlier runs are removed before anything is opened: a removal must never meet a file being read. */
let purged: Promise<void> | null = null;

// Every file opened since the last launch, kept until the launch purge has removed its rows: a page translation still
// in flight when the reader was left can write after the delete, and only the volume id finds those rows again.
const CREATED_KEY = 'fumeto.openedFiles.created';

function createdFiles(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(CREATED_KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

function forgetCreated(volumeUuid: string): void {
	try {
		localStorage.setItem(CREATED_KEY, JSON.stringify(createdFiles().filter((id) => id !== volumeUuid)));
	} catch {
		// Storage unavailable: the volume is no longer under the opened-file library id, which is what the sweep reads.
	}
}

function recordCreated(volumeUuid: string): void {
	try {
		localStorage.setItem(CREATED_KEY, JSON.stringify([...new Set([...createdFiles(), volumeUuid])].slice(-500)));
	} catch {
		// Storage unavailable: the library-id sweep at launch still finds the volume itself.
	}
}

export function isOpenedFile(volume: Pick<VolumeMetadata, 'library_id'> | null | undefined): boolean {
	return volume?.library_id === OPENED_FILE_LIBRARY_ID;
}

/** The opened file in the reader, if any. */
export function openedFileId(): string | null {
	return openFile;
}

/** Stops the file being opened, if one is. Returns whether one was, so Back is consumed exactly when it stopped one. */
export function cancelOpeningFile(): boolean {
	if (!opening) return false;
	opening.abort();
	opening = null;
	openingFile.set(null);
	return true;
}

async function openedFilesFolder(): Promise<string> {
	return join(await appDataDir(), 'opened-files');
}

async function coverBrowser(covered: boolean): Promise<void> {
	try {
		const browser = await import('$lib/web-browser/browser-controller.js');
		await browser.coverBrowser(covered);
	} catch (error) {
		console.warn('[opened-file] Could not cover the browser:', error);
	}
}

function settingsIdle(): Promise<void> {
	if (!get(settingsNavigationBusy)) return Promise.resolve();
	return new Promise((resolve) => {
		let stop: (() => void) | undefined;
		stop = settingsNavigationBusy.subscribe((busy) => {
			if (busy) return;
			resolve();
			queueMicrotask(() => stop?.());
		});
	});
}

/**
 * Leaves whatever is on screen for the reader and returns where its Back goes. Settings flushes its pending apply on
 * the way out, as every way out of it does; a comic in the reader is left the usual way, so its place is kept and a
 * web chapter or an opened file there closes.
 */
async function leaveForReader(): Promise<ReaderReturnView> {
	await settingsIdle();
	if (get(appView) === 'settings') {
		const commit = get(settingsCommitHandler);
		const destination = get(settingsReturnView);
		if (!commit || !(await commit(destination))) appView.set(destination);
	}
	const view = get(appView);
	if (view === 'reader') return leaveReader();
	return view === 'tabs' || view === 'browser' ? view : 'catalog';
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** Not AbortSignal.throwIfAborted: a WebView older than Chrome 100 has no such method. */
function stopIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DOMException('Opening the file was stopped.', 'AbortError');
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

/** Opens a comic another app handed over. The newest wins: one still opening is stopped. */
async function openHandedFile(uri: string, handedName: string): Promise<void> {
	const name = handedName.trim() || safeDecode(uri.split('/').pop() ?? '');
	const extension = fileExtension(name);
	if (extension !== null && !OPENABLE_EXTENSIONS.includes(extension)) {
		pushToast({ message: m.import_opened_unsupported({ name }), tone: 'error' });
		return;
	}

	opening?.abort();
	const controller = new AbortController();
	opening = controller;
	const { signal } = controller;
	openingFile.set({ name, progress: null });
	// The browser's page is native and nothing can be drawn over it: it is swapped for a still image meanwhile.
	if (!coveredBrowser && get(appView) === 'browser') {
		coveredBrowser = true;
		await coverBrowser(true);
	}
	const folder = await openedFilesFolder();
	const copy = await join(folder, `${randomUUID()}.${extension ?? 'zip'}`);
	let volumeUuid: string | null = null;
	try {
		await (purged ??= purgeOpenedFiles());
		stopIfAborted(signal);
		await mkdir(folder, { recursive: true });
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('copy_content_uri', { uri, destination: copy });
		stopIfAborted(signal);
		const read = await filePathToFile(copy);
		stopIfAborted(signal);
		// The import reads the type from the name, and takes the title from it.
		const file = new File([read], extension ? name : `${name}.zip`, { type: read.type });
		volumeUuid = await importArchive(
			file,
			(progress) => {
				if (opening === controller) openingFile.set({ name, progress: progress.message });
			},
			OPENED_FILE_LIBRARY_ID,
			'',
			{ visibility: 'internal', signal }
		);
		recordCreated(volumeUuid);
		stopIfAborted(signal);
		const volume = await db.volumes.get(volumeUuid);
		if (!volume) throw new Error('The opened file was not stored.');
		const origin = await leaveForReader();
		stopIfAborted(signal);
		// The first-run tour returns at the next launch; this time the person came to read.
		onboardingTourOpen.set(false);
		openFile = volumeUuid;
		openSource = { uri, name };
		if (!(await openReader(volume, origin))) {
			openFile = null;
			openSource = null;
			throw new Error('The reader could not open the file.');
		}
	} catch (error) {
		if (volumeUuid && openFile !== volumeUuid) {
			await deleteVolume(volumeUuid, { deletePhysicalFile: false }).catch(() => undefined);
		}
		if (!signal.aborted) {
			console.warn('[opened-file] Could not open a handed-over file:', error);
			const noPages = error instanceof Error && error.message === 'No images found in archive.';
			pushToast({
				message: noPages ? m.import_opened_no_pages({ name }) : m.import_opened_failed({ name }),
				tone: 'error'
			});
		} else if (!isAbort(error)) {
			console.warn('[opened-file] Stopped opening a file:', error);
		}
	} finally {
		await remove(copy).catch(() => undefined);
		if (opening === controller) {
			opening = null;
			openingFile.set(null);
		}
		if (opening === null && coveredBrowser) {
			coveredBrowser = false;
			await coverBrowser(false);
		}
	}
}

/** Takes the file another app handed over, if one is waiting. */
function takeWaitingFile(): void {
	let raw = '';
	try {
		raw = window.__fumeto_android?.takeOpenedFile?.() ?? '';
	} catch {
		return;
	}
	if (!raw) return;
	let handed: unknown;
	try {
		handed = JSON.parse(raw);
	} catch {
		return;
	}
	const { uri, name } = (handed ?? {}) as { uri?: unknown; name?: unknown };
	if (typeof uri !== 'string' || !uri.startsWith('content://')) return;
	void openHandedFile(uri, typeof name === 'string' ? name : '');
}

/** The person left the reader: the opened file goes, and a translation still running on it ends first. */
async function closeOpenFile(): Promise<void> {
	const volumeUuid = openFile;
	openFile = null;
	openSource = null;
	if (!volumeUuid) return;
	try {
		await deleteVolume(volumeUuid, { deletePhysicalFile: false });
	} catch (error) {
		console.warn('[opened-file] Could not remove a file that was read:', error);
	}
}

export interface AddToLibraryChoice {
	libraryId: string;
	author?: string;
	series?: string;
}

/**
 * Adds the opened file in the reader to a local library, filed the way Import files it (library / author / series).
 *
 * The original is copied into the library folder again, natively, from the address it was handed over at, and its
 * import record is written from the same `stat` a scan reads, so the next scan finds the file already known: the
 * volume keeps its id, pages, translations and place instead of being imported a second time. Both happen under the
 * scanner's claim on that path. A file already recorded at that path is the library's already, and is left alone.
 */
export async function addOpenedFileToLibrary(choice: AddToLibraryChoice): Promise<'added' | 'already-in-library'> {
	const volumeUuid = openFile;
	const source = openSource;
	if (!volumeUuid || !source) throw new Error('No file opened from another app is in the reader.');
	const library = get(settings).libraries.filter(isLocalLibrary).find((lib) => lib.id === choice.libraryId);
	if (!library) throw new Error('That library is not a local library.');
	const author = choice.author?.trim() || undefined;
	const series = author ? choice.series?.trim() || undefined : undefined;
	// Named after the file as it was handed over, the way Import names a picked file.
	const destination = await libraryDestinationPath(source.name, library.path, author, series);
	const root = library.path.replace(/[\\/]+$/, '');
	const relative = destination.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1);
	const slash = relative.lastIndexOf('/');
	const folderPath = slash >= 0 ? relative.slice(0, slash) : '';
	const filename = slash >= 0 ? relative.slice(slash + 1) : relative;

	const { withLibraryFileClaim } = await import('$lib/library/library-scanner.js');
	const outcome = await withLibraryFileClaim(destination, async () => {
		if (await db.library_imports.get(destination)) return 'already-in-library' as const;
		await ensureDir(await dirname(destination));
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('copy_content_uri', { uri: source.uri, destination });
		try {
			const info = await stat(destination);
			await db.transaction('rw', [db.library_imports, db.volumes, db.catalog_rows, db.media_assets], async () => {
				await db.library_imports.put({
					file_path: destination,
					volume_uuid: volumeUuid,
					file_size: info.size,
					file_modified: info.mtime ? new Date(info.mtime).getTime() : 0,
					imported_at: new Date().toISOString()
				});
				await updateVolume(volumeUuid, {
					library_id: library.id,
					visibility: 'normal',
					folder_path: folderPath,
					filename
				});
			});
		} catch (error) {
			await remove(destination).catch(() => undefined);
			throw error;
		}
		return 'added' as const;
	});
	if (outcome === 'added') {
		// The library's now: leaving the reader keeps it, and no launch sweep looks for it.
		if (openFile === volumeUuid) {
			openFile = null;
			openSource = null;
		}
		forgetCreated(volumeUuid);
		rememberLocalTarget(library.id);
		currentVolume.update((volume) =>
			volume?.volume_uuid === volumeUuid
				? { ...volume, library_id: library.id, visibility: 'normal', folder_path: folderPath, filename }
				: volume
		);
	}
	return outcome;
}

/**
 * No file can be open before one is handed over, so every volume left behind by an app that closed while reading
 * one goes, with its stored translation job, and so does the temporary folder.
 */
async function purgeOpenedFiles(): Promise<void> {
	try {
		const listed = await db.volumes.where('library_id').equals(OPENED_FILE_LIBRARY_ID).primaryKeys();
		for (const volumeUuid of new Set([...listed, ...createdFiles()])) {
			try {
				await deleteVolume(volumeUuid, { deletePhysicalFile: false });
			} catch (error) {
				console.warn('[opened-file] Could not remove a leftover file:', error);
			}
		}
		try {
			localStorage.removeItem(CREATED_KEY);
		} catch {
			// Nothing recorded.
		}
		await remove(await openedFilesFolder(), { recursive: true }).catch(() => undefined);
	} catch (error) {
		console.warn('[opened-file] Removing leftovers failed:', error);
	}
}

/**
 * Android: removes what an earlier run left, opens a file handed over at launch, listens for the next one, and
 * watches the reader so leaving it closes the opened file.
 */
export function installOpenedFiles(): () => void {
	// Only Android hands files over; a plain browser has no bridge and nothing to remove.
	if (typeof window.__fumeto_android?.takeOpenedFile !== 'function') return () => undefined;
	purged ??= purgeOpenedFiles();
	let reading = get(appView) === 'reader';
	const stopWatching = appView.subscribe((view) => {
		if (view === 'reader') {
			reading = true;
		} else if (view !== 'settings' && reading) {
			reading = false;
			if (openFile) void closeOpenFile();
		}
	});
	window.addEventListener('fumeto:opened-file', takeWaitingFile);
	takeWaitingFile();
	return () => {
		stopWatching();
		window.removeEventListener('fumeto:opened-file', takeWaitingFile);
	};
}

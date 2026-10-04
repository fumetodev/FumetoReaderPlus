/**
 * Files dropped onto the desktop window.
 *
 * Tauri takes OS file drops for itself (the window's `dragDropEnabled`), so a
 * page's HTML5 `drop` listener never receives them in the desktop app. Its
 * drag-drop events carry absolute paths instead, which is also what the
 * path-based import wants: it can read one file at a time rather than hold
 * every dropped File in memory.
 */

export type FileDropEvent =
	| { type: 'enter'; paths: string[] }
	| { type: 'over' }
	| { type: 'drop'; paths: string[] }
	| { type: 'leave' };

export interface FileDropHandlers {
	/** Files are being dragged over the window (true) or the drag ended (false). */
	onHover(active: boolean): void;
	/** Files were dropped; the paths are absolute. */
	onDrop(paths: string[]): void;
}

export function dispatchFileDropEvent(event: FileDropEvent, handlers: FileDropHandlers): void {
	switch (event.type) {
		case 'enter':
		case 'over':
			handlers.onHover(true);
			return;
		case 'leave':
			handlers.onHover(false);
			return;
		case 'drop':
			handlers.onHover(false);
			if (event.paths.length > 0) handlers.onDrop(event.paths);
			return;
	}
}

/** Listen for file drops on the current webview. Resolves to the unlisten function. */
export async function listenForFileDrops(handlers: FileDropHandlers): Promise<() => void> {
	const { getCurrentWebview } = await import('@tauri-apps/api/webview');
	return getCurrentWebview().onDragDropEvent((event) => dispatchFileDropEvent(event.payload, handlers));
}

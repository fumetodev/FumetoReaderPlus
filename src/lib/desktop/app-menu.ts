/**
 * The macOS menu bar's app commands (src-tauri/src/macos_menu.rs): Settings…
 * (⌘,) and Import… (⌘O) arrive as the `fumeto:menu` event and open the same
 * dialogs the toolbar does.
 */

export const MENU_EVENT = 'fumeto:menu';

export type MenuCommand = 'settings' | 'import';

export interface MenuActions {
	openSettings(): void;
	openImport(): void;
}

/** The command a menu event names, or null for anything else. */
export function menuCommand(payload: unknown): MenuCommand | null {
	return payload === 'settings' || payload === 'import' ? payload : null;
}

export function runMenuCommand(payload: unknown, actions: MenuActions): boolean {
	switch (menuCommand(payload)) {
		case 'settings':
			actions.openSettings();
			return true;
		case 'import':
			actions.openImport();
			return true;
		default:
			return false;
	}
}

/** Listen for menu commands. Returns the uninstall function. */
export function installAppMenuHandler(actions: MenuActions): () => void {
	let unlisten: (() => void) | null = null;
	let disposed = false;
	void import('@tauri-apps/api/event')
		.then(({ listen }) => listen<unknown>(MENU_EVENT, (event) => void runMenuCommand(event.payload, actions)))
		.then((stop) => {
			if (disposed) stop();
			else unlisten = stop;
		})
		.catch((error) => console.warn('[app-menu] could not listen for menu commands:', error));
	return () => {
		disposed = true;
		unlisten?.();
	};
}

/**
 * UI state store — tracks sidebar, dialogs, and other UI state.
 */

import { writable } from 'svelte/store';
import type { AppView } from '$lib/types/index.js';

/** Whether the translation side panel is open */
export const sidebarOpen = writable<boolean>(true);

/** Whether the DESKTOP settings dialog is visible. Mobile settings is a real
 *  dock destination (appView === 'settings' renders SettingsView) and never
 *  touches this store. */
export const settingsDialogOpen = writable<boolean>(false);

/** Whether the settings loading overlay is visible (first presentation only,
 *  before the heavy settings DOM exists). */
export const settingsLoading = writable<boolean>(false);

/** True while the mobile SettingsView is mounted (keep-alive). Entry points
 *  use it to show the loading overlay only for the first, expensive mount. */
export const settingsViewMounted = writable<boolean>(false);

/** Destination restored by mobile Settings Save/Cancel. */
export const settingsReturnView = writable<AppView>('catalog');

/** Registered by SettingsDialog so Android Back and the shared bar commit one draft. */
export const settingsCommitHandler = writable<((destination?: AppView) => Promise<boolean>) | null>(null);

export const settingsNavigationBusy = writable<boolean>(false);

/** One-shot: tab the settings dialog should open on (deep links). */
export const settingsInitialTab = writable<'translation' | 'overlay' | 'display' | 'libraries' | 'help' | null>(null);

/** One-shot: Help section to auto-expand when the Help tab mounts. */
export const helpInitialSection = writable<string | null>(null);

/** Whether the import dialog is visible */
export const importDialogOpen = writable<boolean>(false);

/** Whether a volume is currently being imported */
export const isImporting = writable<boolean>(false);

/** Import progress message */
export const importProgressMessage = writable<string>('');

/** UUID of the hovered translation region (for highlight) */
export const hoveredRegionId = writable<string | null>(null);

/** Whether the app has been initialized (db ready) */
export const appReady = writable<boolean>(false);

/** Whether per-box overlay edit mode is active (boxes become clickable) */
export const isOverlayEditMode = writable<boolean>(false);

/** When set, the sidebar opens the edit form for this overlay box ID */
export const editOverlayBoxId = writable<string | null>(null);

/** When set, the user is dragging this overlay box to reposition it */
export const movingBoxId = writable<string | null>(null);

/** Long-pressed overlay currently exposing direct move and resize affordances. */
export const selectedOverlayBoxId = writable<string | null>(null);

/** Whether the mobile bottom sheet is open (for external control) */

/** Whether the reader toolbar and bottom bar are visible (mobile reader only) */
export const readerBarsVisible = writable<boolean>(false);

/** Whether the reader page-thumbnail selector is open */
export const pageThumbnailScrubberOpen = writable<boolean>(false);

/** Whether the catalog context menu is open (for Android back-button handling) */
export const catalogContextMenuOpen = writable<boolean>(false);

/** When set, the user is dragging resize handles on this overlay box */
export const resizingBoxId = writable<string | null>(null);

/** Whether to scale font proportionally during resize (set by editor before dismissing) */
export const resizeScaleFont = writable<boolean>(false);

/** Confirm handler for the active move/resize operation (set by TranslationOverlay) */
export const overlayConfirmHandler = writable<(() => void) | null>(null);

/** Cancel handler for the active move/resize operation (set by TranslationOverlay) */
export const overlayCancelHandler = writable<(() => void) | null>(null);

/** Async close port for the mobile floating editor so Back can await auto-save. */
export const overlayEditorCloseHandler = writable<(() => Promise<void>) | null>(null);

/**
 * Discard port for the mobile floating editor. Back is a dismiss gesture, not
 * a commit: the editor's other exits save, but the one the reader reaches for
 * to "just leave" must not. Move/resize already cancel on Back through
 * `overlayCancelHandler`; this gives the editor the same shape. Kept separate
 * from `overlayEditorCloseHandler` because that port is also how leaving the
 * reader flushes a pending edit, and navigating away must still commit.
 */
export const overlayEditorDismissHandler = writable<(() => void) | null>(null);

/** Close port for reader-scoped dialogs that take Back priority over tools. */
export const readerTransientCloseHandler = writable<(() => void) | null>(null);

/**
 * Close port for catalog-scoped dialogs (details/revise/rename/move/…).
 * Returns true when it consumed the Back press by closing something.
 */
export const catalogTransientCloseHandler = writable<(() => boolean) | null>(null);

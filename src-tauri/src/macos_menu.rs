//! The macOS menu bar: Tauri's default menu (app, File, Edit, View, Window,
//! Help — Edit is what makes copy/paste work in text fields) plus the two app
//! commands a Mac user looks for there: Settings… (⌘,) in the app menu and
//! Import… (⌘O) in File. A choice reaches the frontend as the `fumeto:menu`
//! event (src/lib/desktop/app-menu.ts), which opens the same dialogs the
//! toolbar does.
//!
//! Labels are English, like the Info.plist permission texts; both move to the
//! message catalogues together.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

const MENU_EVENT: &str = "fumeto:menu";
const SETTINGS_ID: &str = "fumeto-settings";
const IMPORT_ID: &str = "fumeto-import";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let items = menu.items()?;

    // The app menu comes first: About, separator, Services, … — Settings goes
    // right after About, as in every Mac app.
    if let Some(app_menu) = items.first().and_then(MenuItemKind::as_submenu) {
        let settings = MenuItem::with_id(app, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
    }

    let file_menu = items
        .iter()
        .filter_map(MenuItemKind::as_submenu)
        .find(|submenu| submenu.text().is_ok_and(|text| text == "File"));
    if let Some(file_menu) = file_menu {
        let import = MenuItem::with_id(app, IMPORT_ID, "Import…", true, Some("CmdOrCtrl+O"))?;
        file_menu.insert_items(&[&import, &PredefinedMenuItem::separator(app)?], 0)?;
    }

    Ok(menu)
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let command = match event.id().as_ref() {
        SETTINGS_ID => "settings",
        IMPORT_ID => "import",
        _ => return,
    };
    if let Err(error) = app.emit(MENU_EVENT, command) {
        log::warn!("menu command {command} not delivered: {error}");
    }
}

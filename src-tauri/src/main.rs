// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before anything else: WebKitGTK reads the renderer variable when its
    // web process spawns, so the decision has to be in the environment
    // before the Tauri builder runs.
    #[cfg(target_os = "linux")]
    app_lib::desktop::apply_webkit_dmabuf_workaround();

    app_lib::run();
}

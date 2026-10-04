#[cfg(not(mobile))]
mod keep_awake;
#[cfg(not(mobile))]
mod llama;
#[cfg(not(mobile))]
mod manga_guidance;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop: remember the folder access the file/folder pickers grant (a
    // library on an external drive, say) across restarts. Must come after the
    // fs plugin, whose scope it restores.
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_persisted_scope::init());

    // Register llama.cpp Tauri commands on desktop (macOS/Windows/Linux).
    // On Android, llama.cpp is accessed via the JNI bridge instead.
    #[cfg(not(mobile))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        llama::llama_load,
        llama::llama_translate,
        llama::llama_get_backend,
        llama::llama_unload,
        llama::llama_is_loaded,
        llama::llama_cancel,
        keep_awake::app_keep_awake,
    ]);

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(mobile))]
pub mod desktop;
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

    // Register llama.cpp Tauri commands on desktop (macOS/Windows/Linux).
    // On Android, llama.cpp is accessed via the JNI bridge instead.
    // The desktop host facts and the frontend's perf-line sink live in the
    // same handler; Android answers those through its Kotlin bridges.
    #[cfg(not(mobile))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        llama::llama_load,
        llama::llama_translate,
        llama::llama_get_backend,
        llama::llama_unload,
        llama::llama_is_loaded,
        llama::llama_cancel,
        desktop::desktop_system_info,
        desktop::perf_log,
    ]);

    builder
        .setup(|app| {
            // Desktop: always log to stderr, so a beta user's terminal shows
            // what the shell decided; FUMETO_LOG=debug|trace adds a file and
            // the prompt lines. The decision lines are emitted only now
            // because no logger exists before the plugin is registered.
            #[cfg(not(mobile))]
            {
                app.handle().plugin(desktop::log_plugin())?;
                desktop::log_startup_decisions();
                llama::log_backend_facts();
            }
            #[cfg(mobile)]
            {
                if cfg!(debug_assertions) {
                    app.handle().plugin(
                        tauri_plugin_log::Builder::default()
                            .level(log::LevelFilter::Info)
                            .build(),
                    )?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

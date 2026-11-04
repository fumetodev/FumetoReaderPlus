#[cfg(mobile)]
mod atomic_copy;
#[cfg(not(mobile))]
mod llama;
#[cfg(not(mobile))]
mod manga_guidance;

/// Copies a file the Android picker handed over to a path in the app's storage, without its bytes
/// crossing the IPC. There a written file reaches Rust as a JSON array, one value per byte: about
/// 86 MB of memory per MB written, enough to get the app killed on an ordinary 74 MB volume. The
/// fs plugin's `copy_file` takes real paths only, and refuses what the picker returns.
///
/// No fs scope to check: Android's sandbox holds the app to the storage that scope allows, and a
/// content:// address is readable only because the person picked it. Not on desktop, where the
/// scope is narrower than what the process can reach and the IPC carries bytes as bytes.
#[cfg(mobile)]
#[tauri::command]
async fn copy_content_uri<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    uri: String,
    destination: std::path::PathBuf,
) -> Result<u64, String> {
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    if !uri.starts_with("content://") {
        return Err(format!("not a content address: {uri}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let source: FilePath = uri.parse().map_err(|e| format!("{e:?}"))?;
        let mut options = OpenOptions::new();
        options.read(true);
        let mut input = app.fs().open(source, options).map_err(|e| e.to_string())?;
        atomic_copy::copy_atomically(&mut input, &destination).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

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
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![copy_content_uri]);

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

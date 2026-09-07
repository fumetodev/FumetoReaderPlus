//! Streaming model downloads for the desktop shell.
//!
//! The on-device models are 460 MB to 1.1 GB. Fetching them through the web
//! view's HTTP plugin turned out to hold several copies of the body in the
//! web process at once — a 460 MB file pushed that process past 3 GB — so the
//! transfer runs here instead: chunks go from the socket straight to
//! `<destination>.part`, progress reaches the page over an IPC channel, and
//! the file is renamed into place only after the last byte. A cancelled or
//! failed transfer removes the partial file, so the size check on the next
//! launch never mistakes it for a finished model.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

/// Progress is sent when the byte count grows by at least this much.
const PROGRESS_STEP_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

static CANCEL_FLAGS: Mutex<Option<HashMap<u64, Arc<AtomicBool>>>> = Mutex::new(None);

fn register(id: u64) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut flags = CANCEL_FLAGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    flags.get_or_insert_with(HashMap::new).insert(id, Arc::clone(&flag));
    flag
}

fn unregister(id: u64) {
    let mut flags = CANCEL_FLAGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(map) = flags.as_mut() {
        map.remove(&id);
    }
}

/// Whether a report is due: the first byte, and every full step after the last report.
pub fn progress_due(reported: u64, downloaded: u64) -> bool {
    downloaded >= reported.saturating_add(PROGRESS_STEP_BYTES)
}

/// Asks a running transfer to stop. Harmless for an unknown or finished id.
#[tauri::command]
pub fn download_cancel(id: u64) {
    let flags = CANCEL_FLAGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(flag) = flags.as_ref().and_then(|map| map.get(&id)) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Downloads `url` to `dest_path`, streaming to disk. Resolves with the byte
/// count; rejects with a message that starts "Download aborted" on cancel.
#[tauri::command]
pub async fn download_to_file(
    id: u64,
    url: String,
    dest_path: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<u64, String> {
    let flag = register(id);
    let result = run(&url, &dest_path, &flag, &on_progress).await;
    unregister(id);
    result
}

async fn run(
    url: &str,
    dest_path: &str,
    cancel: &AtomicBool,
    on_progress: &Channel<DownloadProgress>,
) -> Result<u64, String> {
    let partial_path = format!("{dest_path}.part");
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| format!("Download failed: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status().as_u16()));
    }
    let total_bytes = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&partial_path)
        .await
        .map_err(|error| format!("Could not create the model file: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;

    let outcome: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                return Err("Download aborted".to_string());
            }
            let chunk = chunk.map_err(|error| format!("Download failed: {error}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Could not write the model file: {error}"))?;
            downloaded += chunk.len() as u64;
            if progress_due(reported, downloaded) {
                reported = downloaded;
                let _ = on_progress.send(DownloadProgress { downloaded_bytes: downloaded, total_bytes });
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Download aborted".to_string());
        }
        file.flush()
            .await
            .map_err(|error| format!("Could not write the model file: {error}"))?;
        Ok(())
    }
    .await;
    drop(file);

    match outcome {
        Ok(()) => {
            tokio::fs::rename(&partial_path, dest_path)
                .await
                .map_err(|error| format!("Could not place the model file: {error}"))?;
            let _ = on_progress.send(DownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: if total_bytes > 0 { total_bytes } else { downloaded },
            });
            Ok(downloaded)
        }
        Err(message) => {
            let _ = tokio::fs::remove_file(&partial_path).await;
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_reported_once_per_step() {
        assert!(progress_due(0, PROGRESS_STEP_BYTES));
        assert!(!progress_due(0, PROGRESS_STEP_BYTES - 1));
        assert!(progress_due(PROGRESS_STEP_BYTES, 2 * PROGRESS_STEP_BYTES + 7));
        assert!(!progress_due(3 * PROGRESS_STEP_BYTES, 3 * PROGRESS_STEP_BYTES + 512));
    }

    #[test]
    fn cancel_flag_round_trip() {
        let flag = register(99);
        assert!(!flag.load(Ordering::Relaxed));
        download_cancel(99);
        assert!(flag.load(Ordering::Relaxed));
        unregister(99);
        download_cancel(99);
    }
}

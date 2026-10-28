//! History commands — thin wrappers over the `history` module. Each mutating
//! command emits `history-changed` so the UI refetches.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::commands::config;
use crate::events;
use crate::history::{self, HistoryDb, HistoryItem, StorageStats};

/// Remove a recording's WAV plus any crash-recovery PCM sidecar. Empty paths
/// (audio already purged) are ignored.
fn remove_audio_file(path: &str) {
    if path.is_empty() {
        return;
    }
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{path}.pcm"));
}

fn remove_audio_files(paths: &[String]) {
    for p in paths {
        remove_audio_file(p);
    }
}

#[tauri::command]
pub async fn list_history(app: AppHandle) -> Vec<HistoryItem> {
    // Tauri v2 runs non-async commands on the main thread; a full archive read +
    // serialize would freeze the UI event loop. Run it on the blocking pool (§4.2).
    tauri::async_runtime::spawn_blocking(move || history::list(&app.state::<HistoryDb>()))
        .await
        .unwrap_or_default()
}

/// Word/speaker detail for one recording — the arrays list_history omits, fetched
/// on demand when a history card is expanded (perf §4.1).
#[tauri::command]
pub fn get_history_detail(app: AppHandle, id: i64) -> Option<history::HistoryDetail> {
    history::detail(&app.state::<HistoryDb>(), id)
}

#[tauri::command]
pub fn delete_recording(app: AppHandle, id: i64) -> Result<(), String> {
    if let Some(path) = history::delete(&app.state::<HistoryDb>(), id) {
        remove_audio_file(&path);
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Bulk delete (selection in the Files panel). Always removes row + WAV.
#[tauri::command]
pub fn delete_recordings(app: AppHandle, ids: Vec<i64>) -> Result<(), String> {
    let paths = history::delete_many(&app.state::<HistoryDb>(), &ids);
    remove_audio_files(&paths);
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Disk usage of the recordings directory + recording count (Storage section).
#[tauri::command]
pub fn storage_stats(app: AppHandle) -> StorageStats {
    history::storage_stats(&app)
}

/// Enforce the user's auto-delete retention policy: purge WAVs for recordings
/// that fall outside the policy while keeping every transcript row, emitting
/// `history-changed` if any audio was removed. A cheap no-op when the policy is
/// "never". Safe to call off the hot path (app startup, after a recording
/// completes).
pub fn run_retention(app: &AppHandle) {
    let app = app.clone();
    // File deletion can touch many WAVs on the first sweep after an upgrade, so
    // keep it off the setup/async-runtime threads.
    tauri::async_runtime::spawn_blocking(move || {
        let policy = config::load_config(&app).auto_delete_policy;
        let purge = history::enforce_audio_retention(&app.state::<HistoryDb>(), &policy);
        if purge.paths.is_empty() {
            return;
        }
        remove_audio_files(&purge.paths);
        let _ = app.emit(events::HISTORY_CHANGED, ());
    });
}

/// What the current policy would purge, for the "clean up now" confirmation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCleanupPreview {
    pub count: i64,
    pub bytes: i64,
}

/// What the last explicit cleanup actually removed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCleanupResult {
    pub count: i64,
    pub freed_bytes: i64,
}

/// Preview the audio that the active retention policy would remove. Read-only.
/// Runs on the blocking pool because it stats every eligible WAV.
#[tauri::command]
pub async fn preview_audio_cleanup(app: AppHandle) -> AudioCleanupPreview {
    let policy = config::load_config(&app).auto_delete_policy;
    tauri::async_runtime::spawn_blocking(move || {
        let (count, bytes) = history::preview_audio_purge(&app.state::<HistoryDb>(), &policy);
        AudioCleanupPreview { count, bytes }
    })
    .await
    .unwrap_or(AudioCleanupPreview { count: 0, bytes: 0 })
}

/// Run the active retention policy immediately ("clean up now"). Only audio is
/// removed; transcripts stay in History. File deletion runs off the main thread.
#[tauri::command]
pub async fn cleanup_audio_now(app: AppHandle) -> AudioCleanupResult {
    let policy = config::load_config(&app).auto_delete_policy;
    tauri::async_runtime::spawn_blocking(move || {
        let purge = history::enforce_audio_retention(&app.state::<HistoryDb>(), &policy);
        if purge.paths.is_empty() {
            return AudioCleanupResult {
                count: 0,
                freed_bytes: 0,
            };
        }
        remove_audio_files(&purge.paths);
        let _ = app.emit(events::HISTORY_CHANGED, ());
        AudioCleanupResult {
            count: purge.count(),
            freed_bytes: purge.bytes,
        }
    })
    .await
    .unwrap_or(AudioCleanupResult {
        count: 0,
        freed_bytes: 0,
    })
}

#[tauri::command]
pub fn toggle_favorite(app: AppHandle, id: i64) -> Result<bool, String> {
    let fav = history::toggle_favorite(&app.state::<HistoryDb>(), id);
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(fav)
}

#[tauri::command]
pub fn increment_copy(app: AppHandle, id: i64) -> Result<i64, String> {
    let count = history::increment_copy(&app.state::<HistoryDb>(), id);
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(count)
}

/// Reveal a recording's WAV file in macOS Finder (or the platform's file manager).
#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, id: i64) -> Result<(), String> {
    let db = app.state::<HistoryDb>();
    let item = history::get(&db, id).ok_or("recording not found")?;
    let path = std::path::Path::new(&item.audio_path);
    if !path.exists() {
        return Err("audio file no longer exists".into());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

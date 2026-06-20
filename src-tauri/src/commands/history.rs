//! History commands — thin wrappers over the `history` module. Each mutating
//! command emits `history-changed` so the UI refetches.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::commands::config;
use crate::events;
use crate::history::{self, HistoryDb, HistoryItem, StorageStats};

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
        let _ = std::fs::remove_file(path);
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Bulk delete (selection in the Files panel). Always removes row + WAV.
#[tauri::command]
pub fn delete_recordings(app: AppHandle, ids: Vec<i64>) -> Result<(), String> {
    let paths = history::delete_many(&app.state::<HistoryDb>(), &ids);
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Disk usage of the recordings directory + recording count (Storage section).
#[tauri::command]
pub fn storage_stats(app: AppHandle) -> StorageStats {
    history::storage_stats(&app)
}

/// Enforce the user's auto-delete retention policy: drop rows + WAVs for
/// recordings that fall outside the policy, emitting `history-changed` if any
/// were removed. A cheap no-op when the policy is "never". Safe to call off the
/// hot path (app startup, after a recording completes).
pub fn run_retention(app: &AppHandle) {
    let policy = config::load_config(app).auto_delete_policy;
    if policy == "never" {
        return;
    }
    let paths = history::enforce_retention(&app.state::<HistoryDb>(), &policy);
    if paths.is_empty() {
        return;
    }
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
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

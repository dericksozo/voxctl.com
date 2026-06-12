//! History commands — thin wrappers over the `history` module. Each mutating
//! command emits `history-changed` so the UI refetches.

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::config;
use crate::events;
use crate::history::{self, HistoryDb, HistoryItem, StorageStats};

#[tauri::command]
pub fn list_history(app: AppHandle) -> Vec<HistoryItem> {
    history::list(&app.state::<HistoryDb>())
}

/// Word/speaker detail for one recording — the arrays list_history omits, fetched
/// on demand when a history card is expanded (perf §4.1).
#[tauri::command]
pub fn get_history_detail(app: AppHandle, id: i64) -> Option<history::HistoryDetail> {
    history::detail(&app.state::<HistoryDb>(), id)
}

/// Whether a `×` delete should also remove the WAV (delete-behavior setting).
fn delete_removes_audio(app: &AppHandle) -> bool {
    config::load_config(app).delete_behavior != "transcript"
}

#[tauri::command]
pub fn delete_recording(app: AppHandle, id: i64) -> Result<(), String> {
    let remove_audio = delete_removes_audio(&app);
    if let Some(path) = history::delete(&app.state::<HistoryDb>(), id) {
        if remove_audio {
            let _ = std::fs::remove_file(path);
        }
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Bulk delete (selection in the Files panel). Honors the delete-behavior setting.
#[tauri::command]
pub fn delete_recordings(app: AppHandle, ids: Vec<i64>) -> Result<(), String> {
    let remove_audio = delete_removes_audio(&app);
    let paths = history::delete_many(&app.state::<HistoryDb>(), &ids);
    if remove_audio {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Disk usage of the recordings directory + recording count (Storage section).
#[tauri::command]
pub fn storage_stats(app: AppHandle) -> StorageStats {
    history::storage_stats(&app)
}

/// Delete recordings older than `older_than_days`, optionally keeping favorites.
/// Always frees the audio files (this is the purpose of a purge). Returns the
/// number of recordings removed.
#[tauri::command]
pub fn purge_recordings(
    app: AppHandle,
    older_than_days: u32,
    keep_favorites: bool,
) -> Result<usize, String> {
    let paths =
        history::purge_older_than(&app.state::<HistoryDb>(), older_than_days, keep_favorites);
    let removed = paths.len();
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(removed)
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

/// Return the recording's WAV bytes for in-webview playback.
#[tauri::command]
pub fn read_audio(app: AppHandle, id: i64) -> Result<Vec<u8>, String> {
    let item = history::get(&app.state::<HistoryDb>(), id).ok_or("recording not found")?;
    match item.audio_status.as_str() {
        "capturing" | "saving" => return Err("Audio is still being saved.".into()),
        "failed" => return Err("Audio is unavailable for this recording.".into()),
        _ => {}
    }
    std::fs::read(&item.audio_path).map_err(|e| format!("read audio: {e}"))
}

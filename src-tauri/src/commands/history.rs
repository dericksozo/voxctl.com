//! History commands — thin wrappers over the `history` module. Each mutating
//! command emits `history-changed` so the UI refetches.

use tauri::{AppHandle, Emitter, Manager};

use crate::events;
use crate::history::{self, HistoryDb, HistoryItem};

#[tauri::command]
pub fn list_history(app: AppHandle) -> Vec<HistoryItem> {
    history::list(&app.state::<HistoryDb>())
}

#[tauri::command]
pub fn delete_recording(app: AppHandle, id: i64) -> Result<(), String> {
    if let Some(path) = history::delete(&app.state::<HistoryDb>(), id) {
        let _ = std::fs::remove_file(path);
    }
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
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
    std::fs::read(&item.audio_path).map_err(|e| format!("read audio: {e}"))
}

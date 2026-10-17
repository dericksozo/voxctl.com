//! Commands invoked by the HUD result card. The transcript lives in Rust
//! (`hud::HudState`); the webview only holds a generation token.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::events;
use crate::hud::{self, HudState};

/// Copy the pending transcript, then bump the recording's copy count. A stale
/// generation is a no-op (the card was replaced by a newer one).
#[tauri::command]
pub fn hud_copy_result(app: AppHandle, generation: u64) -> Result<(), String> {
    let pending = {
        let state = app.state::<Mutex<HudState>>();
        let s = state.lock().unwrap();
        s.pending_for_copy(generation)
    };
    let Some((id, text)) = pending else {
        return Ok(());
    };

    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("clipboard write failed: {e}"))?;

    let _ = crate::history::increment_copy(&app.state::<crate::history::HistoryDb>(), id);
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(())
}

/// Dismiss the result card (explicit ✕, idle timeout, or after copying). A
/// stale generation is ignored so an old timer cannot hide a newer recording.
#[tauri::command]
pub fn hud_dismiss_result(app: AppHandle, generation: u64) {
    hud::dismiss_result(&app, generation);
}

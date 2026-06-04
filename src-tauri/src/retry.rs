//! Background retry for failed file-transcriptions. The "queue" is the database
//! itself: rows left in `failed` are picked up here and retried, which survives
//! app restarts. Live-only models and missing keys can't be auto-retried, so
//! they're moved to `needs_transcription` for the user to resolve (re-run via a
//! file mode, or add a key).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::config;
use crate::events;
use crate::file_transcribe::{self, TranscribeOptions};
use crate::history::{self, HistoryDb};
use crate::registry;

const FIRST_DELAY: Duration = Duration::from_secs(15);
const INTERVAL: Duration = Duration::from_secs(30);
const MAX_ATTEMPTS: u32 = 5;

/// In-memory per-recording attempt counter (resets on restart, which is fine —
/// a fresh launch is a reasonable reason to try again).
#[derive(Default)]
pub struct RetryState(pub Mutex<HashMap<i64, u32>>);

/// Reconcile interrupted rows, then loop retrying `failed` rows.
pub fn spawn(app: AppHandle) {
    // Any row still `transcribing` at startup was interrupted (e.g. a crash or
    // quit mid-call). Move it to `failed` so it gets retried.
    let interrupted = history::list_by_status(&app.state::<HistoryDb>(), "transcribing");
    for item in &interrupted {
        history::set_status(&app.state::<HistoryDb>(), item.id, "failed");
    }
    if !interrupted.is_empty() {
        let _ = app.emit(events::HISTORY_CHANGED, ());
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_DELAY).await;
        loop {
            retry_failed(&app).await;
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

async fn retry_failed(app: &AppHandle) {
    let rows = history::list_by_status(&app.state::<HistoryDb>(), "failed");
    if rows.is_empty() {
        return;
    }
    let reg = registry::effective(app);
    for item in rows {
        let Some(model) = reg.model_by_id(&item.model_id) else {
            continue;
        };
        // Can't auto-retry a live-only model from a file.
        if !model.can_file {
            move_to_needs(app, item.id);
            continue;
        }
        let Some(key) = config::get_api_key(&model.provider) else {
            move_to_needs(app, item.id);
            continue;
        };
        let attempts = bump(app, item.id);
        if attempts > MAX_ATTEMPTS {
            move_to_needs(app, item.id);
            continue;
        }
        let Ok(wav) = std::fs::read(&item.audio_path) else {
            continue;
        };
        // Auto-retry uses the persisted language only (mode capabilities/keywords
        // aren't stored); a manual re-run by mode restores full fidelity.
        let opts = TranscribeOptions {
            language: (item.language != "auto" && !item.language.is_empty())
                .then(|| item.language.clone()),
            ..Default::default()
        };
        let Some(transcriber) = file_transcribe::file_transcriber_for(model, key) else {
            continue;
        };
        match transcriber.transcribe_file(&wav, &opts).await {
            Ok(text) if !text.trim().is_empty() => {
                let language = crate::lang_detect::resolve(opts.language.as_deref(), &text);
                history::update_result(
                    &app.state::<HistoryDb>(),
                    item.id,
                    &text,
                    &language,
                    "done",
                );
                clear(app, item.id);
                let _ = app.emit(events::HISTORY_CHANGED, ());
                log::info!("retry succeeded for recording {}", item.id);
            }
            Ok(_) => {
                history::update_result(
                    &app.state::<HistoryDb>(),
                    item.id,
                    "",
                    &item.language,
                    "done",
                );
                clear(app, item.id);
                let _ = app.emit(events::HISTORY_CHANGED, ());
            }
            Err(e) => log::warn!("retry {} failed (attempt {attempts}): {e}", item.id),
        }
    }
}

fn move_to_needs(app: &AppHandle, id: i64) {
    history::set_status(&app.state::<HistoryDb>(), id, "needs_transcription");
    clear(app, id);
    let _ = app.emit(events::HISTORY_CHANGED, ());
}

fn bump(app: &AppHandle, id: i64) -> u32 {
    let st = app.state::<RetryState>();
    let mut m = st.0.lock().unwrap();
    let e = m.entry(id).or_insert(0);
    *e += 1;
    *e
}

fn clear(app: &AppHandle, id: i64) {
    app.state::<RetryState>().0.lock().unwrap().remove(&id);
}

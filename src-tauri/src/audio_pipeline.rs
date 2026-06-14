//! Orchestration invoked when a recording stops. The cardinal rule: ALWAYS
//! persist the WAV + a history row BEFORE transcription is attempted, so a
//! network error can never lose a recording. The active mode's model decides
//! the path — a live OpenAI session is finished here; every other model is
//! transcribed from the saved WAV via its provider's file API. Runs off the
//! UI/audio threads on the async runtime.

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::audio::RecordingContext;
use crate::commands::config;
use crate::events::{self, BackendError, TranscriptText};
use crate::file_transcribe;
use crate::history::{self, HistoryDb};
use crate::hud;
use crate::registry;
use crate::resample;
use crate::transcription::RealtimeSession;

/// Sentinel error meaning "no API key for this provider" (vs a transient
/// network/API failure), so failures route to the right history state.
const NO_KEY: &str = "no_api_key";

/// Called with the raw mono f32 samples at the device input rate, plus the live
/// transcription session opened at record-start (Some only for live streaming
/// models). The WAV + a `transcribing` row are persisted first; transcription
/// then runs and updates the row.
pub fn on_recording_finished(
    app: &AppHandle,
    samples: Vec<f32>,
    rate: u32,
    ctx: RecordingContext,
    session: Option<RealtimeSession>,
    id: i64,
    audio_path: String,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wall-clock starts at recording-stop (this is invoked right after capture
        // finishes), so it measures "time from shortcut release to transcript ready".
        let started = std::time::Instant::now();

        // Transcribe: a live session is already streaming (finish it); every
        // other model transcribes the saved WAV via its provider's file API.
        let result = match session {
            Some(session) => {
                archive_audio(app.clone(), id, audio_path, samples, rate);
                session.finish().await
            }
            None => match archive_audio_now(&app, id, &audio_path, samples, rate).await {
                Ok(wav) => transcribe_file(&app, &ctx, wav).await,
                Err(e) => {
                    let db = app.state::<HistoryDb>();
                    history::set_audio_status(&db, id, "failed");
                    let _ = app.emit(events::HISTORY_CHANGED, ());
                    Err(e)
                }
            },
        };

        // perf instrumentation (§6 measuring before/after): stop → transcript
        // ready. Mirrors the persisted `transcription_ms` so the WAV-buffer /
        // resample work (perf/09-11) shows up against a stable baseline.
        let elapsed_ms = started.elapsed().as_millis() as i64;
        log::debug!("perf: stop→transcript {elapsed_ms} ms (id {id})");
        finalize(&app, id, &ctx, result, elapsed_ms);
    });
}

fn archive_audio(app: AppHandle, id: i64, path: String, samples: Vec<f32>, rate: u32) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = archive_audio_now(&app, id, &path, samples, rate).await {
            log::error!("audio archive failed (id {id}): {e}");
            let db = app.state::<HistoryDb>();
            history::set_audio_status(&db, id, "failed");
            let _ = app.emit(events::HISTORY_CHANGED, ());
        }
    });
}

/// Resample, build the WAV container once in memory, persist it to disk, and
/// return the same bytes so the file transcriber can use them without re-reading
/// the file (§2.2).
async fn archive_audio_now(
    app: &AppHandle,
    id: i64,
    path: &str,
    samples: Vec<f32>,
    rate: u32,
) -> Result<Vec<u8>, String> {
    // Resample (a multi-second sinc pass), WAV encode, and the file write are all
    // blocking/CPU-bound — run them on the blocking pool so they don't occupy a
    // tokio worker on the async runtime (§2.3).
    let target = resample::TARGET_RATE;
    let path_owned = path.to_string();
    let wav = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let pcm16 = resample::resample_to_pcm16_24k(&samples, rate);
        let wav = history::encode_wav(&pcm16, target)?;
        std::fs::write(&path_owned, &wav).map_err(|e| format!("write wav: {e}"))?;
        Ok(wav)
    })
    .await
    .map_err(|e| format!("archive task: {e}"))??;
    let db = app.state::<HistoryDb>();
    if !history::update_audio_result(&db, id, wav.len() as i64, "ready") {
        // The row was deleted while we were archiving — drop the orphan file and
        // skip transcription (the result would update a non-existent row).
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{path}.pcm"));
        return Err("recording was removed before archival completed".into());
    }
    // The full WAV is persisted; the crash-recovery PCM sidecar (Path B, file
    // mode only) is no longer needed. No-op for live mode, which writes none.
    let _ = std::fs::remove_file(format!("{path}.pcm"));
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(wav)
}

/// Transcribe the saved WAV through the active mode's model + capability options.
async fn transcribe_file(
    app: &AppHandle,
    ctx: &RecordingContext,
    wav: Vec<u8>,
) -> Result<file_transcribe::TranscriptOutput, String> {
    let reg = registry::effective(app);
    let model = reg
        .model_by_id(&ctx.model_id)
        .ok_or_else(|| format!("unknown model {}", ctx.model_id))?;
    let key = config::get_api_key(&model.provider).ok_or_else(|| NO_KEY.to_string())?;
    let transcriber = file_transcribe::file_transcriber_for(model, key)
        .ok_or_else(|| format!("no file transcriber for {}", model.provider))?;
    // The WAV bytes were just built in memory by archive_audio_now — no re-read.
    transcriber.transcribe_file(wav, &ctx.options).await
}

/// Record the transcription outcome on the row, deliver the text, and settle the
/// HUD. Always leaves the row in a coherent state (done/failed/needs_transcription).
fn finalize(
    app: &AppHandle,
    id: i64,
    ctx: &RecordingContext,
    result: Result<file_transcribe::TranscriptOutput, String>,
    transcription_ms: i64,
) {
    let db = app.state::<HistoryDb>();
    match result {
        Ok(out) if !out.text.trim().is_empty() => {
            let extra = out.extra_json();
            let text = out.text;
            let language = crate::lang_detect::resolve(ctx.language.as_deref(), &text);
            history::update_result(
                &db,
                id,
                &text,
                &language,
                "done",
                transcription_ms,
                extra.as_deref(),
            );
            log::info!("transcript (id {id}): {} chars", text.len());
            let _ = app.emit(
                events::TRANSCRIPT_FINAL,
                TranscriptText { text: text.clone() },
            );
            let delivered = deliver(app, &text);
            let _ = app.emit(events::HISTORY_CHANGED, ());
            if delivered {
                hud::hide_hud(app);
            } else {
                hide_after_delay(app);
            }
        }
        Ok(_) => {
            // Completed with no speech — a valid, done recording (empty text).
            let language = ctx.language.clone().unwrap_or_else(|| "auto".into());
            history::update_result(&db, id, "", &language, "done", transcription_ms, None);
            let _ = app.emit(events::HISTORY_CHANGED, ());
            hud::hide_hud(app);
        }
        Err(e) => handle_failure(app, id, ctx, &e),
    }
}

/// Deliver the transcript: copy to clipboard if enabled, paste into the focused
/// field when Accessibility is granted. Returns false when delivery hit a
/// problem worth keeping the HUD error visible briefly.
fn deliver(app: &AppHandle, text: &str) -> bool {
    let cfg = config::load_config(app);
    if cfg.copy_to_clipboard {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        if let Err(e) = app.clipboard().write_text(text.to_string()) {
            log::error!("clipboard write failed: {e}");
        }
    }
    if crate::platform::macos::accessibility_trusted() {
        match crate::commands::inject::insert_text(text) {
            Ok(()) => true,
            Err(e) => {
                log::error!("injection failed: {e}");
                let _ = app.emit(events::ERROR, BackendError::new("inject", e));
                false
            }
        }
    } else {
        log::warn!("accessibility not granted; skipping injection");
        let _ = app.emit(
            events::ERROR,
            BackendError::new(
                "inject",
                "Accessibility permission needed to insert text. Grant it in Settings, then open History to copy.",
            ),
        );
        false
    }
}

/// Route a failed transcription to the right state: `needs_transcription` when
/// there's no key or the model can't re-process a file (live-only), else
/// `failed` (the retry worker will retry these).
fn handle_failure(app: &AppHandle, id: i64, ctx: &RecordingContext, err: &str) {
    let db = app.state::<HistoryDb>();
    let reg = registry::effective(app);
    let file_capable = reg
        .model_by_id(&ctx.model_id)
        .map(|m| m.can_file)
        .unwrap_or(false);
    let no_key = err == NO_KEY;
    let status = if no_key || !file_capable {
        "needs_transcription"
    } else {
        "failed"
    };
    history::set_status(&db, id, status);
    if status == "failed" {
        // Wake the retry worker so a freshly-failed row is retried promptly
        // rather than after up to one poll interval (§3.3).
        app.state::<crate::retry::RetryState>().1.notify_one();
    }

    let msg = if no_key {
        "No API key for this mode's provider. Add one in Settings, then re-run from History."
            .to_string()
    } else {
        format!("Transcription failed: {err}")
    };
    log::error!("transcription failed (id {id}, status {status}): {err}");
    let _ = app.emit(events::ERROR, BackendError::new("transcription", msg));
    let _ = app.emit(events::HISTORY_CHANGED, ());
    hide_after_delay(app);
}

/// Keep the quiet HUD error status up for a moment so the user notices, then hide.
fn hide_after_delay(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
        hud::hide_hud(&app);
    });
}

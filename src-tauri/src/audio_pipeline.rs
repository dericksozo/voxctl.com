//! Orchestration invoked when a recording stops: resample for persistence,
//! collect the live transcript, inject, and save to history. Runs off the
//! UI/audio threads on the async runtime.

use tauri::{AppHandle, Emitter};

use crate::commands::audio::RecordingContext;
use crate::commands::config;
use crate::events::{self, BackendError, TranscriptText};
use crate::history;
use crate::hud;
use crate::resample;
use crate::transcription::RealtimeSession;

/// Called with the raw mono f32 samples at the device input rate, plus the live
/// transcription session opened at record-start (None when there was no API
/// key). Uses only the live transcript assembled from manually committed chunks.
/// Full-buffer retranscription is user-triggered from History only. The WAV is
/// always saved.
pub fn on_recording_finished(
    app: &AppHandle,
    samples: Vec<f32>,
    rate: u32,
    ctx: RecordingContext,
    session: Option<RealtimeSession>,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let pcm16 = resample::resample_to_pcm16_24k(&samples, rate);

        let transcript = match session {
            Some(session) => live_transcript_or_error(&app, session.finish().await),
            None => {
                emit_no_api_key_error(&app);
                String::new()
            }
        };

        finalize(&app, &pcm16, &transcript, &ctx);
    });
}

fn live_transcript_or_error(app: &AppHandle, result: Result<String, String>) -> String {
    match result {
        Ok(text) => {
            log::info!("final transcript (streamed): {} chars", text.len());
            let _ = app.emit(
                events::TRANSCRIPT_FINAL,
                TranscriptText { text: text.clone() },
            );
            text
        }
        Err(e) => {
            log::error!("live transcription failed: {e}");
            let _ = app.emit(events::ERROR, BackendError::new("transcription", e));
            String::new()
        }
    }
}

fn emit_no_api_key_error(app: &AppHandle) {
    log::warn!("no API key set; skipping transcription");
    let _ = app.emit(
        events::ERROR,
        BackendError::new(
            "transcription",
            "No OpenAI API key set. Add one in Settings.",
        ),
    );
}

/// Inject the final transcript into the frontmost app (clipboard untouched
/// unless the user enabled the copy toggle), then persist to history. Always
/// hides the HUD; ALWAYS saves so a recording is never lost (brief §3).
fn finalize(app: &AppHandle, pcm16: &[i16], transcript: &str, ctx: &RecordingContext) {
    let trimmed = transcript.trim();
    // An empty transcript means transcription failed (an error was already
    // emitted) or there was no speech; either way the HUD should linger briefly.
    let mut had_error = trimmed.is_empty();
    if !trimmed.is_empty() {
        let cfg = config::load_config(app);

        // Clipboard toggle (brief §4): OFF = never touch it; ON = overwrite.
        if cfg.copy_to_clipboard {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            if let Err(e) = app.clipboard().write_text(transcript.to_string()) {
                log::error!("clipboard write failed: {e}");
            }
        }

        // CGEvent injection requires Accessibility; surface a clear error if missing.
        if crate::platform::macos::accessibility_trusted() {
            if let Err(e) = crate::commands::inject::insert_text(transcript) {
                log::error!("injection failed: {e}");
                had_error = true;
                let _ = app.emit(events::ERROR, BackendError::new("inject", e));
            }
        } else {
            log::warn!("accessibility not granted; skipping injection");
            had_error = true;
            let _ = app.emit(
                events::ERROR,
                BackendError::new(
                    "inject",
                    "Accessibility permission needed to insert text. Grant it in Settings, then open History to copy.",
                ),
            );
        }
    }

    // Always save (even empty transcript / on failure) so nothing is lost.
    // For "auto" recordings, resolve the actual detected language so the history
    // chip shows e.g. "en"/"ja" rather than the literal "auto" selection label.
    let language = crate::lang_detect::resolve(ctx.language.as_deref(), transcript);
    let mode_name = ctx.mode_name.as_deref().unwrap_or("—");
    match history::save(
        app,
        pcm16,
        transcript,
        &language,
        mode_name,
        ctx.app_name.as_deref(),
        ctx.website.as_deref(),
    ) {
        Ok(id) => {
            log::info!("saved recording #{id}");
            let _ = app.emit(events::HISTORY_CHANGED, ());
        }
        Err(e) => log::error!("failed to save recording: {e}"),
    }

    // On success, hide immediately. On failure, keep the quiet HUD ERROR status
    // up for a moment so the user notices, then hide it.
    if had_error {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
            hud::hide_hud(&app);
        });
    } else {
        hud::hide_hud(app);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn normal_recording_has_no_batch_transcription_fallback() {
        let source = include_str!("audio_pipeline.rs");
        assert!(!source.contains(concat!("batch", "_transcribe")));
        assert!(!source.contains(concat!("OpenAi", "RealtimeTranscriber")));
        assert!(source.contains("Full-buffer retranscription is user-triggered from History only"));
    }
}

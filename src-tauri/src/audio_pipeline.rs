//! Orchestration invoked when a recording stops: resample → transcribe →
//! inject → save to history. Runs off the UI/audio threads on the async runtime.

use tauri::{AppHandle, Emitter};

use crate::commands::audio::RecordingContext;
use crate::commands::config;
use crate::events::{self, BackendError, TranscriptText};
use crate::history;
use crate::hud;
use crate::resample;
use crate::transcription::{OpenAiRealtimeTranscriber, Transcriber};

/// Called with the raw mono f32 samples at the device input rate.
pub fn on_recording_finished(app: &AppHandle, samples: Vec<f32>, rate: u32, ctx: RecordingContext) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let pcm16 = resample::resample_to_pcm16_24k(&samples, rate);

        let transcript = match config::get_api_key() {
            None => {
                log::warn!("no API key set; skipping transcription");
                let _ = app.emit(
                    events::ERROR,
                    BackendError::new(
                        "transcription",
                        "No OpenAI API key set. Add one in Settings.",
                    ),
                );
                String::new()
            }
            Some(key) => {
                let transcriber = OpenAiRealtimeTranscriber::new(key);
                let app_delta = app.clone();
                let on_delta = move |text: String| {
                    let _ = app_delta.emit(events::TRANSCRIPT_PARTIAL, TranscriptText { text });
                };
                match transcriber
                    .transcribe(&pcm16, ctx.language.as_deref(), &on_delta)
                    .await
                {
                    Ok(text) => {
                        log::info!("final transcript: {} chars", text.len());
                        let _ = app.emit(
                            events::TRANSCRIPT_FINAL,
                            TranscriptText { text: text.clone() },
                        );
                        text
                    }
                    Err(e) => {
                        log::error!("transcription failed: {e}");
                        let _ = app.emit(events::ERROR, BackendError::new("transcription", e));
                        String::new()
                    }
                }
            }
        };

        finalize(&app, &pcm16, &transcript, &ctx);
    });
}

/// Inject the final transcript into the frontmost app (clipboard untouched
/// unless the user enabled the copy toggle), then persist to history. Always
/// hides the HUD; ALWAYS saves so a recording is never lost (brief §3).
fn finalize(app: &AppHandle, pcm16: &[i16], transcript: &str, ctx: &RecordingContext) {
    let trimmed = transcript.trim();
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
                let _ = app.emit(events::ERROR, BackendError::new("inject", e));
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
        }
    }

    // Always save (even empty transcript / on failure) so nothing is lost.
    let language = ctx.language.as_deref().unwrap_or("auto");
    let mode_name = ctx.mode_name.as_deref().unwrap_or("—");
    match history::save(
        app,
        pcm16,
        transcript,
        language,
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

    hud::hide_hud(app);
}

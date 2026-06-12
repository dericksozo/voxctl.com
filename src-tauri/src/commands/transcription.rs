//! User-triggered re-transcription ("re-run") of a saved recording through a
//! chosen Mode. The mode encodes the provider/model + language + capability
//! settings, so re-run is a single mode pick rather than a raw model/language
//! choice. Only file-capable models can re-process a saved WAV.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{config, modes};
use crate::events;
use crate::file_transcribe;
use crate::history::{self, HistoryDb};
use crate::registry;

/// Result of a manual re-run. Carries the transcript plus a reactive signal that
/// diarization was requested but the provider returned no speaker labels — a known
/// xAI long-file limitation (it 200s with full text/words but silently drops every
/// `speaker` field past ~54–56 min). See PLAN_xai-diarization-silent-failure.md.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerunResult {
    pub text: String,
    pub diarization_dropped: bool,
}

/// True when diarization was requested, transcript text came back, yet zero
/// speaker segments were produced. Source of truth for the post-run notice.
/// Provider-agnostic by shape; duration is deliberately not consulted here.
fn diarization_dropped(requested: bool, text: &str, speaker_count: usize) -> bool {
    requested && speaker_count == 0 && !text.trim().is_empty()
}

/// Re-transcribe a saved recording through `mode_id`. Resolves the mode's model
/// + capability options, runs the saved WAV through that provider's file API,
/// and updates the row's transcript, language, model, and status.
#[tauri::command]
pub async fn retranscribe(app: AppHandle, id: i64, mode_id: String) -> Result<RerunResult, String> {
    let item = history::get(&app.state::<HistoryDb>(), id).ok_or("recording not found")?;

    let mode = modes::all_modes(&app)
        .into_iter()
        .find(|m| m.id == mode_id)
        .ok_or("mode not found")?;
    let reg = registry::effective(&app);
    let model = reg
        .model_by_id(&mode.model)
        .ok_or("this mode's model is unknown")?;
    if !model.can_file {
        return Err("That mode's model can't re-transcribe a saved file (it's live-only).".into());
    }
    let key = config::get_api_key(&model.provider)
        .ok_or("No API key for that mode's provider. Add one in Settings.")?;

    let lang =
        (mode.language != "auto" && !mode.language.is_empty()).then(|| mode.language.clone());
    let options = modes::build_options(Some(&mode), Some(model), lang.clone());
    let transcriber = file_transcribe::file_transcriber_for(model, key)
        .ok_or("no transcriber for that provider")?;

    // Reflect work-in-progress immediately, then transcribe the saved WAV.
    history::set_status(&app.state::<HistoryDb>(), id, "transcribing");
    let _ = app.emit(events::HISTORY_CHANGED, ());

    let wav = std::fs::read(&item.audio_path).map_err(|e| format!("read audio: {e}"))?;
    // Time the re-run the same way the live pipeline does: from request to result.
    let started = std::time::Instant::now();
    let out = match transcriber.transcribe_file(&wav, &options).await {
        Ok(t) => t,
        Err(e) => {
            // Leave it re-runnable rather than stuck "transcribing".
            history::set_status(&app.state::<HistoryDb>(), id, "needs_transcription");
            let _ = app.emit(events::HISTORY_CHANGED, ());
            return Err(e);
        }
    };

    let resolved = crate::lang_detect::resolve(lang.as_deref(), &out.text);
    history::update_result_and_model(
        &app.state::<HistoryDb>(),
        id,
        &out.text,
        &resolved,
        "done",
        started.elapsed().as_millis() as i64,
        out.extra_json().as_deref(),
        &mode.model,
    );
    let _ = app.emit(events::HISTORY_CHANGED, ());

    let diarization_dropped =
        diarization_dropped(options.diarization, &out.text, out.speakers.len());
    Ok(RerunResult {
        text: out.text,
        diarization_dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::diarization_dropped;

    #[test]
    fn flags_only_when_requested_text_present_and_no_speakers() {
        // Requested, transcript came back, zero speakers → the silent drop.
        assert!(diarization_dropped(true, "hello world", 0));
    }

    #[test]
    fn not_flagged_when_diarization_not_requested() {
        assert!(!diarization_dropped(false, "hello world", 0));
    }

    #[test]
    fn not_flagged_when_text_empty() {
        // Empty transcript is a transcription failure, not a speaker-label drop.
        assert!(!diarization_dropped(true, "   ", 0));
    }

    #[test]
    fn not_flagged_when_speakers_present() {
        // A real single-speaker result still has one segment — that's success.
        assert!(!diarization_dropped(true, "hello", 1));
        assert!(!diarization_dropped(true, "hello", 3));
    }
}

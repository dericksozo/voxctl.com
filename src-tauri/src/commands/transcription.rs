//! User-triggered re-transcription for a saved recording. This is the only path
//! that reads an archived WAV and sends the full audio buffer back through the
//! realtime API, then updates the stored transcript.

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::config;
use crate::events;
use crate::history::{self, HistoryDb};
use crate::transcription::{OpenAiRealtimeTranscriber, Transcriber};

#[tauri::command]
pub async fn retranscribe(
    app: AppHandle,
    id: i64,
    language: Option<String>,
) -> Result<String, String> {
    let item = history::get(&app.state::<HistoryDb>(), id).ok_or("recording not found")?;
    let pcm16 = history::read_wav(&item.audio_path)?;
    let key = config::get_api_key("openai").ok_or("No OpenAI API key set.")?;

    let transcriber = OpenAiRealtimeTranscriber::new(key);
    let on_delta = |_t: String| {};
    let text = transcriber
        .transcribe(&pcm16, language.as_deref(), &on_delta)
        .await?;

    // Same "auto" → detected-language resolution as the live recording path.
    let lang = crate::lang_detect::resolve(language.as_deref(), &text);
    history::update_transcript(&app.state::<HistoryDb>(), id, &text, &lang);
    // A successful re-run clears any failed/needs_transcription state.
    history::set_status(&app.state::<HistoryDb>(), id, "done");
    let _ = app.emit(events::HISTORY_CHANGED, ());
    Ok(text)
}

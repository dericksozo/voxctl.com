//! Transcription layer. `Transcriber` is the swappable interface (so an
//! offline/local model can slot in later); `OpenAiRealtimeTranscriber` talks to
//! the OpenAI Realtime API over a rustls WebSocket from Rust — the API key never
//! leaves the backend.
//!
//! Live sessions append audio as it is captured and use client-side silence
//! detection to commit chunks. `gpt-realtime-whisper` does not support Realtime
//! turn detection, so the session sets `turn_detection` to null and commits the
//! final tail on stop. Deltas are surfaced as the HUD preview; completed items
//! are stitched together for the final transcript.
//!
//! NOTE: this is the highest-risk surface — the exact GA message shape can only
//! be confirmed against a live key (see MANUAL_TEST.md). Parsing is defensive.

use std::{collections::HashMap, time::Duration};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const WS_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const MODEL: &str = "gpt-realtime-whisper";
const TRANSCRIPTION_DELAY: &str = "low";
/// ~0.67 s of 24 kHz audio per append message.
const APPEND_SAMPLES: usize = 16000;
const SAMPLE_RATE: usize = 24000;
const MANUAL_COMMIT_SILENCE_MS: u32 = 1500;
const MANUAL_COMMIT_SILENCE_SAMPLES: usize = SAMPLE_RATE * MANUAL_COMMIT_SILENCE_MS as usize / 1000;
const MANUAL_COMMIT_RMS_THRESHOLD: f32 = 0.01;
const READ_TIMEOUT: Duration = Duration::from_secs(45);

#[async_trait::async_trait]
pub trait Transcriber: Send + Sync {
    /// Transcribe 24 kHz mono PCM16. `language` None/"auto" => model auto-detect.
    /// `on_delta` receives the running transcript for live preview.
    async fn transcribe(
        &self,
        pcm16: &[i16],
        language: Option<&str>,
        on_delta: &(dyn Fn(String) + Send + Sync),
    ) -> Result<String, String>;
}

pub struct OpenAiRealtimeTranscriber {
    api_key: String,
}

impl OpenAiRealtimeTranscriber {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }

    /// Open a live transcription session: connect the WebSocket and start a
    /// background task that streams audio in as it's captured and finalizes on
    /// stop. Audio is pushed via the returned [`RealtimeSession`]; the final
    /// transcript is awaited with [`RealtimeSession::finish`]. `on_delta` gets
    /// the running transcript as deltas arrive (used for an optional preview).
    pub fn open_session<F>(
        api_key: String,
        language: Option<String>,
        on_delta: F,
    ) -> RealtimeSession
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();
        let (done_tx, done_rx) = oneshot::channel::<Result<String, String>>();
        tauri::async_runtime::spawn(session_task(api_key, language, audio_rx, done_tx, on_delta));
        RealtimeSession { audio_tx, done_rx }
    }
}

/// Handle to a live transcription session (see [`OpenAiRealtimeTranscriber::open_session`]).
pub struct RealtimeSession {
    audio_tx: mpsc::UnboundedSender<Vec<i16>>,
    done_rx: oneshot::Receiver<Result<String, String>>,
}

impl RealtimeSession {
    /// A cloneable sender for pushing 24 kHz mono PCM16 chunks into the session.
    /// While any sender is alive the session keeps accepting audio; when the last
    /// one drops, the background task commits and finalizes.
    pub fn sender(&self) -> mpsc::UnboundedSender<Vec<i16>> {
        self.audio_tx.clone()
    }

    /// Stop accepting audio and await the final transcript. Drops this handle's
    /// sender; once all other senders (the capture forwarder) are gone too, the
    /// background task commits any final buffered audio and reads to completion.
    pub async fn finish(self) -> Result<String, String> {
        drop(self.audio_tx);
        self.done_rx
            .await
            .unwrap_or_else(|_| Err("transcription task ended unexpectedly".into()))
    }
}

/// Background task owning the WebSocket for a live session: appends audio as it
/// streams in, commits chunks after local silence detection, and waits for any
/// in-flight transcript items after capture stops.
async fn session_task<F>(
    api_key: String,
    language: Option<String>,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<i16>>,
    done_tx: oneshot::Sender<Result<String, String>>,
    on_delta: F,
) where
    F: Fn(String) + Send + Sync + 'static,
{
    let result = run_session(&api_key, language, &mut audio_rx, &on_delta).await;
    let _ = done_tx.send(result);
}

#[derive(Default)]
struct LiveTranscript {
    item_order: Vec<String>,
    text_by_item: HashMap<String, String>,
    anonymous: String,
}

impl LiveTranscript {
    fn note_item(&mut self, item_id: &str) {
        if !self.item_order.iter().any(|id| id == item_id) {
            self.item_order.push(item_id.to_string());
        }
    }

    fn push_delta(&mut self, item_id: Option<&str>, delta: &str) {
        if let Some(item_id) = item_id {
            self.note_item(item_id);
            self.text_by_item
                .entry(item_id.to_string())
                .or_default()
                .push_str(delta);
        } else {
            self.anonymous.push_str(delta);
        }
    }

    fn complete(&mut self, item_id: Option<&str>, text: String) {
        if let Some(item_id) = item_id {
            self.note_item(item_id);
            self.text_by_item.insert(item_id.to_string(), text);
        } else {
            append_transcript_part(&mut self.anonymous, &text);
        }
    }

    fn text(&self) -> String {
        let mut out = String::new();
        for item_id in &self.item_order {
            if let Some(text) = self.text_by_item.get(item_id) {
                append_transcript_part(&mut out, text);
            }
        }
        append_transcript_part(&mut out, &self.anonymous);
        out
    }
}

enum FrameSignal {
    Continue,
    Committed,
    Completed,
    Closed,
}

#[derive(Default)]
struct ManualCommitDetector {
    uncommitted_samples: usize,
    speech_seen: bool,
    silence_after_speech: usize,
}

impl ManualCommitDetector {
    fn observe(&mut self, chunk: &[i16]) -> bool {
        self.uncommitted_samples += chunk.len();

        if chunk_rms(chunk) >= MANUAL_COMMIT_RMS_THRESHOLD {
            self.speech_seen = true;
            self.silence_after_speech = 0;
            return false;
        }

        if self.speech_seen {
            self.silence_after_speech += chunk.len();
        }

        self.should_commit()
    }

    fn should_commit(&self) -> bool {
        self.uncommitted_samples > 0
            && self.speech_seen
            && self.silence_after_speech >= MANUAL_COMMIT_SILENCE_SAMPLES
    }

    fn should_commit_final(&self) -> bool {
        self.uncommitted_samples > 0
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

fn chunk_rms(chunk: &[i16]) -> f32 {
    if chunk.is_empty() {
        return 0.0;
    }
    let sum_squares = chunk
        .iter()
        .map(|s| {
            let normalized = *s as f32 / i16::MAX as f32;
            normalized * normalized
        })
        .sum::<f32>();
    (sum_squares / chunk.len() as f32).sqrt()
}

/// Interpret one inbound WS frame. Deltas and completed items update
/// `transcript`; errors are terminal. Completion is not terminal for a live
/// session because we commit multiple audio items during one recording.
fn handle_frame(
    frame: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    transcript: &mut LiveTranscript,
    on_delta: &impl Fn(String),
) -> Result<FrameSignal, String> {
    let f = match frame {
        Some(Ok(f)) => f,
        Some(Err(e)) => return Err(format!("ws read: {e}")),
        None => return Ok(FrameSignal::Closed),
    };
    if f.is_close() {
        return Ok(FrameSignal::Closed);
    }
    let txt = match f.to_text() {
        Ok(t) => t,
        Err(_) => return Ok(FrameSignal::Continue),
    };
    let v = match serde_json::from_str::<Value>(txt) {
        Ok(v) => v,
        Err(_) => return Ok(FrameSignal::Continue),
    };
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "input_audio_buffer.committed" => {
            if let Some(item_id) = v.get("item_id").and_then(Value::as_str) {
                transcript.note_item(item_id);
            }
            Ok(FrameSignal::Committed)
        }
        "conversation.item.input_audio_transcription.delta" => {
            if let Some(d) = v.get("delta").and_then(Value::as_str) {
                let item_id = v.get("item_id").and_then(Value::as_str);
                transcript.push_delta(item_id, d);
                on_delta(transcript.text());
            }
            Ok(FrameSignal::Continue)
        }
        "conversation.item.input_audio_transcription.completed" => {
            let item_id = v.get("item_id").and_then(Value::as_str);
            let fallback = item_id
                .and_then(|id| transcript.text_by_item.get(id))
                .cloned()
                .unwrap_or_default();
            let text = v
                .get("transcript")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(fallback);
            transcript.complete(item_id, text);
            on_delta(transcript.text());
            Ok(FrameSignal::Completed)
        }
        "error" => {
            let msg = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            Err(format!("api error: {msg}"))
        }
        _ => Ok(FrameSignal::Continue),
    }
}

fn append_transcript_part(out: &mut String, part: &str) {
    if part.is_empty() {
        return;
    }
    if should_insert_space(out, part) {
        out.push(' ');
    }
    out.push_str(part);
}

fn should_insert_space(out: &str, part: &str) -> bool {
    let Some(prev) = out.chars().next_back() else {
        return false;
    };
    let Some(next) = part.chars().next() else {
        return false;
    };
    prev.is_ascii_alphanumeric() && next.is_ascii_alphanumeric()
}

fn is_empty_commit_error(msg: &str) -> bool {
    let msg = msg.to_ascii_lowercase();
    msg.contains("commit") && (msg.contains("empty") || msg.contains("no audio"))
}

async fn run_session<F>(
    api_key: &str,
    language: Option<String>,
    audio_rx: &mut mpsc::UnboundedReceiver<Vec<i16>>,
    on_delta: &F,
) -> Result<String, String>
where
    F: Fn(String) + Send + Sync + 'static,
{
    let mut req = WS_URL
        .into_client_request()
        .map_err(|e| format!("request build: {e}"))?;
    let auth = format!("Bearer {api_key}");
    req.headers_mut().insert(
        "authorization",
        auth.parse()
            .map_err(|_| "invalid auth header".to_string())?,
    );

    let (ws, _resp) = connect_async(req)
        .await
        .map_err(|e| format!("websocket connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();

    write
        .send(Message::Text(
            session_update(language.as_deref()).to_string(),
        ))
        .await
        .map_err(|e| format!("send session.update: {e}"))?;

    let mut transcript = LiveTranscript::default();
    let mut commit_detector = ManualCommitDetector::default();
    let mut pending_commits = 0usize;
    let mut awaiting_final_commit = false;

    // Phase 1: stream audio as it is captured. Since `gpt-realtime-whisper`
    // does not support API turn detection, local silence detection commits
    // chunks after 1500 ms of silence; stop always commits any remaining tail.
    loop {
        tokio::select! {
            maybe_chunk = audio_rx.recv() => {
                match maybe_chunk {
                    Some(chunk) if !chunk.is_empty() => {
                        let msg = json!({ "type": "input_audio_buffer.append", "audio": pcm16_to_base64(&chunk) });
                        if let Err(e) = write.send(Message::Text(msg.to_string())).await {
                            return Err(format!("send audio: {e}"));
                        }
                        if commit_detector.observe(&chunk) {
                            send_commit(&mut write, "silence commit").await?;
                            pending_commits += 1;
                            commit_detector.reset();
                        }
                    }
                    Some(_) => {}
                    None => {
                        if commit_detector.should_commit_final() {
                            send_commit(&mut write, "final commit").await?;
                            pending_commits += 1;
                            awaiting_final_commit = true;
                            commit_detector.reset();
                        }
                        break;
                    }
                }
            }
            frame = read.next() => {
                match handle_frame(frame, &mut transcript, on_delta)? {
                    FrameSignal::Committed => {}
                    FrameSignal::Completed => pending_commits = pending_commits.saturating_sub(1),
                    FrameSignal::Closed => break,
                    FrameSignal::Continue => {}
                }
            }
        }
    }

    // Phase 2: read completions for committed chunks still in flight. If our
    // final manual commit races with an automatic VAD commit, the API may report
    // an empty buffer; keep the transcript already produced in that case.
    let read_final = async {
        while pending_commits > 0 || awaiting_final_commit {
            match handle_frame(read.next().await, &mut transcript, on_delta) {
                Ok(FrameSignal::Committed) => {
                    awaiting_final_commit = false;
                }
                Ok(FrameSignal::Completed) => pending_commits = pending_commits.saturating_sub(1),
                Ok(FrameSignal::Closed) => break,
                Ok(FrameSignal::Continue) => {}
                Err(e) if awaiting_final_commit && is_empty_commit_error(&e) => {
                    awaiting_final_commit = false;
                    pending_commits = pending_commits.saturating_sub(1);
                }
                Err(e) => return Err(e),
            }
        }
        Ok::<String, String>(transcript.text())
    };

    let result = timeout(READ_TIMEOUT, read_final).await.unwrap_or_else(|_| {
        let text = transcript.text();
        if text.is_empty() {
            Err("transcription timed out".into())
        } else {
            Ok(text)
        }
    });

    let _ = write.send(Message::Close(None)).await;
    result
}

async fn send_commit<S>(write: &mut S, label: &str) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    write
        .send(Message::Text(
            json!({ "type": "input_audio_buffer.commit" }).to_string(),
        ))
        .await
        .map_err(|e| format!("send {label}: {e}"))
}

fn pcm16_to_base64(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

fn session_update(language: Option<&str>) -> Value {
    let mut transcription = serde_json::Map::new();
    transcription.insert("model".into(), json!(MODEL));
    transcription.insert("delay".into(), json!(TRANSCRIPTION_DELAY));
    if let Some(l) = language {
        if !l.is_empty() && l != "auto" {
            transcription.insert("language".into(), json!(l));
        }
    }
    json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": 24000 },
                    "transcription": Value::Object(transcription),
                    "turn_detection": Value::Null
                }
            }
        }
    })
}

#[async_trait::async_trait]
impl Transcriber for OpenAiRealtimeTranscriber {
    async fn transcribe(
        &self,
        pcm16: &[i16],
        language: Option<&str>,
        on_delta: &(dyn Fn(String) + Send + Sync),
    ) -> Result<String, String> {
        if pcm16.is_empty() {
            return Err("no audio captured".into());
        }

        let mut req = WS_URL
            .into_client_request()
            .map_err(|e| format!("request build: {e}"))?;
        let auth = format!("Bearer {}", self.api_key);
        req.headers_mut().insert(
            "authorization",
            auth.parse()
                .map_err(|_| "invalid auth header".to_string())?,
        );

        let (ws, _resp) = connect_async(req)
            .await
            .map_err(|e| format!("websocket connect failed: {e}"))?;
        let (mut write, mut read) = ws.split();

        // Configure the transcription session.
        write
            .send(Message::Text(session_update(language).to_string()))
            .await
            .map_err(|e| format!("send session.update: {e}"))?;

        // Stream the captured audio, then commit so the model finalizes.
        for chunk in pcm16.chunks(APPEND_SAMPLES) {
            let msg =
                json!({ "type": "input_audio_buffer.append", "audio": pcm16_to_base64(chunk) });
            write
                .send(Message::Text(msg.to_string()))
                .await
                .map_err(|e| format!("send audio: {e}"))?;
        }
        write
            .send(Message::Text(
                json!({ "type": "input_audio_buffer.commit" }).to_string(),
            ))
            .await
            .map_err(|e| format!("send commit: {e}"))?;

        // Read until the final transcript (or timeout).
        let mut running = String::new();
        let read_loop = async {
            while let Some(frame) = read.next().await {
                let frame = frame.map_err(|e| format!("ws read: {e}"))?;
                if frame.is_close() {
                    break;
                }
                let Ok(txt) = frame.to_text() else { continue };
                let Ok(v) = serde_json::from_str::<Value>(txt) else {
                    continue;
                };
                match v.get("type").and_then(Value::as_str).unwrap_or("") {
                    "conversation.item.input_audio_transcription.delta" => {
                        if let Some(d) = v.get("delta").and_then(Value::as_str) {
                            running.push_str(d);
                            on_delta(running.clone());
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        let text = v
                            .get("transcript")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| running.clone());
                        return Ok(text);
                    }
                    "error" => {
                        let msg = v
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error");
                        return Err(format!("api error: {msg}"));
                    }
                    _ => {}
                }
            }
            if running.is_empty() {
                Err("connection closed before transcript".to_string())
            } else {
                Ok(running.clone())
            }
        };

        let result = timeout(READ_TIMEOUT, read_loop)
            .await
            .map_err(|_| "transcription timed out".to_string())?;
        let _ = write.send(Message::Close(None)).await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_le() {
        // 1 (0x0001) -> bytes 01 00 ; -1 (0xFFFF) -> FF FF
        let b64 = pcm16_to_base64(&[1, -1]);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(bytes, vec![0x01, 0x00, 0xFF, 0xFF]);
    }

    #[test]
    fn session_update_omits_language_when_auto() {
        let v = session_update(Some("auto"));
        let tr = &v["session"]["audio"]["input"]["transcription"];
        assert_eq!(tr["model"], json!(MODEL));
        assert_eq!(tr["delay"], json!(TRANSCRIPTION_DELAY));
        assert!(tr.get("language").is_none());
        assert!(v["session"]["audio"]["input"]["turn_detection"].is_null());
    }

    #[test]
    fn session_update_includes_language() {
        let v = session_update(Some("es"));
        assert_eq!(
            v["session"]["audio"]["input"]["transcription"]["language"],
            json!("es")
        );
    }

    #[test]
    fn realtime_whisper_session_disables_turn_detection() {
        let v = session_update(Some("en"));
        assert_eq!(
            v["session"]["audio"]["input"]["transcription"]["model"],
            json!(MODEL)
        );
        assert!(v["session"]["audio"]["input"]["turn_detection"].is_null());
    }

    #[test]
    fn manual_commit_detector_uses_1500ms_silence_window() {
        let mut detector = ManualCommitDetector::default();
        let speech = vec![i16::MAX / 4; 1200];
        let almost_silence_window = vec![0; MANUAL_COMMIT_SILENCE_SAMPLES - 1];
        let last_silent_sample = vec![0; 1];

        assert!(!detector.observe(&speech));
        assert!(!detector.observe(&almost_silence_window));
        assert!(detector.observe(&last_silent_sample));
    }

    /// Minimal WAV (PCM16) reader: find the `data` chunk and read i16 LE samples.
    fn read_wav_pcm16(path: &str) -> Vec<i16> {
        let bytes = std::fs::read(path).expect("read wav");
        let mut i = 12; // skip RIFF header
        while i + 8 <= bytes.len() {
            let id = &bytes[i..i + 4];
            let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]])
                as usize;
            if id == b"data" {
                let start = i + 8;
                let end = (start + size).min(bytes.len());
                return bytes[start..end]
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]))
                    .collect();
            }
            i += 8 + size + (size & 1);
        }
        panic!("no data chunk in {path}");
    }

    /// Live end-to-end check against the real API. Gated on env so it never runs
    /// in normal `cargo test`. Run with:
    ///   OPENAI_API_KEY=… VOXCTL_TEST_WAV=/tmp/x.wav \
    ///   cargo test --lib transcription::tests::live_transcribe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_transcribe() {
        let key = match std::env::var("OPENAI_API_KEY") {
            Ok(k) if !k.is_empty() => k,
            _ => {
                eprintln!("skip: OPENAI_API_KEY not set");
                return;
            }
        };
        let wav = std::env::var("VOXCTL_TEST_WAV").expect("set VOXCTL_TEST_WAV");
        let pcm16 = read_wav_pcm16(&wav);
        eprintln!(
            "loaded {} samples (~{:.1}s @24k)",
            pcm16.len(),
            pcm16.len() as f32 / 24000.0
        );

        let _ = rustls::crypto::ring::default_provider().install_default();
        let t = OpenAiRealtimeTranscriber::new(key);
        let on_delta = |s: String| eprintln!("  delta: {s}");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(t.transcribe(&pcm16, None, &on_delta));
        eprintln!("RESULT: {result:?}");
        assert!(result.is_ok(), "transcription failed: {result:?}");
        assert!(!result.unwrap().trim().is_empty(), "empty transcript");
    }
}

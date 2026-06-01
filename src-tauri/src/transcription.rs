//! Transcription layer. `Transcriber` is the swappable interface (so an
//! offline/local model can slot in later); `OpenAiRealtimeTranscriber` talks to
//! the OpenAI Realtime API over a rustls WebSocket from Rust — the API key never
//! leaves the backend.
//!
//! Product behavior is "transcribe on stop": we send the full 24 kHz mono PCM16
//! buffer as `input_audio_buffer.append` chunks, `commit`, then read the
//! streamed `...transcription.delta` events (surfaced as a live HUD preview) and
//! the final `...transcription.completed` transcript.
//!
//! NOTE: this is the highest-risk surface — the exact GA message shape can only
//! be confirmed against a live key (see MANUAL_TEST.md). Parsing is defensive.

use std::time::Duration;

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
/// ~0.67 s of 24 kHz audio per append message.
const APPEND_SAMPLES: usize = 16000;
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
    /// background task commits the buffer and reads to completion.
    pub async fn finish(self) -> Result<String, String> {
        drop(self.audio_tx);
        self.done_rx
            .await
            .unwrap_or_else(|_| Err("transcription task ended unexpectedly".into()))
    }
}

/// Background task owning the WebSocket for a live session: appends audio as it
/// streams in, commits when the audio channel closes, and reads to the final
/// transcript (with a post-commit timeout).
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

/// Interpret one inbound WS frame. Returns `Some(terminal result)` for a
/// completed/error/close frame, or `None` to keep reading (deltas, non-text
/// frames, unrelated events). `running` accumulates streamed deltas.
fn handle_frame(
    frame: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    running: &mut String,
    on_delta: &impl Fn(String),
) -> Option<Result<String, String>> {
    let f = match frame {
        Some(Ok(f)) => f,
        Some(Err(e)) => return Some(Err(format!("ws read: {e}"))),
        None => {
            return Some(if running.is_empty() {
                Err("connection closed before transcript".into())
            } else {
                Ok(running.clone())
            })
        }
    };
    if f.is_close() {
        return Some(if running.is_empty() {
            Err("connection closed before transcript".into())
        } else {
            Ok(running.clone())
        });
    }
    let txt = match f.to_text() {
        Ok(t) => t,
        Err(_) => return None,
    };
    let v = match serde_json::from_str::<Value>(txt) {
        Ok(v) => v,
        Err(_) => return None,
    };
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "conversation.item.input_audio_transcription.delta" => {
            if let Some(d) = v.get("delta").and_then(Value::as_str) {
                running.push_str(d);
                on_delta(running.clone());
            }
            None
        }
        "conversation.item.input_audio_transcription.completed" => {
            let text = v
                .get("transcript")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| running.clone());
            Some(Ok(text))
        }
        "error" => {
            let msg = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            Some(Err(format!("api error: {msg}")))
        }
        _ => None,
    }
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

    let mut running = String::new();

    // Phase 1: stream audio in as it's captured while reading deltas, until the
    // audio channel closes (end of recording) or the model finishes early.
    let early: Option<Result<String, String>> = loop {
        tokio::select! {
            maybe_chunk = audio_rx.recv() => {
                match maybe_chunk {
                    Some(chunk) if !chunk.is_empty() => {
                        let msg = json!({ "type": "input_audio_buffer.append", "audio": pcm16_to_base64(&chunk) });
                        if let Err(e) = write.send(Message::Text(msg.to_string())).await {
                            break Some(Err(format!("send audio: {e}")));
                        }
                    }
                    Some(_) => {}
                    None => break None,
                }
            }
            frame = read.next() => {
                if let Some(res) = handle_frame(frame, &mut running, on_delta) {
                    break Some(res);
                }
            }
        }
    };

    // Phase 2: commit and read to the final transcript (bounded by READ_TIMEOUT).
    let result = match early {
        Some(res) => res,
        None => {
            if let Err(e) = write
                .send(Message::Text(
                    json!({ "type": "input_audio_buffer.commit" }).to_string(),
                ))
                .await
            {
                Err(format!("send commit: {e}"))
            } else {
                let read_final = async {
                    loop {
                        if let Some(res) = handle_frame(read.next().await, &mut running, on_delta) {
                            return res;
                        }
                    }
                };
                timeout(READ_TIMEOUT, read_final).await.unwrap_or_else(|_| {
                    if running.is_empty() {
                        Err("transcription timed out".into())
                    } else {
                        Ok(running.clone())
                    }
                })
            }
        }
    };

    let _ = write.send(Message::Close(None)).await;
    result
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

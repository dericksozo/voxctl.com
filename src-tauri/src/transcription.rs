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
                json!({ "type": "input_audio_buffer.commit" })
                    .to_string(),
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

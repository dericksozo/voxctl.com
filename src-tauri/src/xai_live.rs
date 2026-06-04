//! xAI Grok streaming Speech-to-Text over WebSocket (`wss://api.x.ai/v1/stt`).
//!
//! Protocol (verified against docs.x.ai, June 2026):
//! - Auth: `Authorization: Bearer <key>` on the upgrade request.
//! - Config: URL query params only (sample_rate, encoding, interim_results,
//!   language, diarize, multichannel/channels, keyterm). No setup message.
//! - Client sends raw audio as BINARY frames: signed 16-bit little-endian PCM.
//! - Client sends `{"type":"audio.done"}` (text) to end audio → `transcript.done`.
//! - Server events: `transcript.created`, `transcript.partial` (with `text` +
//!   `is_final`), `transcript.done` (final `text`), `error` (`message`).
//!
//! We stream the same 24 kHz PCM16 the capture forwarder already produces and
//! tell the server `sample_rate=24000`, so no extra resampling is needed.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use crate::file_transcribe::TranscribeOptions;
use crate::transcription::RealtimeSession;

const BASE: &str = "wss://api.x.ai/v1/stt";
/// Matches the capture forwarder's output rate (resample::TARGET_RATE).
const SAMPLE_RATE: u32 = 24000;
const READ_TIMEOUT: Duration = Duration::from_secs(45);

/// Open a live xAI transcription session. Audio is pushed via the returned
/// session's `sender()`; the final transcript is awaited with `finish()`.
pub fn open_session<F>(key: String, opts: TranscribeOptions, on_delta: F) -> RealtimeSession
where
    F: Fn(String) + Send + Sync + 'static,
{
    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();
    let (done_tx, done_rx) = oneshot::channel::<Result<String, String>>();
    tauri::async_runtime::spawn(async move {
        let result = run_session(&key, &opts, audio_rx, &on_delta).await;
        let _ = done_tx.send(result);
    });
    RealtimeSession::from_parts(audio_tx, done_rx)
}

/// Percent-encode a query value (conservative: keep unreserved chars).
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn build_url(opts: &TranscribeOptions) -> String {
    let mut url = format!("{BASE}?sample_rate={SAMPLE_RATE}&encoding=pcm&interim_results=true");
    if let Some(l) = opts
        .language
        .as_deref()
        .filter(|l| !l.is_empty() && *l != "auto")
    {
        url.push_str(&format!("&language={}", enc(l)));
    }
    if opts.diarization {
        url.push_str("&diarize=true");
    }
    if opts.multichannel {
        url.push_str("&multichannel=true");
    }
    for kw in &opts.keywords {
        url.push_str(&format!("&keyterm={}", enc(kw)));
    }
    url
}

fn pcm16_le(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

/// Accumulates streamed events into the final transcript. The xAI stream emits
/// FULL per-segment text on each `transcript.partial`: interim ones (cumulative
/// within the current segment) are a live preview; `is_final` ones lock a
/// segment. The full transcript is the locked segments joined. The server emits
/// `is_final` twice per segment (speech_final false then true) with identical
/// text, so consecutive duplicate finals are dropped.
#[derive(Default)]
struct Accumulator {
    segments: Vec<String>,
    interim: String,
}

impl Accumulator {
    fn lock_segment(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if self.segments.last().map(String::as_str) != Some(text) {
            self.segments.push(text.to_string());
        }
    }

    fn partial(&mut self, text: &str, is_final: bool) {
        if is_final {
            self.lock_segment(text);
            self.interim.clear();
        } else {
            self.interim = text.trim().to_string();
        }
    }

    fn done(&mut self, text: &str) {
        // Usually empty (just a completion signal); add a tail if one is carried.
        self.lock_segment(text);
        self.interim.clear();
    }

    /// Locked segments plus any in-progress interim, space-joined.
    fn joined(&self) -> String {
        let mut parts: Vec<&str> = self.segments.iter().map(String::as_str).collect();
        if !self.interim.is_empty() {
            parts.push(self.interim.as_str());
        }
        parts.join(" ").trim().to_string()
    }

    fn preview(&self) -> String {
        self.joined()
    }

    fn final_text(&self) -> String {
        self.joined()
    }
}

enum Flow {
    Continue,
    Done,
    Closed,
}

fn handle_frame(
    frame: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    acc: &mut Accumulator,
    on_delta: &impl Fn(String),
) -> Result<Flow, String> {
    let msg = match frame {
        Some(Ok(m)) => m,
        Some(Err(e)) => return Err(format!("xai ws read: {e}")),
        None => return Ok(Flow::Closed),
    };
    if msg.is_close() {
        return Ok(Flow::Closed);
    }
    let Ok(txt) = msg.to_text() else {
        return Ok(Flow::Continue);
    };
    let Ok(v) = serde_json::from_str::<Value>(txt) else {
        return Ok(Flow::Continue);
    };
    if std::env::var("VOXCTL_WS_DEBUG").is_ok() {
        eprintln!("EVENT {txt}");
    }
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "transcript.partial" => {
            let text = v.get("text").and_then(Value::as_str).unwrap_or("");
            let is_final = v.get("is_final").and_then(Value::as_bool).unwrap_or(false);
            acc.partial(text, is_final);
            on_delta(acc.preview());
            Ok(Flow::Continue)
        }
        "transcript.done" => {
            let text = v.get("text").and_then(Value::as_str).unwrap_or("");
            acc.done(text);
            on_delta(acc.preview());
            Ok(Flow::Done)
        }
        "error" => {
            let m = v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            Err(format!("xai api error: {m}"))
        }
        _ => Ok(Flow::Continue),
    }
}

async fn run_session<F>(
    key: &str,
    opts: &TranscribeOptions,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<i16>>,
    on_delta: &F,
) -> Result<String, String>
where
    F: Fn(String) + Send + Sync + 'static,
{
    let mut req = build_url(opts)
        .into_client_request()
        .map_err(|e| format!("xai request build: {e}"))?;
    let auth = format!("Bearer {key}");
    req.headers_mut().insert(
        "authorization",
        auth.parse()
            .map_err(|_| "invalid auth header".to_string())?,
    );

    let (ws, _resp) = connect_async(req)
        .await
        .map_err(|e| format!("xai websocket connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();

    let mut acc = Accumulator::default();

    // Phase 1: stream audio frames as captured; read events concurrently.
    loop {
        tokio::select! {
            maybe = audio_rx.recv() => match maybe {
                Some(chunk) if !chunk.is_empty() => {
                    if let Err(e) = write.send(Message::Binary(pcm16_le(&chunk))).await {
                        return Err(format!("xai send audio: {e}"));
                    }
                }
                Some(_) => {}
                None => {
                    // Capture ended → signal end of audio, then drain.
                    write
                        .send(Message::Text(json!({ "type": "audio.done" }).to_string()))
                        .await
                        .map_err(|e| format!("xai send audio.done: {e}"))?;
                    break;
                }
            },
            frame = read.next() => {
                match handle_frame(frame, &mut acc, on_delta)? {
                    Flow::Done => {
                        let _ = write.send(Message::Close(None)).await;
                        return Ok(acc.final_text());
                    }
                    Flow::Closed => return Ok(acc.final_text()),
                    Flow::Continue => {}
                }
            }
        }
    }

    // Phase 2: read until the final transcript (or timeout).
    let drain = async {
        loop {
            match handle_frame(read.next().await, &mut acc, on_delta)? {
                Flow::Done | Flow::Closed => return Ok::<String, String>(acc.final_text()),
                Flow::Continue => {}
            }
        }
    };
    let result = timeout(READ_TIMEOUT, drain).await.unwrap_or_else(|_| {
        let t = acc.final_text();
        if t.is_empty() {
            Err("xai transcription timed out".into())
        } else {
            Ok(t)
        }
    });
    let _ = write.send(Message::Close(None)).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_includes_capability_params() {
        let opts = TranscribeOptions {
            language: Some("es".into()),
            keywords: vec!["VOXCTL".into(), "Tauri".into()],
            diarization: true,
            multichannel: false,
            ..Default::default()
        };
        let url = build_url(&opts);
        assert!(url.contains("sample_rate=24000"));
        assert!(url.contains("encoding=pcm"));
        assert!(url.contains("language=es"));
        assert!(url.contains("diarize=true"));
        assert!(url.contains("keyterm=VOXCTL"));
        assert!(url.contains("keyterm=Tauri"));
        assert!(!url.contains("multichannel"));
    }

    #[test]
    fn url_omits_auto_language() {
        let opts = TranscribeOptions {
            language: Some("auto".into()),
            ..Default::default()
        };
        assert!(!build_url(&opts).contains("language="));
    }

    #[test]
    fn interim_is_cumulative_preview_then_locks() {
        let mut a = Accumulator::default();
        a.partial("the quick", false); // interim (cumulative within segment)
        a.partial("the quick brown fox", false);
        assert_eq!(a.preview(), "the quick brown fox");
        a.partial("the quick brown fox.", true); // segment locked
        assert_eq!(a.final_text(), "the quick brown fox.");
    }

    #[test]
    fn duplicate_final_segment_is_dropped() {
        // The server emits is_final twice per segment (speech_final false→true).
        let mut a = Accumulator::default();
        a.partial("First sentence about apples.", true);
        a.partial("First sentence about apples.", true); // duplicate
        a.partial("Second sentence about oranges.", true);
        a.done(""); // empty completion signal
        assert_eq!(
            a.final_text(),
            "First sentence about apples. Second sentence about oranges."
        );
    }

    #[test]
    fn trailing_interim_kept_if_stream_ends_without_final() {
        let mut a = Accumulator::default();
        a.partial("locked one.", true);
        a.partial("unfinished tail", false);
        assert_eq!(a.final_text(), "locked one. unfinished tail");
    }

    /// Live streaming smoke test. Streams a WAV's PCM to the xAI WS and prints
    /// every event so the accumulation logic can be verified against reality.
    ///   VOXCTL_TEST_WAV=/tmp/x.wav VOXCTL_TEST_XAI_KEY=… \
    ///   cargo test --lib xai_live::tests::live_stream -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_stream() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let key = std::env::var("VOXCTL_TEST_XAI_KEY").expect("set VOXCTL_TEST_XAI_KEY");
        let wav = std::env::var("VOXCTL_TEST_WAV").expect("set VOXCTL_TEST_WAV");
        let pcm = read_wav_pcm16_24k(&wav);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (tx, rx) = mpsc::unbounded_channel::<Vec<i16>>();
        // Feed ~100 ms chunks to simulate live capture, then drop to end.
        for chunk in pcm.chunks(2400) {
            tx.send(chunk.to_vec()).unwrap();
        }
        drop(tx);
        let opts = TranscribeOptions::default();
        let on_delta = |s: String| eprintln!("  delta: {s}");
        let result = rt.block_on(run_session(&key, &opts, rx, &on_delta));
        eprintln!("FINAL: {result:?}");
        assert!(result.is_ok(), "xai live failed: {result:?}");
        assert!(!result.unwrap().trim().is_empty(), "empty transcript");
    }

    /// Minimal WAV (PCM16) reader: find the `data` chunk and read i16 LE samples.
    fn read_wav_pcm16_24k(path: &str) -> Vec<i16> {
        let bytes = std::fs::read(path).expect("read wav");
        let mut i = 12;
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
}

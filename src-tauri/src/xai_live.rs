//! xAI Grok streaming Speech-to-Text over WebSocket (`wss://api.x.ai/v1/stt`).
//!
//! Protocol (verified against docs.x.ai, June 2026):
//! - Auth: `Authorization: Bearer <key>` on the upgrade request.
//! - Config: URL query params only (sample_rate, encoding, language, diarize,
//!   multichannel/channels, keyterm). No setup message.
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

use crate::file_transcribe::{self, SpeakerSeg, TranscribeOptions, TranscriptOutput, WordStamp};
use crate::transcription::RealtimeSession;

const BASE: &str = "wss://api.x.ai/v1/stt";
/// Matches the capture forwarder's output rate (resample::TARGET_RATE).
const SAMPLE_RATE: u32 = 24000;
const FINAL_GRACE: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(45);

/// Open a live xAI transcription session. Audio is pushed via the returned
/// session's `sender()`; the final transcript is awaited with `finish()`.
pub fn open_session(key: String, opts: TranscribeOptions) -> RealtimeSession {
    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();
    let (done_tx, done_rx) = oneshot::channel::<Result<TranscriptOutput, String>>();
    tauri::async_runtime::spawn(async move {
        let result = run_session(&key, &opts, audio_rx).await;
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
    let mut url = format!("{BASE}?sample_rate={SAMPLE_RATE}&encoding=pcm");
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

/// Accumulates streamed events into the final transcript.
///
/// xAI finalizes in two overlapping layers (see docs.x.ai): rough "chunk final"
/// segments (`is_final=true, speech_final=false`) emitted ~every 3s while you
/// speak, then a single refined "utterance final" (`speech_final=true`) that
/// RE-TRANSCRIBES the whole utterance with proper formatting. Committing both
/// duplicates each utterance, so we commit ONLY on `speech_final=true` (the
/// refined version) and treat everything else as a live preview. If recording
/// stops before an utterance finalizes, the last preview is kept as the tail.
#[derive(Default)]
struct Accumulator {
    committed: Vec<String>,
    preview_tail: String,
    /// Best-effort structured extras (present only when diarize/word-timing data
    /// rides along on the events). Empty otherwise → no extra tabs.
    speakers: Vec<SpeakerSeg>,
    words: Vec<WordStamp>,
}

impl Accumulator {
    /// Observe a partial. `speech_final` segments are the refined utterance and
    /// are committed; chunk-finals and interims only update the live preview.
    /// Returns true when a new refined utterance was committed.
    fn observe(&mut self, text: &str, speech_final: bool) -> bool {
        let text = text.trim();
        if speech_final {
            let is_new =
                !text.is_empty() && self.committed.last().map(String::as_str) != Some(text);
            if is_new {
                self.committed.push(text.to_string());
            }
            self.preview_tail.clear();
            is_new
        } else {
            self.preview_tail = text.to_string();
            false
        }
    }

    /// Pull any speaker/word data off a just-committed `speech_final` event. Field
    /// names are best-effort (verify against the live API); absence is harmless.
    fn capture_structured(&mut self, ev: &Value) {
        let text = self.committed.last().cloned().unwrap_or_default();
        if let Some(speaker) = file_transcribe::speaker_field(ev) {
            self.speakers.push(SpeakerSeg {
                speaker,
                text,
                start: file_transcribe::num_field(ev, &["start", "start_time", "from"]),
                end: file_transcribe::num_field(ev, &["end", "end_time", "to"]),
            });
        }
        self.words.extend(file_transcribe::parse_words(ev));
    }

    fn done(&mut self, ev: &Value, text: &str) {
        // transcript.done is usually empty (a completion signal). If it ever
        // carries a tail, treat it as a final utterance; otherwise keep the
        // preview tail as a fallback for audio that stopped mid-utterance.
        if !text.trim().is_empty() && self.observe(text, true) {
            self.capture_structured(ev);
        }
    }

    /// Committed utterances plus any in-progress preview, space-joined.
    fn joined(&self) -> String {
        let mut parts: Vec<&str> = self.committed.iter().map(String::as_str).collect();
        if !self.preview_tail.is_empty() {
            parts.push(self.preview_tail.as_str());
        }
        parts.join(" ").trim().to_string()
    }

    #[cfg(test)]
    fn final_text(&self) -> String {
        self.joined()
    }

    fn final_output(&self) -> TranscriptOutput {
        let speakers = if self.speakers.is_empty() {
            file_transcribe::group_words_to_speakers(&self.words)
        } else {
            self.speakers.clone()
        };
        TranscriptOutput {
            text: self.joined(),
            words: self.words.clone(),
            speakers,
        }
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
            // Only `speech_final` segments are the refined utterance we keep;
            // chunk-finals (is_final=true, speech_final=false) are still rough
            // previews that the utterance-final supersedes.
            let speech_final = v
                .get("speech_final")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if acc.observe(text, speech_final) {
                acc.capture_structured(&v);
            }
            Ok(Flow::Continue)
        }
        "transcript.done" => {
            let text = v.get("text").and_then(Value::as_str).unwrap_or("");
            acc.done(&v, text);
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

async fn run_session(
    key: &str,
    opts: &TranscribeOptions,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<i16>>,
) -> Result<TranscriptOutput, String> {
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
                match handle_frame(frame, &mut acc)? {
                    Flow::Done => {
                        let _ = write.send(Message::Close(None)).await;
                        return Ok(acc.final_output());
                    }
                    Flow::Closed => return Ok(acc.final_output()),
                    Flow::Continue => {}
                }
            }
        }
    }

    // Phase 2: read until the final transcript. If xAI's final completion lags
    // but streamed text is already available, prefer delivering that transcript
    // after a short grace period over keeping the user in "processing".
    let grace = async {
        loop {
            match handle_frame(read.next().await, &mut acc)? {
                Flow::Done | Flow::Closed => {
                    return Ok::<TranscriptOutput, String>(acc.final_output())
                }
                Flow::Continue => {}
            }
        }
    };
    let result = match timeout(FINAL_GRACE, grace).await {
        Ok(result) => result,
        Err(_) => {
            let out = acc.final_output();
            if !out.text.is_empty() {
                log::info!("xai live using best-available transcript after grace timeout");
                Ok(out)
            } else {
                let drain = async {
                    loop {
                        match handle_frame(read.next().await, &mut acc)? {
                            Flow::Done | Flow::Closed => {
                                return Ok::<TranscriptOutput, String>(acc.final_output())
                            }
                            Flow::Continue => {}
                        }
                    }
                };
                timeout(READ_TIMEOUT, drain).await.unwrap_or_else(|_| {
                    let out = acc.final_output();
                    if out.text.is_empty() {
                        Err("xai transcription timed out".into())
                    } else {
                        Ok(out)
                    }
                })
            }
        }
    };
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
    fn only_speech_final_commits_refined_utterance() {
        // The rough chunk-final (speech_final=false) is a preview; only the
        // refined utterance-final (speech_final=true) is kept — so the two-pass
        // duplication never reaches the transcript.
        let mut a = Accumulator::default();
        a.observe("today i'm testing", false); // interim
        a.observe("today i'm testing vox control.", false); // chunk-final (rough) as preview
        assert_eq!(a.final_text(), "today i'm testing vox control."); // rough tail before any final
        a.observe("Today I'm testing VoxCTL.", true); // refined utterance final
        a.done(&json!({}), "");
        assert_eq!(a.final_text(), "Today I'm testing VoxCTL.");
    }

    #[test]
    fn multiple_utterances_concatenate() {
        let mut a = Accumulator::default();
        a.observe("first interim", false);
        a.observe("First utterance.", true);
        a.observe("second interim", false);
        a.observe("Second utterance.", true);
        assert_eq!(a.final_text(), "First utterance. Second utterance.");
    }

    #[test]
    fn duplicate_speech_final_is_dropped() {
        let mut a = Accumulator::default();
        a.observe("Hello there.", true);
        a.observe("Hello there.", true); // server repeats the utterance final
        assert_eq!(a.final_text(), "Hello there.");
    }

    #[test]
    fn trailing_preview_kept_without_speech_final() {
        // Recording stopped mid-utterance: keep the last preview as the tail.
        let mut a = Accumulator::default();
        a.observe("Committed one.", true);
        a.observe("unfinished tail", false);
        a.done(&json!({}), ""); // empty done must not drop the tail
        assert_eq!(a.final_text(), "Committed one. unfinished tail");
    }

    #[test]
    fn speaker_segments_are_derived_from_word_speakers() {
        let mut a = Accumulator::default();
        assert!(a.observe("Hello there. General Kenobi.", true));
        a.capture_structured(&json!({
            "words": [
                { "word": "Hello", "start": 0.0, "end": 0.2, "speaker": "0" },
                { "word": "there.", "start": 0.2, "end": 0.5, "speaker": "0" },
                { "word": "General", "start": 0.8, "end": 1.1, "speaker": "1" },
                { "word": "Kenobi.", "start": 1.1, "end": 1.5, "speaker": "1" }
            ]
        }));
        let out = a.final_output();
        assert_eq!(out.speakers.len(), 2);
        assert_eq!(out.speakers[0].speaker, "0");
        assert_eq!(out.speakers[0].text, "Hello there.");
        assert_eq!(out.speakers[1].speaker, "1");
        assert_eq!(out.speakers[1].text, "General Kenobi.");
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
        let opts = TranscribeOptions {
            diarization: true,
            word_timestamps: true,
            ..Default::default()
        };
        let result = rt.block_on(run_session(&key, &opts, rx));
        eprintln!("FINAL: {result:?}");
        assert!(result.is_ok(), "xai live failed: {result:?}");
        let out = result.unwrap();
        eprintln!(
            "  live: {} words, {} speaker segments",
            out.words.len(),
            out.speakers.len()
        );
        assert!(!out.text.trim().is_empty(), "empty transcript");
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

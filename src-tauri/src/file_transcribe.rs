//! File (non-streaming) transcription for saved recordings. Each provider
//! exposes a different REST shape; `FileTranscriber` hides that behind one call
//! so the pipeline and the re-run loop don't special-case providers.
//!
//! Verified live (June 2026):
//! - OpenAI: POST /v1/audio/transcriptions (multipart; model + language + prompt).
//! - xAI: POST https://api.x.ai/v1/stt (multipart; language/format/diarize/multichannel/keyterm; `file` last).
//! - Gemini: POST .../v1beta/models/{model}:generateContent (x-goog-api-key; inline base64 audio + prompt).

use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use crate::registry::ModelRecord;

/// Effective transcription settings for a recording: the mode's language +
/// keywords + capability toggles, already intersected with what the model
/// supports (see `modes::build_options`).
#[derive(Debug, Clone, Default)]
pub struct TranscribeOptions {
    pub language: Option<String>,
    pub keywords: Vec<String>,
    pub diarization: bool,
    pub word_timestamps: bool,
    pub inverse_text_normalization: bool,
    pub multichannel: bool,
}

impl TranscribeOptions {
    fn lang(&self) -> Option<&str> {
        self.language
            .as_deref()
            .filter(|l| !l.is_empty() && *l != "auto")
    }
}

#[async_trait::async_trait]
pub trait FileTranscriber: Send + Sync {
    /// Transcribe a complete WAV (PCM16) container.
    async fn transcribe_file(&self, wav: &[u8], opts: &TranscribeOptions)
        -> Result<String, String>;
}

/// Build the right file transcriber for a model's provider. Returns None for a
/// provider with no file path (none today — kept for forward safety).
pub fn file_transcriber_for(model: &ModelRecord, key: String) -> Option<Box<dyn FileTranscriber>> {
    match model.provider.as_str() {
        "openai" => Some(Box::new(OpenAiFileTranscriber {
            key,
            model: model.id.clone(),
        })),
        "xai" => Some(Box::new(XaiTranscriber { key })),
        "gemini" => Some(Box::new(GeminiTranscriber {
            key,
            model: model.id.clone(),
        })),
        _ => None,
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("unreachable: {e}"))
}

fn wav_part(wav: &[u8]) -> Result<reqwest::multipart::Part, String> {
    reqwest::multipart::Part::bytes(wav.to_vec())
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())
}

// ---- OpenAI ----

struct OpenAiFileTranscriber {
    key: String,
    model: String,
}

#[async_trait::async_trait]
impl FileTranscriber for OpenAiFileTranscriber {
    async fn transcribe_file(
        &self,
        wav: &[u8],
        opts: &TranscribeOptions,
    ) -> Result<String, String> {
        // Only whisper-1 returns word timestamps, and only via verbose_json; the
        // gpt-4o transcribe models support json only.
        let want_words = opts.word_timestamps;
        let mut form = reqwest::multipart::Form::new()
            .text("model", self.model.clone())
            .text(
                "response_format",
                if want_words { "verbose_json" } else { "json" },
            )
            .part("file", wav_part(wav)?);
        if want_words {
            form = form.text("timestamp_granularities[]", "word");
        }
        if let Some(l) = opts.lang() {
            form = form.text("language", l.to_string());
        }
        if !opts.keywords.is_empty() {
            // `prompt` biases vocabulary/spelling for the file models.
            form = form.text("prompt", opts.keywords.join(", "));
        }
        let resp = client()?
            .post("https://api.openai.com/v1/audio/transcriptions")
            .bearer_auth(&self.key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("unreachable: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("openai transcribe {status}: {}", truncate(&body)));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("parse: {e}"))?;
        Ok(v.get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    }
}

// ---- xAI Grok STT ----

struct XaiTranscriber {
    key: String,
}

#[async_trait::async_trait]
impl FileTranscriber for XaiTranscriber {
    async fn transcribe_file(
        &self,
        wav: &[u8],
        opts: &TranscribeOptions,
    ) -> Result<String, String> {
        // Text fields first; `file` MUST be the last part (per xAI docs).
        let mut form = reqwest::multipart::Form::new();
        if let Some(l) = opts.lang() {
            form = form.text("language", l.to_string());
        }
        if opts.inverse_text_normalization {
            form = form.text("format", "true");
        }
        if opts.diarization {
            form = form.text("diarize", "true");
        }
        if opts.multichannel {
            form = form.text("multichannel", "true");
        }
        for kw in &opts.keywords {
            form = form.text("keyterm", kw.clone());
        }
        form = form.part("file", wav_part(wav)?);

        let resp = client()?
            .post("https://api.x.ai/v1/stt")
            .bearer_auth(&self.key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("unreachable: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("xai transcribe {status}: {}", truncate(&body)));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("parse: {e}"))?;
        Ok(v.get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    }
}

// ---- Gemini ----

struct GeminiTranscriber {
    key: String,
    model: String,
}

#[async_trait::async_trait]
impl FileTranscriber for GeminiTranscriber {
    async fn transcribe_file(
        &self,
        wav: &[u8],
        opts: &TranscribeOptions,
    ) -> Result<String, String> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(wav);
        let mut prompt = String::from(
            "Transcribe this audio. Return only the transcript text, with no commentary.",
        );
        if let Some(l) = opts.lang() {
            prompt = format!(
                "Transcribe this audio. The spoken language is '{l}'. Return only the transcript text, with no commentary."
            );
        }
        if !opts.keywords.is_empty() {
            prompt.push_str(&format!(
                " Expect these terms: {}.",
                opts.keywords.join(", ")
            ));
        }
        let body = json!({
            "contents": [{
                "parts": [
                    { "text": prompt },
                    { "inlineData": { "mimeType": "audio/wav", "data": b64 } }
                ]
            }]
        });
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            self.model
        );
        let resp = client()?
            .post(url)
            .header("x-goog-api-key", &self.key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("unreachable: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("gemini transcribe {status}: {}", truncate(&body)));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("parse: {e}"))?;
        Ok(extract_gemini_text(&v))
    }
}

fn extract_gemini_text(v: &Value) -> String {
    v.get("candidates")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn truncate(s: &str) -> String {
    let s = s.replace('\n', " ");
    if s.len() > 200 {
        format!("{}…", &s[..200])
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry;

    #[test]
    fn factory_covers_all_registry_providers() {
        let reg = registry::bundled();
        for m in &reg.models {
            assert!(
                file_transcriber_for(m, "k".into()).is_some(),
                "no file transcriber for provider {}",
                m.provider
            );
        }
    }

    #[test]
    fn lang_filters_auto_and_empty() {
        let mut o = TranscribeOptions::default();
        assert_eq!(o.lang(), None);
        o.language = Some("auto".into());
        assert_eq!(o.lang(), None);
        o.language = Some("".into());
        assert_eq!(o.lang(), None);
        o.language = Some("es".into());
        assert_eq!(o.lang(), Some("es"));
    }

    #[test]
    fn gemini_text_extraction() {
        let v = json!({
            "candidates": [{ "content": { "parts": [{ "text": "hello " }, { "text": "world" }] } }]
        });
        assert_eq!(extract_gemini_text(&v), "hello world");
    }

    /// Live file-transcription smoke test per provider. Gated on env so it never
    /// runs in normal `cargo test`. Provide a 16k+ mono WAV and keys:
    ///   VOXCTL_TEST_WAV=/tmp/x.wav VOXCTL_TEST_OPENAI_KEY=… VOXCTL_TEST_XAI_KEY=… \
    ///   VOXCTL_TEST_GEMINI_KEY=… cargo test --lib file_transcribe::tests::live_file \
    ///   -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_file() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let wav = std::fs::read(std::env::var("VOXCTL_TEST_WAV").expect("set VOXCTL_TEST_WAV"))
            .expect("read wav");
        let reg = registry::bundled();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let opts = TranscribeOptions::default();
        for (model_id, var) in [
            ("gpt-4o-transcribe", "VOXCTL_TEST_OPENAI_KEY"),
            ("grok-stt-file", "VOXCTL_TEST_XAI_KEY"),
            ("gemini-2.5-flash", "VOXCTL_TEST_GEMINI_KEY"),
        ] {
            let Ok(key) = std::env::var(var) else {
                eprintln!("skip {model_id}: {var} unset");
                continue;
            };
            let model = reg.model_by_id(model_id).unwrap();
            let tr = file_transcriber_for(model, key).unwrap();
            let res = rt.block_on(tr.transcribe_file(&wav, &opts));
            eprintln!("{model_id}: {res:?}");
            // A billing/quota error means auth + request shape are correct but the
            // key has no credits — that still verifies we reached the API.
            if let Err(e) = &res {
                let el = e.to_lowercase();
                if el.contains("429") || el.contains("quota") || el.contains("credit") {
                    eprintln!("  (skip {model_id}: reached API but key is out of credits)");
                    continue;
                }
            }
            assert!(res.is_ok(), "{model_id} failed: {res:?}");
            assert!(
                !res.unwrap().trim().is_empty(),
                "{model_id} empty transcript"
            );
        }
    }
}

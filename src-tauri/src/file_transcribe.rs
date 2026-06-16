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
use serde::{Deserialize, Serialize};
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

    /// Whether to send xAI's ITN flag (`format=true`). It is only valid with an
    /// explicit language — xAI 400s ("Field 'language' is required when 'format'
    /// is true") otherwise — so a language-less mode skips ITN rather than fail.
    fn xai_send_itn(&self) -> bool {
        self.inverse_text_normalization && self.lang().is_some()
    }
}

/// One word with its timing (and speaker, when diarization is on). `speaker` is a
/// free-form label ("0", "SPEAKER_1", …) since providers differ.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordStamp {
    pub word: String,
    pub start: f64,
    pub end: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speaker: Option<String>,
}

/// A contiguous span attributed to one speaker (diarization output).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSeg {
    pub speaker: String,
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// A transcription result: always the plain `text`, plus optional structured data
/// (`words`, `speakers`) when the model/mode produced it. Both extra vecs are
/// empty for text-only providers/paths.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptOutput {
    pub text: String,
    #[serde(default)]
    pub words: Vec<WordStamp>,
    #[serde(default)]
    pub speakers: Vec<SpeakerSeg>,
}

impl TranscriptOutput {
    /// Plain-text only result (the common case).
    pub fn text_only(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Default::default()
        }
    }

    /// JSON `{ "words": …, "speakers": … }` for persistence, or None when there is
    /// no structured data to store.
    pub fn extra_json(&self) -> Option<String> {
        if self.words.is_empty() && self.speakers.is_empty() {
            return None;
        }
        serde_json::to_string(&json!({ "words": self.words, "speakers": self.speakers })).ok()
    }
}

#[async_trait::async_trait]
pub trait FileTranscriber: Send + Sync {
    /// Transcribe a complete WAV (PCM16) container. Takes ownership of the bytes so
    /// the multipart part can move them in without an extra copy (§2.2).
    async fn transcribe_file(
        &self,
        wav: Vec<u8>,
        opts: &TranscribeOptions,
    ) -> Result<TranscriptOutput, String>;
}

// ---- Shared defensive parsing of provider word/speaker JSON ----
// Field names differ between providers (and may change), so every accessor tries
// a few plausible keys and tolerates absence. If nothing matches, the relevant
// tab simply won't appear in the UI.

pub(crate) fn num_field(v: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(n) = v.get(*k).and_then(Value::as_f64) {
            return n;
        }
    }
    0.0
}

pub(crate) fn speaker_field(v: &Value) -> Option<String> {
    for k in ["speaker", "speaker_id", "speaker_label", "channel"] {
        if let Some(val) = v.get(k) {
            if let Some(s) = val.as_str() {
                return Some(s.to_string());
            }
            if let Some(n) = val.as_i64() {
                return Some(n.to_string());
            }
        }
    }
    None
}

fn parse_word(w: &Value) -> Option<WordStamp> {
    let word = w
        .get("word")
        .or_else(|| w.get("text"))
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if word.is_empty() {
        return None;
    }
    Some(WordStamp {
        word,
        start: num_field(w, &["start", "start_time", "from"]),
        end: num_field(w, &["end", "end_time", "to"]),
        speaker: speaker_field(w),
    })
}

/// Word stamps from a top-level `words` array, or gathered from `segments[].words`
/// (inheriting each segment's speaker when a word lacks its own).
pub(crate) fn parse_words(v: &Value) -> Vec<WordStamp> {
    if let Some(ws) = v.get("words").and_then(Value::as_array) {
        return ws.iter().filter_map(parse_word).collect();
    }
    let Some(segs) = v.get("segments").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for s in segs {
        let seg_spk = speaker_field(s);
        if let Some(ws) = s.get("words").and_then(Value::as_array) {
            for w in ws {
                if let Some(mut stamp) = parse_word(w) {
                    if stamp.speaker.is_none() {
                        stamp.speaker = seg_spk.clone();
                    }
                    out.push(stamp);
                }
            }
        }
    }
    out
}

/// Speaker segments from a `segments` array (each `{ speaker, text, start, end }`).
fn parse_segment_speakers(v: &Value) -> Vec<SpeakerSeg> {
    let Some(segs) = v.get("segments").and_then(Value::as_array) else {
        return Vec::new();
    };
    segs.iter()
        .filter_map(|s| {
            let speaker = speaker_field(s)?;
            let text = s.get("text").and_then(Value::as_str).unwrap_or("").trim();
            if text.is_empty() {
                return None;
            }
            Some(SpeakerSeg {
                speaker,
                text: text.to_string(),
                start: num_field(s, &["start", "start_time", "from"]),
                end: num_field(s, &["end", "end_time", "to"]),
            })
        })
        .collect()
}

/// Build speaker segments by merging runs of consecutive same-speaker words — the
/// fallback when a provider gives per-word speakers but no segment list.
pub(crate) fn group_words_to_speakers(words: &[WordStamp]) -> Vec<SpeakerSeg> {
    let mut out: Vec<SpeakerSeg> = Vec::new();
    for w in words {
        let Some(spk) = &w.speaker else { continue };
        match out.last_mut() {
            Some(last) if &last.speaker == spk => {
                if should_insert_space_between_tokens(&last.text, &w.word) {
                    last.text.push(' ');
                }
                last.text.push_str(&w.word);
                last.end = w.end;
            }
            _ => out.push(SpeakerSeg {
                speaker: spk.clone(),
                text: w.word.clone(),
                start: w.start,
                end: w.end,
            }),
        }
    }
    out
}

fn should_insert_space_between_tokens(current: &str, next: &str) -> bool {
    let Some(prev) = current.trim_end().chars().next_back() else {
        return false;
    };
    let Some(next) = next.trim_start().chars().next() else {
        return false;
    };
    if is_unspaced_script(prev) && is_unspaced_script(next) {
        return false;
    }
    if is_no_space_before(next) || is_no_space_after(prev) {
        return false;
    }
    true
}

fn is_unspaced_script(c: char) -> bool {
    matches!(
        c as u32,
        0x3040..=0x309f // Hiragana
            | 0x30a0..=0x30ff // Katakana
            | 0x3400..=0x4dbf // CJK Extension A
            | 0x4e00..=0x9fff // CJK Unified Ideographs
            | 0xac00..=0xd7af // Hangul syllables
    )
}

fn is_no_space_before(c: char) -> bool {
    matches!(
        c,
        '.' | ','
            | '!'
            | '?'
            | ':'
            | ';'
            | ')'
            | ']'
            | '}'
            | '、'
            | '。'
            | '，'
            | '．'
            | '！'
            | '？'
            | '：'
            | '；'
            | '）'
            | '］'
            | '｝'
            | '」'
            | '』'
    )
}

fn is_no_space_after(c: char) -> bool {
    matches!(c, '(' | '[' | '{' | '（' | '［' | '｛' | '「' | '『')
}

/// Words + speakers from a provider response: segment speakers when present, else
/// derived from per-word speakers.
fn parse_structured(v: &Value) -> (Vec<WordStamp>, Vec<SpeakerSeg>) {
    let words = parse_words(v);
    let mut speakers = parse_segment_speakers(v);
    if speakers.is_empty() {
        speakers = group_words_to_speakers(&words);
    }
    (words, speakers)
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

fn wav_part(wav: Vec<u8>) -> Result<reqwest::multipart::Part, String> {
    // Part::bytes takes ownership (Cow::Owned) — same wire format as before, but no
    // to_vec() copy of the (up to ~170MB) WAV (§2.2).
    reqwest::multipart::Part::bytes(wav)
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
        wav: Vec<u8>,
        opts: &TranscribeOptions,
    ) -> Result<TranscriptOutput, String> {
        // gpt-4o-transcribe-diarize is a separate request shape: it returns speaker
        // labels via `diarized_json`, requires `chunking_strategy`, and rejects
        // `prompt` / `timestamp_granularities[]`.
        let diarize = self.model == "gpt-4o-transcribe-diarize";
        // Only whisper-1 returns word timestamps, and only via verbose_json; the
        // gpt-4o transcribe models support json only.
        let want_words = opts.word_timestamps && !diarize;
        let response_format = if diarize {
            "diarized_json"
        } else if want_words {
            "verbose_json"
        } else {
            "json"
        };
        let mut form = reqwest::multipart::Form::new()
            .text("model", self.model.clone())
            .text("response_format", response_format)
            .part("file", wav_part(wav)?);
        if diarize {
            // Required by the diarize model (audio > 30s); "auto" lets OpenAI chunk.
            form = form.text("chunking_strategy", "auto");
        }
        if want_words {
            form = form.text("timestamp_granularities[]", "word");
        }
        if let Some(l) = opts.lang() {
            form = form.text("language", l.to_string());
        }
        if !diarize && !opts.keywords.is_empty() {
            // `prompt` biases vocabulary/spelling for the file models (not diarize).
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
        let mut text = v
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // diarize returns speaker segments; whisper-1 returns word timestamps via
        // verbose_json. Everything else is text-only.
        let (words, speakers) = if diarize {
            parse_structured(&v)
        } else if want_words {
            (parse_words(&v), Vec::new())
        } else {
            (Vec::new(), Vec::new())
        };
        // `diarized_json` may omit a top-level `text`; rebuild the flat transcript
        // from the speaker segments so delivery (paste/clipboard) still works.
        if diarize && text.trim().is_empty() {
            text = speakers
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
        }
        Ok(TranscriptOutput {
            text,
            words,
            speakers,
        })
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
        wav: Vec<u8>,
        opts: &TranscribeOptions,
    ) -> Result<TranscriptOutput, String> {
        // Text fields first; `file` MUST be the last part (per xAI docs).
        let mut form = reqwest::multipart::Form::new();
        if let Some(l) = opts.lang() {
            form = form.text("language", l.to_string());
        }
        // The mode editor enforces a language when ITN is on; this guard ensures a
        // language-less request degrades (skips ITN) instead of failing outright.
        if opts.xai_send_itn() {
            form = form.text("format", "true");
        }
        if opts.diarization {
            form = form.text("diarize", "true");
        }
        if opts.multichannel {
            form = form.text("multichannel", "true");
        }
        // Ask for word-level timing when the mode wants it. Param name is
        // best-effort (verify against the live API); the parser tolerates either
        // a `words` array or `segments[].words`, so an unknown shape is harmless.
        if opts.word_timestamps {
            form = form.text("timestamp_granularities", "word");
        }
        if !opts.keywords.is_empty() {
            let kw = opts.keywords.join(" ");
            eprintln!("xai file keyterm: {kw}");
            form = form.text("keyterm", kw);
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
        let text = v
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (words, speakers) = parse_structured(&v);
        Ok(TranscriptOutput {
            text,
            // Only surface what the mode asked for, even if the API returns more.
            words: if opts.word_timestamps {
                words
            } else {
                Vec::new()
            },
            speakers: if opts.diarization {
                speakers
            } else {
                Vec::new()
            },
        })
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
        wav: Vec<u8>,
        opts: &TranscribeOptions,
    ) -> Result<TranscriptOutput, String> {
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
        Ok(TranscriptOutput::text_only(extract_gemini_text(&v)))
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
    fn xai_itn_requires_a_language() {
        let mut o = TranscribeOptions {
            inverse_text_normalization: true,
            ..Default::default()
        };
        // ITN on but language auto/none → don't send `format` (would 400).
        assert!(!o.xai_send_itn());
        o.language = Some("auto".into());
        assert!(!o.xai_send_itn());
        // ITN on with an explicit language → send `format`.
        o.language = Some("ja".into());
        assert!(o.xai_send_itn());
        // ITN off → never send, regardless of language.
        o.inverse_text_normalization = false;
        assert!(!o.xai_send_itn());
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

    #[test]
    fn parse_words_from_top_level_array() {
        let v = json!({
            "text": "hello world",
            "words": [
                { "word": "hello", "start": 0.0, "end": 0.4 },
                { "word": "world", "start": 0.4, "end": 0.9, "speaker": 1 }
            ]
        });
        let (words, _) = parse_structured(&v);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "hello");
        assert_eq!(words[1].speaker.as_deref(), Some("1"));
    }

    #[test]
    fn parse_speakers_from_segments() {
        let v = json!({
            "text": "hi there",
            "segments": [
                { "speaker": "0", "text": "hi", "start": 0.0, "end": 0.5 },
                { "speaker": "1", "text": "there", "start": 0.6, "end": 1.0 }
            ]
        });
        let (_, speakers) = parse_structured(&v);
        assert_eq!(speakers.len(), 2);
        assert_eq!(speakers[0].speaker, "0");
        assert_eq!(speakers[1].text, "there");
    }

    #[test]
    fn speakers_grouped_from_per_word_speaker() {
        // No segment list, but words carry speakers → merge consecutive runs.
        let v = json!({
            "words": [
                { "word": "one", "start": 0.0, "end": 0.2, "speaker": "A" },
                { "word": "two", "start": 0.2, "end": 0.4, "speaker": "A" },
                { "word": "three", "start": 0.4, "end": 0.6, "speaker": "B" }
            ]
        });
        let (_, speakers) = parse_structured(&v);
        assert_eq!(speakers.len(), 2);
        assert_eq!(speakers[0].speaker, "A");
        assert_eq!(speakers[0].text, "one two");
        assert_eq!(speakers[1].text, "three");
    }

    #[test]
    fn speakers_group_japanese_without_artificial_spaces() {
        let v = json!({
            "words": [
                { "word": "じ", "start": 0.0, "end": 0.1, "speaker": "0" },
                { "word": "ゃ", "start": 0.1, "end": 0.2, "speaker": "0" },
                { "word": "あ", "start": 0.2, "end": 0.3, "speaker": "0" },
                { "word": "今", "start": 0.3, "end": 0.4, "speaker": "0" },
                { "word": "日", "start": 0.4, "end": 0.5, "speaker": "0" },
                { "word": "本", "start": 0.5, "end": 0.6, "speaker": "0" },
                { "word": "語", "start": 0.6, "end": 0.7, "speaker": "0" },
                { "word": "hello", "start": 1.0, "end": 1.2, "speaker": "0" }
            ]
        });
        let (_, speakers) = parse_structured(&v);
        assert_eq!(speakers.len(), 1);
        assert_eq!(speakers[0].text, "じゃあ今日本語 hello");
    }

    #[test]
    fn extra_json_roundtrips_and_is_none_when_empty() {
        assert!(TranscriptOutput::text_only("hi").extra_json().is_none());
        let out = TranscriptOutput {
            text: "hi".into(),
            words: vec![WordStamp {
                word: "hi".into(),
                start: 0.0,
                end: 0.3,
                speaker: None,
            }],
            speakers: vec![],
        };
        let json = out.extra_json().expect("some json");
        assert!(json.contains("\"words\""));
        assert!(json.contains("\"hi\""));
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
            // Ask for the structured extras so the live dump reveals each provider's
            // word/speaker JSON shape (used to confirm the defensive parser).
            let opts = TranscribeOptions {
                word_timestamps: true,
                diarization: true,
                ..opts.clone()
            };
            let res = rt.block_on(tr.transcribe_file(wav.clone(), &opts));
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
            let out = res.unwrap();
            eprintln!(
                "  {model_id}: {} words, {} speaker segments",
                out.words.len(),
                out.speakers.len()
            );
            assert!(!out.text.trim().is_empty(), "{model_id} empty transcript");
        }
    }
}

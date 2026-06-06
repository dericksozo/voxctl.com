//! Event names + payloads emitted to the webview. Mirrors `src/lib/events.ts`.
//! Some names/payloads are consumed in later slices.
#![allow(dead_code)]

use serde::Serialize;

pub const MIC_LEVEL: &str = "voxctl:mic-level";
pub const REC_STATE: &str = "voxctl:rec-state";
pub const TRANSCRIPT_FINAL: &str = "voxctl:transcript-final";
pub const MODE_CHANGED: &str = "voxctl:mode-changed";
pub const HISTORY_CHANGED: &str = "voxctl:history-changed";
pub const ERROR: &str = "voxctl:error";

#[derive(Clone, Serialize)]
pub struct MicLevel {
    /// Normalized 0..1 level (from RMS dBFS) for the meters.
    pub db: f32,
    pub peak: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecState {
    pub recording: bool,
    pub language: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct TranscriptText {
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct ModeChanged {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct BackendError {
    pub stage: String,
    pub message: String,
}

#[allow(dead_code)]
impl BackendError {
    pub fn new(stage: &str, message: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            message: message.into(),
        }
    }
}

//! Provider/model registry — the structural spine the whole app reads from.
//!
//! One record describes every transcription model; the only thing that differs
//! is what each model can do (`can_live` / `can_file`) plus optional capability
//! flags the Mode editor surfaces as toggles. The registry is bundled with the
//! app (offline fallback, source of truth today) and can be overridden by a
//! remote copy fetched at runtime so models/pricing/capabilities can change
//! without an app update. See `registry.json`.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::config::STORE_FILE;

/// The bundled registry, compiled into the binary so the app is never dead on
/// first launch or without network.
const BUNDLED: &str = include_str!("../registry.json");

/// Store key holding a remote-fetched registry that overrides the bundled copy.
const CACHE_KEY: &str = "registryCache";

/// Remote source of truth. May 404 today (bundled copy is authoritative); the
/// fetch is best-effort and silently falls back to bundled on any failure.
const REMOTE_URL: &str = "https://registry.voxctl.com/registry.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    pub providers: Vec<ProviderRecord>,
    pub models: Vec<ModelRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    pub label: String,
    /// macOS Keychain account the provider's key is stored under.
    pub keychain_account: String,
    pub docs_url: String,
    /// Model auto-selected when this is the first key the user adds.
    pub default_model_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    #[serde(default)]
    pub word_timestamps: bool,
    #[serde(default)]
    pub diarization: bool,
    #[serde(default)]
    pub inverse_text_normalization: bool,
    #[serde(default)]
    pub multichannel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecord {
    pub id: String,
    pub provider: String,
    pub label: String,
    /// Can transcribe a live audio stream (dictation).
    pub can_live: bool,
    /// Can transcribe a saved audio file (re-run / transcribe-on-stop).
    pub can_file: bool,
    pub cost_rate: f64,
    /// "perMin" | "perHour" | "perToken".
    pub cost_unit: String,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub languages: Vec<String>,
}

// Accessors consumed by the Mode picker, transcription factory, and cost
// estimator in later steps (and by the tests below).
#[allow(dead_code)]
impl Registry {
    pub fn model_by_id(&self, id: &str) -> Option<&ModelRecord> {
        self.models.iter().find(|m| m.id == id)
    }

    pub fn provider_by_id(&self, id: &str) -> Option<&ProviderRecord> {
        self.providers.iter().find(|p| p.id == id)
    }

    /// The provider's default model id (used by onboarding auto-select / the
    /// Default Mode), falling back to the first model the provider offers.
    pub fn default_model_for(&self, provider: &str) -> Option<String> {
        let from_provider = self
            .provider_by_id(provider)
            .map(|p| p.default_model_id.clone());
        from_provider
            .filter(|id| self.model_by_id(id).is_some())
            .or_else(|| {
                self.models
                    .iter()
                    .find(|m| m.provider == provider)
                    .map(|m| m.id.clone())
            })
    }
}

/// Parse the bundled registry. It ships with the app and is covered by a test,
/// so a parse failure is a build-time bug, not a runtime condition.
pub fn bundled() -> Registry {
    serde_json::from_str(BUNDLED).expect("bundled registry.json must be valid")
}

/// A remote-fetched copy cached in the store, if present and parseable.
fn cached(app: &AppHandle) -> Option<Registry> {
    let store = app.store(STORE_FILE).ok()?;
    let v = store.get(CACHE_KEY)?;
    serde_json::from_value(v).ok()
}

/// The effective registry the rest of the app reads: a cached remote copy when
/// available, otherwise the bundled fallback.
pub fn effective(app: &AppHandle) -> Registry {
    cached(app).unwrap_or_else(bundled)
}

/// Persist a fetched registry as the cached override.
pub fn cache(app: &AppHandle, reg: &Registry) {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Ok(v) = serde_json::to_value(reg) {
            store.set(CACHE_KEY, v);
            let _ = store.save();
        }
    }
}

/// Best-effort remote fetch. Any failure is returned to the caller, which keeps
/// the effective (bundled/cached) registry instead.
pub async fn fetch_remote() -> Result<Registry, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(REMOTE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("registry fetch status {}", resp.status()));
    }
    resp.json::<Registry>().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_parses() {
        let reg = bundled();
        assert_eq!(reg.version, 1);
        assert_eq!(reg.providers.len(), 3);
        assert!(reg.models.len() >= 6);
    }

    #[test]
    fn every_model_belongs_to_a_known_provider() {
        let reg = bundled();
        for m in &reg.models {
            assert!(
                reg.provider_by_id(&m.provider).is_some(),
                "model {} references unknown provider {}",
                m.id,
                m.provider
            );
            // A model must be usable in at least one direction.
            assert!(m.can_live || m.can_file, "model {} is neither", m.id);
        }
    }

    #[test]
    fn provider_defaults_resolve_to_real_models() {
        let reg = bundled();
        for p in &reg.providers {
            let def = reg
                .default_model_for(&p.id)
                .expect("provider has a default");
            assert!(reg.model_by_id(&def).is_some());
        }
    }

    #[test]
    fn capabilities_surface_as_expected() {
        let reg = bundled();
        // whisper-1 declares word timestamps only.
        let w = reg.model_by_id("whisper-1").unwrap();
        assert!(w.capabilities.word_timestamps);
        assert!(!w.capabilities.diarization);
        // grok-stt declares the full set and does both live + file.
        let g = reg.model_by_id("grok-stt").unwrap();
        assert!(g.can_live && g.can_file);
        assert!(
            g.capabilities.diarization
                && g.capabilities.multichannel
                && g.capabilities.inverse_text_normalization
                && g.capabilities.word_timestamps
        );
        // gpt-4o-transcribe declares none.
        let t = reg.model_by_id("gpt-4o-transcribe").unwrap();
        assert!(
            !t.capabilities.word_timestamps
                && !t.capabilities.diarization
                && !t.capabilities.multichannel
        );
        // realtime whisper is live-only.
        let r = reg.model_by_id("gpt-realtime-whisper").unwrap();
        assert!(r.can_live && !r.can_file);
    }
}

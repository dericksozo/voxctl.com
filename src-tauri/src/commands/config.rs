//! Non-secret settings (read from the shared tauri-plugin-store file) plus the
//! OpenAI API key, which is kept ONLY in the macOS Keychain — never in plaintext
//! config and never handed to the webview.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "settings.json";
const KEYRING_SERVICE: &str = "com.derick.voxctlcom";
/// Pre-multi-provider OpenAI key account, migrated to `voxctl.openai` on launch.
const LEGACY_OPENAI_USER: &str = "openai_api_key";
/// Providers VOXCTL stores keys for. Mirrors the registry's `keychainAccount`
/// values (`voxctl.<id>`); kept here so key storage never depends on the
/// registry being loadable.
const PROVIDERS: [&str; 3] = ["openai", "xai", "gemini"];

/// Mirrors the TypeScript `Config` (serde camelCase). Single source of truth
/// lives in `settings.json`; Rust reads it on demand.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub capture_mode: String,
    pub shortcut: String,
    pub sfx_enabled: bool,
    pub copy_to_clipboard: bool,
    pub notify_on_mode_switch: bool,
    pub app_locale: String,
    pub default_language: Option<String>,
    /// What `×` removes from a recording: "both" (row + WAV) or "transcript"
    /// (row only, keep the WAV on disk). Defaulted for configs saved earlier.
    #[serde(default = "default_delete_behavior")]
    pub delete_behavior: String,
    /// First-run onboarding is complete once mic/key/first recording are done.
    #[serde(default)]
    pub onboarding_completed: bool,
    /// User skipped the optional Accessibility step during onboarding.
    #[serde(default)]
    pub accessibility_skipped: bool,
}

fn default_delete_behavior() -> String {
    "both".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            capture_mode: "toggle".into(),
            shortcut: "Alt+Space".into(),
            sfx_enabled: true,
            copy_to_clipboard: false,
            notify_on_mode_switch: false,
            app_locale: "en".into(),
            default_language: None,
            delete_behavior: default_delete_behavior(),
            onboarding_completed: false,
            accessibility_skipped: false,
        }
    }
}

/// Read the current config from the shared store, falling back to defaults.
pub fn load_config(app: &AppHandle) -> Config {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get("config") {
            if let Ok(cfg) = serde_json::from_value::<Config>(v) {
                return cfg;
            }
        }
    }
    Config::default()
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> Config {
    load_config(&app)
}

/// JS calls this after writing settings so the backend can re-read. Re-applies
/// the global shortcut (the accelerator / capture mode may have changed).
#[tauri::command]
pub fn reload_config(app: AppHandle) {
    crate::shortcut::apply_shortcut(&app);
}

/// Keychain account a provider's key lives under (`voxctl.<provider>`).
fn account(provider: &str) -> Result<String, String> {
    if PROVIDERS.contains(&provider) {
        Ok(format!("voxctl.{provider}"))
    } else {
        Err(format!("unknown provider: {provider}"))
    }
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &account(provider)?).map_err(|e| e.to_string())
}

/// True when a (previously validated) key is stored for the provider. Because we
/// only ever store validated keys, "present" is equivalent to "validated".
fn key_present(provider: &str) -> bool {
    entry(provider)
        .and_then(|e| e.get_password().map_err(|x| x.to_string()))
        .is_ok()
}

#[tauri::command]
pub fn has_api_key(provider: String) -> bool {
    key_present(&provider)
}

/// Per-provider key status for the UI: "validated" (green) when a key is stored,
/// "none" otherwise. Invalid keys are rejected at entry and never stored, so
/// "invalid (red)" is surfaced transiently from the `set_api_key` error rather
/// than as a persistent state here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub openai: String,
    pub xai: String,
    pub gemini: String,
}

#[tauri::command]
pub fn provider_status() -> ProviderStatus {
    let s = |p: &str| {
        if key_present(p) {
            "validated".to_string()
        } else {
            "none".to_string()
        }
    };
    ProviderStatus {
        openai: s("openai"),
        xai: s("xai"),
        gemini: s("gemini"),
    }
}

/// How a provider authenticates its zero-cost validation request.
enum Auth {
    /// `Authorization: Bearer <key>` (OpenAI, xAI).
    Bearer,
    /// `x-goog-api-key: <key>` (Gemini — the `AQ.`/`AIza` key formats).
    GoogleKey,
}

/// Zero-cost validation: a cheap metadata/models-list GET. 2xx => valid;
/// 400/401/403 => "invalid" (the request is a fixed well-formed GET, so a
/// rejection is the key — Google notably returns 400 `API_KEY_INVALID`);
/// anything else/network => "unreachable".
async fn check_key(url: &str, auth: Auth, key: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("unreachable: {e}"))?;
    let req = match auth {
        Auth::Bearer => client.get(url).bearer_auth(key),
        Auth::GoogleKey => client.get(url).header("x-goog-api-key", key),
    };
    let resp = req.send().await.map_err(|e| format!("unreachable: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else if matches!(status.as_u16(), 400 | 401 | 403) {
        Err("invalid".into())
    } else {
        Err(format!("unreachable: unexpected status {status}"))
    }
}

/// Validate a key against the right provider using a free endpoint.
async fn validate(provider: &str, key: &str) -> Result<(), String> {
    match provider {
        "openai" => check_key("https://api.openai.com/v1/models", Auth::Bearer, key).await,
        "xai" => check_key("https://api.x.ai/v1/models", Auth::Bearer, key).await,
        "gemini" => {
            check_key(
                "https://generativelanguage.googleapis.com/v1beta/models",
                Auth::GoogleKey,
                key,
            )
            .await
        }
        _ => Err(format!("unknown provider: {provider}")),
    }
}

/// Remove a provider's stored key, treating "no key present" as success.
fn clear_key(provider: &str) {
    if let Ok(en) = entry(provider) {
        match en.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("failed clearing {provider} key: {e}"),
        }
    }
}

/// Validate the key against its provider, then store it in the Keychain ONLY if
/// valid (per product decision: reject invalid keys rather than storing them).
///
/// A *definitively invalid* key (401/403/400) also clears any previously stored
/// key for that provider, so the UI never keeps showing "validated" for a key
/// the user just replaced with a bad one. Transient "unreachable" failures
/// leave the existing key untouched.
#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("empty key".into());
    }
    if let Err(e) = validate(&provider, &key).await {
        if e == "invalid" {
            clear_key(&provider);
        }
        return Err(e);
    }
    entry(&provider)?
        .set_password(&key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    account(&provider)?; // reject unknown providers
    clear_key(&provider);
    Ok(())
}

/// Internal accessor for the transcription layer. Stays in Rust.
pub fn get_api_key(provider: &str) -> Option<String> {
    entry(provider).ok().and_then(|e| e.get_password().ok())
}

/// One-time migration of the pre-multi-provider OpenAI key (keychain user
/// `openai_api_key`) into the new per-provider account `voxctl.openai`. No-op
/// when the new account already has a key or the legacy one is absent.
pub fn migrate_legacy_openai_key() {
    let Ok(new_entry) = entry("openai") else {
        return;
    };
    if new_entry.get_password().is_ok() {
        return;
    }
    let Ok(legacy) = keyring::Entry::new(KEYRING_SERVICE, LEGACY_OPENAI_USER) else {
        return;
    };
    if let Ok(key) = legacy.get_password() {
        if new_entry.set_password(&key).is_ok() {
            let _ = legacy.delete_credential();
            log::info!("migrated legacy OpenAI key to voxctl.openai");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_names_are_namespaced_per_provider() {
        assert_eq!(account("openai").unwrap(), "voxctl.openai");
        assert_eq!(account("xai").unwrap(), "voxctl.xai");
        assert_eq!(account("gemini").unwrap(), "voxctl.gemini");
    }

    #[test]
    fn unknown_provider_is_rejected() {
        assert!(account("anthropic").is_err());
        assert!(entry("nope").is_err());
    }

    /// Live check that each provider's free validation endpoint accepts a real
    /// key. Gated on env so it never runs in normal `cargo test`. Run with:
    ///   VOXCTL_TEST_OPENAI_KEY=… VOXCTL_TEST_XAI_KEY=… VOXCTL_TEST_GEMINI_KEY=… \
    ///   cargo test --lib commands::config::tests::live_validate -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_validate() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (provider, var) in [
            ("openai", "VOXCTL_TEST_OPENAI_KEY"),
            ("xai", "VOXCTL_TEST_XAI_KEY"),
            ("gemini", "VOXCTL_TEST_GEMINI_KEY"),
        ] {
            match std::env::var(var) {
                Ok(key) if !key.is_empty() => {
                    let r = rt.block_on(validate(provider, &key));
                    eprintln!("{provider}: {r:?}");
                    assert!(r.is_ok(), "{provider} validation failed: {r:?}");
                    // A deliberately broken key must be rejected as invalid.
                    let bad = rt.block_on(validate(provider, "definitely-not-a-real-key"));
                    eprintln!("{provider} (bad key): {bad:?}");
                    assert_eq!(bad.err().as_deref(), Some("invalid"));
                }
                _ => eprintln!("skip {provider}: {var} not set"),
            }
        }
    }
}

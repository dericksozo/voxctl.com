//! Non-secret settings (read from the shared tauri-plugin-store file) plus the
//! provider API keys, which are kept ONLY in the macOS Keychain — never in plaintext
//! config and never handed to the webview.
//!
//! Every keychain read here is non-interactive (see `crate::keychain`), so nothing
//! on the launch path can raise the macOS login-password dialog. The login keychain
//! is ad-hoc-signed-bound, so after a rebuild a previously stored item may be
//! `Blocked` (access denied without a prompt); the UI then shows the key as not
//! stored and the user re-adds it, which recreates the item under the new build.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::keychain::{self, Access};

pub const STORE_FILE: &str = "settings.json";
/// Providers VOXCTL stores keys for. Mirrors the registry's `keychainAccount`
/// values (`voxctl.<id>`); kept here so key storage never depends on the
/// registry being loadable.
const PROVIDERS: [&str; 3] = ["openai", "xai", "gemini"];

/// How a finished transcript reaches the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    /// Leave the HUD up as a review card (copy + dismiss). The default.
    #[default]
    Review,
    /// Type the text into the focused field (requires Accessibility).
    Paste,
    /// Write the text to the clipboard and flash a confirmation.
    Clipboard,
}

/// Mirrors the TypeScript `Config` (serde camelCase). Single source of truth
/// lives in `settings.json`; Rust reads it on demand.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub capture_mode: String,
    pub shortcut: String,
    pub sfx_enabled: bool,
    /// Post-transcription delivery. Defaults to `review`.
    #[serde(default)]
    pub delivery_mode: DeliveryMode,
    /// Only meaningful for `delivery_mode == Paste`: also write the transcript
    /// to the clipboard. Migrated from the legacy `copyToClipboard` flag.
    #[serde(default)]
    pub also_copy: bool,
    pub notify_on_mode_switch: bool,
    pub app_locale: String,
    /// Automatic audio retention (transcripts are always kept). One of: "never",
    /// "keep_latest_5", "after_3_days", "after_2_weeks", "after_3_months". Only
    /// the WAV is removed when a recording's audio falls outside the policy.
    #[serde(default = "default_auto_delete_policy")]
    pub auto_delete_policy: String,
    /// First-run onboarding is complete once mic/key/first recording are done.
    #[serde(default)]
    pub onboarding_completed: bool,
}

fn default_auto_delete_policy() -> String {
    "never".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            capture_mode: "toggle".into(),
            shortcut: "Alt+Space".into(),
            sfx_enabled: true,
            delivery_mode: DeliveryMode::Review,
            also_copy: false,
            notify_on_mode_switch: false,
            app_locale: "en".into(),
            auto_delete_policy: default_auto_delete_policy(),
            onboarding_completed: false,
        }
    }
}

/// Read the current config from the shared store, falling back to defaults.
pub fn load_config(app: &AppHandle) -> Config {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get("config") {
            if let Some(cfg) = normalize_config(v) {
                return cfg;
            }
        }
    }
    Config::default()
}

/// Deserialize a stored config, applying the legacy `copyToClipboard` migration
/// when the new `deliveryMode` key is absent.
///
/// - legacy copy true  -> Paste + also-copy (preserves today's behavior)
/// - legacy copy false -> Review (the new default)
///
/// An invalid `deliveryMode` makes deserialization fail, which routes the caller
/// to `Config::default()` (Review) rather than trusting a bad value.
fn normalize_config(v: serde_json::Value) -> Option<Config> {
    let has_new_mode = v.get("deliveryMode").is_some();
    let legacy_copy = v
        .get("copyToClipboard")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut cfg = serde_json::from_value::<Config>(v).ok()?;
    if !has_new_mode {
        cfg.delivery_mode = if legacy_copy {
            DeliveryMode::Paste
        } else {
            DeliveryMode::Review
        };
        cfg.also_copy = legacy_copy;
    }
    Some(cfg)
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

/// Keychain account a provider's key lives under (`voxctl.<provider>`). Retained
/// only to validate provider names and to migrate pre-combined per-provider items.
fn account(provider: &str) -> Result<String, String> {
    if PROVIDERS.contains(&provider) {
        Ok(format!("voxctl.{provider}"))
    } else {
        Err(format!("unknown provider: {provider}"))
    }
}

/// In-memory cache of provider keys so record-start (and every transcribe) never
/// hits the Keychain on the hot path. Maps provider → `Some(key)` when present /
/// `None` when known-absent. Invalidated on every set/clear so it can never serve
/// a stale or removed key.
static KEY_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn key_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    KEY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalidate_key_cache(provider: &str) {
    if let Ok(mut m) = key_cache().lock() {
        m.remove(provider);
    }
}

/// Snapshot the cache if `provider` is already resolved.
fn cached(provider: &str) -> Option<Option<String>> {
    key_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(provider).cloned())
}

/// Read + decode the combined blob once and replace the cache with its contents
/// (exactly the providers stored are `Some`; everyone else is `None`). Never
/// prompts — a `Blocked` read caches everyone as absent, so the UI honestly shows
/// "no key stored" rather than blocking on a dialog.
fn load_into_cache() -> HashMap<String, String> {
    let all = match keychain::read_blob() {
        Access::Found(map) => map,
        Access::Absent | Access::Blocked => HashMap::new(),
    };
    if let Ok(mut m) = key_cache().lock() {
        for p in PROVIDERS {
            m.insert(p.to_string(), all.get(p).cloned());
        }
    }
    all
}

/// Per-provider key status for the UI: "validated" (green) when a key is stored,
/// "none" otherwise. Invalid keys are rejected at entry and never stored, so
/// "invalid (red)" is surfaced transiently from the `set_api_key` error rather
/// than as a persistent state here. This is a non-interactive read, so it is safe
/// to call on launch (it will not raise a keychain dialog).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub openai: String,
    pub xai: String,
    pub gemini: String,
}

#[tauri::command]
pub async fn provider_status() -> ProviderStatus {
    // A single non-interactive Keychain round-trip serves all three providers;
    // keep it on the blocking pool so a slow Keychain can never freeze the UI.
    tauri::async_runtime::spawn_blocking(|| {
        let all = load_into_cache();
        let s = |p: &str| {
            if all.contains_key(p) {
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
    })
    .await
    .unwrap_or_else(|_| ProviderStatus {
        openai: "none".to_string(),
        xai: "none".to_string(),
        gemini: "none".to_string(),
    })
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

/// Remove a provider's stored key from the combined blob, treating "no key
/// present" as success. Called only from user-initiated flows (save/delete), so
/// reading the true current contents may show one keychain dialog.
fn clear_key(provider: &str) {
    let mut all = match keychain::read_blob_interactive() {
        Access::Found(map) => map,
        Access::Absent | Access::Blocked => HashMap::new(),
    };
    if all.remove(provider).is_some() {
        if let Err(e) = keychain::write_blob(&all) {
            log::warn!("failed clearing {provider} key: {e}");
        }
    }
    invalidate_key_cache(provider);
}

/// One-time migration of pre-combined keychain layouts into the single
/// `voxctl.keys` blob: the pre-multi-provider `openai_api_key` account and the
/// per-provider `voxctl.<id>` accounts. Non-interactive: if the combined blob
/// already exists, or the probe is blocked (stale build identity), this is a
/// no-op. Runs on the first explicit key action, never during startup.
fn migrate_legacy_keys() {
    // Stop early when the combined blob already exists (or is unreadable).
    if let Access::Found(_) = keychain::read_blob() {
        return;
    }
    let mut all: HashMap<String, String> = HashMap::new();
    for p in PROVIDERS {
        let acct = format!("voxctl.{p}");
        if let Access::Found(k) = keychain::read_account(&acct) {
            all.insert(p.to_string(), k);
        }
    }
    if let Access::Found(k) = keychain::read_account(keychain::LEGACY_OPENAI_USER) {
        all.entry("openai".to_string()).or_insert(k);
    }
    if all.is_empty() {
        return;
    }
    if keychain::write_blob(&all).is_ok() {
        for p in PROVIDERS {
            keychain::delete_account(&format!("voxctl.{p}"));
        }
        keychain::delete_account(keychain::LEGACY_OPENAI_USER);
        log::info!(
            "migrated legacy provider keys into {}",
            keychain::KEYCHAIN_ACCOUNT
        );
    }
}

/// Validate the key against its provider, then store it in the Keychain ONLY if
/// valid (per product decision: reject invalid keys rather than storing them).
///
/// A *definitively invalid* key (401/403/400) also clears any previously stored
/// key for that provider, so the UI never keeps showing "validated" for a key
/// the user just replaced with a bad one. Transient "unreachable" failures
/// leave the existing key untouched.
///
/// This is an explicit user gesture, so it is the one place a keychain dialog is
/// allowed (macOS may ask to authorise the write for a freshly built binary).
#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    account(&provider)?; // reject unknown providers
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
    // Migrate any pre-combined layout once, before the read-modify-write.
    migrate_legacy_keys();
    let mut all = match keychain::read_blob_interactive() {
        Access::Found(map) => map,
        Access::Absent | Access::Blocked => HashMap::new(),
    };
    all.insert(provider.clone(), key);
    keychain::write_blob(&all)?;
    invalidate_key_cache(&provider);
    Ok(())
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    account(&provider)?; // reject unknown providers
    clear_key(&provider);
    Ok(())
}

/// Internal accessor for the transcription layer. Stays in Rust. Serves from the
/// in-memory cache when solved so record-start avoids the Keychain syscall; a cold
/// cache is warmed with a single non-interactive read (never prompts).
pub fn get_api_key(provider: &str) -> Option<String> {
    if let Some(v) = cached(provider) {
        return v;
    }
    load_into_cache();
    cached(provider).flatten()
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
    }

    fn base_config_json() -> serde_json::Value {
        serde_json::json!({
            "captureMode": "toggle",
            "shortcut": "Alt+Space",
            "sfxEnabled": true,
            "notifyOnModeSwitch": false,
            "appLocale": "en",
            "autoDeletePolicy": "never",
            "onboardingCompleted": true
        })
    }

    #[test]
    fn legacy_copy_true_migrates_to_paste_with_also_copy() {
        let mut v = base_config_json();
        v["copyToClipboard"] = serde_json::json!(true);
        let cfg = normalize_config(v).expect("config should parse");
        assert_eq!(cfg.delivery_mode, DeliveryMode::Paste);
        assert!(cfg.also_copy);
    }

    #[test]
    fn legacy_copy_false_migrates_to_review() {
        let mut v = base_config_json();
        v["copyToClipboard"] = serde_json::json!(false);
        let cfg = normalize_config(v).expect("config should parse");
        assert_eq!(cfg.delivery_mode, DeliveryMode::Review);
        assert!(!cfg.also_copy);
    }

    #[test]
    fn missing_legacy_key_defaults_to_review() {
        let cfg = normalize_config(base_config_json()).expect("config should parse");
        assert_eq!(cfg.delivery_mode, DeliveryMode::Review);
        assert!(!cfg.also_copy);
    }

    #[test]
    fn explicit_delivery_mode_wins_over_legacy() {
        let mut v = base_config_json();
        v["copyToClipboard"] = serde_json::json!(true);
        v["deliveryMode"] = serde_json::json!("clipboard");
        v["alsoCopy"] = serde_json::json!(false);
        let cfg = normalize_config(v).expect("config should parse");
        assert_eq!(cfg.delivery_mode, DeliveryMode::Clipboard);
        assert!(!cfg.also_copy);
    }

    #[test]
    fn invalid_delivery_mode_is_rejected() {
        let mut v = base_config_json();
        v["deliveryMode"] = serde_json::json!("telepathy");
        assert!(normalize_config(v).is_none());
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

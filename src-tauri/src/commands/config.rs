//! Non-secret settings (read from the shared tauri-plugin-store file) plus the
//! OpenAI API key, which is kept ONLY in the macOS Keychain — never in plaintext
//! config and never handed to the webview.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "settings.json";
const KEYRING_SERVICE: &str = "com.derick.voxctlcom";
const KEYRING_USER: &str = "openai_api_key";

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
}

impl Default for Config {
    fn default() -> Self {
        Self {
            capture_mode: "toggle".into(),
            shortcut: "Alt+Space".into(),
            sfx_enabled: true,
            copy_to_clipboard: false,
            notify_on_mode_switch: true,
            app_locale: "en".into(),
            default_language: None,
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

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_api_key() -> bool {
    entry().and_then(|e| e.get_password().map_err(|x| x.to_string())).is_ok()
}

#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("empty key".into());
    }
    entry()?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Internal accessor for the transcription layer. Stays in Rust.
#[allow(dead_code)]
pub fn get_api_key() -> Option<String> {
    entry().ok().and_then(|e| e.get_password().ok())
}

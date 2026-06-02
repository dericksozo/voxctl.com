//! Context "Modes" — presets that bind {language, keyword steering, triggers}.
//! Persisted in the shared store under "modes"; seeded with built-in presets on
//! first read. Active-mode resolution (frontmost app/website) arrives in slice 6.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

use super::config::{load_config, STORE_FILE};
use crate::commands::audio::RecordingContext;
use crate::events;
use crate::platform::macos;

const SELF_BUNDLE: &str = "com.derick.voxctlcom";

/// Currently active mode name, tracked in the background as the frontmost app
/// changes. Used to drive the tray title and the header indicator.
#[derive(Default)]
pub struct ActiveModeState(pub Mutex<Option<String>>);

const KEY: &str = "modes";
const MODEL: &str = "gpt-realtime-whisper";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub language: String,
    pub keywords: Vec<String>,
    pub trigger_apps: Vec<String>,
    pub trigger_websites: Vec<String>,
    pub model: String,
    pub builtin: bool,
}

fn preset(id: &str, name: &str, language: &str, apps: &[&str], sites: &[&str]) -> Mode {
    Mode {
        id: id.into(),
        name: name.into(),
        enabled: true,
        language: language.into(),
        keywords: Vec::new(),
        trigger_apps: apps.iter().map(|s| s.to_string()).collect(),
        trigger_websites: sites.iter().map(|s| s.to_string()).collect(),
        model: MODEL.into(),
        builtin: true,
    }
}

fn normalize_mode(mut mode: Mode) -> Mode {
    mode.model = MODEL.into();
    mode
}

fn normalize_modes(modes: Vec<Mode>) -> Vec<Mode> {
    modes.into_iter().map(normalize_mode).collect()
}

/// Built-in presets shipped with the app (brief §3).
pub fn default_modes() -> Vec<Mode> {
    vec![
        preset("claude", "CLAUDE", "auto", &["Claude"], &["claude.ai"]),
        preset(
            "chatgpt",
            "CHATGPT",
            "auto",
            &["ChatGPT"],
            &["chatgpt.com", "chat.openai.com"],
        ),
        preset("gemini", "GEMINI", "auto", &[], &["gemini.google.com"]),
        preset(
            "lang",
            "LANGUAGE LEARNING",
            "es",
            &[],
            &["preply.com", "italki.com", "duolingo.com"],
        ),
    ]
}

fn load(app: &AppHandle) -> Vec<Mode> {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY) {
            if let Ok(modes) = serde_json::from_value::<Vec<Mode>>(v) {
                let modes = normalize_modes(modes);
                if let Ok(v) = serde_json::to_value(&modes) {
                    store.set(KEY, v);
                    let _ = store.save();
                }
                return modes;
            }
        }
        // First run: seed presets so the store is populated.
        let seed = default_modes();
        if let Ok(v) = serde_json::to_value(&seed) {
            store.set(KEY, v);
            let _ = store.save();
        }
        return seed;
    }
    default_modes()
}

fn persist(app: &AppHandle, modes: &[Mode]) {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Ok(v) = serde_json::to_value(modes) {
            store.set(KEY, v);
            let _ = store.save();
        }
    }
}

/// Public accessor for other modules (e.g. the record pipeline) to read modes.
#[allow(dead_code)] // used by the active-mode resolver in slice 6
pub fn all_modes(app: &AppHandle) -> Vec<Mode> {
    load(app)
}

#[tauri::command]
pub fn list_modes(app: AppHandle) -> Vec<Mode> {
    load(&app)
}

#[tauri::command]
pub fn save_mode(app: AppHandle, mode: Mode) {
    let mode = normalize_mode(mode);
    let mut modes = load(&app);
    if let Some(existing) = modes.iter_mut().find(|m| m.id == mode.id) {
        *existing = mode;
    } else {
        modes.push(mode);
    }
    persist(&app, &modes);
}

#[tauri::command]
pub fn delete_mode(app: AppHandle, id: String) {
    let mut modes = load(&app);
    modes.retain(|m| m.id != id);
    persist(&app, &modes);
}

#[tauri::command]
pub fn set_mode_enabled(app: AppHandle, id: String, enabled: bool) {
    let mut modes = load(&app);
    if let Some(m) = modes.iter_mut().find(|m| m.id == id) {
        m.enabled = enabled;
    }
    persist(&app, &modes);
}

/// Find the first enabled mode triggered by the given app/website. Website
/// match (best-effort) takes priority, then app match (reliable). Matching is
/// case-insensitive and substring-tolerant so "Claude" matches "Claude.app".
pub fn match_mode(modes: &[Mode], app_name: Option<&str>, host: Option<&str>) -> Option<Mode> {
    let app_l = app_name.map(str::to_lowercase);
    let host_l = host.map(str::to_lowercase);

    // Pass 1: website match (best-effort) wins over app match.
    if let Some(h) = &host_l {
        if let Some(m) = modes.iter().filter(|m| m.enabled).find(|m| {
            m.trigger_websites.iter().any(|w| {
                let w = w.to_lowercase();
                *h == w || h.ends_with(&format!(".{w}")) || h.contains(&w)
            })
        }) {
            return Some(m.clone());
        }
    }

    // Pass 2: reliable app match.
    if let Some(a) = &app_l {
        if let Some(m) = modes.iter().filter(|m| m.enabled).find(|m| {
            m.trigger_apps.iter().any(|app| {
                let app = app.to_lowercase();
                *a == app || a.contains(&app) || app.contains(a.as_str())
            })
        }) {
            return Some(m.clone());
        }
    }

    None
}

/// The currently active mode (tracked in the background; survives focusing
/// VOXCTL itself). Returns None when nothing matches the frontmost app/website.
#[tauri::command]
pub fn get_active_mode(app: AppHandle) -> Option<Mode> {
    let name = app.state::<ActiveModeState>().0.lock().unwrap().clone()?;
    load(&app).into_iter().find(|m| m.name == name)
}

/// Recompute the active mode from the frontmost app/website. Called on every
/// app switch (and after mode edits). Updates the tray title, emits
/// `mode-changed`, and optionally notifies — only when the mode actually changes.
pub fn refresh_active_mode(app: &AppHandle) {
    let Some((app_name, bundle)) = macos::frontmost_app() else {
        return;
    };
    // Keep the active mode while the user is interacting with VOXCTL itself.
    if bundle.as_deref() == Some(SELF_BUNDLE) {
        return;
    }
    let host = macos::focused_url().as_deref().and_then(macos::host_of);
    let matched = match_mode(&load(app), Some(app_name.as_str()), host.as_deref());
    let new_name = matched.as_ref().map(|m| m.name.clone());

    {
        let state = app.state::<ActiveModeState>();
        let mut cur = state.0.lock().unwrap();
        if *cur == new_name {
            return;
        }
        *cur = new_name.clone();
    }

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(new_name.clone().unwrap_or_else(|| "VOX".into())));
    }
    let _ = app.emit(
        events::MODE_CHANGED,
        events::ModeChanged {
            id: matched.as_ref().map(|m| m.id.clone()).unwrap_or_default(),
            name: new_name.clone().unwrap_or_else(|| "—".into()),
        },
    );

    if let Some(name) = new_name {
        if load_config(app).notify_on_mode_switch {
            use tauri_plugin_notification::{NotificationExt, PermissionState};
            // Only show if the user actually granted notification permission
            // (enabling the toggle prompts for it); otherwise this is a silent no-op.
            if matches!(
                app.notification().permission_state(),
                Ok(PermissionState::Granted)
            ) {
                let _ = app
                    .notification()
                    .builder()
                    .title("VOXCTL")
                    .body(format!("Switched to {name} mode"))
                    .show();
            }
        }
    }
}

/// Build the recording context (language + which app/website/mode it belongs
/// to) from the frontmost app and best-effort focused URL. Language precedence:
/// HUD override → matched mode language → config default → auto.
pub fn resolve_context(app: &AppHandle, override_lang: Option<String>) -> RecordingContext {
    let app_name = macos::frontmost_app().map(|(n, _)| n);
    let host = macos::focused_url().as_deref().and_then(macos::host_of);
    let matched = match_mode(&load(app), app_name.as_deref(), host.as_deref());

    let language = override_lang
        .or_else(|| {
            matched.as_ref().and_then(|m| {
                (m.language != "auto" && !m.language.is_empty()).then(|| m.language.clone())
            })
        })
        .or_else(|| load_config(app).default_language);

    RecordingContext {
        language,
        app_name,
        website: host,
        mode_name: matched.as_ref().map(|m| m.name.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(id: &str, apps: &[&str], sites: &[&str], enabled: bool) -> Mode {
        Mode {
            id: id.into(),
            name: id.to_uppercase(),
            enabled,
            language: "auto".into(),
            keywords: vec![],
            trigger_apps: apps.iter().map(|s| s.to_string()).collect(),
            trigger_websites: sites.iter().map(|s| s.to_string()).collect(),
            model: MODEL.into(),
            builtin: false,
        }
    }

    #[test]
    fn matches_by_app_case_insensitive() {
        let modes = vec![mode("code", &["Code"], &[], true)];
        let m = match_mode(&modes, Some("Visual Studio Code"), None);
        assert_eq!(m.unwrap().id, "code");
    }

    #[test]
    fn matches_by_website_and_subdomain() {
        let modes = vec![mode("gpt", &[], &["chatgpt.com"], true)];
        assert_eq!(
            match_mode(&modes, None, Some("chatgpt.com")).unwrap().id,
            "gpt"
        );
        assert_eq!(
            match_mode(&modes, None, Some("www.chatgpt.com"))
                .unwrap()
                .id,
            "gpt"
        );
        assert!(match_mode(&modes, None, Some("example.com")).is_none());
    }

    #[test]
    fn disabled_modes_are_ignored() {
        let modes = vec![mode("claude", &["Claude"], &[], false)];
        assert!(match_mode(&modes, Some("Claude"), None).is_none());
    }

    #[test]
    fn website_takes_priority_over_app() {
        let modes = vec![
            mode("app_mode", &["Safari"], &[], true),
            mode("site_mode", &[], &["preply.com"], true),
        ];
        // First in list wins on app; but a site match should still resolve to site_mode.
        let m = match_mode(&modes, Some("Safari"), Some("preply.com"));
        assert_eq!(m.unwrap().id, "site_mode");
    }

    #[test]
    fn normalizes_stale_model_values() {
        let mut stale = mode("stale", &[], &[], true);
        stale.model = "whisper-large-v3".into();

        let modes = normalize_modes(vec![stale]);

        assert_eq!(modes[0].model, MODEL);
    }
}

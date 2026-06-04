//! Context "Modes" — presets that bind {model + capabilities, language, keyword
//! steering, app/website triggers}. Persisted in the shared store under "modes".
//!
//! Exactly one mode is active at any instant, resolved by priority:
//!   1. Manual pin (sticky across app switches until unpinned)
//!   2. Auto match (frontmost app / URL matches an *enabled* mode's triggers)
//!   3. Default mode (the priority-3 fallback)
//!
//! Disabled modes never auto-match.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

use super::config::{load_config, STORE_FILE};
use crate::commands::audio::RecordingContext;
use crate::events;
use crate::platform::macos;
use crate::registry::{self, Capabilities};

const SELF_BUNDLE: &str = "com.derick.voxctlcom";

const KEY: &str = "modes";
/// Store keys for the active-mode resolution inputs.
const PINNED_KEY: &str = "pinnedModeId";
const DEFAULT_KEY: &str = "defaultModeId";
/// Ultimate fallback model when a mode references one the registry doesn't know.
const DEFAULT_MODEL: &str = "gpt-realtime-whisper";

/// The currently active mode, cached as (mode id, reason). Kept fresh by the
/// frontmost-app observer (which ignores VOXCTL itself so tabbing into the app
/// doesn't change the mode) and by explicit pin/unpin/edits.
#[derive(Default)]
pub struct ActiveModeState(pub Mutex<Option<(String, String)>>);

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
    /// Transcription model id (must exist in the registry).
    pub model: String,
    /// User-enabled subset of the model's declared capabilities, applied at
    /// transcription time.
    #[serde(default)]
    pub capabilities: Capabilities,
    pub builtin: bool,
}

/// The active mode plus *why* it's active ("pinned" | "auto" | "default").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveMode {
    pub mode: Mode,
    pub reason: String,
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
        model: DEFAULT_MODEL.into(),
        capabilities: Capabilities::default(),
        builtin: true,
    }
}

/// Built-in presets shipped with the app.
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

/// All model ids the registry currently knows about.
fn valid_model_ids(app: &AppHandle) -> Vec<String> {
    registry::effective(app)
        .models
        .into_iter()
        .map(|m| m.id)
        .collect()
}

/// Repair a mode whose model id the registry no longer knows: fall back to the
/// global default (or, failing that, the first registry model). Other models are
/// left untouched — the registry, not this function, decides what's selectable.
fn normalize_mode(mut mode: Mode, valid_ids: &[String]) -> Mode {
    if !valid_ids.iter().any(|id| id == &mode.model) {
        mode.model = if valid_ids.iter().any(|id| id == DEFAULT_MODEL) {
            DEFAULT_MODEL.to_string()
        } else {
            valid_ids
                .first()
                .cloned()
                .unwrap_or_else(|| DEFAULT_MODEL.to_string())
        };
    }
    mode
}

fn read_store_string(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store
        .get(key)
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
}

fn write_store_string(app: &AppHandle, key: &str, val: Option<&str>) {
    if let Ok(store) = app.store(STORE_FILE) {
        match val {
            Some(s) => store.set(key, serde_json::json!(s)),
            None => {
                store.delete(key);
            }
        }
        let _ = store.save();
    }
}

fn load(app: &AppHandle) -> Vec<Mode> {
    let valid = valid_model_ids(app);
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY) {
            if let Ok(modes) = serde_json::from_value::<Vec<Mode>>(v) {
                let modes: Vec<Mode> = modes
                    .into_iter()
                    .map(|m| normalize_mode(m, &valid))
                    .collect();
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

/// Public accessor for other modules (e.g. the record pipeline).
#[allow(dead_code)]
pub fn all_modes(app: &AppHandle) -> Vec<Mode> {
    load(app)
}

#[tauri::command]
pub fn list_modes(app: AppHandle) -> Vec<Mode> {
    load(&app)
}

#[tauri::command]
pub fn save_mode(app: AppHandle, mode: Mode) {
    let valid = valid_model_ids(&app);
    let mode = normalize_mode(mode, &valid);
    let mut modes = load(&app);
    if let Some(existing) = modes.iter_mut().find(|m| m.id == mode.id) {
        *existing = mode;
    } else {
        modes.push(mode);
    }
    persist(&app, &modes);
    recompute_and_emit(&app);
}

#[tauri::command]
pub fn delete_mode(app: AppHandle, id: String) {
    // The default mode is non-deletable.
    if read_store_string(&app, DEFAULT_KEY).as_deref() == Some(id.as_str()) {
        return;
    }
    let mut modes = load(&app);
    modes.retain(|m| m.id != id);
    persist(&app, &modes);
    // A deleted mode can't stay pinned.
    if read_store_string(&app, PINNED_KEY).as_deref() == Some(id.as_str()) {
        write_store_string(&app, PINNED_KEY, None);
    }
    recompute_and_emit(&app);
}

#[tauri::command]
pub fn set_mode_enabled(app: AppHandle, id: String, enabled: bool) {
    let mut modes = load(&app);
    if let Some(m) = modes.iter_mut().find(|m| m.id == id) {
        m.enabled = enabled;
    }
    persist(&app, &modes);
    recompute_and_emit(&app);
}

/// Manually pin a mode. Sticky across app switches until unpinned.
#[tauri::command]
pub fn pin_mode(app: AppHandle, id: String) {
    write_store_string(&app, PINNED_KEY, Some(&id));
    recompute_and_emit(&app);
}

#[tauri::command]
pub fn unpin_mode(app: AppHandle) {
    write_store_string(&app, PINNED_KEY, None);
    recompute_and_emit(&app);
}

/// Designate the priority-3 fallback (non-deletable) mode. Set by onboarding
/// from the first validated key; can be moved to another mode later.
#[tauri::command]
pub fn set_default_mode(app: AppHandle, id: String) {
    write_store_string(&app, DEFAULT_KEY, Some(&id));
    recompute_and_emit(&app);
}

/// Find the first enabled mode triggered by the given app/website. Website match
/// (best-effort) takes priority, then app match (reliable). Matching is
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

/// Pure active-mode resolution: pin > auto > default, with a final fallback to
/// the first mode so there is always an active mode once any exist. Returns the
/// mode and the reason it won.
pub fn resolve_active_mode(
    modes: &[Mode],
    pinned_id: Option<&str>,
    default_id: Option<&str>,
    app_name: Option<&str>,
    host: Option<&str>,
) -> Option<(Mode, &'static str)> {
    // 1. Manual pin (only if it still exists).
    if let Some(pid) = pinned_id {
        if let Some(m) = modes.iter().find(|m| m.id == pid) {
            return Some((m.clone(), "pinned"));
        }
    }
    // 2. Auto match against enabled modes.
    if let Some(m) = match_mode(modes, app_name, host) {
        return Some((m, "auto"));
    }
    // 3. Explicit default mode.
    if let Some(did) = default_id {
        if let Some(m) = modes.iter().find(|m| m.id == did) {
            return Some((m.clone(), "default"));
        }
    }
    // Fallback: the first mode (keeps an active mode before a default is set).
    modes.first().map(|m| (m.clone(), "default"))
}

/// Frontmost app/website for auto-matching. None while pinned (irrelevant) or
/// while VOXCTL itself is frontmost (keep the current mode).
fn current_match_context(pinned: bool) -> (Option<String>, Option<String>) {
    if pinned {
        return (None, None);
    }
    match macos::frontmost_app() {
        Some((name, bundle)) if bundle.as_deref() != Some(SELF_BUNDLE) => {
            let host = macos::focused_url().as_deref().and_then(macos::host_of);
            (Some(name), host)
        }
        _ => (None, None),
    }
}

/// The currently active mode (cached; survives focusing VOXCTL itself).
#[tauri::command]
pub fn get_active_mode(app: AppHandle) -> Option<ActiveMode> {
    let modes = load(&app);
    if let Some((id, reason)) = app.state::<ActiveModeState>().0.lock().unwrap().clone() {
        if let Some(m) = modes.iter().find(|m| m.id == id) {
            return Some(ActiveMode {
                mode: m.clone(),
                reason,
            });
        }
    }
    // No cache yet (fresh launch) → resolve from pin/default only.
    let pinned = read_store_string(&app, PINNED_KEY);
    let default = read_store_string(&app, DEFAULT_KEY);
    resolve_active_mode(&modes, pinned.as_deref(), default.as_deref(), None, None).map(
        |(mode, reason)| ActiveMode {
            mode,
            reason: reason.to_string(),
        },
    )
}

/// Recompute the active mode and emit `mode-changed` only when it actually
/// changes. Used by the app-switch observer and by pin/unpin/edit commands.
pub fn recompute_and_emit(app: &AppHandle) {
    let modes = load(app);
    let pinned = read_store_string(app, PINNED_KEY);
    let default = read_store_string(app, DEFAULT_KEY);
    let (app_name, host) = current_match_context(pinned.is_some());
    let resolved = resolve_active_mode(
        &modes,
        pinned.as_deref(),
        default.as_deref(),
        app_name.as_deref(),
        host.as_deref(),
    );
    let new = resolved
        .as_ref()
        .map(|(m, r)| (m.id.clone(), (*r).to_string()));

    {
        let state = app.state::<ActiveModeState>();
        let mut cur = state.0.lock().unwrap();
        if *cur == new {
            return;
        }
        *cur = new;
    }

    let (id, name) = match &resolved {
        Some((m, _)) => (m.id.clone(), m.name.clone()),
        None => (String::new(), "—".to_string()),
    };
    let _ = app.emit(
        events::MODE_CHANGED,
        events::ModeChanged {
            id,
            name: name.clone(),
        },
    );

    if name != "—" && load_config(app).notify_on_mode_switch {
        use tauri_plugin_notification::{NotificationExt, PermissionState};
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

/// Recompute the active mode from the frontmost app/website. Called on every app
/// switch. Skips recompute while VOXCTL is frontmost (keep the current mode),
/// unless a mode is pinned (sticky regardless of the frontmost app).
pub fn refresh_active_mode(app: &AppHandle) {
    if read_store_string(app, PINNED_KEY).is_none() {
        if let Some((_, bundle)) = macos::frontmost_app() {
            if bundle.as_deref() == Some(SELF_BUNDLE) {
                return;
            }
        }
    }
    recompute_and_emit(app);
}

/// Build the recording context (language + which app/website/mode it belongs to)
/// from the resolved active mode. Language precedence: HUD override → active
/// mode language → config default → auto.
pub fn resolve_context(app: &AppHandle, override_lang: Option<String>) -> RecordingContext {
    let modes = load(app);
    let pinned = read_store_string(app, PINNED_KEY);
    let default = read_store_string(app, DEFAULT_KEY);
    // At record time VOXCTL is not frontmost (hotkey pressed from the target
    // app), so the frontmost app is the real auto-match target.
    let app_name = macos::frontmost_app().map(|(n, _)| n);
    let host = macos::focused_url().as_deref().and_then(macos::host_of);
    let resolved = resolve_active_mode(
        &modes,
        pinned.as_deref(),
        default.as_deref(),
        app_name.as_deref(),
        host.as_deref(),
    );
    let matched = resolved.as_ref().map(|(m, _)| m);

    let language = override_lang
        .or_else(|| {
            matched.and_then(|m| {
                (m.language != "auto" && !m.language.is_empty()).then(|| m.language.clone())
            })
        })
        .or_else(|| load_config(app).default_language);

    RecordingContext {
        language,
        app_name,
        website: host,
        mode_name: matched.map(|m| m.name.clone()),
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
            model: DEFAULT_MODEL.into(),
            capabilities: Capabilities::default(),
            builtin: false,
        }
    }

    fn fixture() -> Vec<Mode> {
        vec![
            mode("default", &[], &[], true),
            mode("code", &["Code"], &[], true),
            mode("gpt", &[], &["chatgpt.com"], true),
            mode("slackoff", &["Slack"], &[], false),
        ]
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
    fn website_takes_priority_over_app() {
        let modes = vec![
            mode("app_mode", &["Safari"], &[], true),
            mode("site_mode", &[], &["preply.com"], true),
        ];
        let m = match_mode(&modes, Some("Safari"), Some("preply.com"));
        assert_eq!(m.unwrap().id, "site_mode");
    }

    #[test]
    fn pin_beats_auto_and_default() {
        let modes = fixture();
        let (m, reason) =
            resolve_active_mode(&modes, Some("gpt"), Some("default"), Some("Code"), None).unwrap();
        assert_eq!(m.id, "gpt");
        assert_eq!(reason, "pinned");
    }

    #[test]
    fn auto_beats_default_when_unpinned() {
        let modes = fixture();
        let (m, reason) =
            resolve_active_mode(&modes, None, Some("default"), Some("Code"), None).unwrap();
        assert_eq!(m.id, "code");
        assert_eq!(reason, "auto");
    }

    #[test]
    fn falls_back_to_default_when_nothing_matches() {
        let modes = fixture();
        let (m, reason) =
            resolve_active_mode(&modes, None, Some("default"), Some("Finder"), None).unwrap();
        assert_eq!(m.id, "default");
        assert_eq!(reason, "default");
    }

    #[test]
    fn disabled_modes_never_auto_match() {
        let modes = fixture();
        // Slack triggers "slackoff" but it's disabled → falls to default.
        let (m, reason) =
            resolve_active_mode(&modes, None, Some("default"), Some("Slack"), None).unwrap();
        assert_eq!(m.id, "default");
        assert_eq!(reason, "default");
    }

    #[test]
    fn pin_to_missing_mode_falls_through_to_auto() {
        let modes = fixture();
        let (m, reason) =
            resolve_active_mode(&modes, Some("ghost"), Some("default"), Some("Code"), None)
                .unwrap();
        assert_eq!(m.id, "code");
        assert_eq!(reason, "auto");
    }

    #[test]
    fn normalizes_unknown_model_to_default() {
        let mut stale = mode("stale", &[], &[], true);
        stale.model = "whisper-large-v3".into();
        let valid = vec!["gpt-realtime-whisper".to_string(), "whisper-1".to_string()];
        assert_eq!(normalize_mode(stale, &valid).model, DEFAULT_MODEL);
    }

    #[test]
    fn keeps_known_model() {
        let mut m = mode("m", &[], &[], true);
        m.model = "whisper-1".into();
        let valid = vec!["gpt-realtime-whisper".to_string(), "whisper-1".to_string()];
        assert_eq!(normalize_mode(m, &valid).model, "whisper-1");
    }
}

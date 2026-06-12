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
/// Onboarding-created fallback mode. It is the one mode every user should have
/// after adding their first provider key.
const ONBOARDING_DEFAULT_ID: &str = "default";

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

fn onboarding_default_mode(model: String) -> Mode {
    Mode {
        id: ONBOARDING_DEFAULT_ID.into(),
        name: "DEFAULT".into(),
        enabled: true,
        language: "auto".into(),
        keywords: Vec::new(),
        trigger_apps: Vec::new(),
        trigger_websites: Vec::new(),
        model,
        capabilities: Capabilities::default(),
        builtin: true,
    }
}

fn default_model_for_provider(reg: &registry::Registry, provider: &str) -> Result<String, String> {
    if reg.provider_by_id(provider).is_none() {
        return Err(format!("unknown provider: {provider}"));
    }
    reg.default_model_for(provider)
        .ok_or_else(|| format!("no default model for provider: {provider}"))
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
        .iter()
        .map(|m| m.id.clone())
        .collect()
}

/// Map a renamed/retired model id to its replacement (e.g. the old combined
/// `grok-stt` split into file/live variants).
fn alias_model(id: &str) -> Option<&'static str> {
    match id {
        "grok-stt" => Some("grok-stt-file"),
        _ => None,
    }
}

/// Repair a mode whose model id the registry no longer knows: apply a rename
/// alias if there is one, else fall back to the global default (or the first
/// registry model). Known models are left untouched — the registry, not this
/// function, decides what's selectable.
fn normalize_mode(mut mode: Mode, valid_ids: &[String]) -> Mode {
    if valid_ids.iter().any(|id| id == &mode.model) {
        return mode;
    }
    if let Some(aliased) = alias_model(&mode.model) {
        if valid_ids.iter().any(|id| id == aliased) {
            mode.model = aliased.to_string();
            return mode;
        }
    }
    mode.model = if valid_ids.iter().any(|id| id == DEFAULT_MODEL) {
        DEFAULT_MODEL.to_string()
    } else {
        valid_ids
            .first()
            .cloned()
            .unwrap_or_else(|| DEFAULT_MODEL.to_string())
    };
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

/// Drop any mode that repeats an id already seen (keeping the first). Older builds
/// and bootstrap races could leave duplicate `default`-id rows behind; this is the
/// invariant that guarantees at most one mode per id — and therefore never two
/// "default" modes.
fn dedupe_by_id(modes: Vec<Mode>) -> Vec<Mode> {
    let mut seen = std::collections::HashSet::new();
    modes
        .into_iter()
        .filter(|m| seen.insert(m.id.clone()))
        .collect()
}

/// Repair a `defaultModeId` that points at a mode which no longer exists (e.g. it
/// was a duplicate collapsed by `dedupe_by_id`). Leaves an unset key alone so
/// onboarding can still seed the default from the first validated key. Picks the
/// onboarding default when present, else the first mode.
fn ensure_default_valid(app: &AppHandle, modes: &[Mode]) {
    let Some(cur) = read_store_string(app, DEFAULT_KEY) else {
        return;
    };
    if modes.iter().any(|m| m.id == cur) {
        return;
    }
    let pick = modes
        .iter()
        .find(|m| m.id == ONBOARDING_DEFAULT_ID)
        .or_else(|| modes.first())
        .map(|m| m.id.clone());
    write_store_string(app, DEFAULT_KEY, pick.as_deref());
}

fn load(app: &AppHandle) -> Vec<Mode> {
    let valid = valid_model_ids(app);
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY) {
            if let Ok(parsed) = serde_json::from_value::<Vec<Mode>>(v) {
                let before_len = parsed.len();
                // normalize_mode only ever rewrites `mode.model`; track whether any
                // mode's model actually changed, plus whether dedupe dropped a row.
                let mut changed = false;
                let normalized: Vec<Mode> = parsed
                    .into_iter()
                    .map(|m| {
                        let before = m.model.clone();
                        let nm = normalize_mode(m, &valid);
                        changed |= nm.model != before;
                        nm
                    })
                    .collect();
                let modes = dedupe_by_id(normalized);
                changed |= modes.len() != before_len;
                // load() runs on every record start, every modes IPC call, and —
                // via recompute_and_emit — on every system-wide app switch. Only
                // persist when normalization actually changed something; otherwise
                // this was a serialize + file write + fsync for a pure read
                // (perf §1.2). After the one-time repair following a registry
                // change, this branch becomes a no-op.
                if changed {
                    if let Ok(v) = serde_json::to_value(&modes) {
                        store.set(KEY, v);
                        let _ = store.save();
                    }
                }
                ensure_default_valid(app, &modes);
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

/// Onboarding bootstrap: once the first provider key validates, create/update
/// the built-in Default Mode from that provider's registry default and make it
/// the priority-3 fallback. Idempotent: repeated calls update the same mode.
#[tauri::command]
pub fn bootstrap_default_mode(app: AppHandle, provider: String) -> Result<Mode, String> {
    let reg = registry::effective(&app);
    let model = default_model_for_provider(&reg, &provider)?;

    let mut modes = load(&app);
    let default_mode = onboarding_default_mode(model);
    if let Some(existing) = modes.iter_mut().find(|m| m.id == ONBOARDING_DEFAULT_ID) {
        *existing = default_mode.clone();
    } else {
        modes.push(default_mode.clone());
    }
    persist(&app, &modes);
    write_store_string(&app, DEFAULT_KEY, Some(ONBOARDING_DEFAULT_ID));
    recompute_and_emit(&app);
    Ok(default_mode)
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

/// Id of the priority-3 default mode — the one mode that is non-deletable. Falls
/// back to the first mode when no explicit default is set yet (matching the
/// active-mode resolution fallback), so the UI can always mark exactly one.
#[tauri::command]
pub fn get_default_mode_id(app: AppHandle) -> Option<String> {
    let modes = load(&app);
    if let Some(id) = read_store_string(&app, DEFAULT_KEY) {
        if modes.iter().any(|m| m.id == id) {
            return Some(id);
        }
    }
    modes.first().map(|m| m.id.clone())
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

/// Whether any enabled mode auto-matches on a website. When none do, the focused
/// URL can never change the resolved mode, so the focused_url() AX-tree walk can
/// be skipped on the hot paths (perf §1.1/§3.1).
fn any_enabled_website_trigger(modes: &[Mode]) -> bool {
    modes
        .iter()
        .any(|m| m.enabled && !m.trigger_websites.is_empty())
}

/// Build the recording context (language + model + capability options + which
/// app/website/mode it belongs to) from the resolved active mode. Language
/// precedence: HUD override → active mode language → config default → auto.
pub fn resolve_context(app: &AppHandle, override_lang: Option<String>) -> RecordingContext {
    let modes = load(app);
    let pinned = read_store_string(app, PINNED_KEY);
    let default = read_store_string(app, DEFAULT_KEY);
    // At record time VOXCTL is not frontmost (hotkey pressed from the target
    // app), so the frontmost app is the real auto-match target.
    let app_name = macos::frontmost_app().map(|(n, _)| n);
    // Only walk the AX tree for the focused URL when a website trigger could
    // actually use it; otherwise the URL can't change the match, so skip the
    // expensive probe on the press→record hot path (perf §1.1).
    let host = if any_enabled_website_trigger(&modes) {
        macos::focused_url().as_deref().and_then(macos::host_of)
    } else {
        None
    };
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

    let reg = registry::effective(app);
    let model_id = matched.map(|m| m.model.clone()).unwrap_or_else(|| {
        reg.providers
            .first()
            .map(|p| p.default_model_id.clone())
            .unwrap_or_default()
    });
    let model = reg.model_by_id(&model_id);
    let options = build_options(matched, model, language.clone());

    RecordingContext {
        language,
        app_name,
        website: host,
        mode_name: matched.map(|m| m.name.clone()),
        model_id,
        options,
    }
}

/// Effective transcription options: the mode's language + keywords + capability
/// toggles, intersected with what the chosen model actually supports (so we
/// never send a language/keyword/capability a model would ignore or reject).
pub fn build_options(
    mode: Option<&Mode>,
    model: Option<&crate::registry::ModelRecord>,
    language: Option<String>,
) -> crate::file_transcribe::TranscribeOptions {
    let supports_lang = model.map(|m| m.supports_language).unwrap_or(false);
    let supports_kw = model.map(|m| m.supports_keywords).unwrap_or(false);
    let mc = model.map(|m| &m.capabilities);
    let sel = mode.map(|m| &m.capabilities);
    let both = |pick: fn(&Capabilities) -> bool| -> bool {
        sel.map(pick).unwrap_or(false) && mc.map(pick).unwrap_or(false)
    };
    crate::file_transcribe::TranscribeOptions {
        language: if supports_lang { language } else { None },
        keywords: if supports_kw {
            mode.map(|m| m.keywords.clone()).unwrap_or_default()
        } else {
            Vec::new()
        },
        diarization: both(|c| c.diarization),
        word_timestamps: both(|c| c.word_timestamps),
        inverse_text_normalization: both(|c| c.inverse_text_normalization),
        multichannel: both(|c| c.multichannel),
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

    #[test]
    fn renamed_model_maps_to_alias() {
        let mut m = mode("m", &[], &[], true);
        m.model = "grok-stt".into();
        let valid = vec![
            "gpt-realtime-whisper".to_string(),
            "grok-stt-file".to_string(),
        ];
        assert_eq!(normalize_mode(m, &valid).model, "grok-stt-file");
    }

    #[test]
    fn onboarding_default_mode_uses_fixed_builtin_shape() {
        let m = onboarding_default_mode("grok-stt-live".into());
        assert_eq!(m.id, ONBOARDING_DEFAULT_ID);
        assert_eq!(m.name, "DEFAULT");
        assert_eq!(m.language, "auto");
        assert_eq!(m.model, "grok-stt-live");
        assert!(m.enabled);
        assert!(m.builtin);
        assert!(m.trigger_apps.is_empty());
        assert!(m.trigger_websites.is_empty());
    }

    #[test]
    fn dedupe_collapses_duplicate_ids_keeping_first() {
        let modes = vec![
            mode("default", &[], &[], true),
            mode("code", &["Code"], &[], true),
            // A stray second "default" from an older build / bootstrap race.
            {
                let mut m = mode("default", &[], &[], false);
                m.name = "DUP".into();
                m
            },
        ];
        let out = dedupe_by_id(modes);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "default");
        // First wins: the original enabled DEFAULT, not the later DUP.
        assert_eq!(out[0].name, "DEFAULT");
        assert!(out[0].enabled);
        assert_eq!(out[1].id, "code");
    }

    #[test]
    fn dedupe_is_noop_when_ids_unique() {
        let modes = fixture();
        let n = modes.len();
        assert_eq!(dedupe_by_id(modes).len(), n);
    }

    #[test]
    fn onboarding_provider_defaults_match_registry() {
        let reg = registry::bundled();
        assert_eq!(
            default_model_for_provider(&reg, "openai").unwrap(),
            "gpt-realtime-whisper"
        );
        assert_eq!(
            default_model_for_provider(&reg, "xai").unwrap(),
            "grok-stt-live"
        );
        assert_eq!(
            default_model_for_provider(&reg, "gemini").unwrap(),
            "gemini-2.5-flash"
        );
        assert!(default_model_for_provider(&reg, "anthropic").is_err());
    }
}

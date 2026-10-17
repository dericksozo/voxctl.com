//! The recording HUD overlay. A borderless, transparent, always-on-top
//! non-activating NSPanel pinned bottom-center that NEVER takes focus — so the
//! user's frontmost app stays frontmost (critical for text injection) while
//! recording. Built lazily on first show, then just shown/hidden.
//!
//! The same panel doubles as the post-transcription result card: it grows a
//! little, becomes clickable (copy + dismiss), and hands its lifecycle to the
//! webview. Clicking it does not activate VOXCTL or raise the dashboard.
//! Click-through is re-enabled whenever the panel is hidden or a new recording
//! starts.

use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use tauri_nspanel::{tauri_panel, ManagerExt, WebviewWindowExt};

use crate::events::{self, HudResult};

// The HUD is a non-activating floating panel: clicking Copy/Dismiss must not
// activate VOXCTL (which would raise the dashboard) or steal focus from the
// app the user is dictating into.
tauri_panel! {
    panel!(HudPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
            becomes_key_only_if_needed: false
        }
    })
}

const LABEL: &str = "hud";
const BASE_W: f64 = 116.0;
const BASE_H: f64 = 38.0;
/// Wide enough for logo + settled meter + copy + dismiss without a layout jump.
const RESULT_W: f64 = 176.0;
const RESULT_H: f64 = 38.0;
const BOTTOM_MARGIN: f64 = 22.0;

/// Backend-owned transcript awaiting a copy/dismiss from the result card.
/// Keeping the text here means the webview only ever receives a generation
/// token — no transcript is sent to (or round-tripped through) the HUD.
struct PendingResult {
    id: i64,
    text: String,
    generation: u64,
}

/// Shared HUD state, managed on the Tauri app.
///
/// `generation` is bumped on every show/hide. A card's copy/dismiss command
/// must present the generation it was created with, so a stale timer or click
/// can never act on a newer recording/card.
#[derive(Default)]
pub struct HudState {
    generation: u64,
    pending: Option<PendingResult>,
}

impl HudState {
    fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    /// Clone the pending transcript if `generation` still matches.
    pub fn pending_for_copy(&self, generation: u64) -> Option<(i64, String)> {
        self.pending
            .as_ref()
            .filter(|p| p.generation == generation)
            .map(|p| (p.id, p.text.clone()))
    }
}

fn position(app: &AppHandle, win: &WebviewWindow, w: f64, h: f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let origin = monitor.position();
        let screen_w = size.width as f64 / scale;
        let screen_h = size.height as f64 / scale;
        let origin_x = origin.x as f64 / scale;
        let origin_y = origin.y as f64 / scale;

        let x = origin_x + (screen_w - w) / 2.0;
        let y = origin_y + screen_h - h - BOTTOM_MARGIN;
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

fn build_hud(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("hud.html".into()))
        .title("VOXCTL REC")
        .inner_size(BASE_W, BASE_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        // Deliver the first click to the webview even while another app is
        // frontmost, instead of consuming it in the window server.
        .accept_first_mouse(true)
        .visible(false)
        .build()?;

    // Swizzle the NSWindow into an NSPanel and add the non-activating style.
    // Without this, clicking the card activates VOXCTL and raises the dashboard.
    match win.to_panel::<HudPanel>() {
        Ok(panel) => {
            if let Err(e) =
                panel.add_style_mask(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel)
            {
                log::error!("failed to make HUD non-activating: {e}");
            }
            // Tauri owns the window; AppKit must not release it independently.
            panel.set_released_when_closed(false);
            panel.set_hides_on_deactivate(false);
            log::info!(
                "HUD panel: floating={} hides_on_deactivate={} nonactivating={} can_become_key={} key_only_if_needed={}",
                panel.is_floating_panel(),
                panel.hides_on_deactivate(),
                panel
                    .as_panel()
                    .styleMask()
                    .contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel),
                panel.can_become_key_window(),
                panel.becomes_key_only_if_needed(),
            );
        }
        Err(e) => log::error!("failed to convert HUD to NSPanel: {e}"),
    }

    Ok(win)
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    match app.get_webview_window(LABEL) {
        Some(win) => Some(win),
        None => match build_hud(app) {
            Ok(win) => Some(win),
            Err(e) => {
                log::error!("failed to build HUD window: {e}");
                None
            }
        },
    }
}

fn set_size(win: &WebviewWindow, w: f64, h: f64) {
    let _ = win.set_size(LogicalSize::new(w, h));
}

/// Order the HUD in without making it key or activating the app. The panel's
/// `orderFrontRegardless` is safer than `WebviewWindow::show()`, which goes
/// through `makeKeyAndOrderFront`. Falls back to the normal window API if the
/// panel conversion failed.
fn show_window(app: &AppHandle, win: &WebviewWindow) {
    match app.get_webview_panel(LABEL) {
        Ok(panel) => panel.show(),
        Err(_) => {
            let _ = win.show();
        }
    }
}

fn resign_if_key(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(LABEL) {
        if panel.as_panel().isKeyWindow() {
            panel.resign_key_window();
        }
    }
}

/// Release key focus held by the non-activating HUD panel. Called before
/// explicitly activating the dashboard so the main window can become key.
pub fn release_key_focus(app: &AppHandle) {
    resign_if_key(app);
}

fn hide_window(app: &AppHandle, win: &WebviewWindow) {
    match app.get_webview_panel(LABEL) {
        Ok(panel) => {
            // A non-activating panel can hold key focus without activating the
            // app. Release it before hiding, otherwise the app can become
            // "active" later with no key window (Dock/tray show appears dead).
            if panel.as_panel().isKeyWindow() {
                log::debug!("HUD panel was key; resigning before hide");
                panel.resign_key_window();
            }
            panel.hide();
        }
        Err(_) => {
            let _ = win.hide();
        }
    }
}

/// Pre-build the HUD (hidden) at startup. Building a window activates the app and
/// would steal focus from the user's text field — so we do it once up front,
/// while the dashboard is already frontmost, instead of on the first recording.
pub fn ensure_hud(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    if let Err(e) = build_hud(app) {
        log::error!("failed to pre-build HUD window: {e}");
    }
}

/// Reset the HUD to its passive recording state and show it. Also invalidates
/// any result card still on screen / any timer it left behind.
pub fn show_hud(app: &AppHandle) {
    {
        let state = app.state::<Mutex<HudState>>();
        let mut s = state.lock().unwrap();
        s.next_generation();
        s.pending = None;
    }

    let Some(win) = window(app) else {
        return;
    };
    set_size(&win, BASE_W, BASE_H);
    position(app, &win, BASE_W, BASE_H);
    // Display-only while recording: never blocks clicks on the app behind it.
    let _ = win.set_ignore_cursor_events(true);
    // A new recording must never inherit key focus from a previous result card.
    resign_if_key(app);
    // Order it in WITHOUT focusing, so the user's frontmost text field keeps key
    // focus (critical for injection). We never call set_focus on the HUD.
    show_window(app, &win);
}

/// Hide the HUD and clear/invalidate any pending result.
pub fn hide_hud(app: &AppHandle) {
    {
        let state = app.state::<Mutex<HudState>>();
        let mut s = state.lock().unwrap();
        s.next_generation();
        s.pending = None;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        // Restore click-through so a stale window can never swallow clicks.
        let _ = win.set_ignore_cursor_events(true);
        hide_window(app, &win);
    }
}

/// Grow the HUD into its interactive result-card state and tell the webview to
/// render it. The pending transcript is retained in Rust for `hud_copy_result`.
pub fn show_result(app: &AppHandle, id: i64, text: &str, auto_copied: bool) -> u64 {
    let generation = {
        let state = app.state::<Mutex<HudState>>();
        let mut s = state.lock().unwrap();
        let generation = s.next_generation();
        s.pending = Some(PendingResult {
            id,
            text: text.to_string(),
            generation,
        });
        generation
    };

    let Some(win) = window(app) else {
        return generation;
    };
    set_size(&win, RESULT_W, RESULT_H);
    position(app, &win, RESULT_W, RESULT_H);
    // Interactive: copy + dismiss live in the card.
    let _ = win.set_ignore_cursor_events(false);
    show_window(app, &win);

    let _ = app.emit(
        events::HUD_RESULT,
        HudResult {
            generation,
            auto_copied,
        },
    );
    generation
}

/// Dismiss the card if `generation` is still current. Returns whether it acted.
/// Checking and clearing under one lock prevents a stale dismiss from hiding a
/// newer recording that started in the meantime.
pub fn dismiss_result(app: &AppHandle, generation: u64) -> bool {
    let acted = {
        let state = app.state::<Mutex<HudState>>();
        let mut s = state.lock().unwrap();
        let matches = s
            .pending
            .as_ref()
            .is_some_and(|p| p.generation == generation);
        if matches {
            s.next_generation();
            s.pending = None;
        }
        matches
    };

    if !acted {
        return false;
    }

    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_ignore_cursor_events(true);
        hide_window(app, &win);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_copy_is_scoped_to_its_generation() {
        let mut state = HudState::default();
        let generation = state.next_generation();
        state.pending = Some(PendingResult {
            id: 7,
            text: "hello".into(),
            generation,
        });

        assert_eq!(
            state.pending_for_copy(generation),
            Some((7, "hello".to_string()))
        );
        assert_eq!(state.pending_for_copy(generation + 1), None);
    }
}

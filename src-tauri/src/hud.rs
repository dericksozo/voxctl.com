//! The recording HUD overlay window. A borderless, transparent, always-on-top
//! window pinned bottom-center that NEVER takes focus — so the user's frontmost
//! app stays frontmost (critical for text injection) while recording. Built
//! lazily on first show, then just shown/hidden.

use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "hud";
const W: f64 = 116.0;
const H: f64 = 38.0;
const BOTTOM_MARGIN: f64 = 22.0;

fn position(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let origin = monitor.position();
        let screen_w = size.width as f64 / scale;
        let screen_h = size.height as f64 / scale;
        let origin_x = origin.x as f64 / scale;
        let origin_y = origin.y as f64 / scale;

        let win_size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(
            (W * scale) as u32,
            (H * scale) as u32,
        ));
        let win_w = win_size.width as f64 / scale;
        let win_h = win_size.height as f64 / scale;

        let x = origin_x + (screen_w - win_w) / 2.0;
        let y = origin_y + screen_h - win_h - BOTTOM_MARGIN;
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

fn build_hud(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("hud.html".into()))
        .title("VOXCTL REC")
        .inner_size(W, H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
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

pub fn show_hud(app: &AppHandle) {
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => match build_hud(app) {
            Ok(win) => win,
            Err(e) => {
                log::error!("failed to build HUD window: {e}");
                return;
            }
        },
    };
    // Let mouse events pass through the HUD window so it never blocks clicks on
    // the app behind it. The HUD is display-only — it has no interactive elements.
    let _ = win.set_ignore_cursor_events(true);
    position(app, &win);
    // Order it in WITHOUT focusing, so the user's frontmost text field keeps key
    // focus (critical for injection). We never call set_focus on the HUD.
    let _ = win.show();
}

pub fn hide_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

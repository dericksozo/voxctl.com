//! The recording HUD overlay window. A borderless, transparent, always-on-top
//! window pinned bottom-center that NEVER takes focus — so the user's frontmost
//! app stays frontmost (critical for text injection) while recording. Built
//! lazily on first show, then just shown/hidden.

use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "hud";
const W: f64 = 560.0;
const H: f64 = 70.0;
const BOTTOM_MARGIN: f64 = 84.0;

fn position(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let screen_w = size.width as f64 / scale;
        let screen_h = size.height as f64 / scale;
        let origin_x = pos.x as f64 / scale;
        let origin_y = pos.y as f64 / scale;
        let x = origin_x + (screen_w - W) / 2.0;
        let y = origin_y + screen_h - H - BOTTOM_MARGIN;
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

pub fn show_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
        let _ = win.show();
        return;
    }
    match WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("hud.html".into()))
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
    {
        Ok(win) => {
            position(app, &win);
            let _ = win.show();
        }
        Err(e) => log::error!("failed to build HUD window: {e}"),
    }
}

pub fn hide_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

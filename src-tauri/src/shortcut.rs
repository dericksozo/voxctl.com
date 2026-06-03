//! Global shortcut registration. Toggle mode fires on key-down; Push-to-Talk
//! starts on key-down and stops on key-up (the plugin exposes both Pressed and
//! Released states, so PTT needs no extra dependency). Re-applied whenever the
//! user changes the shortcut or capture mode (via reload_config).

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::commands::audio;
use crate::commands::config::load_config;

pub fn apply_shortcut(app: &AppHandle) {
    let gs = app.global_shortcut();

    // Re-registering while a PTT key is held can orphan the old Released event.
    // Stop first so shortcut churn cannot leave recording stuck on.
    let _ = audio::stop(app);
    let _ = gs.unregister_all();

    let cfg = load_config(app);
    let accel = cfg.shortcut.clone();
    let ptt = cfg.capture_mode == "ptt";

    let res = gs.on_shortcut(accel.as_str(), move |app, _shortcut, event| {
        match event.state() {
            ShortcutState::Pressed => {
                if ptt {
                    let _ = audio::start(app);
                } else {
                    let _ = audio::toggle(app);
                }
            }
            ShortcutState::Released => {
                if ptt {
                    let _ = audio::stop(app);
                }
            }
        }
    });

    if let Err(e) = res {
        log::error!("failed to register shortcut '{accel}': {e}");
    } else {
        log::info!("registered shortcut '{accel}' (ptt={ptt})");
    }
}

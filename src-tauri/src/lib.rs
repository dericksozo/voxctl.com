//! VOXCTL Tauri app builder. Keeps `main.rs` minimal; this owns plugin
//! registration, the menu-bar tray, and the command surface.

mod audio_pipeline;
mod commands;
mod events;
mod file_transcribe;
mod history;
mod hud;
mod lang_detect;
mod platform;
mod registry;
mod resample;
mod retry;
mod shortcut;
mod transcription;
mod xai_live;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use commands::audio::RecorderState;

/// Bring the main dashboard window to the foreground (used by the tray and the
/// Dock re-open). The window is only hidden (not destroyed) when its close
/// button is clicked, so we re-show it and activate the app so it comes to
/// front — `show()`/`set_focus()` alone don't re-activate a backgrounded app.
fn show_main(app: &tauri::AppHandle) {
    platform::macos::activate_app();
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show VOXCTL", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit VOXCTL", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = Image::from_bytes(include_bytes!("../icons/tray/64x64.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("VOXCTL")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,voxctlcom=debug"),
    )
    .try_init();

    // rustls 0.23 requires a process-wide crypto provider before any TLS
    // (the realtime WebSocket). Install ring once.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(RecorderState::default())
        .manage(commands::modes::ActiveModeState::default())
        .manage(retry::RetryState::default())
        .setup(|app| {
            app.manage(history::init(app.handle())?);
            // Move any pre-multi-provider OpenAI key to its per-provider account.
            commands::config::migrate_legacy_openai_key();
            setup_tray(app.handle())?;
            shortcut::apply_shortcut(app.handle());
            // Build the recording HUD up front (hidden) so the first record just
            // shows it — building it lazily during recording stole focus.
            hud::ensure_hud(app.handle());

            // Auto-switch the active Mode as the frontmost app changes. The
            // notification fires on the main thread, so the callback only enqueues
            // a tick; the debouncer coalesces bursts and runs the recompute (AX
            // walk included) off the main thread (perf §3.1).
            let on_app_switch = commands::modes::spawn_app_switch_debouncer(app.handle().clone());
            platform::macos::observe_app_switches(on_app_switch);

            // Retry failed transcriptions in the background (and reconcile any
            // rows interrupted mid-transcription on a previous run).
            retry::spawn(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep VOXCTL alive in the menu bar when the dashboard is closed;
            // it stays reachable from the tray (brief: "sits in the menu bar all
            // day"). Use the tray's Quit to actually exit.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::reload_config,
            commands::config::has_api_key,
            commands::config::set_api_key,
            commands::config::delete_api_key,
            commands::config::provider_status,
            commands::registry::get_registry,
            commands::registry::refresh_registry,
            commands::modes::list_modes,
            commands::modes::save_mode,
            commands::modes::delete_mode,
            commands::modes::set_mode_enabled,
            commands::modes::get_active_mode,
            commands::modes::get_default_mode_id,
            commands::modes::pin_mode,
            commands::modes::unpin_mode,
            commands::modes::set_default_mode,
            commands::modes::bootstrap_default_mode,
            commands::audio::start_recording,
            commands::audio::stop_recording,
            commands::audio::set_recording_language,
            commands::permissions::get_permissions,
            commands::permissions::request_microphone,
            commands::permissions::request_accessibility,
            commands::permissions::request_notification_permission,
            commands::permissions::open_permission_settings,
            commands::history::list_history,
            commands::history::delete_recording,
            commands::history::delete_recordings,
            commands::history::toggle_favorite,
            commands::history::increment_copy,
            commands::history::read_audio,
            commands::history::storage_stats,
            commands::history::purge_recordings,
            commands::transcription::retranscribe,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the Dock icon when no window is visible (macOS) re-opens
            // the dashboard — same as the tray's Show.
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}

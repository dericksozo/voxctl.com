//! Microphone + Accessibility permission status, prompts, and System Settings
//! deep-links. Real TCC checks via the platform module.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::platform::macos;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub microphone: macos::MicPermission,
    pub accessibility: bool,
}

#[tauri::command]
pub fn get_permissions() -> PermissionStatus {
    PermissionStatus {
        microphone: macos::microphone_status(),
        accessibility: macos::accessibility_trusted(),
    }
}

/// Request microphone access via AVFoundation and report the resulting status.
/// Blocking (waits for the user to answer the system prompt), so it runs off the
/// main thread to avoid freezing the UI. A denied status cannot be re-prompted —
/// the caller should route the user to System Settings.
#[tauri::command]
pub async fn request_microphone() -> macos::MicPermission {
    tauri::async_runtime::spawn_blocking(macos::request_microphone_access)
        .await
        .unwrap_or_else(|_| macos::microphone_status())
}

/// Show the Accessibility prompt and register the app in the list.
#[tauri::command]
pub fn request_accessibility() -> bool {
    macos::prompt_accessibility()
}

/// Ensure macOS notification permission, prompting once if it hasn't been
/// decided yet. Called when the user turns ON "auto-switch alerts" in Settings,
/// so the system prompt is tied to that explicit action (notifications are OFF
/// by default and never prompt on their own). Returns true if granted.
#[tauri::command]
pub fn request_notification_permission(app: AppHandle) -> bool {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let n = app.notification();
    let state = n.permission_state().unwrap_or(PermissionState::Prompt);
    let state = if matches!(state, PermissionState::Granted) {
        state
    } else {
        n.request_permission().unwrap_or(PermissionState::Denied)
    };
    matches!(state, PermissionState::Granted)
}

#[tauri::command]
pub fn open_permission_settings(app: AppHandle, which: String) -> Result<(), String> {
    let url = match which.as_str() {
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    };
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

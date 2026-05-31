//! Microphone + Accessibility permission status, prompts, and System Settings
//! deep-links. Real TCC checks via the platform module.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::commands::audio;
use crate::platform::macos;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub microphone: bool,
    pub accessibility: bool,
}

#[tauri::command]
pub fn get_permissions() -> PermissionStatus {
    PermissionStatus {
        microphone: macos::microphone_authorized(),
        accessibility: macos::accessibility_trusted(),
    }
}

/// Trigger the microphone prompt (if undetermined) and report the resulting
/// status. The user may need to re-check after responding to the dialog.
#[tauri::command]
pub fn request_microphone() -> bool {
    if macos::microphone_authorized() {
        return true;
    }
    audio::trigger_mic_prompt();
    macos::microphone_authorized()
}

/// Show the Accessibility prompt and register the app in the list.
#[tauri::command]
pub fn request_accessibility() -> bool {
    macos::prompt_accessibility()
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

//! Commands exposing the provider/model registry to the frontend. One source of
//! truth: the webview never bundles its own copy — it reads whatever the backend
//! resolves (cached remote override, else bundled fallback).

use tauri::AppHandle;

use crate::registry::{self, Registry};

/// The effective registry (cached remote copy if present, else bundled).
#[tauri::command]
pub fn get_registry(app: AppHandle) -> Registry {
    registry::effective(&app)
}

/// Best-effort remote refresh: fetch the remote registry and cache it as the
/// override. On any failure, silently return the current effective registry so
/// the UI always gets a usable result.
#[tauri::command]
pub async fn refresh_registry(app: AppHandle) -> Registry {
    match registry::fetch_remote().await {
        Ok(reg) => {
            registry::cache(&app, &reg);
            reg
        }
        Err(e) => {
            log::warn!("registry refresh failed, keeping bundled/cached: {e}");
            registry::effective(&app)
        }
    }
}

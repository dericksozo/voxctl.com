// Typed wrappers around Tauri `invoke`. One place to see the whole backend
// command surface. Commands are filled in across slices; all exist as Rust
// stubs from slice 1 so the UI never hits a missing-command runtime error.

import { invoke } from "@tauri-apps/api/core";
import type { Config, HistoryItem, Mode, PermissionStatus } from "./types";

// --- API key (macOS Keychain, Rust-owned) ---
export const hasApiKey = () => invoke<boolean>("has_api_key");
export const setApiKey = (key: string) => invoke<void>("set_api_key", { key });
export const deleteApiKey = () => invoke<void>("delete_api_key");

// --- Permissions / onboarding ---
export const getPermissions = () => invoke<PermissionStatus>("get_permissions");
export const openPermissionSettings = (which: "microphone" | "accessibility") =>
  invoke<void>("open_permission_settings", { which });
export const requestMicrophone = () => invoke<boolean>("request_microphone");
export const requestAccessibility = () => invoke<boolean>("request_accessibility");

// --- Recording control ---
export const startRecording = () => invoke<void>("start_recording");
export const stopRecording = () => invoke<void>("stop_recording");
export const setRecordingLanguage = (language: string | null) =>
  invoke<void>("set_recording_language", { language });

// --- Modes ---
export const listModes = () => invoke<Mode[]>("list_modes");
export const saveMode = (mode: Mode) => invoke<void>("save_mode", { mode });
export const deleteMode = (id: string) => invoke<void>("delete_mode", { id });
export const setModeEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_mode_enabled", { id, enabled });
export const getActiveMode = () => invoke<Mode | null>("get_active_mode");

// --- History ---
export const listHistory = () => invoke<HistoryItem[]>("list_history");
export const deleteRecording = (id: number) => invoke<void>("delete_recording", { id });
export const toggleFavorite = (id: number) => invoke<boolean>("toggle_favorite", { id });
export const incrementCopy = (id: number) => invoke<number>("increment_copy", { id });
export const retranscribe = (id: number, language: string | null) =>
  invoke<string>("retranscribe", { id, language });
/** Returns the recording's WAV bytes for in-webview playback. */
export const readAudio = (id: number) => invoke<number[]>("read_audio", { id });

// --- Config (also persisted JS-side via the store; this re-reads Rust's view) ---
export const getConfig = () => invoke<Config>("get_config");
export const reloadConfig = () => invoke<void>("reload_config");

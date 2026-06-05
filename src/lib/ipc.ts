// Typed wrappers around Tauri `invoke`. One place to see the whole backend
// command surface. Commands are filled in across slices; all exist as Rust
// stubs from slice 1 so the UI never hits a missing-command runtime error.

import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveMode,
  Config,
  HistoryItem,
  Mode,
  PermissionStatus,
  StorageStats,
} from "./types";
import type { ProviderId, ProviderStatus, Registry } from "./registry";

// --- Provider/model registry (bundled + remote override, Rust-owned) ---
export const getRegistry = () => invoke<Registry>("get_registry");
export const refreshRegistry = () => invoke<Registry>("refresh_registry");

// --- Per-provider API keys (macOS Keychain, Rust-owned) ---
export const hasApiKey = (provider: ProviderId) =>
  invoke<boolean>("has_api_key", { provider });
export const setApiKey = (provider: ProviderId, key: string) =>
  invoke<void>("set_api_key", { provider, key });
export const deleteApiKey = (provider: ProviderId) =>
  invoke<void>("delete_api_key", { provider });
/** Per-provider key status ("validated" | "none") for the UI. */
export const providerStatus = () => invoke<ProviderStatus>("provider_status");

// --- Permissions / onboarding ---
export const getPermissions = () => invoke<PermissionStatus>("get_permissions");
export const openPermissionSettings = (which: "microphone" | "accessibility") =>
  invoke<void>("open_permission_settings", { which });
export const requestMicrophone = () => invoke<boolean>("request_microphone");
export const requestAccessibility = () => invoke<boolean>("request_accessibility");
/** Prompt for macOS notification permission (tied to enabling alerts). */
export const requestNotificationPermission = () =>
  invoke<boolean>("request_notification_permission");

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
export const getActiveMode = () => invoke<ActiveMode | null>("get_active_mode");
/** Manually pin a mode (sticky across app switches until unpinned). */
export const pinMode = (id: string) => invoke<void>("pin_mode", { id });
export const unpinMode = () => invoke<void>("unpin_mode");
/** Designate the priority-3 fallback (non-deletable) mode. */
export const setDefaultMode = (id: string) => invoke<void>("set_default_mode", { id });

// --- History ---
export const listHistory = () => invoke<HistoryItem[]>("list_history");
export const deleteRecording = (id: number) => invoke<void>("delete_recording", { id });
export const deleteRecordings = (ids: number[]) => invoke<void>("delete_recordings", { ids });
export const toggleFavorite = (id: number) => invoke<boolean>("toggle_favorite", { id });
export const incrementCopy = (id: number) => invoke<number>("increment_copy", { id });
/** Re-run a saved recording through a chosen (file-capable) mode. */
export const retranscribe = (id: number, modeId: string) =>
  invoke<string>("retranscribe", { id, modeId });
/** Returns the recording's WAV bytes for in-webview playback. */
export const readAudio = (id: number) => invoke<number[]>("read_audio", { id });

// --- Storage ---
export const storageStats = () => invoke<StorageStats>("storage_stats");
export const purgeRecordings = (olderThanDays: number, keepFavorites: boolean) =>
  invoke<number>("purge_recordings", { olderThanDays, keepFavorites });

// --- Config (also persisted JS-side via the store; this re-reads Rust's view) ---
export const getConfig = () => invoke<Config>("get_config");
export const reloadConfig = () => invoke<void>("reload_config");

// Shared data shapes mirrored on the Rust side (serde camelCase).

export type CaptureMode = "toggle" | "ptt";

/** Non-secret settings, persisted via tauri-plugin-store (settings.json).
 *  The OpenAI API key is NOT here — it lives in the macOS Keychain (Rust-only). */
export interface Config {
  captureMode: CaptureMode;
  /** Accelerator string understood by the global-shortcut plugin, e.g. "Alt+Space". */
  shortcut: string;
  sfxEnabled: boolean;
  /** Copy the final transcript to the system clipboard. Default OFF (brief §4). */
  copyToClipboard: boolean;
  notifyOnModeSwitch: boolean;
  /** UI locale, e.g. "en". */
  appLocale: string;
  /** Forced transcription language (ISO-639-1) or null = model auto-detect. */
  defaultLanguage: string | null;
}

export const DEFAULT_CONFIG: Config = {
  captureMode: "toggle",
  shortcut: "Alt+Space",
  sfxEnabled: true,
  copyToClipboard: false,
  notifyOnModeSwitch: true,
  appLocale: "en",
  defaultLanguage: null,
};

export interface Mode {
  id: string;
  name: string;
  enabled: boolean;
  /** ISO-639-1 code or "auto". */
  language: string;
  /** Keyword/vocabulary steering (best-effort). */
  keywords: string[];
  /** Frontmost-app names that auto-activate this mode (reliable match). */
  triggerApps: string[];
  /** Website domains that auto-activate this mode (best-effort via AX). */
  triggerWebsites: string[];
  /** Transcription model id. v1 = "gpt-realtime-whisper". */
  model: string;
  builtin: boolean;
}

export interface HistoryItem {
  id: number;
  /** Unix milliseconds. */
  createdAt: number;
  transcript: string;
  language: string;
  modeName: string;
  appName: string | null;
  website: string | null;
  durationSecs: number;
  words: number;
  favorite: boolean;
  copyCount: number;
  /** Absolute path to the stored WAV (read via a Rust command for playback). */
  audioPath: string;
}

export interface PermissionStatus {
  microphone: boolean;
  accessibility: boolean;
}

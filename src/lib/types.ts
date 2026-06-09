// Shared data shapes mirrored on the Rust side (serde camelCase).

import type { Capabilities } from "./registry";

export type CaptureMode = "toggle" | "ptt";
/** What `×` removes: "both" (entry + audio) or "transcript" (entry, keep WAV). */
export type DeleteBehavior = "both" | "transcript";

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
  /** What `×` removes from a recording. */
  deleteBehavior: DeleteBehavior;
  /** First-run onboarding is complete once mic/key/first recording are done. */
  onboardingCompleted: boolean;
  /** User skipped the optional Accessibility step during onboarding. */
  accessibilitySkipped: boolean;
}

export const DEFAULT_CONFIG: Config = {
  captureMode: "toggle",
  shortcut: "Alt+Space",
  sfxEnabled: true,
  copyToClipboard: false,
  notifyOnModeSwitch: false,
  appLocale: "en",
  defaultLanguage: null,
  deleteBehavior: "both",
  onboardingCompleted: false,
  accessibilitySkipped: false,
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
  /** Transcription model id (must exist in the registry). */
  model: string;
  /** User-enabled subset of the model's declared capabilities. */
  capabilities: Capabilities;
  builtin: boolean;
}

/** Why a mode is currently active. */
export type ActiveReason = "pinned" | "auto" | "default";

export interface ActiveMode {
  mode: Mode;
  reason: ActiveReason;
}

/** One word with its timing (and speaker, when diarization is on). */
export interface WordStamp {
  word: string;
  start: number;
  end: number;
  speaker?: string;
}

/** A contiguous span attributed to one speaker (diarization output). */
export interface SpeakerSeg {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

/** Lifecycle of a recording's transcription. */
export type RecordingStatus = "transcribing" | "done" | "failed" | "needs_transcription";

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
  status: RecordingStatus;
  /** Registry model id used for this recording (drives cost + re-run). */
  modelId: string;
  /** Size of the saved WAV on disk, in bytes (0 if the file is gone). */
  audioBytes: number;
  /** Wall-clock from recording-stop to final transcript, in ms (0 if unknown). */
  transcriptionMs: number;
  /** Per-word timing (empty unless the mode/model produced word timestamps). */
  wordStamps: WordStamp[];
  /** Speaker-attributed segments (empty unless diarization produced them). */
  speakers: SpeakerSeg[];
}

/** Disk usage of the recordings directory (Storage section). */
export interface StorageStats {
  totalBytes: number;
  fileCount: number;
  recordingCount: number;
}

export interface PermissionStatus {
  microphone: boolean;
  accessibility: boolean;
}

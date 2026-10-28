// Shared data shapes mirrored on the Rust side (serde camelCase).

import type { Capabilities } from "./registry";

export type CaptureMode = "toggle" | "ptt";
/** How a finished transcript is delivered. */
export type DeliveryMode = "review" | "paste" | "clipboard";
/** Automatic audio retention. Only the stored WAV is removed for recordings
 *  that fall outside the policy; transcripts are always kept. */
export type AutoDeletePolicy =
  | "never"
  | "keep_latest_5"
  | "after_3_days"
  | "after_2_weeks"
  | "after_3_months";

/** Non-secret settings, persisted via tauri-plugin-store (settings.json).
 *  The OpenAI API key is NOT here — it lives in the macOS Keychain (Rust-only). */
export interface Config {
  captureMode: CaptureMode;
  /** Accelerator string understood by the global-shortcut plugin, e.g. "Alt+Space". */
  shortcut: string;
  sfxEnabled: boolean;
  /** Post-transcription delivery. Default: review card (no auto-paste). */
  deliveryMode: DeliveryMode;
  /** Only meaningful for `deliveryMode === "paste"`: also copy to clipboard. */
  alsoCopy: boolean;
  notifyOnModeSwitch: boolean;
  /** UI locale, e.g. "en". */
  appLocale: string;
  /** Automatic audio-retention policy (transcripts are never auto-deleted). */
  autoDeletePolicy: AutoDeletePolicy;
  /** First-run onboarding is complete once mic/key/first recording are done. */
  onboardingCompleted: boolean;
}

export const DEFAULT_CONFIG: Config = {
  captureMode: "toggle",
  shortcut: "Alt+Space",
  sfxEnabled: true,
  deliveryMode: "review",
  alsoCopy: false,
  notifyOnModeSwitch: false,
  appLocale: "en",
  autoDeletePolicy: "never",
  onboardingCompleted: false,
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
export type RecordingStatus =
  | "recording"
  | "transcribing"
  | "done"
  | "failed"
  | "needs_transcription";
export type AudioStatus = "capturing" | "saving" | "ready" | "failed" | "purged";

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
  /** Absolute path to the stored WAV; empty once audio has been purged. */
  audioPath: string;
  status: RecordingStatus;
  /** Registry model id used for this recording (drives cost + re-run). */
  modelId: string;
  /** Size of the saved WAV on disk, in bytes (0 if the file is gone). */
  audioBytes: number;
  audioStatus: AudioStatus;
  /** Wall-clock from recording-stop to final transcript, in ms (0 if unknown). */
  transcriptionMs: number;
  /** Per-word timing. Empty in list payloads — fetched via getHistoryDetail on
   *  expand (gated by hasWordStamps). */
  wordStamps: WordStamp[];
  /** Speaker-attributed segments. Empty in list payloads — see wordStamps. */
  speakers: SpeakerSeg[];
  /** Whether word-level timestamps exist (gates the STAMPS tab; array loads lazily). */
  hasWordStamps: boolean;
  /** Whether speaker info exists — segments or word-level labels (gates SPEAKERS tab). */
  hasSpeakers: boolean;
  /** 4-char random hex ID (e.g. "A7F3") generated at recording start.
   *  Rendered as VX-0x{hexId} in the UI. Absent for pre-existing recordings. */
  hexId?: string;
}

/** Lazily-fetched structured detail for one recording (the arrays the list omits). */
export interface HistoryDetail {
  wordStamps: WordStamp[];
  speakers: SpeakerSeg[];
}

/** Disk usage of the recordings directory (Storage section). */
export interface StorageStats {
  totalBytes: number;
  fileCount: number;
  recordingCount: number;
}

/** What the active audio-retention policy would purge right now. */
export interface AudioCleanupPreview {
  count: number;
  bytes: number;
}

/** What an explicit "clean up now" pass actually removed. */
export interface AudioCleanupResult {
  count: number;
  freedBytes: number;
}

export interface PermissionStatus {
  /** Microphone TCC state. Only "authorized" means capture is allowed. */
  microphone: MicStatus;
  accessibility: boolean;
}

/** Microphone TCC authorization state, mirrored from Rust `MicPermission`. */
export type MicStatus = "notDetermined" | "restricted" | "denied" | "authorized";

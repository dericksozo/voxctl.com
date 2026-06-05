// Tauri event names emitted by the Rust backend. Centralized so the (high
// frequency) mic-level event can be subscribed to by a single leaf component.

export const EVT = {
  /** ~50-100ms cadence while recording: { db, peak } in 0..1. High frequency. */
  micLevel: "voxctl:mic-level",
  /** Recording lifecycle: { recording: boolean, language: string | null }. */
  recState: "voxctl:rec-state",
  /** Final transcript on stop: { text }. */
  transcriptFinal: "voxctl:transcript-final",
  /** Active mode changed (auto-switch or manual): { id, name }. */
  modeChanged: "voxctl:mode-changed",
  /** History table changed; UI should refetch: {}. */
  historyChanged: "voxctl:history-changed",
  /** User changed language from the HUD picker: { language: string | null }. */
  langChanged: "voxctl:lang-changed",
  /** Non-fatal backend error surfaced to the UI: { stage, message }. */
  error: "voxctl:error",
} as const;

export interface MicLevel {
  db: number;
  peak: number;
}
export interface RecState {
  recording: boolean;
  language: string | null;
}
export interface ModeChanged {
  id: string;
  name: string;
}
export interface BackendError {
  stage: string;
  message: string;
}

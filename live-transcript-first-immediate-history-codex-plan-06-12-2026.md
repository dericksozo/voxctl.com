 # Live Transcript First + Immediate History Card Plan

  ## Summary

  Refactor recording lifecycle so the Home/History screen updates immediately when the shortcut starts recording, and live-model transcript delivery is
  never blocked by WAV archival work.

  Implementation must happen on a separate branch: fix/live-transcript-first.

  Target behavior:

  - Pressing the recording shortcut immediately creates/updates a gray pending card on Home.
  - The card moves through recording/transcribing/saving states using the existing History card styling as much as possible.
  - For live models, transcript availability is the priority: emit/inject/show transcript as soon as the live session can produce usable text.
  - WAV save/resample runs independently and must not delay transcript display, injection, copy, or card expansion.
  - Frontend changes must be minimal and based on current main; do not replace or refactor existing History/Home UI structure.

  ## Key Changes

  - Create a real history row at recording start, after capture has successfully started:
      - status = "recording".
      - audio_status = "capturing".
      - empty transcript.
      - duration/audio bytes initially 0.
      - reserved target WAV path.
      - emit history-changed immediately so Home shows the gray pending card.

  - Extend statuses:
      - RecordingStatus: add "recording".
      - New audioStatus: "capturing" | "saving" | "ready" | "failed".
      - DB migration: add audio_status TEXT NOT NULL DEFAULT 'ready'.

  - On stop:
      - update duration immediately.
      - set status = "transcribing".
      - set audio_status = "saving".
      - emit history-changed.

  - For live models:
      - run transcript finalization and WAV archival concurrently.
      - transcript success updates transcript fields and sets status = "done" even if audio_status is still "saving".
      - audio success later sets audio_status = "ready" and fills audio_bytes.
      - audio failure sets audio_status = "failed" without changing successful transcript status.

  - For file-only models:
      - keep the necessary WAV-first transcription flow, but still show the recording card immediately at start.
      - after stop, save WAV, then transcribe file, updating the same existing row.

  ## UX Behavior

  - Use the existing gray placeholder/pending card behavior for empty transcript states.
  - Add only small status handling:
      - "recording" preview text like “Recording…”.
      - "transcribing" remains the current gray transcribing state.
      - audio saving state disables playback and shows a compact “saving audio” label near playback metadata.
      - audio failed state disables playback and shows “audio unavailable”.

  - Transcript actions must be independent from audio:
      - Copy works once transcript text exists.
      - Expanded text/timestamp/speaker tabs work once transcript data exists.
      - Play remains disabled until audioStatus === "ready".

  - Do not redesign HistoryPanel or HomePanel. Make precise additions to current status rendering and playback disable logic only.

  ## Live Finalization

  - Add a live finalization grace period, default 2s.
  - xAI live:
      - continue streaming audio during capture.
      - on stop, send audio.done.
      - wait up to 2s for transcript.done.
      - if final arrives, use it.
      - if final does not arrive but the accumulator has non-empty committed/preview text, return that best-available transcript immediately.
      - if no usable text exists, keep the existing longer timeout/error behavior.

  - OpenAI realtime:
      - apply the same best-available-after-2s behavior after the final commit has been sent.

  - Log whether transcript completion used provider-final output or best-available timeout output.

  ## Backend Implementation Notes

  - Add history helpers:
      - reserve row at recording start.
      - update duration/status on stop.
      - update transcript result independently.
      - update audio archive result independently.

  - Store the active history row id/path in recorder state while recording.
  - Empty capture behavior:
      - if capture returns no samples, delete the just-created pending row and hide HUD.

  - Deletion safety:
      - if a user deletes a row while audio archival is still running, the archive task must not recreate it.
      - if it writes a WAV for a deleted row, remove that orphan file.

  - Startup reconciliation:
      - rows stuck in "recording" or "transcribing" from a crash become "failed" or "needs_transcription" using existing retry rules.
  ## Test Plan

  - Backend tests:
      - migration adds audio_status defaulting to "ready".
      - recording-start reservation creates a pending row without writing WAV.
      - stop updates duration and audio/transcription states.
      - transcript update can mark row done while audio remains saving.
      - audio update later marks ready and fills bytes.
      - empty capture removes the pending row.
      - read_audio returns a friendly error for capturing/saving/failed audio.
      - live finalization covers provider-final, best-available after 2s, and no-text timeout paths.

  - Frontend tests/checks:
      - TypeScript build passes with new statuses.
      - History card renders "recording" and "saving audio" states.
      - Copy works when transcript exists even if audio is still saving.
      - Play is disabled until audio is ready.

  - Manual acceptance:
      - Start recording from shortcut while Home is visible: gray card appears immediately.
      - Stop a long grok-stt-live recording: transcript appears/injects quickly, before WAV archival if archival is still running.
      - Repeat with gpt-realtime-whisper.
      - Confirm file-only xAI mode still transcribes correctly.
      - Confirm no existing frontend layout/design changes are reverted.

  ## Assumptions

  - A real persisted row at recording start is preferred over a frontend-only optimistic placeholder because it keeps all app windows and refreshes
    consistent.

  - The pending card should use minimal additions to the existing card/status system, not a redesigned UI.
  - Best-available live text after a 2s grace period is acceptable for live models when provider-final output is delayed.
  - No open questions are blocking implementation.

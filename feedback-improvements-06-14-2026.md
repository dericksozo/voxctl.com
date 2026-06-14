# VOXCTL Improvement Backlog — Transcript Digest (2026-06-14)

Structured breakdown of an informal voice transcript covering three improvement areas: storage format efficiency, crash-resilient audio persistence, and recording elapsed-time UI. Each section states the problem, current behavior, desired outcome, constraints, and open decisions.

---

## Executive summary

| # | Theme | Core ask |
|---|--------|----------|
| 1 | **Storage format** | Replace or supplement uncompressed WAV with a more space-efficient format that still works across OpenAI, xAI, and Gemini file transcription. |
| 2 | **Never lose audio** | If the app crashes, is killed (e.g. dev hot-reload), or otherwise dies mid-recording, the user must retain recoverable audio — at minimum enough to re-run through a file-capable mode and get a transcript. |
| 3 | **Recording timer** | While a recording is in progress, show elapsed time somewhere visible — either on the in-flight history card or in the app footer (alongside the existing INPUT meter and UTC clock). |

These three items are independent but interact: a more efficient on-disk format (§1) makes incremental persistence during recording (§2) cheaper; the timer UI (§3) depends on the backend already creating a history row at record-start (which it does today).

---

## 1. More cost-effective audio storage format

### Problem statement

VOXCTL stores every recording as an uncompressed **mono PCM16 WAV at 24 kHz**. That is simple and universally accepted, but wasteful for a speech-to-text app — we are not producing music or mastering audio, we only need enough fidelity for accurate transcription and optional playback.

The transcript suggests exploring **Opus** or **OGG** (or similar) as a smaller on-disk representation while keeping quality adequate for STT.

### Current implementation

- **On disk:** one `.wav` per recording under the app recordings directory (`rec-{timestamp}-{n}.wav`), path stored in SQLite (`history.rs`).
- **At stop:** raw f32 samples captured in memory are resampled to 24 kHz PCM16, encoded into a WAV container, and written once (`audio_pipeline.rs` → `archive_audio_now` → `history::encode_wav`).
- **At upload:** all three file transcribers send WAV today:
  - **OpenAI:** multipart `audio.wav` / `audio/wav` (`file_transcribe.rs`)
  - **xAI:** multipart `file` (WAV bytes, filename `audio.wav`)
  - **Gemini:** inline base64 with `mimeType: "audio/wav"`

### Desired outcome

- **Smaller files** on disk (less storage, faster writes, less I/O on re-run).
- **No regression** in transcription accuracy for typical dictation / meeting capture.
- **Single format** (or a very small set) used for both local storage and provider upload — avoid maintaining parallel encode paths per provider unless the registry already models that cleanly.

### Provider compatibility (decision gate)

Before choosing a format, verify what each provider accepts for **file** transcription:

| Provider | Known today in VOXCTL | Likely broader support (needs live verification) |
|----------|----------------------|--------------------------------------------------|
| OpenAI | WAV only in our code | API docs list mp3, mp4, mpeg, mpga, m4a, wav, webm |
| xAI | WAV multipart | Confirm supported MIME types / extensions in current xAI STT docs |
| Gemini | WAV inline | Gemini file/inline audio supports multiple MIME types (wav, mp3, etc.) |

**Opus** is often carried in **OGG** (`.ogg`) or **WebM** (`.webm`) containers. **WebM+Opus** may be the strongest cross-provider candidate if all three accept it; otherwise a pragmatic fallback is **keep WAV for upload, compress for local storage only** (decode/re-encode on re-run) — but that adds complexity and CPU.

### Format evaluation criteria

1. **Transcription quality** — speech-optimized bitrate (e.g. Opus `voip` or `audio` mode, 24–32 kbps) is usually sufficient for STT; test with real recordings across all three providers.
2. **Encode/decode cost** — encoding must not slow the stop→transcript path; incremental encoding during capture (§2) must stay off the audio callback hot path.
3. **Seek / partial write** — formats that support chunked append or easy truncation help crash recovery.
4. **Playback** — the history panel plays audio back in-app; the chosen format must be decodable in the Tauri/Rust playback path (or transcoded on read).
5. **Migration** — existing `.wav` files should remain readable; new format applies to new recordings (optional background migration is out of scope unless requested).

### Open decisions

- [ ] Pick primary format: **WebM/Opus**, **OGG/Opus**, **AAC/m4a**, or **stay on WAV** with a lighter container tweak.
- [ ] **One format for storage + upload** vs **compress locally, transcode to provider-preferred format on upload**.
- [ ] Whether live streaming paths (OpenAI realtime, xAI WebSocket) need any change — they already send PCM16 frames; format choice mainly affects **archival**, not live wire format.

### Suggested next step

Run a small matrix test: same 2–5 minute recording encoded as WAV, WebM/Opus, and OGG/Opus; upload each to OpenAI, xAI, and Gemini file endpoints; compare transcript quality, upload size, and latency. Document results, then lock the format.

---

## 2. Never lose audio — crash-resilient persistence

### Problem statement

During development (`npm run tauri dev`), the app **shut down unexpectedly while the user was actively recording** (likely due to a code rebuild / hot reload killing the process). The recording was lost.

The user’s requirement is absolute: **audio must survive app faults**. Even if live transcription fails or the process dies, the user should be able to **re-run the saved audio through a file mode** and recover their transcript. Losing a capture because of an app bug or dev reload is unacceptable.

### Current implementation (gap analysis)

**What works today**

- On **normal stop**, the invariant holds: WAV + history row are persisted before / in parallel with transcription (`audio_pipeline.rs` header comment and flow).
- On **record start**, a history row is reserved immediately (`reserve_recording` in `history.rs`): `status = "recording"`, `audio_status = "capturing"`, path reserved, `HISTORY_CHANGED` emitted — so the UI shows a card right away.
- On **startup**, `retry.rs` reconciles interrupted rows:
  - `status` still `"recording"` or `"transcribing"` → moved to `"failed"` (eligible for retry if file exists).
  - `audio_status` `"capturing"` or `"saving"` → if file exists, mark `"ready"`; **if file missing, mark `"failed"`**.

**What fails on crash / kill mid-recording**

1. **Audio lives only in RAM** during capture — `Vec<f32>` in `RecorderState` (`commands/audio.rs`). Nothing is written to the reserved path until **stop** triggers `on_recording_finished` → `archive_audio_now`.
2. **Live modes defer archival** — for OpenAI/xAI live, `archive_audio` runs concurrently with `session.finish()` but still only **after stop**, using the in-memory sample buffer.
3. **Process death** (dev reload, force quit, panic) discards the buffer. On next launch, reconciliation finds **no file** → `audio_status = "failed"`, and retry cannot help because there is nothing to transcribe.
4. **Live transcript text** is also not durably persisted incrementally during capture — if the session dies mid-utterance, even partial live text may be lost (secondary to audio, but related).

### Desired outcome

| Scenario | Expected behavior |
|----------|-------------------|
| Normal stop | Unchanged: fast transcript delivery; audio saved reliably. |
| Crash / kill mid-recording | Recoverable audio file on disk (possibly truncated); history row reflects recoverable state; user can manual re-run or auto-retry via file mode. |
| Dev hot-reload | Same as crash — not a special case for users. |
| Live mode | Must not sacrifice perceived speed; incremental disk writes happen off the realtime audio thread. |

**Success criterion:** After any unexpected termination during an active recording, the user finds a history entry with **playable or re-runnable audio** (or a clear “partial recording saved” state), never a silent total loss.

### Architectural directions (performance-aware)

The transcript explicitly asks for updates that stay **“extremely fast and speedy.”** Any design must keep the cpal callback cheap (downmix + append + optional non-blocking handoff only).

**Option A — Incremental PCM or encoded chunks to disk (recommended baseline)**

- On record start, **create/truncate** the target file immediately (not just reserve the path in DB).
- On a **background writer thread** (fed by the same channel that feeds live streaming), periodically flush audio:
  - *Simplest:* append raw PCM16 frames to a `.pcm` sidecar or a WAV with a **placeholder header** finalized on stop.
  - *With §1:* stream into an Opus/WebM muxer with periodic cluster flush.
- Flush interval: e.g. every 1–2 seconds or every N KB — balance crash window vs I/O.
- On stop: finalize container (WAV header, WebM footer, etc.), update `duration_secs` and `audio_bytes`.
- On crash: next launch, `reconcile_audio_status` detects partial file → mark `audio_status = "ready"` (or new `"partial"`), `status = "needs_transcription"` if stop never ran.

**Option B — Tee live-stream PCM16 to disk**

- The live forwarder already resamples to 24 kHz PCM16 for WebSocket (`StreamResampler` in `commands/audio.rs`). Tee those frames to the archival writer and **skip the second full-buffer resample at stop** (also addresses duplicate work noted in `performance-improvements-06-12-2026.md` §2.1).
- File-only modes still buffer f32 and encode at stop (or use the same tee if a forwarder exists).

**Option C — Periodic full snapshots**

- Less ideal: rewrite entire WAV every N seconds — simple but O(n²) I/O on long recordings; avoid unless encoding is very cheap.

**Transcript durability (optional enhancement)**

- Periodically persist **best-available live transcript** into the history row (or a side table) so even without audio, something is recoverable. Lower priority than audio; audio + re-run is the stated fallback.

### Interaction with existing plans

- **`live-transcript-first-immediate-history-codex-plan-06-12-2026.md`** already separates transcript finalization from WAV archival for live models. Crash resilience **extends** that plan: archival must begin **during** capture, not only after stop.
- **`performance-improvements-06-12-2026.md`** §2.1 (double resample) and §2.2 (WAV copy count) — incremental tee can improve both if designed as one PCM16 stream → disk + network.

### Status / UX implications

Consider extending reconciliation and UI copy for interrupted captures:

| State | Meaning |
|-------|---------|
| `audio_status: "capturing"` + file growing | Recording in progress (new). |
| `audio_status: "partial"` (new?) | Crash recovery — playable truncated file. |
| `status: "needs_transcription"` | Audio OK, no transcript — prompt re-run. |

Playback on partial files may need duration detection from file metadata rather than DB `duration_secs`.

### Open decisions

- [ ] Incremental **raw PCM + finalize on stop** vs **streaming compressed format** (depends on §1).
- [ ] Flush cadence (time vs bytes) and fsync policy (durability vs battery/SSD wear).
- [ ] Whether startup should **auto-queue** partial recordings for file transcription or only surface them for manual re-run.
- [ ] New `audio_status` value for partials vs treating any on-disk bytes as `"ready"`.

### Suggested next step

Prototype **Option B** on a branch: tee PCM16 from the live forwarder to a background writer that flushes every ~1 s; on intentional stop, finalize WAV (or chosen format) and keep the existing pipeline. Kill the process mid-recording and verify the file is playable and re-runnable.

---

## 3. Recording elapsed time in the UI

### Problem statement

When recording starts, a new **history card** appears immediately (gray / “Recording…” state). There is **no visible indication of how long the current recording has been running**. The user cannot see elapsed time anywhere else in the app during capture.

The transcript proposes two placements:

1. **On the in-flight history card** — e.g. live-updating duration next to the timestamp or status chip.
2. **In the footer** — a new footer group that appears while recording, showing elapsed time (alongside the existing INPUT meter and UTC clock in `App.tsx`).

Either location is acceptable; footer may be preferable because it is **always visible** regardless of which panel (Home vs History) is open.

### Current implementation

- **Backend:** `duration_secs` is `0` until stop (`mark_stopped` in `history.rs`). No periodic duration updates during capture.
- **Frontend — history card:** `HistoryPanel.tsx` shows `t("history.recording")` / status chip `"Recording"` for `status === "recording"`; duration column uses `durLabel(item.durationSecs)` which is `0:00` while recording.
- **Frontend — footer:** `VolumeMeter` reacts to `REC_STATE` events; `Clock` shows UTC only. No recording timer.
- **Events:** `REC_STATE { recording: bool, language }` is emitted on start/stop (`commands/audio.rs`) — sufficient to gate a timer UI, but **no tick events** from backend today.

### Desired outcome

- While `recording === true`, display **elapsed time** updating at least once per second, formatted like existing duration labels (`M:SS`).
- When recording stops, the timer freezes and the card shows the final `duration_secs` from the backend (as today).
- No whole-app re-render storm — follow the project convention: high-frequency UI (timer ticks) should live in a **leaf component** with local state or imperative DOM updates (same pattern as `VolumeMeter`).

### Implementation options

**Footer timer (transcript preference)**

- Add a conditional footer group between INPUT and UTC, e.g. `REC` / `01:23`, visible only when `REC_STATE.recording`.
- Implement `RecordingTimer` component: listen for `REC_STATE`, start `setInterval` on start, clear on stop, track `Date.now() - startedAt` (startedAt from first `recording: true` event or a new optional `startedAt` field on `REC_STATE` for accuracy across sleep).

**Card timer**

- For the row where `item.status === "recording"`, run a local interval in that card only (match by `id` or “most recent recording” flag).
- Requires either backend ticks (heavier) or frontend clock from `item.createdAt` — **prefer `createdAt`** so timer survives panel remounts: `elapsed = now - createdAt`.

**Backend assist (optional, more accurate)**

- Emit `RECORDING_TICK { id, elapsed_secs }` every second from Rust, or update `duration_secs` in DB periodically. Probably unnecessary if `createdAt` is trusted.

### Open decisions

- [ ] **Footer only**, **card only**, or **both** (footer for global visibility, card for context in the list).
- [ ] Timer source: **`createdAt` on the history row** vs **`REC_STATE` + client clock**.
- [ ] Copy / styling: match existing `gr-k` label pattern (`REC`, `DURATION`, or reuse `history.statusRecording`).

### Suggested next step

Ship **footer timer** first (smallest diff, always visible): new leaf component subscribed to `REC_STATE`, using the active recording row’s `createdAt` from history state when available. Add card-level elapsed display as a follow-up if footer feels sufficient.

---

## Cross-cutting constraints (from project invariants)

These apply to all three items:

1. **Registry, not special cases** — if format or capability differs by provider, express it in `registry.json` / transcriber factory, not inline `if provider == …` in UI.
2. **Persist before transcribe** — §2 strengthens this for the *during*-recording phase, not only at stop.
3. **Delivery remains end-of-utterance** — §3 is display-only; no change to paste/clipboard timing.
4. **Re-run by mode** — recovered audio must work with existing file-capable mode re-run in `HistoryPanel`.
5. **Performance** — incremental I/O and format encode/decode on `spawn_blocking` / dedicated threads; never block the cpal callback.

---

## Suggested priority / sequencing

| Order | Item | Rationale |
|-------|------|-----------|
| **P0** | §2 Crash-resilient audio | Data loss is the highest-severity bug; dev reload is a common trigger. |
| **P1** | §3 Recording timer | Small UX win, independent, improves trust during long recordings. |
| **P2** | §1 Storage format | Valuable for disk and I/O, but best decided alongside §2’s on-disk writer; run provider format matrix in parallel. |

---

## Acceptance checklist (for sign-off)

### §1 Format
- [ ] Format chosen with evidence from all three providers.
- [ ] New recordings use less disk space than WAV at equal perceived quality.
- [ ] Re-run and playback work without user intervention.
- [ ] Legacy WAV recordings still play and re-run.

### §2 Crash resilience
- [ ] Kill app mid-recording → audio file exists and is transcribable.
- [ ] History row reflects recoverable state after restart.
- [ ] Normal stop latency unchanged within agreed budget (measure stop→transcript).
- [ ] Live mode still feels instant for transcript delivery.

### §3 Timer
- [ ] Elapsed time visible within 1 s of record start.
- [ ] Timer visible on Home and History (if footer-based).
- [ ] Timer stops and matches final duration after stop.

---

## Source transcript (reference)

> We should probably use a more cost-effective file format… Opus or OGG… choose a format that works with all three providers… efficient and good quality.
>
> The app shut down while recording (dev mode, code updating in background). We need to ensure no matter what the app always saves the audio. Live mode isn't completely saving the audio. Update architecture so if it shuts down the user never loses audio — can rerun through file mode. Still extremely fast.
>
> When recording starts, a card appears saying recording. Need elapsed time on the card or in the footer after recording starts.

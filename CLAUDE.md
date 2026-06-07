# CLAUDE.md — VOXCTL Development Brief

VOXCTL is a multi-provider, bring-your-own-key (BYOK) speech-to-text desktop app.
**Stack:** React (TypeScript) + Vite frontend, Tauri v2 + Rust backend. macOS first;
cross-platform later (Keychain, Accessibility, and browser-URL reading are macOS-only for now).

---

## 1. Orientation — read this first

- **The git history is the source of truth for how and why the app got here.**
  Commit messages are written deliberately and describe each step's intent,
  trade-offs, and verification. Before starting work, prefer `git log`,
  `git log --stat`, and reading the relevant commit messages over hunting for
  spec documents — code and history stay current; docs drift.
- Planning/spec docs may exist under `prompts/` and are useful for *historical
  intent*, but treat them as potentially stale. **This file plus the git history
  are the durable references.**
- The architecture overhaul (registry → modes → pipeline → files/storage →
  settings/cost → onboarding) is **built and shipped**. Treat the sections below
  as invariants to preserve, not features to build from scratch.
- When in doubt about *how* something is implemented, read the module map in §4
  and the code; when in doubt about *why*, read the commit that introduced it.

---

## 2. Architecture & mental model

### The registry is the single source of truth
Almost every feature (onboarding gating, model auto-select, Modes, "can't pick a
model without a key," re-run eligibility, capability toggles, cost estimates)
reads from **one provider/model registry**. Build and read from it; **never
special-case a provider inline.** Adding a new model should be a registry entry,
not new branching logic.

- Registry data: `src-tauri/registry.json` (bundled offline fallback; intended to
  be fetched from a remote endpoint so models/pricing/capabilities can change
  without an app update).
- Registry types/logic: `src-tauri/src/registry.rs` (Rust) and
  `src/lib/registry.ts` (frontend), surfaced via `commands/registry.rs`.

### One model, one shape
Every transcription model is one record. The two capabilities that drive UI are
**`canLive`** (stream live audio for dictation) and **`canFile`** (transcribe a
saved file — used for re-run and transcribe-on-stop). A model can be LIVE-only,
FILE-only, or both. Optional flags surface as Mode-editor toggles *only when
present*: `wordTimestamps`, `diarization`, `inverseTextNormalization`,
`multichannel`, plus `languages` and a `costRate`.

### Modes & active-mode resolution
Each mode has **exactly one model** (no capture/re-run pairing). Exactly one mode
is active at any instant, resolved by priority — implemented in
`src-tauri/src/commands/modes.rs`:

| Priority | Source | Wins when |
|:--:|---|---|
| 1 | **Manual pin** | User pinned a mode in the top-bar switcher (sticky until unpinned) |
| 2 | **Auto match** | Frontmost app / URL matches an **enabled** mode's triggers |
| 3 | **Default mode** | Nothing above applies (non-deletable; `language: auto`) |

**Disabled modes never auto-match.** The provider-gated picker only allows models
whose provider has a validated key.

---

## 3. Critical invariants — do not break these

- **Persist WAV + history row BEFORE transcription returns.** If the call fails,
  the recording survives in a re-runnable state. **Never lose a recording to a
  network error.**
- **Delivery is end-of-utterance only.** Write the full transcript once, on stop
  (paste if Accessibility is on, else clipboard). **Never** type word-by-word
  into the focused field — live insertion is explicitly out of scope.
- **Validate every API key on entry, using a zero-cost endpoint where possible.**
  Never run up the user's bill to validate a key. Show per-provider status
  (stored / validated-green / invalid-red).
- **Keys live in the macOS Keychain**, per-provider, never in plaintext.
- **Costs are local estimates only.** `duration × rate` (Gemini: from audio-token
  count). **Never** call providers' billing APIs.
- **Re-run is by MODE, not raw model** — the mode encodes provider/model/options.
  Offer only file-capable modes; if none exist, prompt to create one.
- **Offline queue + retries.** Transient 429/5xx must queue and retry; history
  shows state (recording → transcribing → done / failed / needs-transcription)
  rather than dropping silently.

---

## 4. Module map

**Backend (`src-tauri/src/`)**
- `lib.rs` — Tauri app builder, command registration (`main.rs` is a minimal entry).
- `registry.rs` — provider/model registry types + resolution.
- `commands/modes.rs` — mode CRUD + active-mode resolution (pin > auto > default).
- `commands/registry.rs`, `commands/config.rs` — registry + settings IPC.
- `commands/audio.rs`, `audio_pipeline.rs` — capture flow; routes live vs file by model.
- `file_transcribe.rs` — `FileTranscriber` trait + OpenAI/xAI/Gemini impls + factory.
- `xai_live.rs` — xAI live WebSocket streaming (PCM16 frames).
- `transcription.rs` — OpenAI realtime/live transcription.
- `history.rs` — recordings DB (status + model_id columns, guarded migrations).
- `retry.rs` — background retry worker + startup reconciliation of interrupted rows.
- `commands/permissions.rs`, `commands/inject.rs`, `platform/macos.rs` —
  Accessibility, paste/clipboard injection, frontmost-app + URL reading (macOS).

**Frontend (`src/`)**
- `App.tsx` — shell; gates into onboarding until config + requirements are ready.
- `lib/registry.ts`, `lib/types.ts`, `lib/ipc.ts` — registry mirror, shared types, IPC.
- `panels/` — `HomePanel` (stats + cost), `HistoryPanel` (Files + re-run),
  `ModesPanel` (editor + picker), `SettingsPanel` (sectioned scroll page),
  `OnboardingPanel` (state machine).
- `components/` — `ModeSwitcher` (top-bar active-mode dropdown),
  `ProviderKeyCard` (shared key entry/validate, reused by Settings + onboarding),
  meters/primitives.

---

## 5. Build, test & lint commands

- **Frontend dev:** `npm run dev` (Vite, port 5173)
- **Tauri dev loop:** `npm run tauri dev`
- **Production build:** `npm run tauri build`
- **Frontend build check:** `npm run build`
- **Lint/format (JS/TS):** `npx biome check --write .`
- **Lint/format (Rust):** `cd src-tauri && cargo clippy && cargo fmt`
- **Rust tests:** `cd src-tauri && cargo test` (currently ~53 passing)

**Per-change verification gate (run before considering work done):**
```
cd src-tauri && cargo test && cargo clippy && cargo fmt --check
npm run build
```
Then manually smoke-test with `npm run tauri dev`.

---

## 6. Tauri v2 security & capabilities

- Tauri v2 isolates frontend access to backend features via JSON capabilities.
- **Location:** `src-tauri/capabilities/default.json`.
- **When adding a plugin** (`fs`, `shell`, `dialog`, etc.) you **must** add its
  permission to the capabilities array before using the JS API.
- Example: `"permissions": ["core:path:default", "core:event:default", "fs:allow-write"]`

---

## 7. Coding conventions

- **State management:** keep transient, fast-updating state (dB levels, clocks,
  typewriter effects) in local leaf components. Do not lift it into `App` — it
  causes whole-app re-renders.
- **Process separation:** never process raw mic audio byte-by-byte in the webview.
  Capture/DSP happens in Rust native threads; decimated levels/data are piped to
  the frontend via high-frequency Tauri events (`emit`).
- **Persistence:** transient UI prefs may use the Tauri store, but **durable state
  has a home**: API keys → macOS Keychain; recordings/history → the SQLite-backed
  `history` DB (migrations live in `history.rs`); app config → `settings.json`
  (shared TS + Rust shape). Do not put production secrets or recordings in
  webview `localStorage`.
- **Rust structure:** minimal `main.rs`; app builder + commands in `lib.rs`;
  keep logic modular to support `cargo test`.
- **Comments:** explain non-obvious intent/constraints only; no narration.

---

## 8. Provider reference (live-verified, June 2026)

| Provider | Validation | Live | File |
|---|---|---|---|
| **OpenAI** | `GET /v1/models` (Bearer) | realtime WebSocket (`gpt-realtime-whisper`) | `POST /v1/audio/transcriptions` (whisper-1 → word timestamps) |
| **xAI** | `GET /v1/models` (Bearer) | `wss://api.x.ai/v1/stt` (WebSocket) | `POST https://api.x.ai/v1/stt` (multipart) |
| **Gemini** | `GET /v1beta/models` with **`x-goog-api-key`** header (NOT Bearer; bad key → 400) | separate Live API path | `gemini-2.5-flash:generateContent` + inline base64 audio + "Transcribe this audio" |

Gotchas worth remembering:
- **xAI is a single speech-to-text service — it takes no model-name parameter.**
  The **endpoint URL is what configures the mode**: the WebSocket URL streams
  live, the HTTPS POST URL transcribes a saved file (~$0.20/hr live · ~$0.10/hr
  file). VOXCTL represents this one service as two *internal* registry entries
  (a live one and a file one) only because their capabilities/costs differ — but
  do not send a model name to xAI.
- **Gemini auth is a header (`x-goog-api-key`), not Bearer.**
- **xAI live:** commit only `speech_final` segments to avoid doubled utterances.

---

## 9. Secrets & workflow hygiene

- **`API_KEYS_FOR_TESTING.md` is git-ignored — never stage or commit it.** Live
  tests read keys from env vars exported from that file.
- `prompts/v2/TASK_STATE.md` and planning docs are local/git-ignored status — not
  product code.
- The overhaul followed a **branch-per-step → merge into a holder branch with
  `--no-ff` → pause for sign-off** cadence. Don't auto-merge integration PRs;
  leave them for user review.

---

## 10. Explicitly out of scope (do NOT build unprompted)

- **Post-processing / transcript filters** (filler-word removal, translation,
  RawText→FinalText pipeline).
- **Live word-by-word insertion** into the focused field.
- **Automatic file chunking** for provider size limits.
- **Cross-platform** behavior for macOS-specific features (Keychain, Accessibility,
  URL reading).

# VOXCTL

A fast, low-footprint **macOS voice-to-text** app. Press a global shortcut, speak,
and on stop the transcript is inserted into the focused app — while every recording
(audio + transcript + context) is saved to History. Built with **Tauri v2 + React/TS +
Rust**, using the OpenAI Realtime API (`gpt-realtime-whisper`).

> Status: **v1 dev build** for personal use. Not yet code-signed/notarized
> (see [Signing & notarization](#signing--notarization-later)).

## Quick start

```bash
npm install
npm run tauri dev     # dev: Vite on :1420 + Rust window, logs in the terminal
npm run tauri build   # release: src-tauri/target/release/bundle/macos/VOXCTL.app
```

Requirements: Node, Rust (stable), Xcode Command Line Tools.

1. Launch, open **Settings**, paste your OpenAI API key → **Save** (stored in the
   macOS Keychain, never in plaintext).
2. Grant **Microphone** when prompted (see below).
3. Press **⌥Space** (rebindable), speak, press again to stop. By default a small
   result card appears with **copy** and **dismiss**; choose **Paste** under
   Capture behavior to type transcripts straight into the focused field.

## Permissions (macOS)

VOXCTL uses two TCC permissions; first-run onboarding detects what's missing and
deep-links into System Settings:

- **Microphone** — to capture audio. Required. Declared via `src-tauri/Info.plist`
  (`NSMicrophoneUsageDescription`).
- **Accessibility** — optional, needed for Paste delivery (synthesize keystrokes) and
  for reading the focused browser URL in Mode auto-switching. Review and Copy
  delivery work without it. Checked with `AXIsProcessTrusted()`.

No Automation permission is required — injection uses CGEvent keystrokes, not AppleScript.

> Dev caveat: the unsigned dev binary changes path each build, so macOS may re-ask for
> Accessibility after rebuilds. A signed `.app` makes grants stick.

### Stale permissions after reinstalling

macOS ties Microphone and Accessibility grants to the app's *code identity*. Because
this build is ad-hoc signed, every rebuild/reinstall has a new identity, so macOS can
leave behind stale entries that no longer match the running app. Symptoms: onboarding
keeps re-asking for the Microphone, or System Settings shows Accessibility as "on" but
VOXCTL reports it as not granted.

To clear the stale entries:

```bash
tccutil reset Microphone com.derick.voxctlcom
tccutil reset Accessibility com.derick.voxctlcom
sfltool resetbtm          # clears Background Task Management (often needed for Accessibility)
```

Then relaunch VOXCTL and re-grant. In System Settings → Privacy & Security →
Accessibility, if a "VOXCTL" row is already checked but the app still isn't trusted,
remove that row (select it, press the minus/`-` button) and re-add it.

### API keys and the login keychain

Provider API keys live in one macOS Keychain item (`com.derick.voxctlcom` /
`voxctl.keys`). VOXCTL never reads it interactively during startup: every launch-time
lookup is non-interactive, so launching the app (or checking key status) can never
raise the "wants to use your login keychain" dialog. A keychain dialog is only ever
shown by an explicit **Save key** / **Delete key** action.

Because this build is ad-hoc signed, the item's own ACL is bound to a `cdhash` that
changes on every build. After a rebuild the previously stored key may be unreadable
without re-authorisation; VOXCTL treats that as "no key stored" (rather than popping a
dialog) and you re-add the key once in Settings → Providers, which recreates the item
under the new build. Signing the app with a stable identity removes this step.

If you want to clear the stored key manually:

```bash
security delete-generic-password -s com.derick.voxctlcom -a voxctl.keys
```

## How it works (architecture)

Everything heavy lives in **Rust**; the webview only renders UI and listens to events.

```
src/                      React + TS (Vite)
  App.tsx                 shell: header, nav, footer, panels (low-freq state only)
  components/             Primitives + isolated leaves: Clock, VolumeMeter (canvas/imperative), Typewriter
  panels/                 Home, History, Modes, Settings, Onboarding
  hud/                    separate window: live meter while recording; copy/dismiss result card
  hooks/  lib/  i18n/  styles/
src-tauri/src/
  lib.rs                  app builder: plugins, tray, windows, state, app-switch observer
  commands/
    audio.rs              cpal capture on its own thread; RMS→dB atomic; emits voxctl:mic-level @ ~16Hz
    transcription.rs      retranscribe command (re-runs saved WAV)
    inject.rs             CGEvent Unicode keystroke injection (clipboard untouched)
    modes.rs              presets + CRUD + match_mode + active-mode tracking
    config.rs             store-backed settings + Keychain API key (keyring)
    permissions.rs        mic/accessibility status, prompts, deep-links
    history.rs            (top-level) SQLite metadata + WAV files; always-save
    hud.rs                result-card copy/dismiss commands (transcript lives in Rust)
  transcription.rs        Transcriber trait + OpenAiRealtimeTranscriber (WebSocket, rustls)
  resample.rs             rubato resample → 24kHz mono PCM16
  audio_pipeline.rs       on stop: resample → transcribe → deliver → save (always)
  platform/macos.rs       NSWorkspace frontmost app, AX focused URL, NSSound SFX, app-switch observer
  hud.rs                  builds/positions the transparent, non-activating HUD panel
```

**Core flow:** global shortcut → `audio::start` (open cpal stream, show HUD, resolve Mode
from frontmost app/URL) → speak (dB emitted to UI) → `audio::stop` → `audio_pipeline`
resamples to 24kHz PCM16, streams it to the Realtime API (`input_audio_buffer.append` →
`commit`), reads `…transcription.delta`/`.completed`, injects the final text, and **always**
saves the WAV + a History row (even on failure).

**Performance choices:** the cpal stream is open *only* while recording (idle ≈ 0% CPU, no
mic in use); dB is computed in Rust and emitted as a single event ~16×/s; the
`VolumeMeter`/HUD meter paint to canvas/DOM imperatively (no React reconciliation); the
caret blink is pure CSS (no JS timer). Libraries were picked for low footprint: `cpal`
(native CoreAudio), `tokio-tungstenite + rustls` (no OpenSSL), `keyring` (native Keychain),
`rusqlite` + WAV files (no audio BLOBs in the DB), `rubato` (anti-aliased resample, runs once).

### Transcription layer is swappable

`Transcriber` (in `src-tauri/src/transcription.rs`) is a trait; `OpenAiRealtimeTranscriber`
is the WebSocket impl. Add an offline/local model by implementing the trait and selecting it
in `audio_pipeline`/`retranscribe` — no other code needs to change.

## Adding a locale

1. Copy `src/i18n/locales/en.json` to e.g. `es.json` and translate the values.
2. Register it in `src/i18n/index.ts` (`LOCALES`, `AVAILABLE_LOCALES`).
3. It appears in Settings → App Language. (UI strings only; transcription language is separate.)

## Adding / editing a Mode

A Mode binds **language + keyword steering + triggers** (app and/or website). In the app:
**Modes → Define New Mode**. Programmatically, presets live in `default_modes()` in
`src-tauri/src/commands/modes.rs`. App matching is reliable (NSWorkspace); website matching
is best-effort via the Accessibility API and degrades to app-only when a URL can't be read.

## Resource usage (measured, dev build)

| State | CPU | RAM |
|---|---|---|
| Idle (not recording) | ~0–1% (just the 1 Hz clock) | ~35–45 MB |
| Recording | low (one cpal stream + a 60 ms dB emit loop) | similar |

Release builds are leaner (minified webview, no StrictMode double-render, no HMR socket).
Idle uses no microphone and opens no audio stream.

## Debug logging

VOXCTL can capture raw xAI Grok STT WebSocket traces as JSONL files for
troubleshooting transcription issues (duplication, missing text, etc.).

```bash
# Enable session logging (off by default):
VOXCTL_LOG_SESSIONS=1 npm run tauri dev

# Also enable verbose stderr WS event dump:
VOXCTL_LOG_SESSIONS=1 VOXCTL_WS_DEBUG=1 npm run tauri dev
```

Logs land in `notes/raw-logs/recording-{id}-{hex_id}.jsonl`. Each file contains:

| line type | description |
|---|---|
| `session_start` | recording metadata (id, hex_id, model, URL, sample rate, options) |
| raw WS events | every `transcript.created`, `transcript.partial`, `transcript.done` |
| `acc_snapshot` | accumulator state at each sink fire (committed count, joined chars, full text) |
| `session_end` / `session_error` | final transcript text and char count, or error details |

The `acc_snapshot` lines are the fastest way to spot duplication — if `joined_chars`
suddenly doubles and `joined` contains repeated text, the duplicate threshold is
visible at a glance.

To disable logging, omit the env var: `npm run tauri dev`

## Testing

- `cd src-tauri && cargo test` — resampling, dB mapping, WAV round-trip, history CRUD, mode
  matching, host parsing, realtime `session.update` shape.
- A live transcription test exists but is `#[ignore]`d:
  `OPENAI_API_KEY=… VOXCTL_TEST_WAV=/path.wav cargo test --lib transcription::tests::live_transcribe -- --ignored --nocapture`
  (generate a WAV with `say -o x.aiff "…"; afconvert x.aiff x.wav -f WAVE -d LEI16@24000`).
- Things requiring a mic/permissions/other apps: see [`MANUAL_TEST.md`](./MANUAL_TEST.md).

## Signing & notarization (later)

This dev build is unsigned. For distribution you'll need:
- An Apple **Developer ID Application** certificate.
- `codesign --deep --options runtime` with a **hardened runtime** and entitlements for the
  microphone (`com.apple.security.device.audio-input`) — note the app also uses the
  Accessibility API (user-granted, no entitlement) and CGEvent injection.
- Notarization via `xcrun notarytool submit … --wait` then `xcrun stapler staple VOXCTL.app`.
- Tauri can drive this: set `bundle.macOS.signingIdentity` / `bundle.macOS.entitlements` and
  the `APPLE_*` notarization env vars, then `npm run tauri build`.
- **`app.macOSPrivateApi: true`** (used for the transparent HUD) is incompatible with the Mac
  App Store; it's fine for Developer ID distribution. Swap the HUD to an opaque window if MAS
  is required.

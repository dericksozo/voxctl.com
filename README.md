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
2. Grant **Microphone** and **Accessibility** when prompted (see below).
3. Press **⌥Space** (rebindable), speak, press again to stop. The text types itself
   into whatever app is focused.

## Permissions (macOS)

VOXCTL needs two TCC permissions; first-run onboarding detects what's missing and
deep-links into System Settings:

- **Microphone** — to capture audio. Declared via `src-tauri/Info.plist`
  (`NSMicrophoneUsageDescription`).
- **Accessibility** — to (a) synthesize keystrokes for text injection and (b) read the
  focused browser URL for Mode auto-switching. Checked with `AXIsProcessTrusted()`.

No Automation permission is required — injection uses CGEvent keystrokes, not AppleScript.

> Dev caveat: the unsigned dev binary changes path each build, so macOS may re-ask for
> Accessibility after rebuilds. A signed `.app` makes grants stick.

## How it works (architecture)

Everything heavy lives in **Rust**; the webview only renders UI and listens to events.

```
src/                      React + TS (Vite)
  App.tsx                 shell: header, nav, footer, panels (low-freq state only)
  components/             Primitives + isolated leaves: Clock, VolumeMeter (canvas/imperative), Typewriter
  panels/                 Home, History, Modes, Settings, Onboarding
  hud/                    separate window: REC dot, live dB meter, partial transcript, language picker
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
  transcription.rs        Transcriber trait + OpenAiRealtimeTranscriber (WebSocket, rustls)
  resample.rs             rubato resample → 24kHz mono PCM16
  audio_pipeline.rs       on stop: resample → transcribe → inject → save (always)
  platform/macos.rs       NSWorkspace frontmost app, AX focused URL, NSSound SFX, app-switch observer
  hud.rs                  builds/positions the transparent HUD window
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

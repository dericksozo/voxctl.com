# VOXCTL — Manual Test Checklist

Automated tests (`cargo test`) cover the pure logic: resampling, dB mapping,
WAV round-trip, history CRUD, mode matching, host parsing, the realtime
`session.update` shape, and a live transcription smoke test (ignored by default).
The items below need a real mic, a real OpenAI key, real permissions, and other
apps in focus — so they must be checked by hand on a Mac.

Run the dev build: `npm run tauri dev` (Rust logs print in that terminal).

## 0. First-run permissions
- [ ] On first launch a **PERMISSIONS REQUIRED** banner appears (left column).
- [ ] Click **REVIEW** → the onboarding panel lists Microphone + Accessibility.
- [ ] **Microphone → GRANT** triggers the macOS mic prompt; Allow → re-check shows GRANTED.
- [ ] **Accessibility → GRANT** opens the prompt / System Settings; enable VOXCTL,
      then **RE-CHECK** shows GRANTED and the banner disappears.
- [ ] Header shows `LINK ✓ OK` (accessibility) and `KEY ✓ SET` once a key is saved.

> Dev note: the dev binary is unsigned and its path changes per build, so macOS may
> re-ask for Accessibility after a rebuild, and may attribute the mic prompt to your
> terminal. A signed `.app` (see README) makes these stick.

## 1. API key (Keychain)
- [ ] Settings → paste an OpenAI key → **SAVE** → status flips to `✓ STORED`.
- [ ] Quit and relaunch → key still recognized (`✓ STORED`), value never shown.
- [ ] Confirm it's in the Keychain, not plaintext: `security find-generic-password -s com.derick.voxctlcom` lists it; `grep -r sk- ~/Library/Application\ Support/com.derick.voxctlcom` finds nothing.

## 2. Toggle recording + transcription (core loop)
- [ ] Focus a text field in another app (TextEdit, Notes, a browser box).
- [ ] Press the global shortcut (default **⌥Space**) → the HUD appears bottom-center
      with a pulsing dot + live dB meter; CPU stays low.
- [ ] Speak a sentence. Press the shortcut again to stop.
- [ ] HUD switches to **TRANSCRIBING…**, then the transcript is **typed into the field**.
- [ ] The clipboard is unchanged (paste elsewhere → your old clipboard, not the transcript)
      — with "Copy to clipboard" OFF (default).

## 3. Clipboard toggle
- [ ] Settings → enable **COPY TO CLIPBOARD** → record again → after stop, paste
      elsewhere yields the transcript. (OFF = clipboard never touched.)

## 4. Manual language override (HUD)
- [ ] Start recording → change the language dropdown in the HUD → speak in that language
      → transcript respects the chosen language.

## 5. Push-to-Talk
- [ ] Settings → CAPTURE BEHAVIOR → **PUSH-TO-TALK**.
- [ ] Hold the shortcut while speaking; release → recording stops + transcribes.
- [ ] Toggle back to TOGGLE works as before.

## 6. History
- [ ] After several recordings, History lists them newest-first, grouped by day.
- [ ] **▶ PLAY** plays back the original audio.
- [ ] **⧉ COPY** copies text; the counter increments (1, 2, … 10+) and persists across relaunch.
- [ ] **☆/★ FAV** toggles and persists.
- [ ] **↻ RE-RUN** → pick a language → transcript updates from the saved audio.
- [ ] **✕** deletes the row and its WAV file.
- [ ] Each item shows time, app/website context, language, duration, word count.
- [ ] Pull the plug on transcription (bad key) → recording STILL saved with empty
      transcript so audio isn't lost.

## 7. Modes & auto-switch
- [ ] Modes panel lists the 4 presets (Claude, ChatGPT, Gemini, Language Learning).
- [ ] Create a mode (e.g. trigger app "TextEdit", language ES) → Save.
- [ ] Switch to TextEdit → the **menu-bar (tray) title** updates to that mode,
      the header ACTIVE MODE updates, and (if enabled) a **notification** appears.
- [ ] Switch to a browser on `chatgpt.com` → ChatGPT mode activates (best-effort URL).
      If URL can't be read, it falls back to app-only matching (no crash).
- [ ] Recording while a mode is active tags the History row with that mode + its language.

## 8. Menu bar / lifecycle
- [ ] Tray icon present; left-click shows the dashboard; right-click → Show / Quit.
- [ ] Closing the dashboard window keeps the app running in the tray (Quit from tray exits).
- [ ] Idle (not recording): no mic in use, CPU ≈ 0 (check Activity Monitor).

## 9. Sound effects
- [ ] SFX ON (default): a start cue on record-start, a stop cue on stop.
- [ ] SFX → SILENT: no cues.

## 10. Build
- [ ] `npm run tauri build` produces `src-tauri/target/release/bundle/macos/VOXCTL.app`.
- [ ] The `.app` launches and the above flows work (after granting permissions to it).

# APP Feedback (Round 2)

## Priority Overview
- **P0**: Global shortcut capture does not register new shortcut input.
- **P1**: Main app mic level/input visuals sometimes continue after stopping recording.
- **P1**: History language chip shows `auto` instead of the actual detected/used language.

## Issues

### 1) Global Shortcut Capture Not Working
- **Priority**: P0
- **Area**: Settings / shortcut configuration
- **Observed behavior**: Clicking to capture a new global shortcut does not register key input.
- **Expected behavior**: After entering capture mode, the app should detect and save the pressed shortcut combination.
- **Status**: Needs fix
- **Suggested verification**:
  - Enter shortcut capture mode.
  - Press a valid key combination.
  - Confirm the captured shortcut appears in UI and persists.

### 2) Main App Mic Input Continues After Stop (Intermittent)
- **Priority**: P1
- **Area**: Recording state + main app input indicator
- **Observed behavior**: After stopping recording, the main app (not HUD) sometimes still shows mic activity (pink input blocks).
- **Expected behavior**: On stop, all recording/input visualization tied to active capture should stop immediately.
- **Status**: Intermittent; retest after fix
- **Suggested verification**:
  - Start recording and speak.
  - Stop recording.
  - Confirm all input indicators stop in both HUD and main app.
  - Repeat multiple times to catch intermittent behavior.

### 3) History Language Chip Incorrectly Displays `auto`
- **Priority**: P1
- **Area**: History list metadata chips
- **Observed behavior**: Last chip often displays `auto`.
- **Expected behavior**: Chip should display the actual language used/detected in the transcription result, never the literal selection label `auto`.
- **Implementation note**: If source setting is `auto`, resolve and store/render the returned language from streaming/API result.
- **Status**: Needs fix
- **Suggested verification**:
  - Run transcriptions with language set to `auto`.
  - Open history.
  - Confirm each item shows detected/actual language value (for example `en`, `ja`, etc.), not `auto`.

## Next Implementation Order
1. Fix global shortcut capture (P0).
2. Fix recording stop state sync for main app input indicator.
3. Fix history language chip rendering/data source for auto-detect mode.
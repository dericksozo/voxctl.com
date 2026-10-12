# Investigation: Onboarding re-asks for Microphone, and Accessibility "looks on" but isn't

## TL;DR

Both symptoms are the same underlying problem: **macOS TCC permissions (Microphone
and Accessibility) are keyed to the app's code identity, and this app is ad-hoc
signed**, so every rebuild/reinstall produces a new code identity. After repeated
uninstall/reinstall cycles, macOS is left with stale TCC entries that reference an
old identity, while the freshly installed binary is untrusted:

- **Microphone**: `microphone_authorized()` reports the *current* binary's grant,
  which is missing after a reinstall, so onboarding keeps re-prompting. There are
  also two small bugs that make the "GRANT" button behave like a no-op: the
  prompt is fired with a `cpal` stream hack instead of the AVFoundation request,
  and the command re-reads status synchronously *before* the user answers the
  dialog (its return value is ignored anyway).
- **Accessibility**: the System Settings entry persists after uninstall and still
  shows the toggle "on" for the *old* binary, but `AXIsProcessTrusted()` returns
  `false` for the new one. `prompt_accessibility()` won't present a fresh prompt
  while an entry already exists, so the user is stuck.

Fixing it means (1) giving the app a stable signing identity and (2) teaching the
onboarding UI to distinguish "denied" from "not-yet-asked" from "stale identity",
instead of treating everything as a single boolean.

---

## Symptom

1. During first-run onboarding the Microphone step keeps asking for permission.
   The user grants it, but the step never flips to "GRANTED" — it looks like the
   grant was ignored.
2. The Accessibility step shows a System Settings entry that is already checked
   "on" (left over from a previous install/uninstall), but the app reports it as
   not granted and text injection doesn't work.
3. Both are reported after uninstalling and reinstalling the app many times.

## Evidence

The packaged binary is ad-hoc signed, with no Team ID and a content-derived
CDHash that changes on every build:

```
$ codesign -dv src-tauri/target/release/bundle/macos/VOXCTL.app
Executable=.../VOXCTL.app/Contents/MacOS/voxctlcom
Identifier=voxctlcom-7e794abb46ba5d2f
Format=app bundle with Mach-O thin (arm64)
Signature=adhoc
TeamIdentifier=not set
flags=0x20002(adhoc,linker-signed)

$ codesign -dvvv ... | grep -E "Identifier|TeamIdentifier|CDHash="
Identifier=voxctlcom-7e794abb46ba5d2f
CDHash=56dd9ad70797bacbf7eb4fe03894406dd8a99f14
TeamIdentifier=not set
```

Note the Mach-O `Identifier` is a *generated* name (`voxctlcom-<random>`), not the
configured bundle id — while the bundle's `Info.plist` correctly carries
`CFBundleIdentifier = com.derick.voxctlcom`. The ad-hoc signature binds to the
binary's `CDHash`, which changes each build.

There are also **two copies of the app** on this machine, both currently the same
build (same CDHash) but diverging across reinstall cycles:

```
/Applications/VOXCTL.app
src-tauri/target/release/bundle/macos/VOXCTL.app
```

The `NSMicrophoneUsageDescription` is present and correctly merged into the
bundle (confirmed via PlistBuddy), so the mic prompt itself is not crashing on a
missing usage description.

(`TCC.db` could not be read directly — `com.apple.TCC` requires Full Disk Access
— so the stale-entry contents were inferred, not dumped. See Verification.)

---

## Root cause

### 1. Ad-hoc signing → TCC identity changes every build (the real bug)

macOS TCC records a grant against the app's *designated requirement* (its code
signing identity). For an ad-hoc signature the DR is effectively just the
`CDHash`, so a reinstall (or even a rebuild) produces a new identity that TCC has
never seen:

- `macos::accessibility_trusted()` (`src-tauri/src/platform/macos.rs:8`) calls
  `AXIsProcessTrusted()`, which checks the **current** binary — `false` when the
  identity changed.
- `macos::microphone_authorized()` (`src-tauri/src/platform/macos.rs:29`) calls
  `AVCaptureDevice::authorizationStatusForMediaType(AVMediaTypeAudio)`, which
  again reflects the **current** binary's decision — `NotDetermined` after a
  reinstall.

The TCC *database* still holds the old entry (stored under
`com.derick.voxctlcom`), which is why System Settings shows the app as already
granted. The running process just isn't the identity that grant was made to.

This is the exact same root cause as the earlier keychain-prompts investigation:
an ad-hoc-signed app can't hold a durable macOS security grant. See
`INVESTIGATION-keychain-password-prompts.md`.

### 2. Accessibility: stale entry blocks the re-prompt

- The Accessibility list entry survives uninstall (macOS does not remove it when
  the `.app` is deleted). It stays "on" but points at the old CDHash.
- `prompt_accessibility()` (`src-tauri/src/platform/macos.rs:14`) uses
  `AXIsProcessTrustedWithOptions(kAXTrustedCheckOptionPrompt = true)`. Because an
  entry already exists for this bundle id, macOS does not present a fresh prompt
  — the user cannot re-grant for the new identity without manually removing the
  stale entry (toggle it off/on, delete the row, or `tccutil reset`).
- The onboarding UI only has a boolean (`perms.accessibility`), so it can't
  explain this to the user; it just shows "NEEDS ATTENTION" and a GRANT button
  that re-runs the same no-op prompt.

### 3. Microphone: prompt is a `cpal` hack + status read happens too early

`request_microphone()` (`src-tauri/src/commands/permissions.rs:29`):

```rust
pub fn request_microphone() -> bool {
    if macos::microphone_authorized() {
        return true;
    }
    audio::trigger_mic_prompt();      // opens a cpal input stream for 300 ms
    macos::microphone_authorized()    // read while the dialog is still up
}
```

Three problems:

1. The prompt is triggered by briefly opening a **cpal input stream**
   (`trigger_mic_prompt`, `src-tauri/src/commands/audio.rs:564`) rather than the
   AVFoundation `requestAccessForMediaType` call. It works the first time status
   is `NotDetermined`, but once status is `Denied`, opening a stream does **not**
   re-present the TCC prompt — TCC never re-prompts after a denial. So the GRANT
   button becomes a silent no-op.
2. `trigger_mic_prompt()` sleeps 300 ms and returns, then the command immediately
   re-reads `microphone_authorized()` — while the user is *still looking at the
   dialog*. It returns `false`, and that return value is ignored by the caller
   (`grantMic()` in `src/panels/OnboardingPanel.tsx:90` ignores the boolean).
3. Recovery is supposed to come from the 1500 ms poll loop
   (`src/App.tsx:228-237`), but that only re-reads status — it can't make a grant
   recorded against a *different* identity appear. So if the identity is stale,
   the step never turns green no matter how many times the user clicks GRANT.

### 4. Frontend can't distinguish the failure modes

The whole permission model is two booleans:

- Rust `PermissionStatus { microphone: bool, accessibility: bool }`
  (`permissions.rs:11`), TS `PermissionStatus { microphone: boolean; accessibility: boolean }`
  (`types.ts:149`).

So onboarding can't tell the difference between "not asked yet", "denied",
"granted", and "stale identity", and therefore can't show the correct remedy.
`grantMic`/`grantAccessibility` also discard the `request_*` boolean return
(`OnboardingPanel.tsx:90-114`), so the UI never learns whether the prompt was
shown at all.

Related dead code: `Config.accessibilitySkipped` / `accessibility_skipped`
(`types.ts:31`, `config.rs:43`) is no longer used — Accessibility is now a
required gate (see the comment at `OnboardingPanel.tsx:116`).

---

## Proposed fixes (not yet applied)

### Primary — stabilize the code identity

1. **Sign the app** with a stable identity (Developer ID for distribution, or a
   fixed self-signed certificate for local dev). A stable designated requirement
   means TCC grants survive rebuilds/reinstalls, and System Settings stops
   accumulating stale "VOXCTL" rows. This is the same fix recommended in the
   keychain investigation; `bundle.macOS.signingIdentity` (or the
   `APPLE_SIGNING_IDENTITY` env var) goes in `src-tauri/tauri.conf.json`.
2. **Document the stale-entry recovery** for already-affected machines:
   - `tccutil reset Microphone com.derick.voxctlcom`
   - `tccutil reset Accessibility com.derick.voxctlcom`
   - `sfltool resetbtm` (clears Background Task Management, often needed for
     Accessibility to fully reset)
   - or manually remove the "VOXCTL" row(s) from System Settings → Privacy &
     Security → Accessibility, then re-grant.

### Code-level robustness

3. **Use AVFoundation for the mic request.** Replace the `cpal` prompt hack with
   `AVCaptureDevice::requestAccessForMediaType(AVMediaTypeAudio, …)` (async). This
   makes the prompt and the status check the same TCC path, returns the
   authoritative result *after* the user answers, and correctly reports `Denied`
   vs `NotDetermined`.
4. **Return an enum, not a bool, from `get_permissions` / `request_*`.** For the
   mic expose `NotDetermined | Authorized | Denied | Restricted` (Accessibility
   can stay a bool via `AXIsProcessTrusted`). Mirror it in `types.ts`.
5. **Drive onboarding from that enum** (`OnboardingPanel.tsx`):
   - `NotDetermined` → "GRANT" may prompt.
   - `Denied` → show "DENIED — use SYSTEM SETTINGS", and **stop re-prompting**
     (the GRANT button should deep-link instead of re-prompting).
   - `Authorized` but the step still shows stale → treat as granted (this is the
     identity-mismatch case; guide the user to remove the stale System Settings
     entry and re-grant).
   - Act on the `request_*` return value instead of ignoring it.
6. **Accessibility stale-entry guidance**: when `accessibility_trusted()` is false
   but the user reports the toggle is already on, surface the "remove the old
   VOXCTL entry / run `tccutil reset Accessibility`" instructions in the
   onboarding step rather than only a GRANT button that can't do anything.
7. **Cleanup**: remove the dead `accessibility_skipped` field (Rust + TS) since
   Accessibility is mandatory.

### Defense-in-depth

8. The onboarding poll (`App.tsx:228`) is correct but only helps when the grant
   applies to the *running* identity. Once identity churn is fixed (fix 1) it is
   sufficient; keep it. Optionally also re-check on a short delay *after* the
   `request_*` command resolves (the TCC grant may land a beat after the dialog
   dismisses).

---

## Verification

To reproduce and confirm without Full Disk Access:

1. Confirm signing: `codesign -dvvv src-tauri/target/release/bundle/macos/VOXCTL.app`
   → expect `Signature=adhoc`, `TeamIdentifier=not set`.
2. Confirm stale entries (requires granting the terminal Full Disk Access, or
   reading manually):
   `sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "select service, client, auth_value from access where client like '%voxctl%';"`
   → expect multiple rows for `com.derick.voxctlcom` across
   `kTCCServiceMicrophone` / `kTCCServiceAccessibility` after repeated installs.
3. Reproduce the stuck onboarding: uninstall (`rm -rf /Applications/VOXCTL.app`),
   rebuild, reinstall, launch → Mic re-prompts despite a prior grant; Accessibility
   shows "on" in System Settings but `get_permissions` reports `false`.
4. Recovery check: run the `tccutil reset` commands above, re-grant, and confirm
   onboarding proceeds (with the enum + AVFoundation fixes from #3-#5 in place).
5. After fix 1 (signing), rebuild twice and confirm the grant survives the second
   build (no re-prompt).

## Files involved

- `src-tauri/src/platform/macos.rs:8` — `accessibility_trusted()` (`AXIsProcessTrusted`).
- `src-tauri/src/platform/macos.rs:14` — `prompt_accessibility()`.
- `src-tauri/src/platform/macos.rs:29` — `microphone_authorized()`.
- `src-tauri/src/commands/permissions.rs:11` — `PermissionStatus` (booleans).
- `src-tauri/src/commands/permissions.rs:29` — `request_microphone()` (cpal hack + early read).
- `src-tauri/src/commands/audio.rs:564` — `trigger_mic_prompt()`.
- `src/App.tsx:71` — `perms` initial state; `src/App.tsx:228` — poll loop.
- `src/panels/OnboardingPanel.tsx:90-114` — `grantMic` / `grantAccessibility`
  (ignore the request result).
- `src/lib/types.ts:149` — `PermissionStatus`; `src/lib/ipc.ts:30-37` — IPC wrappers.
- `src/lib/types.ts:31` + `src-tauri/src/commands/config.rs:43` — dead
  `accessibility_skipped`.
- `src-tauri/tauri.conf.json:5` — `identifier` (no macOS signing config set).

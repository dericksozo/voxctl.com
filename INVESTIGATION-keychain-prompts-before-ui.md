# Investigation: VOXCTL still asks for the Keychain password 5–6× and does it *before* the UI renders

## TL;DR

The previous keychain fix (PR #38, `e1af31c`) reduced the number of **distinct**
keychain items from four to one, but it did **not** reduce the number of interactive
keychain *reads at launch* to zero, and it did **not** address *signing*. Both
surviving root causes are still live, and together they produce exactly the reported
behaviour:

1. **The legacy keychain item that VOXCTL creates is ACL-pinned to a code-signing
   `cdhash`, and this app is ad-hoc signed, so the pin is different on every build.**
   macOS therefore does not recognise the freshly built binary as the item's owner,
   raises an *ACL partition mismatch*, and shows the login-password dialog. Clicking
   "Always Allow" writes the current `cdhash` into the partition list, but the next
   `npm run tauri build` produces a new `cdhash`, so the approval is dead on arrival.
   This was **confirmed on this machine**: the existing `voxctl.keys` item's ACL
   partition list literally contains `cdhash:56dd9ad7…`, while the currently installed
   app is `cdhash:40c51911…`.

2. **The app reads the keychain during startup, before the webview shows anything.**
   `migrate_legacy_keys()` runs synchronously inside Tauri's `.setup()` (which runs
   before the window is presented / the React UI is rendered), and
   `provider_status()` is invoked from `App.tsx`'s mount effect. Every one of those
   secret *reads* is an independent interactive access, so a launch can produce
   several "wants to use your login keychain" dialogs — and the first one appears
   before the app UI has drawn.

Because ad-hoc signing + the **legacy file-based keychain** is the combination that
makes the read interactive in the first place (see §Root cause), the durable fix is
code-level: **make every keychain access non-interactive and defer the ones that
don't need to happen at launch until the user explicitly asks for them.** Signing is
still required for a clean, zero-prompt experience, but #504-style non-interactive
reads are what stop the pre-render dialog.

---

## Why the previous fix did not work

PR #38 said, accurately, "one keychain read on launch → one prompt". That model was
wrong in two ways that the follow-up (PR #39) did not touch, because it was scoped to
TCC permissions, not the keychain:

- It assumed **one read = one prompt**. In reality the prompt count is one per
  *interactive keychain access*, and (per §Why the count is 5–6) the launch still
  performs more than one, and every one of them is interactive while the item's
  partition is pinned to a stale `cdhash`.
- It assumed the read could happen safely at startup. The **legacy keychain API has
  no "don't prompt" mode**, so a read during `.setup()` or the first React effect
  will show the dialog *before* the UI is on screen. The read has to be avoided or
  made non-interactive — collapsing four items into one only changed the prompt
  count downward, not to zero.

Also note the earlier investigations were written against an *inferred* cause
("ad-hoc can't persist Always Allow"). That inference is now confirmed with hard
evidence below, which changes the fix set.

---

## Evidence (measured on this machine, 2026‑10‑12)

### The app is ad-hoc signed; the item's ACL is pinned to an *old* cdhash

```
$ codesign -dvvv /Applications/VOXCTL.app | grep -E "Signature|TeamIdentifier|CDHash"
Signature=adhoc
TeamIdentifier=not set
CDHash=40c519119e81d8763613ace2ff143de56da77e28

$ codesign -d -r- /Applications/VOXCTL.app
# designated => cdhash H"40c519119e81d8763613ace2ff143de56da77e28"
```

`src-tauri/tauri.conf.json` has **no** `bundle.macOS.signingIdentity` and no
entitlements, so `npm run tauri build` always produces this ad-hoc signature.

Dumping the existing keychain item's access control list (`SecKeychainItemCopyAccess`
→ `SecAccessCopyACLList` → `SecACLCopyContents`, decoding the partition plist) shows
the pin:

```
ACL count: 5
  ACL desc=com.derick.voxctlcom
  ACL desc=com.derick.voxctlcom  trustedApps=[/Applications/VOXCTL.app]
  ACL desc=56a482efb37e708ef068d7f1a9497b4761cb7833d1ad27296384c4e8e3428eaa
  ACL desc=<hex>  -> plist { Partitions = [ "cdhash:56dd9ad70797bacbf7eb4fe03894406dd8a99f14" ] }
  ACL desc=com.derick.voxctlcom  trustedApps=[]
```

- The only item is `service=com.derick.voxctlcom, account=voxctl.keys` in
  `login.keychain-db` (the per-provider `voxctl.*` and legacy `openai_api_key`
  accounts are gone — migration did run).
- **Partition = `cdhash:56dd9ad7…`**, but the running build is `cdhash:40c51911…`.
  The item is bound to a previous build; the current one is a stranger to it.

`56dd9ad7…` is the exact cdhash recorded in the first investigation doc — i.e. this
item has now outlived several rebuilds, each one a fresh identity, each one getting
re-prompted and re-writing a new pin that the next build invalidates.

### The terminal `security` tool does **not** reproduce it

`security find-generic-password` and a small `keyring`-based program both read the
item here without prompting, because those callers are self-consistent readers of the
open ACL this item currently has. That is a red herring: the *real* app is a different
identity than the item's pin, which is the whole problem.

### This is a known, documented macOS behaviour — not VOXCTL-specific

- `cachix/secretspec#438` ("macOS prompts for password after every upgrade"): the
  `keyring` crate uses `SecKeychainAddGenericPassword`/`FindGenericPassword`, whose
  default ACL binds the item to the creating binary's **code signature**; ad-hoc/Nix
  builds get a `cdhash:` that changes on every build, so every upgrade re-prompts.
  Their measured ACL shows `Partitions = ['cdhash:…']`.
- `nguyenphutrong/quotio#447`: reproducible `securityd` log lines
  `ACL partition mismatch: client cdhash:<…>` → `asking user about XARA partition`
  → `displaying keychain prompt`, *and* the key confirmation — the user reports
  "it did ask for the password about 3 times at startup, once for each of my accounts".
  Their shipped fix (#466/#504) was to **make background credential reads
  non-interactive** and skip the credential silently when access isn't already
  granted; signing/notarization was tracked as a separate improvement.
- Apple docs for the deprecated `SecKeychainAddGenericPassword`: "sets the initial
  access rights for the new keychain item so that the application creating the item
  is given trusted access."

---

## Root cause

### 1. Legacy keychain ACL partition is pinned to a per-build cdhash (the interactive part)

VOXCTL stores keys through the **`keyring` crate's `apple-native` backend**, which
calls the deprecated `SecKeychainFindGenericPassword` / `SecKeychainAddGenericPassword`
(confirmed: `src-tauri/Cargo.toml:33`, `keyring-3.6.3/src/macos.rs` →
`security-framework`'s `os/macos/passwords.rs`). The item created this way carries:

- an **ACL partition list** (`kSecACLAuthorizationPartitionID`) — for an ad-hoc binary,
  a single `cdhash:<build>`; and
- a trusted-application list that, even when "open", is *not* the binding gate —
  the partition is.

macOS evaluates the partition on **every secret read**. The current build's `cdhash`
matches none of `teamid:` / `apple:` / `apple-tool:` / the stored `cdhash:`, so every
read is a partition mismatch → password dialog. "Always Allow" adds the current
`cdhash`, but the next build changes it. There is **no user-side workaround** that
survives rebuilds (`security set-generic-password-partition-list`, manually editing
Access Control in Keychain Access — all tested by the upstream reports and all
fail after a rebuild).

### 2. Keychain reads happen at startup, so the prompt precedes the UI

Two separate launch-time reads of the secret exist:

| When | Code path | Interactive? |
|---|---|---|
| Tauri `.setup()` — **before the window/UI is shown** | `lib.rs:96` → `config::migrate_legacy_keys()` → `config.rs:302` → `entry.get_password()` (line 306) | yes (read) |
| Frontend mount effect | `src/App.tsx:121` `refreshProviders()` → `provider_status()` → `config.rs:163` → `refresh_keys()` → `load_all_keys()` → `entry.get_password()` | yes (read) |

There are more `get_api_key()`/`load_all_keys()` call sites that can each become an
independent interactive access if the cache is cold or the flow runs at the wrong time:
recording start (`commands/audio.rs:329`), file pipeline (`audio_pipeline.rs:129`),
transcription (`commands/transcription.rs:51`), retry worker (`retry.rs:97`), plus
`set_api_key`/`clear_key` (`config.rs:242`, `272`) which do a read-modify-write on
every save/delete.

`.setup()` is the important one for "before the UI": Tauri runs it while building the
app, ahead of presenting the main webview, so the very first dialog appears over a
not-yet-rendered (or empty) app. That is a direct consequence of reading the keychain
in `migrate_legacy_keys()` rather than deferring it.

### Why the count is 5–6 (not 1)

The code intends a single read (the `KEY_CACHE`), but several things defeat it at
launch, and each interactive read is a separate dialog:

1. `migrate_legacy_keys()` reads the item (setup) — prompt/access #1.
2. `provider_status()` reads it again via `refresh_keys()` (mount) — #2. The cache
   only gets populated as a side effect of a read; `provider_status` runs before any
   `get_api_key()` call and so pays its own read.
3. Any other cold-cache `get_api_key()` path (recording start, retries, re-runs)
   pays its own read.
4. In `npm run tauri dev`, `React.StrictMode` (`src/main.tsx:8`, `src/hud/main.tsx:8`)
   double-invokes mount effects, doubling the mount-time read.
5. Once the ad-hoc `cdhash` mismatches the pin, **none** of these reads is satisfied
   by a durable grant, so the dialog is not suppressed between them.

That is enough independent interactive accesses to total the observed 5–6, and the
first of them (`.setup()`) lands before the UI is visible.

> Note on the two investigation docs' "one read → one prompt": the count of prompts
> tracks the number of *interactive accesses*, not the number of *items*. Consolidating
> items was necessary but not sufficient.

---

## What the fix needs to do (two independent requirements from the user)

1. **Never prompt before the UI is rendered, and never prompt until the user clicks
   something that actually needs a key.** → stop reading the secret during `.setup()`
   and the initial mount; when a status check is needed for the UI, it must be
   **non-interactive** (it may return "unknown / needs key" instead of popping a dialog).
2. **At most one prompt, ever, and only from an explicit user action.** → an explicit
   "save key / use key" action is the only place a dialog is allowed, and a correctly
   signed build removes even that.

---

## Proposed fix (nothing applied yet)

### Primary — make all keychain access non-interactive; defer the rest (code fix)

The `keyring` crate gives no control over the prompt, so this means talking to the
Keychain directly (add `security-framework` as a dependency, or extend the existing
platform layer). Two shapes, in order of preference:

1. **Use the data-protection keychain** (`kSecUseDataProtectionKeychain = true`,
   modern `SecItemAdd`/`SecItemCopyMatching`). It keys items by *authorisation tags/
   access group*, not by the legacy ACL partition list, so it is stable across
   rebuilds **when the app is properly signed**. It also supports
   `kSecUseAuthenticationUIFail`, which makes a read that *would* prompt return
   `errSecInteractionNotAllowed` **instead of showing a dialog** — exactly the
   "silently check, never block the UI" primitive this needs. Migrate the existing
   `voxctl.keys` blob into it once, on first explicit key use.
   (Gated on signing; see "Signing" below.)
2. **Keep the legacy keychain but forbid the dialog.** `SecKeychainSetUserInteractionAllowed(false)`
   makes a partition-mismatched read return an error rather than presenting a dialog.
   Wrapping every non-user-initiated access in it guarantees "no prompt before the UI
   / no prompt on launch", at the cost of the UI temporarily showing "key needed"
   until the user acts. This works *today* on the ad-hoc build.

Concretely:

- **Remove the secret read from `migrate_legacy_keys()`** (or run it lazily, on the
  first explicit key action), so `.setup()` never touches the keychain.
- **Make `provider_status()` non-interactive.** It only needs *presence*, not the
  secret. Read item **attributes** only (no `kSecReturnData`) — that does not decrypt
  and does not hit the ACL — or read with interaction disallowed and treat failure as
  "none". Either way it can run at mount with zero dialogs, so onboarding still knows
  whether a key exists.
- **Keep the in-memory cache**, and ensure the first *real* secret read happens only
  from an explicit user gesture (entering a key, clicking to use a provider, or
  starting a recording *after* onboarding). That gesture is the only place a dialog
  may appear.
- If the data-protection keychain is adopted, add `kSecUseAuthenticationUIFail` to
  every startup/background read so they can never block on a dialog.

### Signing — required for the "one-click, then never again" experience

Even with the code fix, an ad-hoc build cannot hold a durable grant. To get a stable
partition (or the data-protection keychain), sign with a **stable identity**:

- **Local/dev (recommended, so this stops happening on this machine):** create a
  fixed self-signed code-signing certificate once and set
  `bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json` (or
  `APPLE_SIGNING_IDENTITY`). *Caveat to verify during implementation:* if a self-signed
  identity still yields a `cdhash:` partition (no Team ID), the data-protection
  keychain (which needs no Team ID, only a real signature) is the path that actually
  stops re-prompting; the legacy partition fix needs a **Developer ID** (`teamid:`).
- **Distribution:** Developer ID Application + notarization (already planned in the
  README's "Signing & notarization (later)"). A `teamid:` partition is honoured across
  launches **and** updates.

Because which of these fully removes the prompt depends on Apple's partition/data-
protection rules for the chosen identity, the code fix (non-interactive + deferred) is
what should land first and is what actually satisfies "never before the UI".

### One-time recovery for the already-affected machine

The current `voxctl.keys` item is pinned to a dead cdhash. After the code fix, the
user must re-save the key once (Delete + Save in Settings / onboarding) so the item is
recreated under the new scheme. Optionally provide an in-app "Reset stored keys"
action, or document:

```bash
security delete-generic-password -s com.derick.voxctlcom -a voxctl.keys
```

---

## Verification plan (for the eventual fix)

1. **No pre-render prompt:** launch the packaged app with a stored key and confirm no
   dialog appears before the dashboard/onboarding is on screen. (Today a dialog fires
   from `.setup()`.)
2. **No launch prompt at all after the fix:** launch with a stored key and confirm
   *zero* dialogs until you click a provider/recording action.
3. **At most one prompt on the explicit action:** delete the key, click "Save"/"GRANT"
   for a provider, allow once; confirm subsequent launches are silent for that build.
4. **Cross-rebuild:** rebuild (`npm run tauri build`), reinstall, relaunch, confirm the
   grant survives with the signing solution in place (and that the item partition is
   `teamid:`/data-protection rather than `cdhash:` — re-run the `SecAccessCopyACLList`
   dump).
5. **Regression:** `provider_status()` still reports validated/none correctly for
   onboarding gating, and recording/transcription can read the key from cache on the
   hot path without a dialog.
6. **Confirm the diagnosis independently:** before/after, watch
   `log stream --predicate 'process == "securityd"'` for
   `ACL partition mismatch: client cdhash:<…>` while launching.

---

## Files involved

- `src-tauri/src/lib.rs:96` — `migrate_legacy_keys()` in `.setup()` (reads the secret
  before the UI; must not run interactively at launch).
- `src-tauri/src/commands/config.rs`
  - `121-127` `load_all_keys()` / `140-148` `refresh_keys()` — the interactive read.
  - `163-188` `provider_status()` — should be a non-interactive presence check.
  - `242`/`272` `clear_key()` / `set_api_key()` — read-modify-write on save/delete.
  - `288-295` `get_api_key()` — hot-path access, must be cache-first and non-interactive.
  - `302-338` `migrate_legacy_keys()` — startup read, defer or make non-interactive.
- `src-tauri/Cargo.toml:33` — `keyring = { version = "3", features = ["apple-native"] }`
  (legacy keychain, no prompt control). Add/adopt `security-framework` for the
  non-interactive path.
- `src/App.tsx:118-124` — mount effect that calls `provider_status()` before the UI.
- `src/main.tsx:8`, `src/hud/main.tsx:8` — `React.StrictMode` doubles effects in dev.
- `src-tauri/src/commands/audio.rs:329`, `audio_pipeline.rs:129`,
  `commands/transcription.rs:51`, `retry.rs:97` — further `get_api_key()` call sites.
- `src-tauri/tauri.conf.json:5` — `identifier`; no `bundle.macOS.signingIdentity` set.
- Related prior docs: `INVESTIGATION-keychain-password-prompts.md`,
  `INVESTIGATION-onboarding-permission-staleness.md`.

## External references

- `cachix/secretspec#438` — keyring/legacy-keychain ACL cdhash binding; `-A` is not
  enough because the partition list is the second gate.
- `nguyenphutrong/quotio#447` — `securityd` "ACL partition mismatch" logs; fix was
  non-interactive reads + Developer ID signing tracked separately.
- Apple: `SecKeychainAddGenericPassword` (deprecated) grants trusted access to the
  creating application; ACL partition IDs (`teamid:` / `apple:` / `apple-tool:` /
  `cdhash:`); Keychain data protection (`kSecUseDataProtectionKeychain`,
  `kSecUseAuthenticationUIFail`).

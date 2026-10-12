# Investigation: App asks for the macOS Keychain password 6–7 times on launch

## TL;DR

Two things combine to produce the repeated keychain prompts:

1. **The app is ad-hoc signed, not properly code-signed.** The packaged binary is
   `Signature=adhoc` with no `TeamIdentifier`, so macOS Keychain cannot persist an
   "Always Allow" access decision. Every `SecItemCopyMatching` call re-prompts.
2. **The backend reads the keychain far more times than it needs to.** On a fresh
   launch with three stored keys it performs ~7 separate keychain reads, each of
   which can trigger its own prompt.

Fixing either one alone helps, but doing both is what gets it down to a single
prompt (and, with a signed build, zero prompts after the first "Always Allow").

---

## Symptom

- Every launch prompts for the login/keychain password ~6–7 times before settling.
- Count scales with how many provider keys are stored (OpenAI / xAI / Gemini).
- Happens on the packaged `.app` and, less reliably, in `tauri dev`.

## Root cause

### 1. Ad-hoc signing means macOS can't remember the access grant

```
$ codesign -dv src-tauri/target/release/bundle/macos/VOXCTL.app
Signature=adhoc
Identifier=voxctlcom-7e794abb46ba5d2f
TeamIdentifier=not set
flags=0x20002(adhoc,linker-signed)
```

macOS stores keychain access-control decisions (the "Always Allow" checkbox)
keyed on the app's *designated requirement* (its code-signing identity). An
ad-hoc signature is generated on the fly and carries no Team ID / stable
identity, so the Keychain can't persist a durable grant. The result: every
individual `SecItemCopyMatching`/`SecItemAdd` call re-triggers authorization,
independent of anything the user clicks.

The `keyring` crate (v3.6.3, `apple-native`) is used here with the default
access control — see `keyring-3.6.3/src/macos.rs`, which calls
`security_framework`'s `find_generic_password` / `set_generic_password` directly
with no custom ACL. So the prompt behaviour is entirely driven by the app's
signing state.

### 2. The code reads the keychain ~7× at startup

The relevant code lives in `src-tauri/src/commands/config.rs` and the call
sites in `src-tauri/src/lib.rs` and `src/App.tsx`.

Each `Entry::get_password()` is a separate keychain read:

| # | Trigger | Location | Keychain item read |
|---|---------|----------|--------------------|
| 1 | `migrate_legacy_openai_key()` at setup | `lib.rs:96` → `config.rs:284` | `voxctl.openai` |
| 2 | `provider_status()` → `key_present("openai")` | `App.tsx:102` → `config.rs:149` | `voxctl.openai` |
| 3 | `provider_status()` → `key_present("xai")` | `config.rs:149` | `voxctl.xai` |
| 4 | `provider_status()` → `key_present("gemini")` | `config.rs:149` | `voxctl.gemini` |
| 5–7 | first `get_api_key(provider)` per provider (record/transcribe/retry) | `config.rs:270`, called from `audio.rs:329`, `audio_pipeline.rs:129`, `transcription.rs:51`, `retry.rs:97` | one per provider |

So with all three keys stored, a launch touches the keychain ~7 times. With a
locked keychain (or ad-hoc signing) each read is its own prompt — matching the
"6 or 7 times" report exactly.

There is already an in-memory cache (`KEY_CACHE`, `config.rs:106`) intended to
avoid keychain hits on the hot path, but `key_present()` / `provider_status()`
and `migrate_legacy_openai_key()` all **bypass it**, so it provides no relief
during startup.

> Note: a read of a *nonexistent* item returns `errSecItemNotFound` and does not
> itself prompt — the prompts come from the items that actually hold a secret.
> That's why the count tracks the number of stored keys.

---

## How to fix

### Fix 1 (root cause) — sign the app properly

Give the app a stable code-signing identity so macOS can persist "Always Allow".

- For distribution: sign with a Developer ID (`APPLE_SIGNING_IDENTITY` /
  `APPLE_CERTIFICATE` env vars, or `bundle.macOS.signingIdentity` in
  `tauri.conf.json`).
- For local/dev: even a self-signed certificate with a fixed designated
  requirement lets the Keychain remember the decision, eliminating the per-access
  prompts. Tauri v2 already wires the `tauri.conf.json` bundle identifier
  (`com.derick.voxctlcom`) into the DR; the keychain service name in
  `config.rs:13` should stay aligned with that identifier.

With a signed app, the user sees the prompt **once** and clicks "Always Allow";
it never appears again.

### Fix 2 (code) — collapse to a single keychain item + reuse the cache

Today there are four separate keychain accounts: the legacy `openai_api_key`
plus `voxctl.openai`, `voxctl.xai`, `voxctl.gemini`. Each is its own item, so it
can't be read in one go.

Refactor `commands/config.rs` to:

1. Store all provider keys in **one** keychain item, e.g. account `voxctl.keys`,
   value a JSON object `{ "openai": "...", "xai": "...", "gemini": "..." }`.
2. Load that single item **once** at startup and populate `KEY_CACHE`; make
   `provider_status()`, `has_api_key()`, and `get_api_key()` all read from the
   cache (falling back to the single item on a cold cache).
3. Make `set_api_key()` / `delete_api_key()` update the single item and then
   invalidate the cache (existing `invalidate_key_cache` already handles this).
4. Fold `migrate_legacy_openai_key()` into that one startup load, so the legacy
   item is read only if the new combined item is absent.

Result: **one** keychain read on launch → **one** prompt, regardless of how many
keys are stored, and no keychain syscalls on the record/transcribe hot path.

### Fix 3 (hygiene) — drop the dead `has_api_key` command

`has_api_key` (`config.rs:127`, exported in `src/lib/ipc.ts:22`) is registered in
`lib.rs:129` but never called by the frontend. Removing it (and its
`key_present` helper, once the cache handles presence) removes a redundant
keychain read and a stale command from the surface.

---

## Recommended order

1. **Fix 2** (single-item + cache): deterministic code fix, no tooling required,
   reduces startup to one logical read even in an unsigned dev build.
2. **Fix 1** (signing): eliminates the *repeated* prompts entirely and is required
   for a release you distribute.
3. **Fix 3** (dead code): small cleanup to keep the command surface honest.

## Files involved

- `src-tauri/src/commands/config.rs` — keychain access, `KEY_CACHE`, all commands.
- `src-tauri/src/lib.rs:96` — `migrate_legacy_openai_key()` at startup.
- `src/App.tsx:101-124` — `refreshProviders()` → `provider_status()`.
- `src-tauri/Cargo.toml:33` — `keyring` v3 `apple-native`.
- `src-tauri/tauri.conf.json` — bundle `identifier` (no macOS signing config set).
- `src-tauri/src/retry.rs:97`, `audio.rs:329`, `audio_pipeline.rs:129`,
  `transcription.rs:51` — `get_api_key()` hot-path call sites.

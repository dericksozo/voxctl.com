//! Keychain access primitives for the single combined provider-key item.
//!
//! All provider keys live in ONE generic-password item (service
//! `com.derick.voxctlcom`, account `voxctl.keys`, value a JSON object). Keeping a
//! single item minimises access; this module's job is to make every **read**
//! non-interactive.
//!
//! Why: the item is created through the legacy (file-based) Keychain, whose ACL
//! binds it to the creating binary's code signature. This app is ad-hoc signed,
//! so that binding is a `cdhash:` that changes on every build. Once the item's
//! partition list no longer matches the running binary, macOS normally pops the
//! login-password dialog on *every secret read* — including reads during startup,
//! before the UI is on screen. `SecKeychainSetUserInteractionAllowed(false)`
//! (wrapped by [`security_framework::os::macos::keychain::SecKeychain::disable_user_interaction`])
//! makes such a read fail with `errSecInteractionNotAllowed` instead of prompting.
//! Result: launch, status checks, and hot-path key lookups can never block on a
//! dialog; a dialog is only ever shown by an explicit save/delete.
//!
//! The user-interaction flag is process-global, so every access is serialised
//! behind one mutex and the flag is restored (via the guard's `Drop`) while the
//! lock is still held.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

pub const KEYRING_SERVICE: &str = "com.derick.voxctlcom";
/// Single account holding every provider key as one JSON blob.
pub const KEYCHAIN_ACCOUNT: &str = "voxctl.keys";
/// Pre-multi-provider OpenAI key account, migrated into the combined blob.
pub const LEGACY_OPENAI_USER: &str = "openai_api_key";

/// Non-interactive read outcome. `Blocked` means access was denied without
/// prompting (typically a stale ad-hoc ACL partition) and the caller must treat
/// the value as *unknown*, not as absent.
#[derive(Debug)]
pub enum Access<T> {
    /// The keychain returned a value.
    Found(T),
    /// No such item (`errSecItemNotFound`).
    Absent,
    /// Access needs user authorisation that we refused to prompt for.
    Blocked,
}

/// One global mutex, so the process-wide "user interaction allowed" flag is
/// flipped and restored atomically with respect to every other keychain access.
fn keychain_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Holds the lock for the duration of a keychain access and (when non-interactive)
/// guarantees the user-interaction flag is restored on drop while the lock is
/// still held. Field order matters: `_lock` is dropped last.
struct AccessGuard {
    _lock: MutexGuard<'static, ()>,
    _no_ui: Option<security_framework::os::macos::keychain::KeychainUserInteractionLock>,
}

fn guard() -> AccessGuard {
    let lock = keychain_lock().lock().unwrap_or_else(|e| e.into_inner());
    AccessGuard {
        _lock: lock,
        _no_ui: None,
    }
}

/// Run `f` with the keychain's user interaction **disabled** — any access that
/// would prompt instead fails with `errSecInteractionNotAllowed`.
fn non_interactive<T>(f: impl FnOnce() -> T) -> T {
    let mut g = guard();
    g._no_ui =
        security_framework::os::macos::keychain::SecKeychain::disable_user_interaction().ok();
    f()
}

/// Run `f` with user interaction **allowed** — the only place a macOS keychain
/// dialog may appear. Reserve this for explicit user gestures (save/delete).
fn interactive<T>(f: impl FnOnce() -> T) -> T {
    let _g = guard();
    f()
}

fn entry_for(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())
}

fn read_map(entry: &keyring::Entry) -> Access<HashMap<String, String>> {
    match entry.get_password() {
        Ok(json) => match serde_json::from_str::<HashMap<String, String>>(&json) {
            Ok(map) => Access::Found(map),
            // Malformed/legacy plaintext value: treat as no usable keys.
            Err(_) => Access::Absent,
        },
        Err(keyring::Error::NoEntry) => Access::Absent,
        // Any other error (interaction suppressed, ACL partition mismatch,
        // locked keychain) is "we couldn't read it without prompting".
        Err(e) => {
            log::debug!("keychain read blocked: {e}");
            Access::Blocked
        }
    }
}

fn read_string(entry: &keyring::Entry) -> Access<String> {
    match entry.get_password() {
        Ok(v) => Access::Found(v),
        Err(keyring::Error::NoEntry) => Access::Absent,
        Err(e) => {
            log::debug!("keychain read blocked for legacy account: {e}");
            Access::Blocked
        }
    }
}

/// Non-interactive read of the combined blob. Never shows a dialog.
pub fn read_blob() -> Access<HashMap<String, String>> {
    non_interactive(|| match entry_for(KEYCHAIN_ACCOUNT) {
        Ok(e) => read_map(&e),
        Err(_) => Access::Absent,
    })
}

/// Interactive read of the combined blob. Only for user-initiated flows that must
/// see the true current contents (save/delete) — may show one dialog.
pub fn read_blob_interactive() -> Access<HashMap<String, String>> {
    interactive(|| match entry_for(KEYCHAIN_ACCOUNT) {
        Ok(e) => read_map(&e),
        Err(_) => Access::Absent,
    })
}

/// Non-interactive read of one account (legacy migration probing). Never prompts.
pub fn read_account(account: &str) -> Access<String> {
    non_interactive(|| match entry_for(account) {
        Ok(e) => read_string(&e),
        Err(_) => Access::Absent,
    })
}

/// Write the full map as JSON into the single combined item. Interactive: an
/// explicit save is one of the few gestures allowed to show a keychain dialog.
pub fn write_blob(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    interactive(|| -> Result<(), String> {
        entry_for(KEYCHAIN_ACCOUNT)?
            .set_password(&json)
            .map_err(|e| format!("keychain write failed: {e}"))
    })
}

/// Delete a single account (legacy cleanup during migration). Best-effort.
pub fn delete_account(account: &str) {
    let _ = interactive(|| entry_for(account).map(|e| e.delete_credential()));
}

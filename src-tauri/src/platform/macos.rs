//! macOS system integration: permission status (Accessibility, Microphone),
//! prompts, and frontmost-app / focused-URL detection for Mode auto-switching.

use accessibility_sys::AXIsProcessTrusted;

/// True if the app is trusted for the Accessibility API (needed for CGEvent
/// text injection and reading the focused element / URL).
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Show the system Accessibility prompt and register the app in the list. Safe
/// to call repeatedly; returns the current trust state.
pub fn prompt_accessibility() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    unsafe {
        let key = CFString::wrap_under_get_rule(accessibility_sys::kAXTrustedCheckOptionPrompt);
        let value = CFBoolean::true_value();
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
        accessibility_sys::AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const _)
    }
}

/// Microphone TCC authorization status.
pub fn microphone_authorized() -> bool {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    unsafe {
        let Some(media) = AVMediaTypeAudio else {
            return false;
        };
        AVCaptureDevice::authorizationStatusForMediaType(media) == AVAuthorizationStatus::Authorized
    }
}

/// Frontmost application: (localized name, bundle id). Reliable via NSWorkspace.
pub fn frontmost_app() -> Option<(String, Option<String>)> {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    let app = ws.frontmostApplication()?;
    let name = app.localizedName()?.to_string();
    let bundle = app.bundleIdentifier().map(|s| s.to_string());
    Some((name, bundle))
}

fn frontmost_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    let app = ws.frontmostApplication()?;
    Some(app.processIdentifier())
}

/// Best-effort URL of the focused browser tab via the Accessibility API.
///
/// Browsers (Chrome/Safari/Arc/Edge/Brave) don't expose `AXURL` on the focused
/// text field — it lives on the `AXWebArea` inside the window. So we first try
/// the focused element (some apps expose it there), then walk the focused
/// window's element tree to find the first element with an `AXURL`. Returns None
/// for non-browsers or when no URL is found — website matching degrades to
/// app-only. Uses only the already-granted Accessibility API (no new prompt).
pub fn focused_url() -> Option<String> {
    use accessibility_sys::{
        kAXErrorSuccess, AXUIElementCopyAttributeValue, AXUIElementCreateApplication,
        AXUIElementRef,
    };
    use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::{CFURLRef, CFURL};
    use core_foundation_sys::array::{
        CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
    };
    use core_foundation_sys::base::CFRetain;

    if !accessibility_trusted() {
        return None;
    }

    unsafe fn copy_attr(el: AXUIElementRef, name: &str) -> Option<CFTypeRef> {
        let attr = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut value);
        if err == kAXErrorSuccess && !value.is_null() {
            Some(value)
        } else {
            None
        }
    }

    unsafe fn url_string(value: CFTypeRef) -> Option<String> {
        let id = CFGetTypeID(value);
        if id == CFURL::type_id() {
            let url = CFURL::wrap_under_create_rule(value as CFURLRef);
            Some(url.get_string().to_string())
        } else if id == CFString::type_id() {
            let s = CFString::wrap_under_create_rule(value as CFStringRef);
            Some(s.to_string())
        } else {
            CFRelease(value);
            None
        }
    }

    /// Bounded breadth-first search for the first element exposing `AXURL`
    /// (the `AXWebArea` in browsers). We hold a retain on every queued element
    /// and release it after processing, so nothing leaks even when we stop early.
    unsafe fn find_url_in_tree(root: AXUIElementRef) -> Option<String> {
        use std::collections::VecDeque;
        const MAX_VISITS: usize = 1500;

        let mut queue: VecDeque<AXUIElementRef> = VecDeque::new();
        CFRetain(root as CFTypeRef);
        queue.push_back(root);

        let mut found = None;
        let mut visited = 0usize;
        while let Some(el) = queue.pop_front() {
            if found.is_none() {
                visited += 1;
                if let Some(url_val) = copy_attr(el, "AXURL") {
                    found = url_string(url_val);
                }
                if found.is_none() && visited < MAX_VISITS {
                    if let Some(kids) = copy_attr(el, "AXChildren") {
                        if CFGetTypeID(kids) == CFArrayGetTypeID() {
                            let arr = kids as CFArrayRef;
                            let n = CFArrayGetCount(arr);
                            for i in 0..n {
                                let child = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                                if !child.is_null() {
                                    CFRetain(child as CFTypeRef);
                                    queue.push_back(child);
                                }
                            }
                        }
                        CFRelease(kids);
                    }
                }
            }
            CFRelease(el as CFTypeRef);
        }
        found
    }

    unsafe {
        let pid = frontmost_pid()?;
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return None;
        }

        let mut result = None;

        // Fast path: some apps expose AXURL right on the focused element.
        if let Some(focused) = copy_attr(app_el, "AXFocusedUIElement") {
            if let Some(url_val) = copy_attr(focused as AXUIElementRef, "AXURL") {
                result = url_string(url_val);
            }
            CFRelease(focused);
        }

        // Browser fallback: walk the focused/main window for the AXWebArea URL.
        if result.is_none() {
            if let Some(win) =
                copy_attr(app_el, "AXFocusedWindow").or_else(|| copy_attr(app_el, "AXMainWindow"))
            {
                result = find_url_in_tree(win as AXUIElementRef);
                CFRelease(win);
            }
        }

        CFRelease(app_el as CFTypeRef);
        result
    }
}

/// Bring the application to the foreground (activate it), so a window shown from
/// the tray or a Dock re-open actually comes to front. Must run on the main
/// thread — tray/Reopen callbacks already do.
pub fn activate_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // `activate()` (14+) isn't always enough to pull a backgrounded app forward;
    // the (deprecated) ignoring-other-apps variant is the reliable cross-version call.
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

/// Play a macOS system sound by name (e.g. "Tink", "Pop"). Using the built-in
/// sounds keeps the bundle small and avoids shipping audio assets; swap in
/// `NSSound::soundWithContentsOfFile` later for custom cues.
pub fn play_system_sound(name: &str) {
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;
    let ns_name = NSString::from_str(name);
    if let Some(sound) = NSSound::soundNamed(&ns_name) {
        sound.play();
    }
}

/// Install a callback fired whenever the frontmost application changes, via the
/// NSWorkspace activation notification (event-driven; no polling). The observer
/// lives for the process lifetime.
pub fn observe_app_switches<F: Fn() + Send + Sync + 'static>(callback: F) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    let ws = NSWorkspace::sharedWorkspace();
    let nc = ws.notificationCenter();
    let block = RcBlock::new(move |_n: NonNull<NSNotification>| callback());
    let observer = unsafe {
        nc.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidActivateApplicationNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(observer); // keep the subscription alive for the app lifetime
}

/// Extract a lowercased host from a URL string (no `url` crate dependency).
pub fn host_of(url: &str) -> Option<String> {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split('/').next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::host_of;

    #[test]
    fn host_extraction() {
        assert_eq!(
            host_of("https://chatgpt.com/c/123").as_deref(),
            Some("chatgpt.com")
        );
        assert_eq!(
            host_of("http://www.preply.com:8080/x").as_deref(),
            Some("www.preply.com")
        );
        assert_eq!(
            host_of("https://user@gemini.google.com/app").as_deref(),
            Some("gemini.google.com")
        );
        assert_eq!(host_of("claude.ai/new").as_deref(), Some("claude.ai"));
        assert_eq!(host_of(""), None);
    }
}

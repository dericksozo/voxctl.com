//! Text injection into the frontmost app via CGEvent Unicode keystroke
//! synthesis. This types the transcript as if from the keyboard, so the system
//! clipboard is never touched (the "Copy to clipboard" toggle is handled
//! separately). Requires macOS Accessibility permission.

use core_graphics::event::{CGEvent, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

/// CGEventKeyboardSetUnicodeString is reliable for short strings; chunk longer
/// text so every character lands.
const CHUNK_CHARS: usize = 16;

/// Type `text` into whatever app is frontmost. No-op for empty text.
pub fn insert_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let chars: Vec<char> = text.chars().collect();
    for chunk in chars.chunks(CHUNK_CHARS) {
        let s: String = chunk.iter().collect();
        post_unicode(&s)?;
    }
    Ok(())
}

fn post_unicode(s: &str) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "failed to create CGEventSource".to_string())?;

    let down = CGEvent::new_keyboard_event(source.clone(), 0, true)
        .map_err(|_| "failed to create key-down event".to_string())?;
    down.set_string(s);
    down.post(CGEventTapLocation::HID);

    let up = CGEvent::new_keyboard_event(source, 0, false)
        .map_err(|_| "failed to create key-up event".to_string())?;
    up.set_string(s);
    up.post(CGEventTapLocation::HID);
    Ok(())
}

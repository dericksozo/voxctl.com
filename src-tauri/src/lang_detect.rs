//! Best-effort language detection for transcripts recorded in "auto" mode, so
//! the history chip shows the actual language used (e.g. "en", "ja") instead of
//! the literal "auto" selection label. Pure-Rust (whatlang), offline, no extra
//! network round-trip.

use whatlang::Lang;

/// Resolve the language code to store/render for a finished transcript.
///
/// When the user picked an explicit language we keep it verbatim. When the
/// selection was "auto" (or unset) we detect the language from the transcript
/// text and return that code instead — falling back to "auto" only when the
/// text is empty or too ambiguous to detect.
pub fn resolve(selected: Option<&str>, transcript: &str) -> String {
    match selected {
        Some(l) if !l.is_empty() && l != "auto" => l.to_string(),
        _ => detect_code(transcript).unwrap_or_else(|| "auto".to_string()),
    }
}

/// Detect the language of `text` and return a short language code. Returns the
/// ISO 639-1 code for the languages VOXCTL offers in its picker (so the chip
/// matches the picker labels exactly) and falls back to whatlang's ISO 639-3
/// code for anything else. `None` when the text is empty or undetectable.
pub fn detect_code(text: &str) -> Option<String> {
    let info = whatlang::detect(text.trim())?;
    let lang = info.lang();
    Some(iso639_1(lang).unwrap_or_else(|| lang.code()).to_string())
}

/// Map whatlang's `Lang` to the ISO 639-1 codes used by the picker (see
/// `src/lib/languages.ts`). Only the offered languages are mapped; others fall
/// back to the 639-3 code in [`detect_code`].
fn iso639_1(lang: Lang) -> Option<&'static str> {
    Some(match lang {
        Lang::Eng => "en",
        Lang::Spa => "es",
        Lang::Deu => "de",
        Lang::Fra => "fr",
        Lang::Ita => "it",
        Lang::Por => "pt",
        Lang::Nld => "nl",
        Lang::Jpn => "ja",
        Lang::Cmn => "zh",
        Lang::Kor => "ko",
        Lang::Rus => "ru",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_selection_is_kept() {
        assert_eq!(resolve(Some("es"), "anything"), "es");
        assert_eq!(resolve(Some("ja"), "hello world"), "ja");
    }

    #[test]
    fn auto_resolves_to_detected_language() {
        // English / Russian / Japanese are unambiguous enough for whatlang.
        assert_eq!(
            resolve(
                None,
                "the quick brown fox jumps over the lazy dog every morning"
            ),
            "en"
        );
        assert_eq!(
            resolve(Some("auto"), "Съешь же ещё этих мягких французских булок"),
            "ru"
        );
        assert_eq!(
            resolve(None, "今日はいい天気ですね、散歩に行きましょう"),
            "ja"
        );
    }

    #[test]
    fn empty_transcript_stays_auto() {
        assert_eq!(resolve(None, ""), "auto");
        assert_eq!(resolve(Some("auto"), "   "), "auto");
    }

    #[test]
    fn detected_codes_match_picker_for_offered_langs() {
        // The codes we map must exist in the picker so the chip resolves to a
        // proper label rather than a raw uppercase code.
        assert_eq!(iso639_1(Lang::Eng), Some("en"));
        assert_eq!(iso639_1(Lang::Jpn), Some("ja"));
        assert_eq!(iso639_1(Lang::Cmn), Some("zh"));
    }
}

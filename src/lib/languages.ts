// Languages offered in the HUD picker, Modes form, and re-transcribe. `code`
// is the value sent as `transcription.language` ("auto" => omit / auto-detect).

export interface Language {
  code: string;
  label: string;
}

export const LANGUAGES: Language[] = [
  { code: "auto", label: "AUTO" },
  { code: "en", label: "ENGLISH" },
  { code: "es", label: "ESPAÑOL" },
  { code: "de", label: "DEUTSCH" },
  { code: "fr", label: "FRANÇAIS" },
  { code: "it", label: "ITALIANO" },
  { code: "pt", label: "PORTUGUÊS" },
  { code: "nl", label: "NEDERLANDS" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "ko", label: "한국어" },
  { code: "ru", label: "РУССКИЙ" },
];

export function langLabel(code: string | null): string {
  if (!code || code === "auto") return "AUTO";
  return LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

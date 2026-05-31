// Tiny i18n: a flat key→string lookup with optional {placeholder} interpolation.
// English-only today; drop a new JSON into ./locales and register it below to
// add a language (no library, minimal bundle).

import en from "./locales/en.json";

export type Locale = "en";

const LOCALES: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
};

export const AVAILABLE_LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "ENGLISH (US)" },
];

let current: Locale = "en";

export function setLocale(locale: string) {
  if (locale in LOCALES) current = locale as Locale;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = LOCALES[current][key] ?? LOCALES.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

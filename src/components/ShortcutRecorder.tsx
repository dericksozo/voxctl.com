import { useState } from "react";
import { t } from "../i18n";

// Builds an accelerator string understood by tauri-plugin-global-shortcut, e.g.
// "Alt+Space", "Super+Shift+D". On macOS "Super" maps to Command.

function mainKeyFromCode(code: string): string | null {
  if (code === "Space") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const map: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Enter: "Enter",
    Tab: "Tab",
  };
  return map[code] ?? null;
}

function accelFromEvent(e: React.KeyboardEvent): string | null {
  const main = mainKeyFromCode(e.code);
  if (!main) return null; // modifier-only press: keep waiting
  const parts: string[] = [];
  if (e.metaKey) parts.push("Super");
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(main);
  return parts.join("+");
}

const SYM: Record<string, string> = { Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Space: "SPACE" };

export function prettyAccel(accel: string): string {
  return accel
    .split("+")
    .map((p) => SYM[p] ?? p)
    .join(" ");
}

export function ShortcutRecorder({ value, onChange }: { value: string; onChange: (accel: string) => void }) {
  const [recording, setRecording] = useState(false);

  return (
    <button
      type="button"
      className={"kbd" + (recording ? " recording" : "")}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        if (e.key === "Escape") {
          setRecording(false);
          return;
        }
        const accel = accelFromEvent(e);
        if (accel) {
          onChange(accel);
          setRecording(false);
        }
      }}
    >
      {recording ? t("settings.shortcutRecord") : prettyAccel(value)}
    </button>
  );
}

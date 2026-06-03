import { useEffect, useRef, useState } from "react";
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

function accelFromEvent(e: KeyboardEvent): string | null {
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

export function ShortcutRecorder({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (accel: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // While capturing, listen on the window (capture phase) instead of relying on
  // the button's own onKeyDown. macOS WKWebView does NOT focus a <button> on
  // click, so an element-level key handler never fires there — a window listener
  // is the robust way to read the next chord. The capture phase + stopPropagation
  // also keeps the keypress from triggering the app's j/k/arrow nav shortcuts.
  useEffect(() => {
    if (!recording) return;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const accel = accelFromEvent(e);
      if (accel) {
        onChange(accel);
        setRecording(false);
      }
      // modifier-only press: keep waiting for a full chord
    }
    // Clicking anywhere outside the button cancels capture.
    function onPointerDown(e: PointerEvent) {
      if (!btnRef.current?.contains(e.target as Node)) setRecording(false);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [recording, onChange]);

  useEffect(() => {
    if (disabled) setRecording(false);
  }, [disabled]);

  return (
    <button
      ref={btnRef}
      type="button"
      className={"kbd" + (recording ? " recording" : "")}
      onClick={() => setRecording((r) => !r)}
      disabled={disabled}
    >
      {recording ? t("settings.shortcutRecord") : prettyAccel(value)}
    </button>
  );
}

# VOXCTL UI Backlog — Scoped (2026-06-14)

Focused implementation list from follow-up review. **Deferred:** active mode picker, stats page, mode editor, prior feedback-thread items.

---

## 1. Settings — remove transcription default language

**Goal:** Drop the global “transcription default language” from Settings. App settings should describe app behavior; language belongs on the mode, and most models use auto anyway.

**Frontend**
- [ ] Remove the entire **Transcription** section from `SettingsPanel.tsx` (or remove that section from `SECTIONS` if nothing else lives there).
- [ ] Remove `defaultLanguage` from the frontend config type/defaults in `src/lib/types.ts`.

**Backend**
- [ ] Remove `default_language` from config (`src-tauri/src/commands/config.rs`) and stop using it as a fallback in `commands/modes.rs` (today: `override_lang` → mode language → `config.default_language`). After removal, fall back to mode language or auto only.
- [ ] Migrate or ignore existing `default_language` values in saved `settings.json`.

---

## 2. Settings — clipboard toggle

**Goal:** Make clipboard behavior easier to find and understand.

**Frontend**
- [ ] **Move** the “Copy to clipboard” toggle from the **System** section to the **Capture** section (layout move only — same `Toggle` control).
- [ ] **Rewrite** the helper copy to something short and plain, e.g.  
  *“When a transcript finishes, it is copied to your clipboard automatically (replacing whatever was there).”*
- [ ] Update `en.json` keys (`settings.clipboardSub` or equivalent).

**Backend:** None.

---

## 3. Settings — auto-delete recordings

**Goal:** Replace the current storage block (delete behavior segmented control + manual purge UI) with one simple setting.

**New setting**
- **Label:** Auto delete recordings
- **Control:** `<select>` with options:
  - Never
  - Keep latest 5
  - After 3 days
  - After 2 weeks
  - After 3 months

**Behavior**
- Always deletes **both** the history row (transcript + metadata) **and** the audio file. No “keep transcript, delete audio” mode.
- Remove the old **Delete behavior** segmented control (`both` / `transcript`).
- Remove the manual **Purge recordings older than N days** UI (days input, keep-favorites toggle, Purge button) — retention is driven only by this setting.

**Frontend**
- [ ] Replace `StorageSection` delete-behavior + purge controls with a single select in `SettingsPanel.tsx`.
- [ ] Replace `DeleteBehavior` type with something like `AutoDeletePolicy`: `"never" | "keep_latest_5" | "after_3_days" | "after_2_weeks" | "after_3_months"`.
- [ ] Keep the **storage used** readout (disk usage + recording count) if still useful above the select.

**Backend**
- [ ] Store new policy in config (`settings.json`); migrate away from `delete_behavior`.
- [ ] Remove `delete_removes_audio()` branching in `commands/history.rs` — manual deletes always remove audio + row.
- [ ] Implement automatic enforcement:
  - **Time-based policies:** compare `created_at` to now; delete row + WAV when past threshold.
  - **Keep latest 5:** after each new recording completes (or on a periodic/startup sweep), delete everything beyond the 5 most recent.
- [ ] Run enforcement on a sensible trigger (app startup + after recording/transcription completes; avoid blocking the hot path).
- [ ] Reuse or replace `purge_older_than` in `history.rs` as needed; `purge_recordings` IPC may become unnecessary.

---

## 4. Modes list — minor UX

**Goal:** Clear hierarchy: default mode → separator → add button → custom modes.

**Frontend (`ModesPanel.tsx`)**
- [ ] Sort/render so **default mode** is always first (`defaultModeId`).
- [ ] Add a **visual separator** immediately after the default mode card.
- [ ] Move **Define new mode** button to sit **directly below** that separator (not above the whole list).
- [ ] Render **custom modes** after the button.
- [ ] Add **delete confirmation** before `deleteMode()` (confirm dialog or inline confirm — e.g. “Delete mode X?” with Cancel / Delete).

**Backend:** None (unless you want delete confirmation to block modes with in-flight recordings — existing `inUse` lock already disables delete).

---

## 5. History — sticky search bar

**Goal:** Search stays visible while scrolling the transcript list.

**Frontend (`HistoryPanel.tsx` + CSS)**
- [ ] Make `.hm-toolbar` (search input) **sticky** at the top of the scroll container.
- [ ] Ensure background/z-index so list content doesn’t show through while scrolling; confirm it works with day-group headers below it.

**Backend:** None.

---

## Out of scope (for now)

| Area | Reason |
|------|--------|
| Active mode picker redesign | Needs design work |
| Stats page changes | Needs product decisions |
| Mode editor redesign | Needs more thinking |
| Prior feedback-thread items (post-processing, capture HUD, per-mode shortcuts, etc.) | Later |

---

## Suggested implementation order

1. **Clipboard move + copy** — smallest diff, immediate clarity win
2. **Remove transcription default language** — UI removal + backend fallback cleanup
3. **Modes list UX** — self-contained frontend
4. **Sticky search** — self-contained CSS
5. **Auto-delete recordings** — UI simplification + new backend retention worker (largest piece)

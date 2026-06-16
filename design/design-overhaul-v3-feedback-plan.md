# Design Overhaul v3 — Feedback Implementation Plan

> Hand-off doc. Implements the feedback in
> `design/design-overhaul-v3-design-feedback.md`, targeting the mockup in
> `design/new-design-settings-page-screenshot.png`. **Design-only pass** — no
> functionality changes. Work on a branch off `feat/design-overhaul-v3`, then
> merge back into it with `--no-ff` (repo cadence per CLAUDE.md §9).

## Context

The `feat/design-overhaul-v3` holder branch shipped a 3-phase visual restyle
(tokens/chrome → panels → HUD). After living with it, the user recorded design
feedback (see file above) plus a target settings mockup. This pass implements
that feedback. Only files touched get staged; the unrelated pre-existing
working-tree changes (deleted `APP_FEEDBACK_*.md`, moved `design/*` files) are
left alone.

## Decisions (confirmed with user)

- **Font size**: global modest reduction (~2px off prominent body/content text;
  large display numerals scaled down lightly; tiny 10–11px micro-labels mostly
  left alone to stay legible).
- **Settings**: match the new screenshot — API PROVIDERS stays full-width; every
  other section becomes a compact two-column `LABEL → control` grid. Map only the
  app's **existing** settings into it (do **not** add mockup-only ones like INPUT
  DEVICE / OUTPUT — out of scope per brief §10).
- **Default-mode duplicate bug**: leave out (design-only pass; noted at bottom).

## Changes

### 1. HUD grid lines too harsh → soften to match the app
`src/styles/hud.css`
- App grid uses `--line-faint: rgba(16,20,26,0.045)` (theme.css); HUD grid uses
  `--line-soft` (0.09) — twice as dark, so it "pops." Add `--line-faint` to the
  HUD `:root` and switch `.hud::before` to it (and bump cell size 16→~18px) so the
  HUD grid reads as soft as the main window.

### 2. Deleting a transcript leaves all cards faded (bug)
`src/panels/HistoryPanel.tsx`
- Root cause: `dim = expanded !== null && !exp`. `doDelete` removes the expanded
  row but never clears `expanded`, so it points at a now-gone id → no card matches
  `exp`, every remaining card stays dimmed. Fix: `setExpanded(null)` inside
  `doDelete` (and in `deleteSelected` for safety).

### 3. Global font-size reduction (~2px)
`src/styles/theme.css`, `src/styles/panels/{home,settings,modes,stats,onboarding}.css`
- Coordinated trim of the prominent readable sizes, e.g.:
  - theme.css: `.nav-text` clamp(20→18 … 27→24), `.stat-v` clamp(28→24 … 48→40),
    `.sysdesc-text` 13→12, `.vx-btn`/`.splitcopy` 13→12, `.mode-n`/`.nm-title` 17→15.
  - home.css: `.hm-preview` 15.5→13.5, `.hm-text` 16→14, `.hm-time` 16→14,
    `.hm-meta` 13.5→12, `.hm-stat-v` 22→19 (sm 18→16), `.hm-day-label` 13→12.
  - Pattern, not exhaustive: drop the dominant text ~2px; leave 10–11px labels.

### 4. Remove app-title chip from collapsed card; show only when opened
`src/panels/HistoryPanel.tsx` (+ `home.css`)
- Remove `<span className="hm-ctx">{ctx…}</span>` from the collapsed `hm-head-right`.
- Add an `APP`/context cell to the expanded `hm-meta` row so it appears on open.
- Remove now-unused `.hm-ctx` rule.

### 5 + 6. HOME horizontal scrollbar & tooltip cut off on the left
`src/styles/theme.css`, `src/panels/HistoryPanel.tsx`
- Shared root cause: `.panel-body { overflow-y: auto }` forces `overflow-x: auto`;
  the absolutely-positioned provider tooltips (`.prov .tip`, centered with
  `translateX(-50%)`) extend past the container's left/right edges even at
  opacity 0 → a horizontal scrollbar, and get clipped when shown.
- Kill the scrollbar: `.panel-body { overflow-x: hidden }` (x clipped, y scrolls).
- Keep tooltips visible within the clipped box via edge-aware alignment variants on
  `.prov`: default centered, `.prov--left` (anchor left, grow right) for left-edge
  chips, `.prov--right` (anchor right, grow left) for right-edge chips, with the
  arrow repositioned per variant. `ProviderChip` gains an `align` prop; the
  expanded-meta chip (the one the user hovered) uses `--left`; drop the redundant
  TOP MODEL tooltip (its label is already shown beside it).

### 7. "Recording in progress" message — make it clear
`src/panels/SettingsPanel.tsx`, `src/i18n/locales/en.json`
- Replace the hardcoded `RECORDING IN PROGRESS` with a new i18n key, e.g.
  `settings.recLock` = "RECORDING IN PROGRESS — SETTINGS LOCKED UNTIL YOU FINISH",
  rendered via `t()`.

### 8. Settings → two-column layout (match screenshot)
`src/panels/SettingsPanel.tsx`, `src/styles/panels/settings.css`
- Keep API PROVIDERS full-width (stacked `ProviderKeyCard`s + footer note).
- For the other sections, replace the stacked `.vx-set-card` boxes with a compact
  two-column grid (`.vx-set-grid`, `1fr 1fr`, collapses to 1 col < 880px) of
  `LABEL (left) → control (right)` rows with a subtle divider (the look in the
  screenshot's CAPTURE block).
- Wide controls (full-width `<select>`s, permission cards, storage-purge row) get a
  `--full` span-both-columns modifier so they don't squeeze.
- Preserve `data-sec` anchors + scroll-spy, magenta section headers, and the
  recording-lockout disabling of inputs.

### 9. Remove pink blinking caret on the top-right (stage) title
`src/App.tsx`
- In the stage `Frame` label, drop `{phase !== "closing" ? <span className="caret" /> : null}`
  (keep the Typewriter). Carets then live only on the sidebar nav titles
  (`.nav-caret`) and SYS.DESC (`.caret`).

### 10. Synchronize the two remaining carets
`src/styles/theme.css`
- `.blink` (nav-caret) runs `blink 1s`; `.caret` (SYS.DESC) runs `blink 1.05s` →
  they drift apart ("chaotic"). Unify to one duration (1s, same `blink` keyframes).
  Both elements exist from first paint, so equal duration keeps them in lockstep.

## Files touched
- `src/App.tsx` (#9)
- `src/panels/HistoryPanel.tsx` (#2, #4, #5/6)
- `src/panels/SettingsPanel.tsx` (#7, #8)
- `src/i18n/locales/en.json` (#7)
- `src/styles/hud.css` (#1)
- `src/styles/theme.css` (#3, #5/6, #10)
- `src/styles/panels/home.css` (#3, #4)
- `src/styles/panels/settings.css` (#3, #8)
- `src/styles/panels/{modes,stats,onboarding}.css` (#3, light trims)

## Verification
1. `npx biome check --write .` (lint/format JS/TS).
2. `npm run build` (TS typecheck + Vite build must pass).
3. `npm run tauri dev` — manual smoke test:
   - HUD grid reads soft/faint like the main window.
   - Record → expand → delete a transcript: remaining cards return to full opacity.
   - Text is visibly ~2px smaller across panels; layout still clean.
   - Collapsed HOME cards show no app title; it appears in the expanded card meta.
   - HOME has no horizontal scrollbar; can't scroll left/right.
   - Hovering a provider icon in an expanded card shows a fully-visible tooltip.
   - Settings: providers full-width, other settings paired two-per-row; scroll-spy
     header + SYS.DESC still update; recording lockout still disables inputs.
   - Start a recording, open Settings: lockout message reads clearly.
   - Top-right (stage) title has no blinking caret; nav-title + SYS.DESC carets
     blink in sync.

(No Rust changes this pass, so the `cargo` gate is unaffected.)

## Git workflow
- Branch `overhaul/v3-design-feedback` off `feat/design-overhaul-v3`.
- Commit the design-feedback changes only (selective `git add`).
- Merge back into `feat/design-overhaul-v3` with `git merge --no-ff` and pause.

## Out of scope (noted)
- Duplicate "default mode" creation (functionality bug, `src-tauri/src/commands/modes.rs`).
- Mockup-only settings (INPUT DEVICE selection, OUTPUT routing).

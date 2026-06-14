# VOXCTL Design Update Spec

> **Purpose of this document.** This is a design brief to hand to a design tool (Claude design) to generate the new UI. It describes *what the screens should look like and do*, not how to implement them. Re-wiring the actual app behavior is a separate, later step.
>
> **Aesthetic to preserve.** VOXCTL uses a **'90s sci-fi / terminal aesthetic**: monospace type, letter-spaced uppercase headers, framed panels with corner brackets, a hot-pink/magenta accent on a near-white background, scanline/grid texture, blinking caret blocks, and terminal-style labels (`// HOME`, `VX-0xA7`, `// SYS.DESC`). Every screen below must keep that look. See the current-app screenshots in [§2](#2-current-app-starting-point). The reference screenshots from *other* apps are for **layout and interaction inspiration only** — translate their structure into the VOXCTL aesthetic, do not copy their visual style. The **one exception** to "no brand visuals" is provider logos (see [Provider logos](#provider-logos)).

---

## 1. Summary

The core shift: move VOXCTL away from showing abstract usage stats first, and toward showing the user's **actual transcriptions** first.

- The **Home** page becomes a transcription-focused workspace (inspired by WhisperFlow's directness and Superwhisper's simplicity).
- The current stats-heavy Home moves to a dedicated **Stats** page.
- The transcript list is dramatically simplified: plain, readable, searchable, easy to copy, with deeper metadata and actions revealed only on expand.
- Onboarding becomes a single, explicit, gated setup screen (inspired by Handy) that the user is forced back to if they ever break a required permission or key.

Overall goal: cleaner, less noisy, focused on the core value of voice-to-text.

---

## 2. Current app (starting point)

This is what exists **today**, so the designer understands they are redesigning existing screens, not building from scratch. Current-app screenshots live in `design/voxctl-current-app-screenshots/` and are the source of truth for the aesthetic to preserve.

**Shared chrome (every screen):** an app header with the `VOCAL CONTROL PROTOCOL` / `VOXCTL` wordmark, an `ACTIVE MODE ▸ …` pill plus `LINK · KEY · SET` status dots top-right; a left sidebar with numbered nav (`01–04`), a `// SELECT FUNCTION` label, a `↵` cursor on the active item, a logo/QR block, and a framed `// SYS.DESC` description box; a footer strip with `INPUT` dB meter, `MODE`, `SFX`, and a `UTC` clock + QR glyph. The main content sits in a corner-bracketed frame labeled `// <SECTION>` with a `VX-0xA7` tag.

- **Sidebar nav (current):** `HOME · FILES · MODES · SETTINGS`
  - **HOME** (`voxctl-home.png`) — currently a *stats dashboard*: a stat row (`WORDS // ALL TIME`, `MINUTES CAPTURED`, `INTERFACES ENGAGED`, `EST. SPEND // ALL TIME`), a `GETTING STARTED` list, and a `TOP INTERFACES` bar chart.
  - **FILES** (`voxctl-files.png`) — the transcript list. It **already has** a `SEARCH TRANSCRIPTS` field, `ALL APPS` / `ALL LANGUAGES` dropdown filters, `FAVORITES` + `SELECT` chips, day grouping (`TODAY`), and cards that currently show — even when collapsed — the time, mode/app/language chips, a `COPY / PLAY / FAV / RE-RUN / ×` action row, and a meta row (duration, words, file size, cost like `<$0.01`) with a `⌄` expand caret.
  - **MODES** (`voxctl-modes.png`) — context-aware presets: `+ DEFINE NEW MODE`, then mode cards (`DEFAULT`, `CHATGPT`, `GEMINI`, …) each with `MODEL`, `TRIGGER`, `LANG`, an `EDIT` button and an `ENABLED` toggle. Modes can be triggered with shortcuts (e.g. `Option+1/2/3`).
  - **SETTINGS** (`voxctl-settings.png`) — `API PROVIDERS` (bring-your-own-key cards for OpenAI, xAI, Gemini with paste-key fields, `SAVE`, and `VALIDATED` state), plus `CAPTURE` and other system config.

Most of the *functionality* in this spec already exists in the FILES panel — it mostly needs to be **redesigned and simplified**, not built new. In particular, the redesign **moves the action row and chips off the collapsed card** (collapsed = time + transcript only; actions appear on expand), **drops the dropdown filters** (search only), and **grays out non-focused cards on expand**.

---

## 3. Navigation changes

| Before | After |
| --- | --- |
| `HOME` (stats) | `HOME` (transcripts-first) |
| `FILES` (transcript list) | **removed** — its transcript content moves into HOME |
| `MODES` | `MODES` |
| — | **`STATS`** (new page, placed above Settings) |
| `SETTINGS` | `SETTINGS` |

**New sidebar order:** `HOME · MODES · STATS · SETTINGS`

---

## 4. Home (transcripts-first)

Reference: `design-inspiration-screenshots/whisperflow-homepage.png` (overall list layout) and `design-inspiration-screenshots/superwhisper-history-1.png` (collapsed list + search).

The Home page is, top to bottom: **stats strip → search bar → transcript list**.

### 4.1 Stats strip (top)

A single, small, unobtrusive horizontal strip. It is **not** the focus of the page — it's a thin band above the transcripts. Three metrics only:

1. **Top model used** — which model the user has used the most.
2. **Total spend** — estimated money spent (all-time, local estimate).
3. **Minutes captured** — total minutes of audio captured.

Keep it compact and quiet; the transcripts are the star.

### 4.2 Search bar

- A single search bar sits above the first transcript entry.
- Style it like a good, familiar search field (clean, obvious affordance, placeholder text such as `Search transcripts`).
- **No other filters.** Remove the app filter, language filter, and the standalone favorites filter from the old FILES toolbar. Search only.
- Functionality is out of scope for the design — just present it well.

### 4.3 Transcript list

- Transcripts are grouped by **day**. Each day is a header/divider (e.g. `TODAY`, `YESTERDAY`, or a date), with that day's individual transcripts listed beneath it. (WhisperFlow groups a day's entries together and separates groups with a thin line — emulate that grouping.)
- Within a day, each transcript is its own **collapsed card** (see below).

### 4.4 Collapsed card (default state)

Plain and highly readable. Shows only:

- **Time** the transcript was recorded (e.g. `06:21 PM`).
- **Transcript preview** — the first ~3 sentences of the transcript, plain text. Nothing else (no chips, no badges, no metadata in the collapsed/resting state). Keep it as plain as possible.

> **No language chip.** Do not show a language chip/badge anywhere (collapsed or expanded). It isn't needed — to find transcripts in a given language, the user just searches for text in that language.

Interactions:

- **On hover:** two quiet controls appear on the card:
  1. A quick **copy** button (copies the plain transcript).
  2. The **provider logo** (Gemini / OpenAI / xAI) for the model that produced this transcript, placed beside the copy button. **Hovering the logo reveals the Mode name** that was used (e.g. the tooltip shows the mode like `XAI LIVE`, not the raw provider name).
- No other controls appear in the collapsed/hover state.
- **On click:** the card **expands in place** (see below).

### 4.5 Expanded card

Reference: `design-inspiration-screenshots/superwhisper-history-2.png`.

When a card is clicked it **expands in place** (pushing the cards below it down — not an overlay). At the same time, **all other cards gray out** so focus lands on the expanded transcript. Collapsing it (clicking again) returns everything to the uniform, readable state.

The expanded card reveals:

1. **Play / Stop control.** A single play button. Clicking it plays the recording and transforms into a stop button; clicking stop ends playback.
   - **No waveform.** Never render an audio waveform to the user. Just a play/stop control (optionally a simple elapsed/total time readout, but no waveform graphic).

2. **Transcript version tabs.** A tab control for switching between the available versions of the transcript:
   - **Original** (plain text) — always present and the default.
   - **Word timestamps** — only when the model supports it.
   - **Speaker labels** — only when the model supports it.
   - These tabs are driven by **model capability**: some models return only plain text (e.g. GPT realtime / Whisper), while others (e.g. xAI Speech-to-Text) also return speaker labels and word timestamps. Only show the tabs that the recording's model actually produced.
   - _(Note: the Superwhisper reference only shows `Original / Segmented`. The VOXCTL tabs above are an intentional extension of that idea, not something visible in the screenshot.)_

3. **Split copy button.** A two-part button:
   - **Left side:** a normal copy icon → copies the currently displayed version.
   - **Right side:** a small divider + down-arrow → opens a menu with explicit options:
     - `Copy plain text`
     - `Copy with word timestamps`
     - `Copy with speaker labels`
   - _(No reference screenshot exists for this control — design a clean split-button + dropdown.)_

4. **Retranscribe.** A control to re-run this recording through **another already-defined Mode** (pick from existing modes). Useful when the user wants a different model/behavior applied to the same audio.

5. **Delete.** Removes the recording.

6. **Metadata row.** A compact row of details about the recording:
   - **Provider logo** — the logo of the provider/model used (Gemini / OpenAI / xAI). Shown as a small icon. **On hover, it reveals the Mode name** that produced this recording. (This is the only place company logos appear — see [Provider logos](#provider-logos).)
   - **Duration** — length of the recording (e.g. `54s`).
   - **File size** — disk space the recording uses (e.g. `2.5 MB`).
   - **Cost** — the estimated cost to produce this specific transcription, **hyper-specific** (e.g. `$0.0001`). Each model has its own cost calculation; show the precise per-recording figure, not a rounded value.

### 4.6 Empty state (new user, zero transcriptions)

When Home has no transcriptions yet, show an encouraging prompt that nudges the user to record their first one — e.g.:

> **Take control of your voice.** Hold `Option + Space` to record your first transcription.

Keep it friendly and action-oriented; the goal is to get them to record once.

---

## 5. Stats page (new)

The current Home dashboard moves here, essentially unchanged. It includes:

- **Words (all-time)**
- **Minutes captured**
- **Interfaces engaged** (distinct apps/sites)
- **Estimated spend (all-time)**
- **Top interfaces** (which apps/sites the user dictates into most)

This is the deeper "how am I using VOXCTL" view, separate from the day-to-day transcript workspace on Home. (Some overlap with the Home stats strip is fine and expected.)

---

## 6. Onboarding

Reference: `design-inspiration-screenshots/handy-onboarding.png`.

On first launch, before the main UI is shown, VOXCTL presents a **single setup screen** (in the '90s aesthetic) with the app logo, a `Permissions Required`-style header, and a short subheader like "VOXCTL needs a few things set up to work properly."

This is **one screen** with all steps **explicitly labeled and listed** (`Step 1`, `Step 2`, `Step 3`, `Step 4`), each showing its own status (e.g. `Waiting…` / `Granted` / `Done`), similar to how Handy stacks Microphone Access and Accessibility Access on one panel.

### 6.1 The four required steps (gates)

All four must be satisfied to finish onboarding:

1. **Microphone Access** — the user clicks to grant; prompts the OS permission; shows `Granted` when done. (Required: hear the user's voice.)
2. **Accessibility Access** — the user clicks to grant; shows `Granted` when done. (Required: type transcribed text into other apps.) **This is now required** (no skip).
3. **API key** — the user adds at least one key from a supported provider: **xAI, OpenAI, or Gemini**. VOXCTL is bring-your-own-key; it does not work without one. After a key is added, the app **auto-selects an appropriate default model** for that provider.
4. **First recording** — the user records at least one transcription. Prompt them to hold the shortcut (`Option + Space`), record a short snippet, watch the text appear, then stop. On success, confirm with something like "You set up VOXCTL in 30 seconds."

When all four are satisfied, onboarding is complete and the user enters the main UI.

### 6.2 Re-entry guard

After onboarding, if the user ever breaks a hard requirement, VOXCTL forces them back to this same setup screen:

- Microphone access disabled, **or**
- Accessibility access disabled, **or**
- All API keys removed (so the app is unusable).

On re-entry:

- Because the screen lists all steps explicitly with per-step status, the user can immediately see **which step is broken** and fix only that one.
- If the user **already has recordings**, they do **not** need to record again — the "first recording" step is already satisfied.

---

## 7. Reference screenshots

### 7.1 Inspiration (other apps) — `design/design-inspiration-screenshots/`

Two source apps are referenced: **WhisperFlow** and **Superwhisper**. These inform **layout and interaction only**, not visual style.

| File | App | What it informs |
| --- | --- | --- |
| `whisperflow-homepage.png` | WhisperFlow | Home layout: day-grouped transcript list, time + transcript per entry, small stats strip on the side |
| `superwhisper-history-1.png` | Superwhisper | Collapsed transcript list + top search bar; uniform, readable cards |
| `superwhisper-history-2.png` | Superwhisper | Expanded card behavior: in-place expand, other cards grayed out, play control, tabs, copy/info/delete actions |
| `handy-onboarding.png` | Handy | Single permissions/setup screen with logo, header, and per-step status |

### 7.2 Current VOXCTL app (aesthetic to preserve) — `design/voxctl-current-app-screenshots/`

These are the **existing VOXCTL screens**; match this '90s sci-fi look in every redesigned screen.

| File | Screen | Notes |
| --- | --- | --- |
| `voxctl-home.png` | Home (current stats dashboard) | This content moves to the new **Stats** page |
| `voxctl-files.png` | Files (transcript list) | This content, simplified, becomes the new **Home** |
| `voxctl-modes.png` | Modes | Unchanged; shown for aesthetic reference |
| `voxctl-settings.png` | Settings | Unchanged; shows provider key cards / pricing style |

---

## 8. Aesthetic notes

### '90s sci-fi aesthetic
Keep VOXCTL's existing monospace, framed-panel, terminal look across every redesigned screen. Reference apps inform **layout and interaction**, never visual style.

<a id="provider-logos"></a>
### Provider logos (the one exception)
The expanded card's metadata row is the **only** place real company logos appear. Use the **Gemini**, **OpenAI**, and **xAI** logos as small provider icons, with the Mode name revealed on hover. Everywhere else, stay within the '90s sci-fi aesthetic (no other brand logos).

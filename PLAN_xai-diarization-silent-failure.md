# Plan — Surface xAI's silent diarization failure

**Date:** 2026-06-10
**Product decision:** No hard recording limit, no parser change, no chunking workaround. Add transparent UX around xAI’s long-file diarization limitation.

---

## 1. Background — what's actually broken

A user re-ran a recording through an xAI **file** mode with **SPEAKER DIARIZATION** on, got plain text back, but **no Speakers tab and no error** — with no way to tell "one speaker" from "diarization failed."

Root cause was traced to an **xAI server-side bug**, not VOXCTL:

* For audio up to roughly **54 min**, xAI returns `speaker` on every word.
* Our parser handles that shape correctly:

  * `words[]`
  * `parse_word` reads the `text` key and integer `speaker` field
  * `group_words_to_speakers` collapses runs into speaker segments
* Past the roughly **54–56 min** threshold, xAI returns **HTTP 200** with full `text` + `words` but silently drops every `speaker` field.
* Our parser then correctly produces zero speakers because there is nothing to attribute.
* Intermittent **502/500** responses can also occur near the threshold and are already handled by the transient retry path.

Therefore:

* **No parser change.** The parser is correct.
* **No hard 54-minute recording limit.** Users should never lose the ability to record or import long audio.
* **No chunking workaround.** Chunking is explicitly out of scope for now.
* **No single-request hard block.** The transcript can still succeed.
* The fix is product/UX: make the limitation visible before and after it matters.

---

## 2. Product goal

When xAI file diarization is likely to be unreliable, VOXCTL should communicate that clearly without blocking the user.

When diarization was requested but xAI returned no speaker attribution, VOXCTL should explicitly tell the user that the transcript completed but speaker labels were not returned.

The user should understand:

1. Their recording is safe.
2. Their transcript is still valid.
3. Speaker labels are the part that failed or may fail.
4. This is a known xAI long-file limitation.
5. They can use another model if they need more reliable diarization for long recordings.

---

## 3. Product decisions

### Do

* Add a **backend diarization-drop signal** on manual re-run.
* Render a **persistent per-card notice** when a manual re-run requested diarization but got no speaker segments.
* Add a **soft pre-run warning** before manual re-run only when all are true:

  * provider is xAI
  * mode is file transcription
  * diarization is enabled
  * recording duration is roughly 55+ minutes
* Add a **mode-settings informational hint** when the user creates or edits an xAI file mode and enables speaker diarization.
* Keep the language neutral, factual, and non-alarming.

### Do not

* Do not add a hard 54-minute recording limit.
* Do not stop recording at 54 minutes.
* Do not prevent users from importing long files.
* Do not change the parser.
* Do not add a chunking workaround.
* Do not persist a new DB column for this.
* Do not modify auto-retry behavior.
* Do not make the UI sound like the whole transcription failed when only speaker labels are affected.

---

## 4. Detection rule

The backend should detect the actual failure reactively after transcription returns.

Inside the manual re-run path, after `out` is produced:

```rust
let diarization_dropped = options.diarization
    && out.speakers.is_empty()
    && !out.text.trim().is_empty();
```

Meaning:

```txt
diarization was requested
AND transcript text exists
AND zero speaker segments were produced
```

This is the source of truth for the post-run notice.

Do **not** use duration to decide whether diarization succeeded. Duration is only used for a soft pre-run warning.

---

## 5. Backend implementation

Use the backend-signaled approach.

Change `retranscribe` from returning only a `String` to returning a small result object.

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerunResult {
    pub text: String,
    pub diarization_dropped: bool,
}
```

In `commands/transcription.rs::retranscribe`, after the transcription result is produced and saved:

```rust
let diarization_dropped = options.diarization
    && out.speakers.is_empty()
    && !out.text.trim().is_empty();

Ok(RerunResult {
    text: out.text.clone(),
    diarization_dropped,
})
```

No DB migration is needed. This signal is tied to the just-completed manual re-run.

---

## 6. IPC update

Update the frontend IPC wrapper in `src/lib/ipc.ts`.

Before:

```ts
export async function retranscribe(...): Promise<string> {
  return invoke("retranscribe", ...);
}
```

After:

```ts
export type RerunResult = {
  text: string;
  diarizationDropped: boolean;
};

export async function retranscribe(...): Promise<RerunResult> {
  return invoke<RerunResult>("retranscribe", ...);
}
```

Update all callers to expect the object shape.

---

## 7. Persistent per-card notice after manual re-run

In `src/panels/HistoryPanel.tsx`, update the manual re-run flow.

After:

```ts
const result = await retranscribe(...);
await onChange();
```

If:

```ts
result.diarizationDropped === true
```

then store a transient per-card notice keyed by recording ID.

Example shape:

```ts
const [cardNotices, setCardNotices] = useState<Record<number, CardNotice>>({});
```

Example notice type:

```ts
type CardNotice = {
  kind: "diarizationDropped";
};
```

Set it after the re-run succeeds:

```ts
if (result.diarizationDropped) {
  setCardNotices((prev) => ({
    ...prev,
    [item.id]: { kind: "diarizationDropped" },
  }));
}
```

Render the notice inside the expanded card body, near the transcript tabs / Speakers tab area.

This should be persistent while the card remains visible. Do not use only a global toast.

Suggested placement:

* Below the transcript action row, or
* Above the tab row where the Speakers tab would normally appear

The notice should not block copy, playback, export, or transcript viewing.

---

## 8. Soft pre-run warning for long xAI diarization re-runs

Before starting a manual re-run, show a non-blocking confirmation only when all are true:

```txt
provider is xAI
AND mode is file transcription
AND diarization is enabled
AND recording duration is roughly 55+ minutes
```

This is a UX warning, not a correctness rule.

Suggested helper:

```ts
function shouldWarnAboutXaiLongDiarization({
  provider,
  transcriptionKind,
  diarization,
  durationSeconds,
}: {
  provider: string;
  transcriptionKind: "file" | "realtime";
  diarization: boolean;
  durationSeconds?: number | null;
}) {
  return (
    provider === "xai" &&
    transcriptionKind === "file" &&
    diarization &&
    durationSeconds != null &&
    durationSeconds >= 55 * 60
  );
}
```

The threshold may exist as a frontend warning constant, but it must not prevent the user from continuing.

Example:

```ts
const XAI_DIARIZATION_WARNING_SECONDS = 55 * 60;
```

Do not use this constant in backend success/failure detection.

### Warning actions

The warning should offer:

* Continue with xAI
* Choose another mode
* Cancel

If the app already supports running without diarization as a separate mode/action, optionally include:

* Run transcript-only

Do not force the user away from xAI.

---

## 9. Mode-settings informational hint

When the user creates or edits a mode and all are true:

```txt
provider is xAI
AND mode is file transcription
AND speaker diarization is enabled
```

show a small informational hint near the speaker diarization setting.

This warning does not need the recording duration because it is explaining a mode-level limitation.

The copy should be neutral and non-scary.

Suggested placement:

* Directly under the speaker diarization toggle
* Or inside the provider capability details area
* Do not use a modal
* Do not block saving the mode

The hint should disappear if the user disables diarization, changes provider, or switches to a non-file mode.

---

## 10. Copy

Add i18n keys in `src/i18n/locales/en.json`.

### Post-run persistent card notice

```json
{
  "history.diarizationDropped.title": "Speaker labels were not returned",
  "history.diarizationDropped.body": "The transcript completed, but xAI did not return speaker labels for this recording. This can happen with longer file transcriptions. The transcript itself was saved."
}
```

### Manual re-run pre-run warning

```json
{
  "history.xaiLongDiarizationWarning.title": "Speaker labels may be unavailable",
  "history.xaiLongDiarizationWarning.body": "This recording is roughly 55+ minutes. xAI may return the transcript without speaker labels when diarization is enabled. You can continue, choose another mode, or cancel.",
  "history.xaiLongDiarizationWarning.continue": "Continue with xAI",
  "history.xaiLongDiarizationWarning.chooseMode": "Choose another mode",
  "history.xaiLongDiarizationWarning.cancel": "Cancel"
}
```

### Mode-settings hint

```json
{
  "modes.xaiDiarizationHint": "For longer file transcriptions, xAI may return the transcript without speaker labels. The transcript still completes, but diarization may be unavailable around 55+ minutes."
}
```

Keep wording factual. Avoid saying "broken," "failed completely," or "error" in the user-facing copy.

---

## 11. UI behavior

### If the transcript succeeds and speaker labels are returned

* Show transcript.
* Show Speakers tab.
* Show no warning after the run.

### If the transcript succeeds but speaker labels are missing after diarization was requested

* Show transcript.
* Do not show Speakers tab if there are no speaker segments.
* Show persistent per-card notice.
* Do not mark the whole transcription as failed.

### If the transcript itself fails

* Use the existing error path.
* Do not show the diarization-dropped notice.

### If diarization was not requested

* Do not show the diarization-dropped notice.
* No Speakers tab is expected.

---

## 12. Edge cases

### Single-speaker recordings

A real single-speaker xAI response should still include `speaker: 0` on words, producing one speaker segment.

So this condition should not misfire:

```txt
diarization requested
AND one speaker detected
```

That is a success state.

### Empty transcript

If text is empty, do not show the diarization-dropped notice. That is not a speaker-label-only failure.

### Auto-retry

Do not change `retry.rs`.

Auto-retry does not carry enough persisted diarization intent per row. Leave it untouched.

### Other providers

The backend detection is provider-agnostic by shape:

```txt
asked for diarization
got transcript
got zero speakers
```

But the soft pre-run and mode-settings warnings should be xAI-specific because this is currently a known xAI limitation.

---

## 13. Out of scope

Do not implement any of the following in this pass:

* Chunking audio to avoid the xAI threshold
* Hard recording limit
* Hard transcription limit
* Parser changes
* Speaker embedding matching
* Global speaker reconciliation
* DB schema migration
* Persisted provider capability snapshots
* Auto-retry changes
* General provider-health dashboard

---

## 14. Verification

### Backend

Add a small unit test around the detection rule if practical.

Expected `diarization_dropped = true` only when:

```txt
diarization requested
AND text is non-empty
AND speakers are empty
```

Expected `false` when:

```txt
diarization not requested
OR text is empty
OR speakers are non-empty
```

### Manual test — short xAI file

* Re-run a recording under roughly 54 minutes.
* Use xAI file mode with diarization enabled.
* Expected:

  * transcript appears
  * Speakers tab appears
  * no persistent notice

### Manual test — long xAI file

* Re-run a recording roughly 56+ minutes.
* Use xAI file mode with diarization enabled.
* Expected:

  * pre-run warning appears
  * user can continue
  * transcript appears
  * Speakers tab does not appear if xAI returned no speakers
  * persistent per-card notice appears

### Manual test — long xAI file with diarization off

* Re-run same file with diarization disabled.
* Expected:

  * no pre-run diarization warning
  * transcript appears
  * no Speakers tab
  * no persistent notice

### Manual test — mode settings

* Create or edit an xAI file transcription mode.
* Enable speaker diarization.
* Expected:

  * small informational hint appears near the diarization control
* Disable diarization.
* Expected:

  * hint disappears
* Change provider away from xAI.
* Expected:

  * hint disappears

### Manual test — non-xAI provider

* Use another provider with diarization enabled.
* Expected:

  * no xAI-specific pre-run warning
  * no xAI-specific mode-settings hint

### Build gates

Run:

```bash
cd src-tauri && cargo test && cargo clippy && cargo fmt --check
npm run build
npx biome check --write .
```

---

## 15. Follow-up

Keep the xAI bug report open.

If xAI fixes the long-file diarization behavior, the backend reactive notice naturally stops appearing because speaker segments will be returned again.

The soft warning can remain as a conservative product note until the behavior has been verified as fixed across long files.

# xAI STT file API: `diarize=true` silently omits `speaker` fields above ~54 minutes

**Report date:** 2026-06-10  
**Endpoint:** `POST https://api.x.ai/v1/stt`  
**Reporter context:** Debugging speaker diarization in [VOXCTL](https://github.com/derick/voxctl.com) (a BYOK desktop STT app). All tests below were run via raw `curl` against the xAI API — no client middleware.

---

## TL;DR (for humans and agents)

When calling the xAI **file** STT endpoint with `diarize=true`, speaker labels work correctly on audio **up to ~54 minutes**, then **silently disappear** on longer clips. The API returns **HTTP 200**, a full transcript, word-level timestamps, and correct `duration` — but **zero** `speaker` fields on any word. There is no error, warning, or documentation of this behavior.

**Estimated failure threshold:** between **54.1 minutes** (works) and **56.4 minutes** (fails).  
**Not** a clean 60-minute cutoff (59 min fails; 56 min fails).

This is reproducible on clips trimmed from the **same source recording**, so content/language are not the cause.

---

## Expected behavior (per xAI docs)

From [Speech to Text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text):

> When `true`, enables speaker diarization. Each word in the response includes a `speaker` field (integer) identifying the detected speaker.

Response schema:

| Field | Description |
|-------|-------------|
| `words` | Word-level segments with `text`, `start`, `end`, and **`speaker` (integer, only when `diarize=true`)** |

Documented limits: max file size **500 MB**. No documented max duration for diarization.

---

## Actual behavior

Two distinct failure modes observed on long audio:

### 1. Silent diarization drop (primary bug)

- HTTP **200**
- `text`, `language`, `duration`, `words[]` all present
- Each word has `text`, `start`, `end` only — **no `speaker` key at all**
- No top-level `segments` or `speakers` array as fallback
- Affects **100%** of words (not partial degradation toward end of file)

Verification one-liner:

```bash
jq '[.words[] | has("speaker")] | all' response.json
# true  → diarization present (working)
# false → diarization absent (broken)
```

### 2. Transient server errors (secondary, intermittent)

On the ~56-minute clip, two of three attempts failed before returning a transcript:

| Attempt | HTTP | Body |
|---------|------|------|
| 1 | 502 | `error code: 502` |
| 2 | 500 | `{"error":"Transcription service encountered an internal error."}` |
| 3 | 200 | Full transcript, **no speaker fields** |

These may be unrelated gateway timeouts, but they occurred only near the duration threshold.

---

## Test methodology

### Request (identical for every test)

```bash
curl -s https://api.x.ai/v1/stt \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -F "language=ja" \
  -F "diarize=true" \
  -F "file=@<AUDIO_FILE>"
```

- **Language:** `ja` (Japanese) for all long-clip tests; short control clip also `ja`
- **Diarization:** always `true`
- **No model parameter** (xAI STT is endpoint-configured; this matches xAI docs)
- **Audio format:** mono WAV, 24 kHz PCM16 (VOXCTL recording format)

### Source material

All duration-sweep clips were trimmed from the **same original ~77-minute recording** of a two-person Japanese conversation (plus brief background/third-voice artifacts in some segments). Clips were created with **QuickTime trim** on macOS (same codec, only duration changed).

A separate **~53-second control clip** (`rec-1781065999500-6.wav`) from a different recording (user intro + YouTube news audio) confirmed diarization works on short unrelated content.

### What we measured

For each response:

1. HTTP status
2. `duration` (seconds)
3. Word count
4. Whether **every** word includes `speaker`
5. Speaker ID distribution when present
6. First word object shape (presence/absence of `speaker` key)

---

## Results summary

| # | File | File size | Duration | HTTP | Words | All words have `speaker`? | Speaker IDs | Notes |
|---|------|-----------|----------|------|-------|---------------------------|-------------|-------|
| 1 | `rec-1781065999500-6.wav` | 2.4 MB | **52.87 s** (0.9 min) | 200 | 197 | **Yes** | 0, 1 | Different source; control |
| 2 | `7-minute-clip.wav` | 20 MB | **439.04 s** (7.3 min) | 200 | 1,556 | **Yes** | 0, 1 | Trimmed from original |
| 3 | `32-minute-clip.wav` | 88 MB | **1,928.23 s** (32.1 min) | 200 | 6,505 | **Yes** | 0, 1 | |
| 4 | `51-minute-clip.wav` | 141 MB | **3,078.36 s** (51.3 min) | 200 | 10,152 | **Yes** | 0, 1, 2† | Full-clip coverage verified by quartile |
| 5 | `54-minute-clip.wav` | 149 MB | **3,244.39 s** (54.1 min) | 200 | 10,549 | **Yes** | 0, 1, 2† | **Last known working duration** |
| 6 | `56-minute-clip.wav` | 155 MB | **3,385.89 s** (56.4 min) | 200‡ | 11,017 | **No** (0/11,017) | — | **First known failing duration** |
| 7 | `59-minute-clip.wav` | 162 MB | **3,540.90 s** (59.0 min) | 200 | 11,451 | **No** | — | |
| 8 | `60-minute-clip.wav` | 166 MB | **3,620.15 s** (60.3 min) | 200 | 11,736 | **No** | — | |
| 9 | `rec-1781011258476-0.wav` | 211 MB | **4,614.25 s** (76.9 min) | 200 | 13,953 | **No** | — | Original full recording |

† `speaker: 2` appears on only **33 words** in the 51- and 54-minute clips (likely brief third voice or mis-label); main conversation is speakers 0 and 1.

‡ Third attempt; attempts 1–2 returned 502/500.

### Threshold diagram

```
Duration (minutes)
0        10        20        30        40        50   54 56   60        77
|---------|---------|---------|---------|---------|----|--|----|---------|
[======== diarization works ========]              X  X    X         X
                                                    ↑  ↑
                                              last OK  first fail
                                              (54.1m)  (56.4m)
```

**Bracketed threshold: ~54–56 minutes (~3,244–3,386 seconds).**

---

## Example response shapes

### Working (~54 min) — first word

```json
{
  "text": "ス",
  "start": 17.01,
  "end": 17.09,
  "speaker": 0
}
```

### Broken (~56 min) — first word (same audio content, longer clip)

```json
{
  "text": "ス",
  "start": 17.01,
  "end": 17.09
}
```

Note: `start`/`end` timestamps are identical at the beginning — only `speaker` is missing. Transcription itself is not degraded.

### Broken (~77 min) — top-level fields still look healthy

```json
{
  "text": "<full Japanese transcript, ~15,000 chars>",
  "language": "Japanese",
  "duration": 4614.25,
  "words": [ /* 13,953 entries, none with speaker */ ]
}
```

---

## What this rules out

| Hypothesis | Evidence against |
|------------|------------------|
| Client bug (VOXCTL) | Reproduced with raw `curl` only |
| Wrong request params | Identical `curl` for all tests; short clips work |
| File size limit (500 MB) | Largest file 211 MB, well under limit |
| Language issue | Same `language=ja` works on short clips, fails on long |
| Audio content / speakers | Same source file trimmed; 54 min works, 56 min fails |
| Partial diarization drop-off | 0% of words have `speaker` when broken, across all quartiles |
| Clean 60-minute limit | 56 min and 59 min fail; 54 min works |

---

## Impact

Any application relying on xAI file STT diarization for recordings longer than ~1 hour (or possibly as short as ~55 minutes) will:

1. Receive no indication that diarization failed
2. Store/display transcripts without speaker attribution
3. Be unable to distinguish "one speaker" from "diarization silently skipped"

VOXCTL persists `extra_json: { words, speakers }` per recording. When xAI omits `speaker`, both arrays end up empty for speaker data despite the user enabling diarization on the mode.

---

## Suggested fixes (for xAI)

1. **Honor `diarize=true`** for the full documented file size/duration range, or
2. **Return an explicit error** when diarization cannot be applied (e.g. 400 with `"diarization_unavailable: duration exceeds limit"`), or
3. **Document the actual duration limit** for diarization in the STT API reference

---

## Reproduction steps

1. Obtain or create a mono WAV of a multi-speaker Japanese conversation **longer than 56 minutes** (or trim an existing file to 56+ min).
2. Run:

```bash
curl -s https://api.x.ai/v1/stt \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -F "language=ja" \
  -F "diarize=true" \
  -F "file=@long-clip.wav" \
  -o response.json
```

3. Verify:

```bash
jq '{duration, word_count: (.words|length), all_have_speaker: ([.words[]|has("speaker")]|all), first_word: .words[0]}' response.json
```

4. Compare with a **54-minute** trim of the same file — `all_have_speaker` should be `true`.

---

## Environment

- **Date of tests:** 2026-06-10
- **Client machine:** macOS (darwin 22.6.0)
- **Tool:** `curl` (direct API, no SDK)
- **API region (per docs):** us-east-1
- **Audio:** mono WAV, PCM16, 24 kHz sample rate

---

## Contact / follow-up

Happy to provide:

- Trimmed audio clips (54 min working, 56 min failing) on request
- Full JSON responses (largest ~645 KB for 77-min file)
- Additional bisect points (e.g. 55-minute clip) if helpful

**Suggested report channel:** support@x.ai (per [xAI debugging docs](https://docs.x.ai/developers/debugging))  
**Related docs:** https://docs.x.ai/developers/model-capabilities/audio/speech-to-text

---

## Machine-readable test matrix

```yaml
bug: xai-stt-diarize-silent-failure
endpoint: POST https://api.x.ai/v1/stt
params:
  language: ja
  diarize: true
failure_mode: silent  # HTTP 200, no speaker fields on any word
threshold_minutes:
  last_working: 54.07
  first_failing: 56.43
  bracket_minutes: [54.07, 56.43]
not_duration_limit: 60  # 56min and 59min fail; not a round 60min cutoff
tests:
  - {file: rec-1781065999500-6.wav, duration_sec: 52.87, diarize_ok: true}
  - {file: 7-minute-clip.wav, duration_sec: 439.04, diarize_ok: true}
  - {file: 32-minute-clip.wav, duration_sec: 1928.23, diarize_ok: true}
  - {file: 51-minute-clip.wav, duration_sec: 3078.36, diarize_ok: true}
  - {file: 54-minute-clip.wav, duration_sec: 3244.39, diarize_ok: true}
  - {file: 56-minute-clip.wav, duration_sec: 3385.89, diarize_ok: false, notes: "attempts 1-2 returned 502/500"}
  - {file: 59-minute-clip.wav, duration_sec: 3540.90, diarize_ok: false}
  - {file: 60-minute-clip.wav, duration_sec: 3620.15, diarize_ok: false}
  - {file: rec-1781011258476-0.wav, duration_sec: 4614.25, diarize_ok: false}
verify_command: jq '[.words[] | has("speaker")] | all' response.json
```

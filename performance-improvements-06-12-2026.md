# VOXCTL Performance Improvement Report — June 12, 2026

Scope: full read-through of `src-tauri/src/` and `src/` with a focus on the two
latency paths users actually feel (shortcut-press → mic open, shortcut-release →
transcript delivered), background/system-wide costs, DB + IPC scaling, and
frontend rendering. **Nothing here is implemented — this is analysis + proposals.**

What's already good (and should be preserved): capture/DSP lives in native Rust
threads; the mic-level meters update the DOM imperatively (no React reconciliation);
the HUD is pre-built so showing it never steals focus; history is windowed to 30
DOM cards; the cpal stream only exists while recording. The issues below are
mostly about what happens *around* that solid core.

---

## 1. Hot path: shortcut press → recording starts

This is the most important latency in a dictation app — any delay here clips the
user's first words.

### 1.1 Synchronous Accessibility-tree walk before the mic opens — **highest impact**

`commands/audio.rs:236` calls `modes::resolve_context()` *before*
`start_capture()` (line 274). `resolve_context` (`commands/modes.rs:542-585`)
calls `macos::focused_url()`, which does a breadth-first walk of up to **1,500 AX
elements** of the frontmost app (`platform/macos.rs:109-145`). Every
`AXUIElementCopyAttributeValue` is a synchronous IPC round-trip into the *target*
process. On a heavy browser window (or any busy/unresponsive app) this can take
hundreds of milliseconds — occasionally seconds — and all of it happens between
the hotkey press and the microphone opening.

Fixes, in order of preference:

1. **Use the already-cached active mode.** `ActiveModeState` is kept fresh by the
   app-switch observer; record-start can read the cache and skip re-resolving
   entirely. The only staleness risk is a tab change within the same browser app —
   acceptable, or refreshable in the background.
2. **Start capture first, resolve context in parallel.** The context isn't needed
   until the history row is written / the live session is configured; the mic
   doesn't need it at all. Reordering removes the AX walk from the critical path
   even if resolution stays as-is.
3. **Skip the URL walk when it can't matter:** if no *enabled* mode has
   `trigger_websites`, never call `focused_url()` (the common case for many users).
4. **Bound the walk:** call `AXUIElementSetMessagingTimeout` on the app element
   (e.g. 100–250 ms) so a hung target app can't stall recording; also consider
   lowering `MAX_VISITS` — the `AXWebArea` is nearly always shallow in the tree,
   so a depth-limited search would find it with far fewer visits.

### 1.2 Mode store re-written to disk on *every* load

`modes::load()` (`commands/modes.rs:222-250`) normalizes the modes and then
**unconditionally writes them back** (`store.set` + `store.save`, lines 233-236)
on every call. `load()` runs on every record start, every `list_modes` /
`get_active_mode` / `get_default_mode_id` IPC call, and — via
`recompute_and_emit` — on **every app switch system-wide**. That's a JSON
serialize + file write (and fsync) for what should be a read.

Fix: persist only when normalization actually changed something (compare before
writing, or return a `changed` flag from `normalize_mode`/`dedupe_by_id`).
Normalization only ever changes anything once per registry change, so this turns
a per-app-switch disk write into a once-ever write.

### 1.3 Synchronous DB insert + default journal mode at record start

`reserve_recording` (`history.rs:258-289`) inserts a row before recording is
considered started. With SQLite's default `DELETE` journal mode each commit
fsyncs; on a slow disk that's ~10 ms+, and it shares a single `Mutex<Connection>`
with everything else.

Fix: enable WAL once at `init` (`PRAGMA journal_mode=WAL; PRAGMA
synchronous=NORMAL;`). This makes every small write in the app (status flips,
copy counts, etc.) dramatically cheaper and lets reads proceed during writes.
(See also §4 — the same change helps the history panel.)

### 1.4 Keychain read at record start

`start()` reads the provider key from the Keychain (`commands/audio.rs:248-254`)
on the hot path. Usually ~ms, but Keychain calls can occasionally block. A small
in-memory key cache (invalidated by `set_api_key`/`delete_api_key`) removes the
syscall from the press-to-record path entirely.

### 1.5 Optional: pre-warm capture

Opening a CoreAudio input stream takes time (device power-up, route negotiation —
tens to ~200 ms). If first-word clipping is ever reported, an opt-in "keep the
input stream warm" setting would eliminate it; the trade-off is the persistent
orange mic indicator (privacy signal), so it must be opt-in. Cheaper variant:
begin opening the stream on key-*down* in press-and-hold mode.

---

## 2. Hot path: stop → transcript delivered

### 2.1 Live recordings are resampled twice

For live (OpenAI/xAI) sessions, audio is resampled to 24 kHz PCM16 *while
streaming* (`StreamResampler` in the forwarder, `commands/audio.rs:300-312`) and
then the **entire raw f32 buffer is resampled again** at stop for the WAV
(`audio_pipeline.rs:47` → `archive_audio_now` → `resample::resample_to_pcm16_24k`).
The sinc resampler (sinc_len 128, oversampling 128) over a long recording is
real CPU time, duplicated.

Fix: have the forwarder (or a tee on its output) accumulate the streamed PCM16
and write the WAV from that, skipping the second full-buffer pass for live modes.
This also fixes most of the memory issue in §2.4.

### 2.2 WAV bytes are copied ~4× before they reach the network

File-path flow today:

1. `archive_audio_now` resamples → `Vec<i16>` (copy 1) and writes the WAV
   (`history.rs:171-183`);
2. `transcribe_file` immediately **reads the same file back from disk**
   (`audio_pipeline.rs:108`, `std::fs::read`) (copy 2);
3. `wav_part` does `wav.to_vec()` (copy 3, `file_transcribe.rs:322-327`);
4. Gemini additionally base64-encodes (+33 %, copy 4) and embeds it in a
   `serde_json::Value` string (effectively copy 5).

For a 1-hour recording the WAV is ~173 MB; this chain peaks at several × that.

Fixes:
- Build the WAV container **in memory once** (`hound` supports writing to a
  `Cursor<Vec<u8>>`), write that buffer to disk *and* hand the same buffer
  (wrapped in `bytes::Bytes`) to the transcriber — no re-read, no `to_vec()`.
- `reqwest::multipart::Part::stream` / `Body::from(Bytes)` avoids the multipart
  copy.
- For Gemini, consider the Files/upload API for large audio instead of inline
  base64 JSON (also removes the 33 % wire overhead and the giant JSON string).

### 2.3 CPU-bound work runs on the async runtime, and WAV writing is per-sample

- `resample_to_pcm16_24k` + `write_wav` run inside `tauri::async_runtime::spawn`
  tasks (`audio_pipeline.rs:38-93`). A multi-second sinc pass occupies a tokio
  worker; use `spawn_blocking` for the resample/WAV-encode stage.
- `write_wav` calls `w.write_sample(s)` in a loop (`history.rs:179-181`). hound's
  documented fast path is `writer.get_i16_writer(n)` (bulk `SampleWriter16`) —
  typically several × faster on large files.
- The resampler settings (sinc_len 128 / oversampling 128 / BlackmanHarris2) are
  audiophile-grade. For 16-bit speech going to an STT model, sinc_len 64 (or
  rubato's `FastFixedIn` polynomial resampler) is transparent to transcription
  accuracy and roughly halves the cost. Worth an A/B against a few recordings.

### 2.4 Memory: raw f32 at device rate is held for the whole recording

The capture callback accumulates mono f32 at the device rate into one growing
`Vec` (`commands/audio.rs:78-88`). One hour at 48 kHz ≈ **690 MB**, with `Vec`
doubling causing transient peaks well above that — before the PCM16 copy is made.

Fix: convert to 24 kHz PCM16 *incrementally during capture* for **all**
recordings (the `StreamResampler` already exists and already does this for live
modes) and accumulate `Vec<i16>` instead — ~4× less resident memory, no
end-of-recording resample stall, and §2.1 falls out for free. Optionally append
to the WAV on disk incrementally, making memory O(1) and crash-safe mid-recording.

Cheap interim mitigations: `Vec::with_capacity` for ~60 s up front and periodic
`reserve` from the level-emitter loop to avoid doubling reallocations in the
audio callback's lock window.

### 2.5 Audio-callback hygiene (correct today, fragile under pressure)

The cpal callback allocates two `Vec`s per block (`downmix` at
`commands/audio.rs:90-104`, plus the channel send) and takes a `Mutex`
(`process_block`). Contention is rare (the consumer only locks at stop), but
allocation + locking inside a realtime audio callback is the classic source of
glitches under memory pressure. If long recordings become a first-class use case,
move to a lock-free SPSC ring buffer (`rtrb`/`ringbuf`) with a reused scratch
buffer for the downmix. Low urgency; listed for completeness.

---

## 3. System-wide background costs

### 3.1 Every app switch can trigger an AX tree walk on VOXCTL's main thread

`observe_app_switches` registers an NSWorkspace notification with `queue: None`
(`platform/macos.rs:210-228`), so the block runs on the **main thread**.
`refresh_active_mode` → `recompute_and_emit` → `current_match_context`
(`commands/modes.rs:420-431`) calls `focused_url()` — the same up-to-1,500-element
AX walk from §1.1 — synchronously on every Cmd-Tab anywhere on the system (when
unpinned). It can also block VOXCTL's UI event loop (tray, window events). Plus
§1.2's store write per switch.

Fixes: dispatch the recompute to a background thread with a short debounce
(~150 ms — fast app-switch sequences only need the last one); apply the same
"skip URL walk unless an enabled mode has website triggers" gate and AX
messaging timeout as §1.1.

### 3.2 Registry is re-parsed on every access

`registry::effective()` (`registry.rs:139-141`) deserializes the registry on
every call — either `serde_json::from_str` of the bundled JSON or
`serde_json::from_value` of the store cache. It's called at record start, in
`resolve_context`, in `valid_model_ids` (i.e. inside every `modes::load()`!), in
the pipeline, in failure handling, and in every retry-loop iteration. Each parse
is small, but it's pure waste on hot paths.

Fix: parse once into a `OnceLock<RwLock<Arc<Registry>>>` (or managed state),
invalidate on `refresh_registry`/`cache()`. Callers get an `Arc<Registry>` clone.

### 3.3 Retry worker polls forever

`retry.rs:45-52` queries `status = 'failed'` every 30 s for the life of the
process, and there is **no index on `status`** (schema: `history.rs:94-118`, only
`created_at`), so each poll is a full table scan. With a large archive that's a
periodic scan + `extra_json` parse of matching rows.

Fixes: add `CREATE INDEX idx_recordings_status ON recordings(status)` (also
speeds `list_by_status` at startup reconciliation), and/or wake the worker with a
`tokio::sync::Notify` when a row is marked failed instead of unconditional
polling. The xAI debug env check per WS frame (`xai_live.rs:205`) is the same
"do it once, not per event" pattern in miniature — read it once at session start.

---

## 4. Database + IPC scaling (the big architectural cliff)

### 4.1 `HISTORY_CHANGED` → full-table refetch, several times per recording

Every mutation emits `HISTORY_CHANGED`, and `App.tsx:113` responds by calling
`listHistory()` — which runs `SELECT <everything> FROM recordings ORDER BY
created_at DESC` with **no LIMIT** (`history.rs:405-423`), parses `extra_json`
for **every row** (`row_to_item`, lines 221-247), serializes every transcript
ever made to JSON for IPC, and re-renders the app.

A single dictation emits the event at least 4 times (reserve →
`commands/audio.rs:325`, stop → line 404, audio archived →
`audio_pipeline.rs:91`, transcript final → line 142). So one 5-second dictation
costs ~4 full scans + serializations of the entire archive. With a few thousand
recordings — especially diarized ones, whose `extra_json` word arrays can be MBs
each — this becomes the dominant cost of *using the app at all*, and it grows
forever.

Fixes (these compose; the first two are the big ones):

1. **Paginate at the DB.** `list_history(limit, before_created_at)` keyset
   pagination matching the UI's existing `PAGE_SIZE = 30` windowing — today the
   windowing only limits DOM nodes, not data fetched.
2. **Drop `extra_json` from list queries.** The list view needs it only to decide
   whether the STAMPS/SPEAKERS tabs exist. Select `length(extra_json) > 0` (or two
   boolean flags) in the list, and add a `get_history_detail(id)` command that
   returns word stamps/speakers when a card is expanded.
3. **Coalesce events.** Debounce `historyChanged` → refetch on the frontend
   (~100-150 ms) so event bursts cost one fetch; or better, emit the changed row
   in the payload and patch the local array instead of refetching.
4. **WAL + indexes** (§1.3, §3.3) so the remaining queries are cheap and don't
   serialize behind writes on the single mutex'd connection.
5. `delete_many` (`history.rs:485-499`) runs N selects + N deletes, each its own
   transaction. Wrap in one transaction (and `retranscribe`'s `update_result` +
   `set_model_id` pair can be one statement).

### 4.2 Synchronous Tauri commands run on the main thread

In Tauri v2, non-`async` commands execute on the **main thread**. That means
`list_history` (full-table scan + serialize), `provider_status` (3 Keychain
round-trips, `commands/config.rs:126-139`), `list_modes` (store load + the §1.2
disk write), and `read_audio` (a full `std::fs::read` of a possibly-hundreds-of-MB
WAV, `commands/history.rs:87-95`) can all freeze the UI event loop while they run.

Fix: mark the heavy commands `async` (Tauri then runs them on the async runtime)
and wrap blocking work (`fs::read`, SQLite, Keychain) in `spawn_blocking`.

### 4.3 `read_audio` returns `Vec<u8>` as a JSON number array

`ipc.ts:80` types it `number[]`: each byte becomes a JSON number (~3-4× wire
size, slow parse). Playback actually uses `convertFileSrc` + the asset protocol
(streamed from disk — the right design), so `read_audio` appears **dead**. Either
delete it, or if it's kept for future use, return `tauri::ipc::Response::new(bytes)`
to use Tauri's binary fast path.

---

## 5. Frontend rendering

### 5.1 All shared state lives in `App` → whole-tree re-renders

`history`, `modes`, `registry`, `providers`, `recording`, `toast`, `headerSection`
all live in `App.tsx`. Every `HISTORY_CHANGED` (≥4× per recording), every mode
event, and every toast re-renders the header, nav, `ModeSwitcher`, and the active
panel. None of the panels are memoized, and `App` recreates inline callbacks each
render, so `React.memo` alone won't stick without stabilizing props.

Fixes: wrap panels and `ModeSwitcher` in `React.memo` with `useCallback`-stable
props; compute the `META` reduce (`App.tsx:129-136`) in a `useMemo` keyed on
`history`; longer-term, move history into its own context/store so a history
refresh doesn't re-render the shell. (The transient stuff — Clock, meters,
Typewriter — is already correctly isolated.)

### 5.2 `HistoryPanel` does heavy per-card work on every render

For each of the (up to 30+) visible cards, **every render** recomputes
`speakerSegments(item)` (`HistoryPanel.tsx:779`) — which walks the full
`wordStamps` array (thousands of entries for long diarized recordings) — plus
`estimateCost`/`modelById` and date formatting. And "every render" includes
**every keystroke in the search box**, since `query` lives in the same component.

Fixes:
- Compute `speakerSegments`/tab availability only for the *expanded* card (or
  memoize per item id in a `useMemo`-built Map keyed on `history`).
- The search filter (`HistoryPanel.tsx:519-526`) lowercases and concatenates
  every transcript per keystroke. Wrap `query` in `useDeferredValue` (React 19)
  or debounce; precompute a lowercased haystack per item when `history` changes.
- At archive scale, move search into SQLite **FTS5** (index `transcript`) and
  query ids from the backend — combines with §4.1 pagination naturally.
- `speakerSegments` also *mutates* `last.text` on objects derived from props —
  besides being a React anti-pattern, it makes memoization hazardous; fix when
  memoizing.

### 5.3 Minor

- `dayLabel` builds 2-3 `Date` objects per item per render — fold into the
  memoized grouping.
- `IntersectionObserver` and scroll-spy re-attach per `visibleCount` bump — fine
  at current scale; revisit only if groups grow large.

---

## 6. Build, startup, binary

### 6.1 No `[profile.release]` in `src-tauri/Cargo.toml`

Defaults leave performance and size on the table. Suggested:

```toml
[profile.release]
lto = "thin"          # or true; cross-crate inlining (serde/tokio/reqwest heavy app)
codegen-units = 1     # better optimization at the cost of compile time
strip = true          # smaller binary
panic = "abort"       # smaller + faster unwind-free code (verify no catch_unwind reliance)
```

`lto` + `codegen-units = 1` typically give a real (single-digit %) speedup on
serde-heavy code paths like the registry/IPC/JSON parsing, plus a noticeably
smaller binary.

### 6.2 Startup setup is serial on the main thread

`setup()` (`lib.rs:93-113`) does Keychain migration (up to 2 Keychain reads),
tray build, shortcut registration, HUD webview pre-build, and DB open serially.
The HUD pre-build is a deliberate, documented trade-off (keep it). The Keychain
migration and retry-reconciliation could move off the setup path
(`spawn`/`spawn_blocking`) to shave cold-start time. Low priority.

---

## 7. Prioritized summary

| # | Change | Area | Impact | Effort |
|---|--------|------|--------|--------|
| 1 | Remove AX walk from record-start (cached mode / parallel resolve / trigger gate / AX timeout) | §1.1 | **High** — directly cuts press-to-record latency, prevents clipped first words | Medium |
| 2 | Paginate `list_history` + lazy `extra_json` detail fetch | §4.1 | **High** — removes the unbounded scaling cliff on every history event | Medium |
| 3 | Stop re-writing the mode store on every `load()` | §1.2 | High — disk write per app switch / record / IPC call becomes ~never | Low |
| 4 | SQLite WAL + `synchronous=NORMAL` + `status` index; transactions for bulk ops | §1.3/§3.3/§4.1 | High — cheaper writes everywhere, faster record-start | Low |
| 5 | Debounce/coalesce `HISTORY_CHANGED` refetches (or row-delta payloads) | §4.1 | High — 4×+ fewer full refreshes per recording | Low |
| 6 | Make heavy commands `async` + `spawn_blocking` (list_history, provider_status, read_audio, list_modes) | §4.2 | High — stops UI-thread freezes | Low |
| 7 | Single in-memory WAV buffer: write disk + send to API from one `Bytes` (no re-read, no `to_vec`) | §2.2 | Medium-High — big copies removed from stop-to-transcript | Medium |
| 8 | Accumulate 24 kHz PCM16 incrementally for all recordings (kills double resample + 4× memory) | §2.1/§2.4 | Medium-High for long recordings | Medium |
| 9 | Cache parsed registry (`OnceLock`) | §3.2 | Medium — removes JSON parse from several hot paths | Low |
| 10 | Background-thread + debounced app-switch recompute | §3.1 | Medium — keeps main thread free during Cmd-Tab | Low-Med |
| 11 | `HistoryPanel`: memoize per-card derived data; defer/debounce search | §5.2 | Medium — smooth search/expand on big archives | Low-Med |
| 12 | Memoize panels / `META`; stabilize App callbacks | §5.1 | Medium | Low-Med |
| 13 | hound bulk `i16` writer; `spawn_blocking` resample; lighter sinc params | §2.3 | Medium on long recordings | Low |
| 14 | `[profile.release]` lto/codegen-units/strip | §6.1 | Small-Medium, free | Low |
| 15 | Delete (or binary-fast-path) `read_audio`; key cache; Notify-driven retry; FTS5 search | misc | Small each | Low |

### Measuring before/after

Worth adding lightweight instrumentation before touching anything, so wins are
provable: a `log::debug!` timing span around (a) shortcut-press → `stream.play()`,
(b) stop → `TRANSCRIPT_FINAL` (already captured as `transcription_ms`), and
(c) `list_history` duration + row count. Items 1-6 should each be visible in
those three numbers.

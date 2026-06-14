//! Recording history: a SQLite metadata index + one WAV file per recording on
//! disk. We keep audio out of the DB (BLOBs bloat it / slow queries) and store
//! a path instead — fast feed queries, cheap streaming playback. Every
//! recording is saved here, even when injection or transcription fails, so a
//! capture is never lost (brief §3).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::file_transcribe::{SpeakerSeg, WordStamp};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: i64,
    pub created_at: i64,
    pub transcript: String,
    pub language: String,
    pub mode_name: String,
    pub app_name: Option<String>,
    pub website: Option<String>,
    pub duration_secs: f64,
    pub words: i64,
    pub favorite: bool,
    pub copy_count: i64,
    pub audio_path: String,
    /// "recording" | "transcribing" | "done" | "failed" | "needs_transcription".
    pub status: String,
    /// Registry model id used (drives cost + auto-retry).
    pub model_id: String,
    /// Size of the saved WAV on disk, in bytes (0 if the file is gone).
    pub audio_bytes: i64,
    /// "capturing" | "saving" | "ready" | "failed".
    pub audio_status: String,
    /// Wall-clock from recording-stop to the final transcript being persisted,
    /// in milliseconds (0 until a transcription completes).
    pub transcription_ms: i64,
    /// Per-word timing (present only when the mode/model produced word timestamps).
    /// Empty in list payloads — fetched lazily via detail() on expand (perf §4.1).
    #[serde(default)]
    pub word_stamps: Vec<WordStamp>,
    /// Speaker-attributed segments (present only when diarization produced them).
    /// Empty in list payloads — see word_stamps.
    #[serde(default)]
    pub speakers: Vec<SpeakerSeg>,
    /// Whether word-level timestamps exist (gates the STAMPS tab without shipping
    /// the potentially-MB word array). Always set; the array is fetched on expand.
    #[serde(default)]
    pub has_word_stamps: bool,
    /// Whether speaker info exists — top-level segments OR word-level speaker
    /// labels (matches the UI's speakerSegments()). Gates the SPEAKERS tab.
    #[serde(default)]
    pub has_speakers: bool,
}

/// Parse the persisted `extra_json` blob (`{ words, speakers }`) into the typed
/// structured fields. Tolerates NULL/empty/garbage by returning empties.
fn parse_extra(s: Option<String>) -> (Vec<WordStamp>, Vec<SpeakerSeg>) {
    #[derive(Deserialize, Default)]
    struct Extra {
        #[serde(default)]
        words: Vec<WordStamp>,
        #[serde(default)]
        speakers: Vec<SpeakerSeg>,
    }
    let Some(s) = s.filter(|s| !s.is_empty()) else {
        return (Vec::new(), Vec::new());
    };
    serde_json::from_str::<Extra>(&s)
        .map(|e| (e.words, e.speakers))
        .unwrap_or_default()
}

/// Managed state: the open SQLite connection.
pub struct HistoryDb(pub Mutex<Connection>);

static FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn recordings_dir(app: &AppHandle) -> PathBuf {
    let dir = data_dir(app).join("recordings");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recordings (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at    INTEGER NOT NULL,
            transcript    TEXT    NOT NULL,
            language      TEXT    NOT NULL,
            mode_name     TEXT    NOT NULL,
            app_name      TEXT,
            website       TEXT,
            duration_secs REAL    NOT NULL,
            words         INTEGER NOT NULL,
            favorite      INTEGER NOT NULL DEFAULT 0,
            copy_count    INTEGER NOT NULL DEFAULT 0,
            audio_path    TEXT    NOT NULL,
            status        TEXT    NOT NULL DEFAULT 'done',
            model_id      TEXT    NOT NULL DEFAULT '',
            audio_bytes   INTEGER NOT NULL DEFAULT 0,
            audio_status  TEXT    NOT NULL DEFAULT 'ready',
            transcription_ms INTEGER NOT NULL DEFAULT 0,
            extra_json    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC);",
    )
}

/// Add columns introduced after the initial schema. Guarded so it's a no-op on
/// databases that already have them (existing installs predate status/model_id).
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut have: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("PRAGMA table_info(recordings)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        for c in rows {
            have.push(c?);
        }
    }
    if !have.iter().any(|c| c == "status") {
        conn.execute_batch(
            "ALTER TABLE recordings ADD COLUMN status TEXT NOT NULL DEFAULT 'done'",
        )?;
    }
    if !have.iter().any(|c| c == "model_id") {
        conn.execute_batch("ALTER TABLE recordings ADD COLUMN model_id TEXT NOT NULL DEFAULT ''")?;
    }
    if !have.iter().any(|c| c == "audio_bytes") {
        conn.execute_batch(
            "ALTER TABLE recordings ADD COLUMN audio_bytes INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    if !have.iter().any(|c| c == "audio_status") {
        conn.execute_batch(
            "ALTER TABLE recordings ADD COLUMN audio_status TEXT NOT NULL DEFAULT 'ready'",
        )?;
    }
    if !have.iter().any(|c| c == "transcription_ms") {
        conn.execute_batch(
            "ALTER TABLE recordings ADD COLUMN transcription_ms INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    if !have.iter().any(|c| c == "extra_json") {
        conn.execute_batch("ALTER TABLE recordings ADD COLUMN extra_json TEXT")?;
    }
    // Index `status` for the retry worker's poll and startup reconciliation
    // (perf §3.3/§4.1). Created here (not in create_schema) so it runs only
    // after the status column is guaranteed to exist on legacy databases.
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status)")?;
    Ok(())
}

pub fn init(app: &AppHandle) -> Result<HistoryDb, String> {
    let dir = data_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    let conn = Connection::open(dir.join("voxctl.db")).map_err(|e| format!("open db: {e}"))?;
    // WAL + synchronous=NORMAL (perf §1.3/§4.1): commits stop fsync-ing the whole
    // DB, so every small write — reserve_recording on the record-start hot path,
    // status flips, copy counts — is dramatically cheaper, and reads proceed
    // concurrently with writes on the single shared connection. Set once per open.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("pragmas: {e}"))?;
    create_schema(&conn).map_err(|e| format!("schema: {e}"))?;
    migrate(&conn).map_err(|e| format!("migrate: {e}"))?;
    Ok(HistoryDb(Mutex::new(conn)))
}

// ---- WAV helpers ----

/// Encode PCM16 mono into a WAV container in memory (no disk). Lets the same bytes
/// be written to disk AND handed to the file transcriber without re-reading the
/// file or an extra copy (§2.2).
pub fn encode_wav(pcm16: &[i16], rate: u32) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut w =
            hound::WavWriter::new(&mut cursor, spec).map_err(|e| format!("wav create: {e}"))?;
        {
            // hound's bulk i16 fast path: pack all samples in one pass instead of a
            // bounds-checked write_sample() call per sample (§2.3). Byte-identical
            // output (covered by wav_roundtrip), just several× faster on long files.
            let mut sw = w.get_i16_writer(pcm16.len() as u32);
            for &s in pcm16 {
                sw.write_sample(s);
            }
            sw.flush().map_err(|e| format!("wav write: {e}"))?;
        }
        w.finalize().map_err(|e| format!("wav finalize: {e}"))?;
    }
    Ok(cursor.into_inner())
}

#[cfg(test)]
pub fn read_wav(path: &str) -> Result<Vec<i16>, String> {
    let mut r = hound::WavReader::open(path).map_err(|e| format!("wav open: {e}"))?;
    r.samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("wav read: {e}"))
}

// ---- CRUD ----

#[allow(clippy::too_many_arguments)]
fn insert_row(
    conn: &Connection,
    created_at: i64,
    transcript: &str,
    language: &str,
    mode_name: &str,
    app_name: Option<&str>,
    website: Option<&str>,
    duration_secs: f64,
    words: i64,
    audio_path: &str,
    status: &str,
    model_id: &str,
    audio_bytes: i64,
    audio_status: &str,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO recordings
            (created_at, transcript, language, mode_name, app_name, website, duration_secs, words, audio_path, status, model_id, audio_bytes, audio_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![created_at, transcript, language, mode_name, app_name, website, duration_secs, words, audio_path, status, model_id, audio_bytes, audio_status],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_item(row: &rusqlite::Row) -> rusqlite::Result<HistoryItem> {
    let mut item = HistoryItem {
        id: row.get(0)?,
        created_at: row.get(1)?,
        transcript: row.get(2)?,
        language: row.get(3)?,
        mode_name: row.get(4)?,
        app_name: row.get(5)?,
        website: row.get(6)?,
        duration_secs: row.get(7)?,
        words: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
        copy_count: row.get(10)?,
        audio_path: row.get(11)?,
        status: row.get(12)?,
        model_id: row.get(13)?,
        audio_bytes: row.get(14)?,
        audio_status: row.get(15)?,
        transcription_ms: row.get(16)?,
        word_stamps: Vec::new(),
        speakers: Vec::new(),
        has_word_stamps: false,
        has_speakers: false,
    };
    let (word_stamps, speakers) = parse_extra(row.get::<_, Option<String>>(17)?);
    item.has_word_stamps = !word_stamps.is_empty();
    item.has_speakers = !speakers.is_empty() || word_stamps.iter().any(|w| w.speaker.is_some());
    item.word_stamps = word_stamps;
    item.speakers = speakers;
    Ok(item)
}

const SELECT_COLS: &str =
    "id, created_at, transcript, language, mode_name, app_name, website, duration_secs, words, favorite, copy_count, audio_path, status, model_id, audio_bytes, audio_status, transcription_ms, extra_json";

/// Columns for the list view: everything in SELECT_COLS *except* extra_json, plus
/// two cheap flags derived in SQL. The (potentially MB) word/speaker arrays never
/// leave SQLite or cross IPC — fetched lazily via detail() on expand (perf §4.1).
/// instr() matches a field key *with its colon* (`"word":` / `"speaker":`), which
/// never collides with the plural top-level keys (`"words"` / `"speakers"`):
///   - any `"word":`    ⟺ the words array is non-empty (STAMPS tab)
///   - any `"speaker":` ⟺ a SpeakerSeg or a word-level speaker exists (SPEAKERS tab)
const LIST_COLS: &str = "id, created_at, transcript, language, mode_name, app_name, website, duration_secs, words, favorite, copy_count, audio_path, status, model_id, audio_bytes, audio_status, transcription_ms, (COALESCE(instr(extra_json, '\"word\":'), 0) > 0), (COALESCE(instr(extra_json, '\"speaker\":'), 0) > 0)";

/// Row → list item: full metadata + transcript, but no word/speaker arrays (the
/// flags at columns 17/18 gate the detail tabs instead). See LIST_COLS.
fn row_to_list_item(row: &rusqlite::Row) -> rusqlite::Result<HistoryItem> {
    Ok(HistoryItem {
        id: row.get(0)?,
        created_at: row.get(1)?,
        transcript: row.get(2)?,
        language: row.get(3)?,
        mode_name: row.get(4)?,
        app_name: row.get(5)?,
        website: row.get(6)?,
        duration_secs: row.get(7)?,
        words: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
        copy_count: row.get(10)?,
        audio_path: row.get(11)?,
        status: row.get(12)?,
        model_id: row.get(13)?,
        audio_bytes: row.get(14)?,
        audio_status: row.get(15)?,
        transcription_ms: row.get(16)?,
        word_stamps: Vec::new(),
        speakers: Vec::new(),
        has_word_stamps: row.get::<_, i64>(17)? != 0,
        has_speakers: row.get::<_, i64>(18)? != 0,
    })
}

fn next_recording_path(app: &AppHandle, created_at: i64) -> PathBuf {
    let n = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    recordings_dir(app).join(format!("rec-{created_at}-{n}.wav"))
}

#[allow(clippy::too_many_arguments)]
pub fn reserve_recording(
    app: &AppHandle,
    language: &str,
    mode_name: &str,
    app_name: Option<&str>,
    website: Option<&str>,
    model_id: &str,
) -> Result<(i64, String, i64), String> {
    let created_at = now_millis();
    let path = next_recording_path(app, created_at);
    let path_str = path.to_string_lossy().to_string();
    let db = app.state::<HistoryDb>();
    let conn = db.0.lock().unwrap();
    let id = insert_row(
        &conn,
        created_at,
        "",
        language,
        mode_name,
        app_name,
        website,
        0.0,
        0,
        &path_str,
        "recording",
        model_id,
        0,
        "capturing",
    )
    .map_err(|e| format!("reserve recording: {e}"))?;
    Ok((id, path_str, created_at))
}

pub fn mark_stopped(db: &HistoryDb, id: i64, duration_secs: f64, status: &str, audio_status: &str) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET duration_secs = ?2, status = ?3, audio_status = ?4 WHERE id = ?1",
        params![id, duration_secs, status, audio_status],
    );
}

/// Update a row with the transcription result, final status, how long the
/// transcription took (ms from recording-stop), and any structured `extra_json`
/// (`{ words, speakers }`; None leaves the column as-is/null).
pub fn update_result(
    db: &HistoryDb,
    id: i64,
    transcript: &str,
    language: &str,
    status: &str,
    transcription_ms: i64,
    extra_json: Option<&str>,
) {
    let conn = db.0.lock().unwrap();
    let words = transcript.split_whitespace().count() as i64;
    let _ = conn.execute(
        "UPDATE recordings SET transcript = ?2, language = ?3, words = ?4, status = ?5, transcription_ms = ?6, extra_json = ?7 WHERE id = ?1",
        params![id, transcript, language, words, status, transcription_ms, extra_json],
    );
}

/// Like `update_result` but also sets `model_id` in the same statement — used by
/// re-run, where a recording is re-transcribed through a different mode's model.
/// One UPDATE instead of the previous update_result + set_model_id pair (perf §4.1).
#[allow(clippy::too_many_arguments)]
pub fn update_result_and_model(
    db: &HistoryDb,
    id: i64,
    transcript: &str,
    language: &str,
    status: &str,
    transcription_ms: i64,
    extra_json: Option<&str>,
    model_id: &str,
) {
    let conn = db.0.lock().unwrap();
    let words = transcript.split_whitespace().count() as i64;
    let _ = conn.execute(
        "UPDATE recordings SET transcript = ?2, language = ?3, words = ?4, status = ?5, transcription_ms = ?6, extra_json = ?7, model_id = ?8 WHERE id = ?1",
        params![id, transcript, language, words, status, transcription_ms, extra_json, model_id],
    );
}

/// Persist the best-available live transcript mid-capture without touching
/// `status` (the row stays `recording`/`transcribing`), so a crash before stop
/// leaves recoverable text. Called at stable points by the live transcript sink.
pub fn update_partial_transcript(db: &HistoryDb, id: i64, transcript: &str) {
    let conn = db.0.lock().unwrap();
    let words = transcript.split_whitespace().count() as i64;
    let _ = conn.execute(
        "UPDATE recordings SET transcript = ?2, words = ?3 WHERE id = ?1",
        params![id, transcript, words],
    );
}

pub fn update_audio_result(db: &HistoryDb, id: i64, audio_bytes: i64, audio_status: &str) -> bool {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "UPDATE recordings SET audio_bytes = ?2, audio_status = ?3 WHERE id = ?1",
        params![id, audio_bytes, audio_status],
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// Set just the status (e.g. moving a row to `failed`/`needs_transcription`).
pub fn set_status(db: &HistoryDb, id: i64, status: &str) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET status = ?2 WHERE id = ?1",
        params![id, status],
    );
}

pub fn set_audio_status(db: &HistoryDb, id: i64, status: &str) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET audio_status = ?2 WHERE id = ?1",
        params![id, status],
    );
}

/// Reconcile rows interrupted while audio archival was in progress.
pub fn reconcile_audio_status(app: &AppHandle) -> bool {
    let db = app.state::<HistoryDb>();
    let rows = {
        let conn = db.0.lock().unwrap();
        let mut stmt = match conn.prepare(&format!(
            "SELECT {SELECT_COLS} FROM recordings WHERE audio_status IN ('capturing', 'saving')"
        )) {
            Ok(s) => s,
            Err(e) => {
                log::error!("reconcile_audio_status prepare: {e}");
                return false;
            }
        };
        let rows = match stmt.query_map([], row_to_item) {
            Ok(iter) => iter.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(e) => {
                log::error!("reconcile_audio_status query: {e}");
                return false;
            }
        };
        rows
    };
    let mut changed = false;
    for item in rows {
        let path = Path::new(&item.audio_path);
        if path.exists() {
            let bytes = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
            changed |= update_audio_result(&db, item.id, bytes, "ready");
        } else if let Some((bytes, secs)) = recover_pcm_sidecar(&item.audio_path) {
            // A file-mode capture crashed mid-recording (Path B): the raw PCM16
            // sidecar survived. We wrapped it into a playable WAV; surface it for
            // a MANUAL re-run (needs_transcription — deliberately not auto-retried).
            recover_partial_recording(&db, item.id, bytes, secs);
            changed = true;
        } else {
            set_audio_status(&db, item.id, "failed");
            changed = true;
        }
    }
    changed
}

/// If a raw PCM16 sidecar (`{audio_path}.pcm`, written during file-mode capture
/// for crash recovery) exists, wrap it into a playable WAV at `audio_path` and
/// delete the sidecar. The sidecar is headerless mono 24 kHz PCM16, so building a
/// valid WAV from it is deterministic. Returns (wav byte length, duration secs).
fn recover_pcm_sidecar(audio_path: &str) -> Option<(i64, f64)> {
    let sidecar = format!("{audio_path}.pcm");
    let raw = std::fs::read(&sidecar).ok()?;
    if raw.len() < 2 {
        return None;
    }
    let pcm16: Vec<i16> = raw
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    let wav = encode_wav(&pcm16, crate::resample::TARGET_RATE).ok()?;
    std::fs::write(audio_path, &wav).ok()?;
    let _ = std::fs::remove_file(&sidecar);
    let secs = pcm16.len() as f64 / crate::resample::TARGET_RATE as f64;
    Some((wav.len() as i64, secs))
}

/// Mark a recording recovered from its PCM sidecar: audio is ready on disk, but
/// no transcript was produced, so it awaits a manual re-run by mode.
fn recover_partial_recording(db: &HistoryDb, id: i64, audio_bytes: i64, duration_secs: f64) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET audio_bytes = ?2, duration_secs = ?3, audio_status = 'ready', status = 'needs_transcription' WHERE id = ?1",
        params![id, audio_bytes, duration_secs],
    );
}

/// Rows currently in a given status (used by the retry worker).
pub fn list_by_status(db: &HistoryDb, status: &str) -> Vec<HistoryItem> {
    let conn = db.0.lock().unwrap();
    let sql =
        format!("SELECT {SELECT_COLS} FROM recordings WHERE status = ?1 ORDER BY created_at ASC");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("list_by_status prepare: {e}");
            return Vec::new();
        }
    };
    let rows = stmt.query_map(params![status], row_to_item);
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => {
            log::error!("list_by_status query: {e}");
            Vec::new()
        }
    }
}

pub fn list(db: &HistoryDb) -> Vec<HistoryItem> {
    // perf instrumentation (§6 measuring before/after): DB scan + extra_json
    // parse cost grows with the archive — log duration + row count so the
    // pagination work (perf/06) is provable. Cheap; gated behind `debug`.
    let t0 = std::time::Instant::now();
    let conn = db.0.lock().unwrap();
    let sql = format!("SELECT {LIST_COLS} FROM recordings ORDER BY created_at DESC");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("list prepare: {e}");
            return Vec::new();
        }
    };
    let rows = stmt.query_map([], row_to_list_item);
    let items: Vec<HistoryItem> = match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => {
            log::error!("list query: {e}");
            Vec::new()
        }
    };
    log::debug!(
        "perf: list_history {} rows in {} ms",
        items.len(),
        t0.elapsed().as_millis()
    );
    items
}

pub fn get(db: &HistoryDb, id: i64) -> Option<HistoryItem> {
    let conn = db.0.lock().unwrap();
    let sql = format!("SELECT {SELECT_COLS} FROM recordings WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_item).ok()
}

/// Lazily-fetched structured detail for one recording — the word/speaker arrays
/// the list view omits (perf §4.1). Fetched when a history card is expanded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDetail {
    pub word_stamps: Vec<WordStamp>,
    pub speakers: Vec<SpeakerSeg>,
}

/// Word/speaker detail for a single recording (just the one row's extra_json).
pub fn detail(db: &HistoryDb, id: i64) -> Option<HistoryDetail> {
    let conn = db.0.lock().unwrap();
    let extra: Option<String> = conn
        .query_row(
            "SELECT extra_json FROM recordings WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()?;
    let (word_stamps, speakers) = parse_extra(extra);
    Some(HistoryDetail {
        word_stamps,
        speakers,
    })
}

/// Delete a row; returns the audio path so the caller can remove the file.
pub fn delete(db: &HistoryDb, id: i64) -> Option<String> {
    let conn = db.0.lock().unwrap();
    let path: Option<String> = conn
        .query_row(
            "SELECT audio_path FROM recordings WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    let _ = conn.execute("DELETE FROM recordings WHERE id = ?1", params![id]);
    path
}

pub fn toggle_favorite(db: &HistoryDb, id: i64) -> bool {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET favorite = 1 - favorite WHERE id = ?1",
        params![id],
    );
    conn.query_row(
        "SELECT favorite FROM recordings WHERE id = ?1",
        params![id],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .unwrap_or(false)
}

pub fn increment_copy(db: &HistoryDb, id: i64) -> i64 {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET copy_count = copy_count + 1 WHERE id = ?1",
        params![id],
    );
    conn.query_row(
        "SELECT copy_count FROM recordings WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Delete multiple rows; returns each removed row's audio path so the caller can
/// decide whether to also remove the file (per the delete-behavior setting).
pub fn delete_many(db: &HistoryDb, ids: &[i64]) -> Vec<String> {
    let mut conn = db.0.lock().unwrap();
    let mut paths = Vec::new();
    // One transaction instead of N implicit ones — a single commit for the whole
    // batch rather than a fsync per row (perf §4.1).
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => {
            log::error!("delete_many transaction: {e}");
            return paths;
        }
    };
    for &id in ids {
        if let Ok(p) = tx.query_row(
            "SELECT audio_path FROM recordings WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        ) {
            paths.push(p);
        }
        let _ = tx.execute("DELETE FROM recordings WHERE id = ?1", params![id]);
    }
    let _ = tx.commit();
    paths
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    /// Total bytes of all WAV files in the recordings directory (incl. any orphans).
    pub total_bytes: i64,
    pub file_count: i64,
    pub recording_count: i64,
}

/// Disk usage of the recordings directory + how many history rows exist.
pub fn storage_stats(app: &AppHandle) -> StorageStats {
    let dir = recordings_dir(app);
    let mut total_bytes = 0i64;
    let mut file_count = 0i64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Ok(meta) = e.metadata() {
                if meta.is_file() {
                    total_bytes += meta.len() as i64;
                    file_count += 1;
                }
            }
        }
    }
    let db = app.state::<HistoryDb>();
    let recording_count =
        db.0.lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM recordings", [], |r| r.get(0))
            .unwrap_or(0);
    StorageStats {
        total_bytes,
        file_count,
        recording_count,
    }
}

/// Enforce the auto-delete retention `policy`, returning the audio paths of the
/// removed rows so the caller can delete the files. Only terminal rows
/// (`done`/`failed`) are eligible, so a row still `recording`/`transcribing` is
/// never swept out from under the pipeline. `"never"` and unknown policies are
/// no-ops. Time policies delete rows older than a fixed age; `keep_latest_5`
/// keeps the 5 most recent recordings and drops the rest.
pub fn enforce_retention(db: &HistoryDb, policy: &str) -> Vec<String> {
    // Eligible-row predicate. The cutoff/limit is interpolated from a trusted
    // i64 or a constant — no user input reaches the SQL string.
    let predicate = match policy {
        "after_3_days" => time_predicate(3),
        "after_2_weeks" => time_predicate(14),
        "after_3_months" => time_predicate(90),
        "keep_latest_5" => "status IN ('done','failed') AND id NOT IN \
             (SELECT id FROM recordings ORDER BY created_at DESC LIMIT 5)"
            .to_string(),
        _ => return Vec::new(),
    };
    let conn = db.0.lock().unwrap();
    let paths: Vec<String> = {
        let mut stmt = match conn.prepare(&format!(
            "SELECT audio_path FROM recordings WHERE {predicate}"
        )) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| r.get::<_, String>(0));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    };
    let _ = conn.execute(&format!("DELETE FROM recordings WHERE {predicate}"), []);
    paths
}

/// SQL predicate for a time-based retention policy: terminal rows older than
/// `days` from now.
fn time_predicate(days: i64) -> String {
    let cutoff = now_millis() - days * 86_400_000;
    format!("status IN ('done','failed') AND created_at < {cutoff}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("voxctl-test-{}.wav", now_millis()));
        let samples: Vec<i16> = (0..1000).map(|i| (i % 256 - 128) as i16 * 100).collect();
        let bytes = encode_wav(&samples, 24000).unwrap();
        std::fs::write(&path, bytes).unwrap();
        let back = read_wav(&path.to_string_lossy()).unwrap();
        assert_eq!(samples, back);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn crud_in_memory() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        let id = insert_row(
            &conn,
            1000,
            "hello world",
            "en",
            "CLAUDE",
            Some("Claude"),
            None,
            1.5,
            2,
            "/tmp/x.wav",
            "done",
            "gpt-4o-transcribe",
            12345,
            "ready",
        )
        .unwrap();
        assert_eq!(id, 1);

        // favorite toggles 0 -> 1
        conn.execute(
            "UPDATE recordings SET favorite = 1 - favorite WHERE id = ?1",
            params![id],
        )
        .unwrap();
        let fav: i64 = conn
            .query_row(
                "SELECT favorite FROM recordings WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fav, 1);

        // copy_count increments
        conn.execute(
            "UPDATE recordings SET copy_count = copy_count + 1 WHERE id = ?1",
            params![id],
        )
        .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT copy_count FROM recordings WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let item = conn
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM recordings WHERE id = ?1"),
                params![id],
                row_to_item,
            )
            .unwrap();
        assert_eq!(item.transcript, "hello world");
        assert_eq!(item.words, 2);
        assert_eq!(item.app_name.as_deref(), Some("Claude"));
        assert_eq!(item.status, "done");
        assert_eq!(item.model_id, "gpt-4o-transcribe");
    }

    #[test]
    fn migrate_adds_columns_to_legacy_db_idempotently() {
        // Simulate a pre-status/model_id database.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
                transcript TEXT NOT NULL, language TEXT NOT NULL, mode_name TEXT NOT NULL,
                app_name TEXT, website TEXT, duration_secs REAL NOT NULL, words INTEGER NOT NULL,
                favorite INTEGER NOT NULL DEFAULT 0, copy_count INTEGER NOT NULL DEFAULT 0,
                audio_path TEXT NOT NULL );
             INSERT INTO recordings (created_at, transcript, language, mode_name, duration_secs, words, audio_path)
             VALUES (1, 'hi', 'en', 'M', 1.0, 1, '/tmp/a.wav');",
        )
        .unwrap();
        // Running migrate twice must be safe and leave legacy rows as done/ready.
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let (status, model, audio_status): (String, String, String) = conn
            .query_row(
                "SELECT status, model_id, audio_status FROM recordings WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "done");
        assert_eq!(model, "");
        assert_eq!(audio_status, "ready");
    }

    #[test]
    fn status_lifecycle() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        let id = insert_row(
            &conn,
            1,
            "",
            "auto",
            "M",
            None,
            None,
            2.0,
            0,
            "/tmp/a.wav",
            "transcribing",
            "grok-stt",
            0,
            "ready",
        )
        .unwrap();
        let db = HistoryDb(Mutex::new(conn));
        assert_eq!(list_by_status(&db, "transcribing").len(), 1);
        update_result(&db, id, "done text", "en", "done", 1234, None);
        assert!(list_by_status(&db, "transcribing").is_empty());
        let item = get(&db, id).unwrap();
        assert_eq!(item.status, "done");
        assert_eq!(item.audio_status, "ready");
        assert_eq!(item.words, 2);
        assert_eq!(item.transcription_ms, 1234);
        update_audio_result(&db, id, 99, "failed");
        let item = get(&db, id).unwrap();
        assert_eq!(item.audio_bytes, 99);
        assert_eq!(item.audio_status, "failed");
        set_status(&db, id, "failed");
        assert_eq!(list_by_status(&db, "failed").len(), 1);
    }

    fn mk_row(conn: &Connection, at: i64, path: &str, status: &str) -> i64 {
        insert_row(
            conn, at, "t", "en", "M", None, None, 1.0, 1, path, status, "m", 100, "ready",
        )
        .unwrap()
    }

    #[test]
    fn enforce_retention_time_based_drops_old_terminal_rows() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        let day = 86_400_000i64;
        let old = now_millis() - 10 * day;
        let recent = now_millis() - day;
        mk_row(&conn, old, "/tmp/old.wav", "done");
        // An old row still in flight must NOT be swept out from under the pipeline.
        mk_row(&conn, old, "/tmp/old_inflight.wav", "transcribing");
        mk_row(&conn, recent, "/tmp/recent.wav", "done");
        let db = HistoryDb(Mutex::new(conn));

        let removed = enforce_retention(&db, "after_3_days");
        assert_eq!(removed, vec!["/tmp/old.wav".to_string()]);
        assert_eq!(list(&db).len(), 2); // in-flight + recent remain
    }

    #[test]
    fn enforce_retention_keep_latest_5_drops_the_rest() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        for i in 0..7i64 {
            mk_row(&conn, 1000 + i, &format!("/tmp/{i}.wav"), "done");
        }
        let db = HistoryDb(Mutex::new(conn));

        let removed = enforce_retention(&db, "keep_latest_5");
        assert_eq!(removed.len(), 2); // the two oldest go
        assert_eq!(list(&db).len(), 5);
    }

    #[test]
    fn enforce_retention_never_and_unknown_are_noops() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        mk_row(&conn, 1, "/tmp/a.wav", "done");
        let db = HistoryDb(Mutex::new(conn));

        assert!(enforce_retention(&db, "never").is_empty());
        assert!(enforce_retention(&db, "bogus").is_empty());
        assert_eq!(list(&db).len(), 1);
    }

    #[test]
    fn update_partial_transcript_keeps_status() {
        // The live sink persists partial text mid-capture without disturbing the
        // recording lifecycle (status stays "recording" until stop/recovery).
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        let id = insert_row(
            &conn,
            1000,
            "",
            "auto",
            "Default",
            None,
            None,
            0.0,
            0,
            "/tmp/p.wav",
            "recording",
            "gpt-realtime-whisper",
            0,
            "capturing",
        )
        .unwrap();
        let db = HistoryDb(Mutex::new(conn));
        update_partial_transcript(&db, id, "hello there friend");
        let item = get(&db, id).unwrap();
        assert_eq!(item.transcript, "hello there friend");
        assert_eq!(item.words, 3);
        assert_eq!(item.status, "recording");
        assert_eq!(item.audio_status, "capturing");
    }

    #[test]
    fn recover_pcm_sidecar_wraps_into_wav() {
        let dir = std::env::temp_dir();
        let wav = dir
            .join(format!("voxctl-test-rec-{}.wav", now_millis()))
            .to_string_lossy()
            .to_string();
        let sidecar = format!("{wav}.pcm");
        let samples: Vec<i16> = (0..2400).map(|i| (i % 256 - 128) as i16 * 50).collect();
        let mut raw = Vec::with_capacity(samples.len() * 2);
        for s in &samples {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(&sidecar, &raw).unwrap();

        let (bytes, secs) = recover_pcm_sidecar(&wav).expect("recovers from sidecar");
        assert!(Path::new(&wav).exists());
        assert!(!Path::new(&sidecar).exists(), "sidecar consumed");
        assert_eq!(read_wav(&wav).unwrap(), samples);
        assert_eq!(bytes as u64, std::fs::metadata(&wav).unwrap().len());
        assert!((secs - 2400.0 / crate::resample::TARGET_RATE as f64).abs() < 1e-9);
        let _ = std::fs::remove_file(&wav);
    }

    #[test]
    fn recover_pcm_sidecar_absent_is_none() {
        let dir = std::env::temp_dir();
        let wav = dir
            .join(format!("voxctl-test-missing-{}.wav", now_millis()))
            .to_string_lossy()
            .to_string();
        assert!(recover_pcm_sidecar(&wav).is_none());
    }
}

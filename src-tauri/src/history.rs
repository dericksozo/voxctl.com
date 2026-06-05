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
    /// "transcribing" | "done" | "failed" | "needs_transcription".
    pub status: String,
    /// Registry model id used (drives cost + auto-retry).
    pub model_id: String,
    /// Size of the saved WAV on disk, in bytes (0 if the file is gone).
    pub audio_bytes: i64,
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
            audio_bytes   INTEGER NOT NULL DEFAULT 0
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
    Ok(())
}

pub fn init(app: &AppHandle) -> Result<HistoryDb, String> {
    let dir = data_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    let conn = Connection::open(dir.join("voxctl.db")).map_err(|e| format!("open db: {e}"))?;
    create_schema(&conn).map_err(|e| format!("schema: {e}"))?;
    migrate(&conn).map_err(|e| format!("migrate: {e}"))?;
    Ok(HistoryDb(Mutex::new(conn)))
}

// ---- WAV helpers ----

pub fn write_wav(path: &Path, pcm16: &[i16], rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| format!("wav create: {e}"))?;
    for &s in pcm16 {
        w.write_sample(s).map_err(|e| format!("wav write: {e}"))?;
    }
    w.finalize().map_err(|e| format!("wav finalize: {e}"))
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
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO recordings
            (created_at, transcript, language, mode_name, app_name, website, duration_secs, words, audio_path, status, model_id, audio_bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![created_at, transcript, language, mode_name, app_name, website, duration_secs, words, audio_path, status, model_id, audio_bytes],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_item(row: &rusqlite::Row) -> rusqlite::Result<HistoryItem> {
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
    })
}

const SELECT_COLS: &str =
    "id, created_at, transcript, language, mode_name, app_name, website, duration_secs, words, favorite, copy_count, audio_path, status, model_id, audio_bytes";

/// Persist the WAV + a `transcribing` row BEFORE transcription is attempted, so
/// a recording is never lost to a network error. Returns (id, audio_path).
pub fn insert_pending(
    app: &AppHandle,
    pcm16: &[i16],
    language: &str,
    mode_name: &str,
    app_name: Option<&str>,
    website: Option<&str>,
    model_id: &str,
) -> Result<(i64, String), String> {
    let created_at = now_millis();
    let n = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = recordings_dir(app).join(format!("rec-{created_at}-{n}.wav"));
    write_wav(&path, pcm16, crate::resample::TARGET_RATE)?;

    let path_str = path.to_string_lossy().to_string();
    let duration = pcm16.len() as f64 / crate::resample::TARGET_RATE as f64;
    let audio_bytes = std::fs::metadata(&path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

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
        duration,
        0,
        &path_str,
        "transcribing",
        model_id,
        audio_bytes,
    )
    .map_err(|e| format!("insert recording: {e}"))?;
    Ok((id, path_str))
}

/// Update a row with the transcription result and final status.
pub fn update_result(db: &HistoryDb, id: i64, transcript: &str, language: &str, status: &str) {
    let conn = db.0.lock().unwrap();
    let words = transcript.split_whitespace().count() as i64;
    let _ = conn.execute(
        "UPDATE recordings SET transcript = ?2, language = ?3, words = ?4, status = ?5 WHERE id = ?1",
        params![id, transcript, language, words, status],
    );
}

/// Set just the status (e.g. moving a row to `failed`/`needs_transcription`).
pub fn set_status(db: &HistoryDb, id: i64, status: &str) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET status = ?2 WHERE id = ?1",
        params![id, status],
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
    let conn = db.0.lock().unwrap();
    let sql = format!("SELECT {SELECT_COLS} FROM recordings ORDER BY created_at DESC");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("list prepare: {e}");
            return Vec::new();
        }
    };
    let rows = stmt.query_map([], row_to_item);
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => {
            log::error!("list query: {e}");
            Vec::new()
        }
    }
}

pub fn get(db: &HistoryDb, id: i64) -> Option<HistoryItem> {
    let conn = db.0.lock().unwrap();
    let sql = format!("SELECT {SELECT_COLS} FROM recordings WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_item).ok()
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

/// Set the model id (after a re-run through a different mode).
pub fn set_model_id(db: &HistoryDb, id: i64, model_id: &str) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE recordings SET model_id = ?2 WHERE id = ?1",
        params![id, model_id],
    );
}

/// Delete multiple rows; returns each removed row's audio path so the caller can
/// decide whether to also remove the file (per the delete-behavior setting).
pub fn delete_many(db: &HistoryDb, ids: &[i64]) -> Vec<String> {
    let conn = db.0.lock().unwrap();
    let mut paths = Vec::new();
    for &id in ids {
        if let Ok(p) = conn.query_row(
            "SELECT audio_path FROM recordings WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        ) {
            paths.push(p);
        }
        let _ = conn.execute("DELETE FROM recordings WHERE id = ?1", params![id]);
    }
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

/// Delete recordings older than `older_than_days` (optionally keeping favorites).
/// Returns the audio paths of the removed rows so the caller can delete the files
/// (purge always frees disk, regardless of the delete-behavior setting).
pub fn purge_older_than(db: &HistoryDb, older_than_days: u32, keep_favorites: bool) -> Vec<String> {
    let cutoff = now_millis() - (older_than_days as i64) * 86_400_000;
    let conn = db.0.lock().unwrap();
    let (select_sql, delete_sql) = if keep_favorites {
        (
            "SELECT audio_path FROM recordings WHERE created_at < ?1 AND favorite = 0",
            "DELETE FROM recordings WHERE created_at < ?1 AND favorite = 0",
        )
    } else {
        (
            "SELECT audio_path FROM recordings WHERE created_at < ?1",
            "DELETE FROM recordings WHERE created_at < ?1",
        )
    };
    let paths: Vec<String> = {
        let mut stmt = match conn.prepare(select_sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![cutoff], |r| r.get::<_, String>(0));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    };
    let _ = conn.execute(delete_sql, params![cutoff]);
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("voxctl-test-{}.wav", now_millis()));
        let samples: Vec<i16> = (0..1000).map(|i| (i % 256 - 128) as i16 * 100).collect();
        write_wav(&path, &samples, 24000).unwrap();
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
        // Running migrate twice must be safe and leave legacy rows as 'done'/''.
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let (status, model): (String, String) = conn
            .query_row(
                "SELECT status, model_id FROM recordings WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "done");
        assert_eq!(model, "");
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
        )
        .unwrap();
        let db = HistoryDb(Mutex::new(conn));
        assert_eq!(list_by_status(&db, "transcribing").len(), 1);
        update_result(&db, id, "done text", "en", "done");
        assert!(list_by_status(&db, "transcribing").is_empty());
        let item = get(&db, id).unwrap();
        assert_eq!(item.status, "done");
        assert_eq!(item.words, 2);
        set_status(&db, id, "failed");
        assert_eq!(list_by_status(&db, "failed").len(), 1);
    }

    #[test]
    fn purge_older_than_respects_favorites() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        let day = 86_400_000i64;
        let old = now_millis() - 10 * day;
        let recent = now_millis() - day;
        // old + not favorite -> purged; old + favorite -> kept when keep_favorites; recent -> kept.
        let mk = |conn: &Connection, at: i64, fav: i64, path: &str| {
            let id = insert_row(
                conn, at, "t", "en", "M", None, None, 1.0, 1, path, "done", "m", 100,
            )
            .unwrap();
            conn.execute(
                "UPDATE recordings SET favorite = ?2 WHERE id = ?1",
                params![id, fav],
            )
            .unwrap();
        };
        mk(&conn, old, 0, "/tmp/old.wav");
        mk(&conn, old, 1, "/tmp/oldfav.wav");
        mk(&conn, recent, 0, "/tmp/recent.wav");
        let db = HistoryDb(Mutex::new(conn));

        let removed = purge_older_than(&db, 7, true);
        assert_eq!(removed, vec!["/tmp/old.wav".to_string()]);
        assert_eq!(list(&db).len(), 2); // favorite + recent remain
    }
}

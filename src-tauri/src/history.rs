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
            audio_path    TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC);",
    )
}

pub fn init(app: &AppHandle) -> Result<HistoryDb, String> {
    let dir = data_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    let conn = Connection::open(dir.join("voxctl.db")).map_err(|e| format!("open db: {e}"))?;
    create_schema(&conn).map_err(|e| format!("schema: {e}"))?;
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
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO recordings
            (created_at, transcript, language, mode_name, app_name, website, duration_secs, words, audio_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![created_at, transcript, language, mode_name, app_name, website, duration_secs, words, audio_path],
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
    })
}

const SELECT_COLS: &str =
    "id, created_at, transcript, language, mode_name, app_name, website, duration_secs, words, favorite, copy_count, audio_path";

/// Persist a recording (WAV + DB row). Always called on stop, even on failure.
#[allow(clippy::too_many_arguments)]
pub fn save(
    app: &AppHandle,
    pcm16: &[i16],
    transcript: &str,
    language: &str,
    mode_name: &str,
    app_name: Option<&str>,
    website: Option<&str>,
) -> Result<i64, String> {
    let created_at = now_millis();
    let n = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = recordings_dir(app).join(format!("rec-{created_at}-{n}.wav"));
    write_wav(&path, pcm16, crate::resample::TARGET_RATE)?;

    let words = transcript.split_whitespace().count() as i64;
    let duration = pcm16.len() as f64 / crate::resample::TARGET_RATE as f64;

    let db = app.state::<HistoryDb>();
    let conn = db.0.lock().unwrap();
    insert_row(
        &conn,
        created_at,
        transcript,
        language,
        mode_name,
        app_name,
        website,
        duration,
        words,
        &path.to_string_lossy(),
    )
    .map_err(|e| format!("insert recording: {e}"))
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

pub fn update_transcript(db: &HistoryDb, id: i64, transcript: &str, language: &str) {
    let conn = db.0.lock().unwrap();
    let words = transcript.split_whitespace().count() as i64;
    let _ = conn.execute(
        "UPDATE recordings SET transcript = ?2, language = ?3, words = ?4 WHERE id = ?1",
        params![id, transcript, language, words],
    );
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
    }
}

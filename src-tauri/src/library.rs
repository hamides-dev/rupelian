use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::persistence;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePhraseInput {
    pub text: String,
    pub translation: String,
    pub video_path: String,
    pub subtitle_start: f64,
    pub subtitle_end: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPhrase {
    pub id: i64,
    pub text: String,
    pub translation: String,
    pub video_path: String,
    pub subtitle_start: f64,
    pub subtitle_end: f64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVocabularyInput {
    pub term: String,
    pub meaning: String,
    pub source_sentence: String,
    pub video_path: String,
    pub subtitle_start: f64,
    pub subtitle_end: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVocabulary {
    pub id: i64,
    pub term: String,
    pub meaning: String,
    pub source_sentence: String,
    pub video_path: String,
    pub subtitle_start: f64,
    pub subtitle_end: f64,
    pub status: String,
    pub created_at: String,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let destination = persistence::user_data_dir(app)?.join("rupelian.sqlite3");
    if destination.exists() || persistence::uses_data_directory_override() {
        return Ok(destination);
    }
    let legacy_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve the legacy app data directory: {error}"))?;
    for legacy_database in [
        legacy_directory.join("lingo-cinema.sqlite3"),
        legacy_directory.with_file_name("com.webler.lingocinema").join("lingo-cinema.sqlite3"),
    ] {
        if legacy_database.is_file() {
            persistence::copy_legacy_database(&legacy_database, &destination)?;
            break;
        }
    }
    Ok(destination)
}

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let database = Connection::open(database_path(app)?)
        .map_err(|error| format!("Could not open local library: {error}"))?;
    database
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS saved_phrases (
                id INTEGER PRIMARY KEY,
                text TEXT NOT NULL,
                translation TEXT NOT NULL DEFAULT '',
                video_path TEXT NOT NULL DEFAULT '',
                subtitle_start REAL NOT NULL DEFAULT 0,
                subtitle_end REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(text, video_path, subtitle_start)
            );
            CREATE TABLE IF NOT EXISTS vocabulary (
                id INTEGER PRIMARY KEY,
                term TEXT NOT NULL COLLATE NOCASE,
                meaning TEXT NOT NULL DEFAULT '',
                source_sentence TEXT NOT NULL DEFAULT '',
                video_path TEXT NOT NULL DEFAULT '',
                subtitle_start REAL NOT NULL DEFAULT 0,
                subtitle_end REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'saved' CHECK(status IN ('saved', 'learning', 'learned')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(term, video_path, subtitle_start)
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|error| format!("Could not prepare local library: {error}"))?;
    Ok(database)
}

#[tauri::command]
pub fn save_phrase(app: AppHandle, input: SavePhraseInput) -> Result<SavedPhrase, String> {
    let text = input.text.trim();
    if text.is_empty() {
        return Err("Cannot save an empty subtitle line.".into());
    }
    let database = connection(&app)?;
    database
        .execute(
            "INSERT INTO saved_phrases (text, translation, video_path, subtitle_start, subtitle_end)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(text, video_path, subtitle_start) DO UPDATE SET
             translation = CASE WHEN excluded.translation <> '' THEN excluded.translation ELSE saved_phrases.translation END,
             subtitle_end = excluded.subtitle_end",
            params![text, input.translation.trim(), input.video_path, input.subtitle_start, input.subtitle_end],
        )
        .map_err(|error| format!("Could not save the subtitle line: {error}"))?;
    database
        .query_row(
            "SELECT id, text, translation, video_path, subtitle_start, subtitle_end, created_at
             FROM saved_phrases WHERE text = ?1 AND video_path = ?2 AND subtitle_start = ?3",
            params![text, input.video_path, input.subtitle_start],
            |row| {
                Ok(SavedPhrase {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    translation: row.get(2)?,
                    video_path: row.get(3)?,
                    subtitle_start: row.get(4)?,
                    subtitle_end: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        )
        .map_err(|error| format!("Could not read saved subtitle line: {error}"))
}

#[tauri::command]
pub fn list_phrases(app: AppHandle) -> Result<Vec<SavedPhrase>, String> {
    let database = connection(&app)?;
    let mut statement = database
        .prepare("SELECT id, text, translation, video_path, subtitle_start, subtitle_end, created_at FROM saved_phrases ORDER BY created_at DESC, id DESC")
        .map_err(|error| format!("Could not read library: {error}"))?;
    let phrases = statement
        .query_map([], |row| {
            Ok(SavedPhrase {
                id: row.get(0)?,
                text: row.get(1)?,
                translation: row.get(2)?,
                video_path: row.get(3)?,
                subtitle_start: row.get(4)?,
                subtitle_end: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Could not query library: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not load saved lines: {error}"))?;
    Ok(phrases)
}

#[tauri::command]
pub fn delete_phrase(app: AppHandle, id: i64) -> Result<(), String> {
    connection(&app)?
        .execute("DELETE FROM saved_phrases WHERE id = ?1", params![id])
        .map_err(|error| format!("Could not delete saved line: {error}"))?;
    Ok(())
}

fn vocabulary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedVocabulary> {
    Ok(SavedVocabulary {
        id: row.get(0)?,
        term: row.get(1)?,
        meaning: row.get(2)?,
        source_sentence: row.get(3)?,
        video_path: row.get(4)?,
        subtitle_start: row.get(5)?,
        subtitle_end: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
    })
}

#[tauri::command]
pub fn save_vocabulary(
    app: AppHandle,
    input: SaveVocabularyInput,
) -> Result<SavedVocabulary, String> {
    let term = input.term.trim();
    if term.is_empty() {
        return Err("Select at least one word before saving it.".into());
    }
    if term.chars().count() > 500 {
        return Err("The selected text is too long for a vocabulary card.".into());
    }
    let database = connection(&app)?;
    database
        .execute(
            "INSERT INTO vocabulary (term, meaning, source_sentence, video_path, subtitle_start, subtitle_end)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(term, video_path, subtitle_start) DO UPDATE SET
             meaning = CASE WHEN excluded.meaning <> '' THEN excluded.meaning ELSE vocabulary.meaning END,
             source_sentence = excluded.source_sentence,
             subtitle_end = excluded.subtitle_end",
            params![
                term,
                input.meaning.trim(),
                input.source_sentence.trim(),
                input.video_path,
                input.subtitle_start,
                input.subtitle_end
            ],
        )
        .map_err(|error| format!("Could not save the selected text: {error}"))?;
    database
        .query_row(
            "SELECT id, term, meaning, source_sentence, video_path, subtitle_start, subtitle_end, status, created_at
             FROM vocabulary WHERE term = ?1 AND video_path = ?2 AND subtitle_start = ?3",
            params![term, input.video_path, input.subtitle_start],
            vocabulary_from_row,
        )
        .map_err(|error| format!("Could not read the saved vocabulary card: {error}"))
}

#[tauri::command]
pub fn list_vocabulary(app: AppHandle) -> Result<Vec<SavedVocabulary>, String> {
    let database = connection(&app)?;
    let mut statement = database
        .prepare(
            "SELECT id, term, meaning, source_sentence, video_path, subtitle_start, subtitle_end, status, created_at
             FROM vocabulary ORDER BY created_at DESC, id DESC",
        )
        .map_err(|error| format!("Could not read vocabulary: {error}"))?;
    let items = statement
        .query_map([], vocabulary_from_row)
        .map_err(|error| format!("Could not query vocabulary: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not load vocabulary: {error}"))?;
    Ok(items)
}

#[tauri::command]
pub fn set_vocabulary_status(app: AppHandle, id: i64, status: String) -> Result<(), String> {
    if !matches!(status.as_str(), "saved" | "learning" | "learned") {
        return Err("Unsupported vocabulary status.".into());
    }
    connection(&app)?
        .execute(
            "UPDATE vocabulary SET status = ?1 WHERE id = ?2",
            params![status, id],
        )
        .map_err(|error| format!("Could not update the vocabulary card: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_vocabulary(app: AppHandle, id: i64) -> Result<(), String> {
    connection(&app)?
        .execute("DELETE FROM vocabulary WHERE id = ?1", params![id])
        .map_err(|error| format!("Could not delete the vocabulary card: {error}"))?;
    Ok(())
}

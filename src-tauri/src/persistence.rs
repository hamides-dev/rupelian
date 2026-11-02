use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const DATA_DIRECTORY_NAME: &str = "Rupelian";
const SETTINGS_FILE_NAME: &str = "settings.json";
const CREDENTIALS_FILE_NAME: &str = "credentials.json";
const TRANSLATIONS_DIRECTORY_NAME: &str = "Translations";
const ALLOWED_SETTING_SECTIONS: &[&str] = &[
    "player",
    "translation",
    "learningPrompts",
    "playbackProgress",
    "youtube",
];

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDocument {
    #[serde(default = "settings_schema_version")]
    version: u32,
    #[serde(default)]
    sections: BTreeMap<String, Value>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsDocument {
    #[serde(default = "settings_schema_version")]
    version: u32,
    #[serde(default)]
    providers: BTreeMap<String, Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettingsSnapshot {
    root_path: String,
    settings_path: String,
    sections: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTranslationCue {
    source_index: usize,
    start: f64,
    end: f64,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSubtitleTranslationInput {
    media_identity: String,
    media_label: String,
    source_fingerprint: String,
    source_label: String,
    source_language: String,
    target_language: String,
    target_language_code: String,
    provider: String,
    model: String,
    mode: String,
    total_cues: usize,
    request_count: u64,
    token_count: u64,
    #[serde(default)]
    include_source_fallbacks: bool,
    translated_cues: Vec<SavedTranslationCue>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSubtitleTranslation {
    version: u32,
    media_identity: String,
    media_label: String,
    source_fingerprint: String,
    source_label: String,
    source_language: String,
    target_language: String,
    target_language_code: String,
    provider: String,
    model: String,
    mode: String,
    total_cues: usize,
    translated_count: usize,
    complete: bool,
    request_count: u64,
    token_count: u64,
    include_source_fallbacks: bool,
    updated_at: u128,
    translated_cues: Vec<SavedTranslationCue>,
    json_path: String,
    srt_path: String,
}

fn settings_schema_version() -> u32 {
    1
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn uses_data_directory_override() -> bool {
    data_directory_override().is_some()
}

fn data_directory_override() -> Option<std::ffi::OsString> {
    std::env::var_os("RUPELIAN_DATA_DIR")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("LINGO_CINEMA_DATA_DIR").filter(|value| !value.is_empty()))
}

// Copy into a staging folder before publishing the new root. Never modify the
// old installation, overwrite Rupelian data, or import real data into test roots.
fn migrate_brand_data(documents: &Path) -> Result<(), String> {
    let destination = documents.join(DATA_DIRECTORY_NAME);
    let legacy = documents.join("Lingo Cinema");
    if destination.exists() || !legacy.is_dir() {
        return Ok(());
    }
    let staging = documents.join(".rupelian-migration");
    fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                copy_directory(&entry.path(), &destination.join(entry.file_name()))?;
            } else if kind.is_file() {
                fs::copy(entry.path(), destination.join(entry.file_name()))?;
            }
        }
        Ok(())
    }
    fs::create_dir_all(&staging).map_err(|error| format!("Could not prepare Rupelian data migration: {error}"))?;
    for name in ["settings.json", "credentials.json", "youtube-session.json"] {
        if legacy.join(name).is_file() {
            fs::copy(legacy.join(name), staging.join(name))
                .map_err(|error| format!("Could not migrate {name}: {error}"))?;
        }
    }
    if legacy.join(TRANSLATIONS_DIRECTORY_NAME).is_dir() {
        copy_directory(&legacy.join(TRANSLATIONS_DIRECTORY_NAME), &staging.join(TRANSLATIONS_DIRECTORY_NAME))
            .map_err(|error| format!("Could not migrate saved translations: {error}"))?;
    }
    let database = legacy.join("lingo-cinema.sqlite3");
    if database.is_file() {
        let snapshot = staging.join("rupelian.sqlite3");
        if snapshot.exists() {
            fs::remove_file(&snapshot).map_err(|error| format!("Could not retry library migration: {error}"))?;
        }
        copy_legacy_database(&database, &snapshot)?;
    }
    fs::rename(&staging, &destination).map_err(|error| format!("Could not finish Rupelian data migration: {error}"))
}

pub(crate) fn copy_legacy_database(source: &Path, destination: &Path) -> Result<(), String> {
    // SQLite creates a consistent snapshot including committed WAL data.
    let database = rusqlite::Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not read the previous library: {error}"))?;
    database.execute("VACUUM INTO ?1", [destination.to_string_lossy().as_ref()])
        .map_err(|error| format!("Could not migrate the previous library: {error}"))?;
    Ok(())
}

pub fn user_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = if let Some(override_path) = data_directory_override() {
        PathBuf::from(override_path)
    } else {
        let documents = app.path()
            .document_dir()
            .map_err(|error| format!("Could not resolve the Documents directory: {error}"))?;
        static MIGRATION: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
        MIGRATION.get_or_init(|| migrate_brand_data(&documents)).clone()?;
        documents.join(DATA_DIRECTORY_NAME)
    };
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the Rupelian data directory: {error}"))?;
    Ok(directory)
}

fn translations_dir(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(TRANSLATIONS_DIRECTORY_NAME);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the saved-translations directory: {error}"))?;
    Ok(directory)
}

fn read_settings_document(path: &Path) -> Result<SettingsDocument, String> {
    if !path.exists() {
        return Ok(SettingsDocument {
            version: settings_schema_version(),
            sections: BTreeMap::new(),
        });
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read persistent settings: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("The persistent settings file is not valid JSON: {error}"))
}

fn read_credentials_document(path: &Path) -> Result<CredentialsDocument, String> {
    if !path.exists() {
        return Ok(CredentialsDocument {
            version: settings_schema_version(),
            providers: BTreeMap::new(),
        });
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Could not read encrypted AI credentials: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("The encrypted AI credentials file is not valid JSON: {error}"))
}

#[cfg(windows)]
pub(crate) fn protect_credential(value: &str) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let bytes = value.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| "The API key is too long.".to_string())?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "Windows could not encrypt the API key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let encrypted = unsafe {
        std::slice::from_raw_parts(output.pbData.cast_const(), output.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(encrypted)
}

#[cfg(windows)]
pub(crate) fn unprotect_credential(encrypted: &[u8]) -> Result<String, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(encrypted.len())
            .map_err(|_| "The encrypted API key is too large.".to_string())?,
        pbData: encrypted.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "Windows could not decrypt the saved API key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let decrypted = unsafe {
        std::slice::from_raw_parts(output.pbData.cast_const(), output.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    String::from_utf8(decrypted).map_err(|_| "The decrypted API key is not valid UTF-8.".into())
}

#[cfg(not(windows))]
pub(crate) fn protect_credential(_value: &str) -> Result<Vec<u8>, String> {
    Err("Persistent API-key encryption is currently available on Windows only.".into())
}

#[cfg(not(windows))]
pub(crate) fn unprotect_credential(_encrypted: &[u8]) -> Result<String, String> {
    Err("Persistent API-key encryption is currently available on Windows only.".into())
}

pub(crate) fn write_json_file(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize persistent data: {error}"))?;
    write_bytes_file(path, &bytes)
}

fn write_bytes_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary_path = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json")
    ));
    let mut file = fs::File::create(&temporary_path)
        .map_err(|error| format!("Could not create persistent data file: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write persistent data: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace persistent data file: {error}"))?;
    }
    fs::rename(&temporary_path, path)
        .map_err(|error| format!("Could not commit persistent data file: {error}"))
}

fn sanitize_setting_value(section: &str, mut value: Value) -> Value {
    if section == "translation" {
        if let Some(object) = value.as_object_mut() {
            for sensitive_key in ["apiKey", "api_key", "key", "credentials"] {
                object.remove(sensitive_key);
            }
        }
    }
    value
}

#[tauri::command]
pub fn load_user_settings(app: AppHandle) -> Result<UserSettingsSnapshot, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = user_data_dir(&app)?;
    let settings_path = root.join(SETTINGS_FILE_NAME);
    let document = read_settings_document(&settings_path)?;
    Ok(UserSettingsSnapshot {
        root_path: root.to_string_lossy().into_owned(),
        settings_path: settings_path.to_string_lossy().into_owned(),
        sections: document.sections,
    })
}

#[tauri::command]
pub fn save_user_setting(
    app: AppHandle,
    section: String,
    value: Value,
) -> Result<UserSettingsSnapshot, String> {
    if !ALLOWED_SETTING_SECTIONS.contains(&section.as_str()) {
        return Err("Unsupported persistent settings section.".into());
    }
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = user_data_dir(&app)?;
    let settings_path = root.join(SETTINGS_FILE_NAME);
    let mut document = read_settings_document(&settings_path)?;
    document.version = settings_schema_version();
    document
        .sections
        .insert(section.clone(), sanitize_setting_value(&section, value));
    write_json_file(&settings_path, &document)?;
    Ok(UserSettingsSnapshot {
        root_path: root.to_string_lossy().into_owned(),
        settings_path: settings_path.to_string_lossy().into_owned(),
        sections: document.sections,
    })
}

fn load_ai_credentials_at(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = root.join(CREDENTIALS_FILE_NAME);
    let document = read_credentials_document(&path)?;
    let mut credentials = BTreeMap::new();
    for (provider, encrypted) in document.providers {
        if let Ok(value) = unprotect_credential(&encrypted) {
            credentials.insert(provider, value);
        }
    }
    Ok(credentials)
}

fn save_ai_credential_at(root: &Path, provider: &str, api_key: &str) -> Result<(), String> {
    let provider = provider.trim().to_ascii_lowercase();
    if provider.is_empty()
        || provider.len() > 80
        || !provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The AI provider identifier is invalid.".into());
    }
    if api_key.len() > 32_768 {
        return Err("The API key is too long.".into());
    }
    let path = root.join(CREDENTIALS_FILE_NAME);
    let mut document = read_credentials_document(&path)?;
    document.version = settings_schema_version();
    let api_key = api_key.trim();
    if api_key.is_empty() {
        document.providers.remove(&provider);
    } else {
        document
            .providers
            .insert(provider, protect_credential(api_key)?);
    }
    write_json_file(&path, &document)
}

#[tauri::command]
pub fn load_ai_credentials(app: AppHandle) -> Result<BTreeMap<String, String>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    load_ai_credentials_at(&user_data_dir(&app)?)
}

#[tauri::command]
pub fn save_ai_credential(app: AppHandle, provider: String, api_key: String) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    save_ai_credential_at(&user_data_dir(&app)?, &provider, &api_key)
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn safe_filename_component(value: &str, fallback: &str, max_chars: usize) -> String {
    let mut result = String::new();
    let mut previous_separator = false;
    for character in value.trim().chars() {
        if result.chars().count() >= max_chars {
            break;
        }
        if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
            result.push(character);
            previous_separator = false;
        } else if !previous_separator {
            result.push('-');
            previous_separator = true;
        }
    }
    let cleaned = result.trim_matches(['-', '.', ' ']).to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn srt_time(seconds: f64) -> String {
    let milliseconds = if seconds.is_finite() {
        (seconds.max(0.0) * 1000.0).round() as u64
    } else {
        0
    };
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn translation_srt(cues: &[SavedTranslationCue]) -> String {
    let mut sorted = cues.to_vec();
    sorted.sort_by_key(|cue| cue.source_index);
    sorted
        .iter()
        .enumerate()
        .map(|(index, cue)| {
            let text = cue
                .text
                .replace('\r', "")
                .replace('\0', "")
                .trim()
                .to_string();
            format!(
                "{}\n{} --> {}\n{}\n",
                index + 1,
                srt_time(cue.start),
                srt_time(cue.end.max(cue.start)),
                text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn save_subtitle_translation_at(
    root: &Path,
    input: SaveSubtitleTranslationInput,
) -> Result<SavedSubtitleTranslation, String> {
    if input.media_identity.trim().is_empty()
        || input.source_fingerprint.trim().is_empty()
        || input.target_language.trim().is_empty()
    {
        return Err("Media, source subtitle, and target language are required.".into());
    }
    if input.total_cues > 500_000 || input.translated_cues.len() > 500_000 {
        return Err("The subtitle translation is too large to save.".into());
    }
    if input
        .translated_cues
        .iter()
        .any(|cue| cue.text.len() > 250_000 || !cue.start.is_finite() || !cue.end.is_finite())
    {
        return Err("The subtitle translation contains an invalid cue.".into());
    }
    let directory = translations_dir(root)?;
    let identity = format!(
        "{}\0{}\0{}",
        input.media_identity, input.source_fingerprint, input.target_language
    );
    let base_name = format!(
        "{}-{}-{}",
        safe_filename_component(&input.media_label, "media", 56),
        safe_filename_component(&input.target_language_code, "translated", 18),
        stable_hash(&identity)
    );
    let json_path = directory.join(format!("{base_name}.json"));
    let srt_path = directory.join(format!("{base_name}.srt"));
    let translated_count = input.translated_cues.len();
    let record = SavedSubtitleTranslation {
        version: 1,
        media_identity: input.media_identity,
        media_label: input.media_label,
        source_fingerprint: input.source_fingerprint,
        source_label: input.source_label,
        source_language: input.source_language,
        target_language: input.target_language,
        target_language_code: input.target_language_code,
        provider: input.provider,
        model: input.model,
        mode: input.mode,
        total_cues: input.total_cues,
        translated_count,
        complete: input.total_cues > 0 && translated_count >= input.total_cues,
        request_count: input.request_count,
        token_count: input.token_count,
        include_source_fallbacks: input.include_source_fallbacks,
        updated_at: now_millis(),
        translated_cues: input.translated_cues,
        json_path: json_path.to_string_lossy().into_owned(),
        srt_path: srt_path.to_string_lossy().into_owned(),
    };
    write_json_file(&json_path, &record)?;
    write_bytes_file(
        &srt_path,
        translation_srt(&record.translated_cues).as_bytes(),
    )
    .map_err(|error| format!("Could not write the reusable SRT translation: {error}"))?;
    Ok(record)
}

#[tauri::command]
pub fn save_subtitle_translation(
    app: AppHandle,
    input: SaveSubtitleTranslationInput,
) -> Result<SavedSubtitleTranslation, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = user_data_dir(&app)?;
    save_subtitle_translation_at(&root, input)
}

fn load_subtitle_translations_at(
    root: &Path,
    media_identity: &str,
) -> Result<Vec<SavedSubtitleTranslation>, String> {
    let directory = translations_dir(root)?;
    let mut records = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not read saved translations: {error}"))?
        .filter_map(Result::ok)
        .take(20_000)
    {
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<SavedSubtitleTranslation>(&bytes) else {
            continue;
        };
        if record.media_identity == media_identity {
            records.push(record);
        }
    }
    records.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(records)
}

#[tauri::command]
pub fn load_subtitle_translations(
    app: AppHandle,
    media_identity: String,
) -> Result<Vec<SavedSubtitleTranslation>, String> {
    if media_identity.len() > 16_384 {
        return Err("The media identity is too long.".into());
    }
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = user_data_dir(&app)?;
    load_subtitle_translations_at(&root, &media_identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rupelian-persistence-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ))
    }

    #[test]
    fn brand_migration_preserves_settings_secrets_translations_and_wal_library() {
        let documents = test_directory("brand-migration");
        let legacy = documents.join("Lingo Cinema");
        fs::create_dir_all(legacy.join("Translations")).unwrap();
        for name in ["settings.json", "credentials.json", "youtube-session.json"] {
            fs::write(legacy.join(name), format!("test-{name}")).unwrap();
        }
        fs::write(legacy.join("Translations/project.json"), "project").unwrap();
        fs::write(legacy.join("Translations/project.srt"), "زیرنویس").unwrap();
        let database = rusqlite::Connection::open(legacy.join("lingo-cinema.sqlite3")).unwrap();
        database.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE vocabulary(term TEXT); INSERT INTO vocabulary VALUES ('preserved');").unwrap();
        migrate_brand_data(&documents).unwrap();
        let root = documents.join("Rupelian");
        for name in ["settings.json", "credentials.json", "youtube-session.json", "Translations/project.json", "Translations/project.srt"] {
            assert_eq!(fs::read(root.join(name)).unwrap(), fs::read(legacy.join(name)).unwrap());
        }
        let migrated = rusqlite::Connection::open(root.join("rupelian.sqlite3")).unwrap();
        assert_eq!(migrated.query_row("SELECT term FROM vocabulary", [], |row| row.get::<_, String>(0)).unwrap(), "preserved");
        fs::write(root.join("settings.json"), "new settings").unwrap();
        migrate_brand_data(&documents).unwrap();
        assert_eq!(fs::read_to_string(root.join("settings.json")).unwrap(), "new settings");
        assert_eq!(fs::read_to_string(legacy.join("settings.json")).unwrap(), "test-settings.json");
        drop(migrated);
        drop(database);
        fs::remove_dir_all(documents).unwrap();
    }

    #[test]
    fn brand_migration_without_legacy_data_does_not_create_a_root() {
        let documents = test_directory("no-legacy");
        migrate_brand_data(&documents).unwrap();
        assert!(!documents.exists());
    }

    #[test]
    fn saves_translation_progress_as_json_and_srt() {
        let root = test_directory("translation");
        fs::create_dir_all(&root).expect("test directory should be created");
        let record = save_subtitle_translation_at(
            &root,
            SaveSubtitleTranslationInput {
                media_identity: "local:c:/video/movie.mkv".into(),
                media_label: "Movie.mkv".into(),
                source_fingerprint: "3-deadbeef".into(),
                source_label: "Movie.srt".into(),
                source_language: "en".into(),
                target_language: "Persian (Farsi)".into(),
                target_language_code: "fa".into(),
                provider: "openai".into(),
                model: "test-model".into(),
                mode: "batch".into(),
                total_cues: 3,
                request_count: 1,
                token_count: 42,
                include_source_fallbacks: true,
                translated_cues: vec![SavedTranslationCue {
                    source_index: 0,
                    start: 1.25,
                    end: 3.5,
                    text: "ترجمه آزمایشی".into(),
                }],
            },
        )
        .expect("translation should be saved");
        assert_eq!(record.translated_count, 1);
        assert!(!record.complete);
        assert!(Path::new(&record.json_path).is_file());
        let srt = fs::read_to_string(&record.srt_path).expect("SRT should be readable");
        assert!(srt.contains("00:00:01,250 --> 00:00:03,500"));
        assert!(srt.contains("ترجمه آزمایشی"));
        let loaded = load_subtitle_translations_at(&root, "local:c:/video/movie.mkv")
            .expect("translation should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].token_count, 42);
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn removes_credentials_from_translation_settings() {
        let sanitized = sanitize_setting_value(
            "translation",
            serde_json::json!({ "provider": "openai", "model": "gpt", "apiKey": "secret" }),
        );
        assert_eq!(sanitized["provider"], "openai");
        assert!(sanitized.get("apiKey").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_dpapi_round_trips_credentials_without_plaintext() {
        let api_key = "sk-test-persistent-secret";
        let encrypted = protect_credential(api_key).expect("DPAPI should encrypt the API key");
        assert!(!encrypted.is_empty());
        assert!(!encrypted
            .windows(api_key.len())
            .any(|window| window == api_key.as_bytes()));
        assert_eq!(
            unprotect_credential(&encrypted).expect("DPAPI should decrypt the API key"),
            api_key
        );
    }

    #[cfg(windows)]
    #[test]
    fn persists_encrypted_credentials_across_file_reloads_and_removes_them() {
        let root = test_directory("credentials");
        fs::create_dir_all(&root).expect("test directory should be created");
        let api_key = "sk-test-file-persistence-secret";
        save_ai_credential_at(&root, "OpenAI", api_key)
            .expect("credential should be encrypted and saved");
        let file = fs::read(root.join(CREDENTIALS_FILE_NAME))
            .expect("encrypted credential file should be readable");
        assert!(!file
            .windows(api_key.len())
            .any(|window| window == api_key.as_bytes()));
        let reloaded = load_ai_credentials_at(&root).expect("credential should decrypt on reload");
        assert_eq!(reloaded.get("openai").map(String::as_str), Some(api_key));
        save_ai_credential_at(&root, "openai", "")
            .expect("clearing the field should remove the credential");
        assert!(load_ai_credentials_at(&root)
            .expect("credential file should remain readable")
            .is_empty());
        fs::remove_dir_all(root).expect("test directory should be removed");
    }
}

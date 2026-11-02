//! YouTube-only cookie storage. Cookie values never cross the frontend bridge.
use crate::persistence;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicU64, Ordering}}, time::{SystemTime, UNIX_EPOCH}};
use tauri::AppHandle;

static SESSION_LOCK: Mutex<()> = Mutex::new(());
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
const MAX_COOKIE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedSession {
    saved_at: u64,
    source: String,
    encrypted_cookies: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    saved: bool,
    usable: bool,
    saved_at: Option<u64>,
    source: String,
    message: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub(crate) fn youtube_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.');
    domain == "youtube.com" || domain.ends_with(".youtube.com")
}

fn auth_cookie(name: &str) -> bool {
    matches!(name, "SAPISID" | "__Secure-1PAPISID" | "__Secure-3PAPISID" | "LOGIN_INFO")
}

/// Parse Netscape exports, excluding other sites and expired cookies before storage/use.
pub(crate) fn normalize_cookies(input: &str, timestamp: u64) -> Result<String, String> {
    if input.len() as u64 > MAX_COOKIE_BYTES { return Err("The cookies file is too large (maximum 2 MB).".into()); }
    let input = input.trim_start_matches('\u{feff}');
    if !input.lines().next().is_some_and(|line| line.contains("Netscape HTTP Cookie File") || line.contains("HTTP Cookie File")) {
        return Err("Choose a Netscape cookies.txt export, not a JSON file or browser database.".into());
    }
    let mut output = String::from("# Netscape HTTP Cookie File\n# YouTube session saved by Rupelian\n\n");
    let mut signed_in = false;
    for line in input.lines() {
        if line.is_empty() || (line.starts_with('#') && !line.starts_with("#HttpOnly_")) { continue; }
        let columns: Vec<&str> = line.split('\t').collect();
        if columns.len() != 7 { return Err("Invalid cookies.txt row. Export cookies in Netscape format and import again.".into()); }
        let domain = columns[0].trim_start_matches("#HttpOnly_");
        if !youtube_domain(domain) { continue; }
        let expires: u64 = columns[4].parse().map_err(|_| "Invalid cookie expiry in cookies.txt.".to_owned())?;
        if !matches!(columns[1], "TRUE" | "FALSE") || !matches!(columns[3], "TRUE" | "FALSE") || !columns[2].starts_with('/') {
            return Err("Invalid YouTube cookie fields. Export cookies again.".into());
        }
        if expires != 0 && expires <= timestamp { continue; }
        signed_in |= auth_cookie(columns[5]) && !columns[6].is_empty();
        output.push_str(line);
        output.push('\n');
    }
    if !signed_in {
        return Err("No unexpired signed-in YouTube session was found. Sign in to YouTube, then save or import the session again.".into());
    }
    Ok(output)
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(persistence::user_data_dir(app)?.join("youtube-session.json"))
}

fn read_session(path: &Path) -> Result<Option<SavedSession>, String> {
    if !path.exists() { return Ok(None); }
    let bytes = fs::read(path).map_err(|_| "Could not read the saved YouTube session.".to_owned())?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "The saved YouTube session is damaged. Save a new session in Settings > YouTube.".into())
}

fn decrypt(session: &SavedSession) -> Result<String, String> {
    let cookies = persistence::unprotect_credential(&session.encrypted_cookies)
        .map_err(|_| "The saved YouTube session could not be decrypted for this Windows account. Save a new session.".to_owned())?;
    normalize_cookies(&cookies, now())
}

fn status_at(path: &Path) -> Result<SessionStatus, String> {
    match read_session(path)? {
        None => Ok(SessionStatus { saved: false, usable: false, saved_at: None, source: String::new(), message: "No saved access. Public videos work automatically.".into() }),
        Some(session) => {
            let result = decrypt(&session);
            Ok(SessionStatus { saved: true, usable: result.is_ok(), saved_at: Some(session.saved_at), source: session.source,
                message: result.err().unwrap_or_else(|| "Session saved on this device. Check a video below to verify access.".into()) })
        }
    }
}

#[tauri::command]
pub fn youtube_session_status(app: AppHandle) -> Result<SessionStatus, String> {
    let _lock = SESSION_LOCK.lock().map_err(|_| "Session storage is busy.".to_owned())?;
    status_at(&session_path(&app)?)
}

fn save_at(path: &Path, cookies: &str, source: &str) -> Result<SessionStatus, String> {
    let normalized = normalize_cookies(cookies, now())?;
    let encrypted_cookies = persistence::protect_credential(&normalized)
        .map_err(|_| "Could not encrypt the YouTube session. Persistent sessions currently require Windows.".to_owned())?;
    persistence::write_json_file(path, &SavedSession { saved_at: now(), source: source.into(), encrypted_cookies })?;
    status_at(path)
}

pub(crate) fn save(app: &AppHandle, cookies: &str, source: &str) -> Result<SessionStatus, String> {
    let _lock = SESSION_LOCK.lock().map_err(|_| "Session storage is busy.".to_owned())?;
    save_at(&session_path(app)?, cookies, source)
}

#[tauri::command]
pub fn import_youtube_cookies(app: AppHandle, path: String) -> Result<SessionStatus, String> {
    let path = Path::new(&path);
    if fs::metadata(path).map_err(|_| "The selected cookies file could not be read.".to_owned())?.len() > MAX_COOKIE_BYTES {
        return Err("The cookies file is too large (maximum 2 MB).".into());
    }
    let cookies = fs::read_to_string(path).map_err(|_| "Choose a UTF-8 Netscape cookies.txt export.".to_owned())?;
    normalize_cookies(&cookies, now())?;
    // A manual export is not proof that the previously paired browser uses the
    // same Google account. Never leave Like silently targeting that old profile.
    save(&app, &cookies, "Cookies file")
}

#[tauri::command]
pub fn remove_youtube_session(app: AppHandle) -> Result<SessionStatus, String> {
    let _lock = SESSION_LOCK.lock().map_err(|_| "Session storage is busy.".to_owned())?;
    let path = session_path(&app)?;
    if path.exists() { fs::remove_file(&path).map_err(|_| "Could not remove the saved YouTube session.".to_owned())?; }
    status_at(&path)
}

/// yt-dlp requires a file. Give each invocation its own short-lived copy, removed on drop.
pub(crate) struct CookieFile(pub PathBuf);
impl Drop for CookieFile {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}
impl CookieFile {
    fn new(cookies: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("lingo-youtube-{}-{}-{}.txt", std::process::id(), now(), NEXT_FILE.fetch_add(1, Ordering::Relaxed)));
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|_| "Could not prepare the saved YouTube session.".to_owned())?;
        let guard = Self(path);
        file.write_all(cookies.as_bytes()).map_err(|_| "Could not prepare YouTube cookies.".to_owned())?;
        Ok(guard)
    }
}

pub(crate) fn resolver_cookies(app: &AppHandle) -> Result<Option<CookieFile>, String> {
    let _lock = SESSION_LOCK.lock().map_err(|_| "Session storage is busy.".to_owned())?;
    read_session(&session_path(app)?)?.map(|session| CookieFile::new(&decrypt(&session)?)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> String { "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-test-secret\n".into() }
    #[test]
    fn accepts_session_cookies_and_filters_unrelated_domains() {
        let input = format!("{}#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t200\tLOGIN_INFO\ttest\n.evil-youtube.com\tTRUE\t/\tTRUE\t0\tSID\tunrelated\n.google.com\tTRUE\t/\tTRUE\t0\tSID\tunrelated\n", fixture());
        let result = normalize_cookies(&input, 100).unwrap();
        assert!(result.contains("#HttpOnly_.youtube.com"));
        assert!(!result.contains("unrelated"));
        assert!(!youtube_domain("youtube.com.evil.com"));
    }
    #[test]
    fn rejects_expired_unsigned_malformed_and_empty_sessions() {
        for input in [fixture().replace("\t0\t", "\t100\t"), fixture().replace("SAPISID", "PREF"), fixture().replace("\t0\t", "\tinvalid\t"), fixture().replace("synthetic-test-secret", ""), "{}".into()] {
            assert!(normalize_cookies(&input, 100).is_err());
        }
    }
    #[test]
    fn temporary_cookies_are_independent_and_removed() {
        let first = CookieFile::new(&fixture()).unwrap();
        let second = CookieFile::new(&fixture()).unwrap();
        let path = first.0.clone();
        assert_ne!(path, second.0);
        drop(first);
        assert!(!path.exists());
        assert!(second.0.exists());
    }
    #[cfg(windows)]
    #[test]
    fn encrypted_session_survives_reload_and_invalid_import_preserves_it() {
        let directory = std::env::temp_dir().join(format!("lingo-session-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.json");
        assert!(save_at(&path, &fixture(), "Test").unwrap().usable);
        assert!(!fs::read_to_string(&path).unwrap().contains("synthetic-test-secret"));
        assert!(status_at(&path).unwrap().saved);
        assert!(save_at(&path, "invalid", "Invalid").is_err());
        assert!(decrypt(&read_session(&path).unwrap().unwrap()).unwrap().contains("synthetic-test-secret"));
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&directory).unwrap();
    }
}

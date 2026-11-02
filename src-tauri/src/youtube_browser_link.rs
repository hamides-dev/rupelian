//! Connect the existing personal browser profile through an explicitly installed
//! extension. Visiting a link never launches a browser or creates a profile.
use axum::{body::Bytes, extract::{DefaultBodyLimit, State}, http::{HeaderMap, StatusCode}, response::{Html, IntoResponse, Response}, routing::get, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::{future::IntoFuture, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSignInLink {
    attempt_id: String,
    url: String,
    status: String,
}

struct LinkAttempt {
    public: BrowserSignInLink,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

static CURRENT_LINK: Mutex<Option<LinkAttempt>> = Mutex::new(None);

#[derive(Clone)]
struct LinkServer {
    app: AppHandle,
    attempt_id: String,
    port: u16,
    extension_path: PathBuf,
}

pub(crate) fn extension_folder(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|_| "Could not locate the browser connector folder.".to_owned())?
        .join("youtube-browser-connector");
    std::fs::create_dir_all(&root).map_err(|_| "Could not prepare the browser connector folder.".to_owned())?;
    for (name, contents) in [
        ("manifest.json", include_str!("../browser-extension/manifest.json")),
        ("background.js", include_str!("../browser-extension/background.js")),
        ("content.js", include_str!("../browser-extension/content.js")),
        ("README.txt", include_str!("../browser-extension/README.txt")),
    ] {
        let path = root.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(contents) {
            std::fs::write(path, contents).map_err(|_| "Could not write the browser connector files.".to_owned())?;
        }
    }
    // Remove only obsolete assets previously exported by this application.
    for name in ["ratings.js", "action-tab.js"] {
        match std::fs::remove_file(root.join(name)) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("Could not update the browser connector files.".into()),
        }
    }
    Ok(root)
}

#[tauri::command]
pub fn reveal_youtube_browser_extension(app: AppHandle) -> Result<String, String> {
    let root = extension_folder(&app)?;
    open::that_detached(&root).map_err(|_| "Could not open the browser connector folder.".to_owned())?;
    Ok(root.to_string_lossy().into_owned())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[tauri::command]
pub async fn prepare_youtube_sign_in_link(app: AppHandle) -> Result<BrowserSignInLink, String> {
    let extension_path = extension_folder(&app)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await
        .map_err(|_| "Could not prepare the local connection link.".to_owned())?;
    let port = listener.local_addr().map_err(|_| "Could not prepare the connection link.".to_owned())?.port();
    let token = random_token();
    let path = format!("/connect/{token}");
    let public = BrowserSignInLink { attempt_id: token.clone(), url: format!("http://127.0.0.1:{port}{path}"), status: "ready".into() };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    {
        let mut current = CURRENT_LINK.lock().map_err(|_| "Connection is busy.".to_owned())?;
        if let Some(active) = current.as_ref().filter(|active| active.public.status == "ready") {
            return Ok(active.public.clone());
        }
        if let Some(old) = current.as_mut().and_then(|active| active.cancel.take()) { let _ = old.send(()); }
        *current = Some(LinkAttempt { public: public.clone(), cancel: Some(cancel) });
    }
    let server = LinkServer { app, attempt_id: token.clone(), port, extension_path };
    let router = Router::new().route(&path, get(connection_page).post(receive_access))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024)).with_state(server);
    tokio::spawn(async move {
        tokio::select! {
            _ = cancelled => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(30 * 60)) => {},
            _ = axum::serve(listener, router).into_future() => {},
        }
        if let Ok(mut current) = CURRENT_LINK.lock() {
            if let Some(active) = current.as_mut().filter(|active| active.public.attempt_id == token) {
                active.public.url.clear();
                if active.public.status == "ready" { active.public.status = "expired".into(); }
            }
        }
    });
    Ok(public)
}

#[tauri::command]
pub fn youtube_sign_in_link_status() -> Result<Option<BrowserSignInLink>, String> {
    Ok(CURRENT_LINK.lock().map_err(|_| "Connection is busy.".to_owned())?.as_ref().map(|active| active.public.clone()))
}

#[tauri::command]
pub fn open_youtube_sign_in_link(attempt_id: String) -> Result<BrowserSignInLink, String> {
    let current = CURRENT_LINK.lock().map_err(|_| "Connection is busy.".to_owned())?;
    let active = current.as_ref().filter(|active| active.public.attempt_id == attempt_id && active.public.status == "ready")
        .ok_or("This connection link has expired. Prepare a new link.")?;
    // Open an ordinary tab. Never supply a custom profile or remote-debugging flag.
    open::that_detached(&active.public.url).map_err(|_| "Could not open the link. Copy it into your signed-in browser.".to_owned())?;
    Ok(active.public.clone())
}

#[tauri::command]
pub fn cancel_youtube_sign_in_link(attempt_id: String) -> Result<(), String> {
    let mut current = CURRENT_LINK.lock().map_err(|_| "Connection is busy.".to_owned())?;
    let active = current.as_mut().filter(|active| active.public.attempt_id == attempt_id)
        .ok_or("This connection attempt is no longer active.")?;
    if let Some(cancel) = active.cancel.take() { let _ = cancel.send(()); }
    active.public.status = "cancelled".into();
    active.public.url.clear();
    Ok(())
}

fn trusted_host(headers: &HeaderMap, port: u16) -> bool {
    headers.get("host").and_then(|value| value.to_str().ok()) == Some(format!("127.0.0.1:{port}").as_str())
}

fn extension_origin(headers: &HeaderMap) -> bool {
    headers.get("origin").and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("chrome-extension://"))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn response(code: StatusCode, body: impl IntoResponse) -> Response {
    let mut response = (code, body).into_response();
    for (name, value) in [
        ("cache-control", "no-store"), ("referrer-policy", "no-referrer"), ("x-content-type-options", "nosniff"),
        ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"),
    ] { response.headers_mut().insert(name, value.parse().unwrap()); }
    response
}

async fn connection_page(State(server): State<LinkServer>, headers: HeaderMap) -> Response {
    if !trusted_host(&headers, server.port) { return response(StatusCode::NOT_FOUND, "Connection unavailable."); }
    let status = CURRENT_LINK.lock().ok().and_then(|current| current.as_ref()
        .filter(|active| active.public.attempt_id == server.attempt_id).map(|active| active.public.status.clone()));
    match status.as_deref() {
        Some("ready") => response(StatusCode::OK, Html(include_str!("youtube_connect.html")
            .replace("{{extension_path}}", &escape_html(&server.extension_path.to_string_lossy())))),
        Some("connected") => response(StatusCode::OK, Html("<!doctype html><meta charset=utf-8><title>Rupelian</title><h1>Connected</h1><p>Your existing YouTube account is connected. You can close this tab and return to Rupelian.</p>")),
        _ => response(StatusCode::GONE, "This connection link has expired or was cancelled. Prepare a new link in Rupelian."),
    }
}

async fn receive_access(State(server): State<LinkServer>, headers: HeaderMap, body: Bytes) -> Response {
    if !trusted_host(&headers, server.port) || !extension_origin(&headers) {
        return response(StatusCode::FORBIDDEN, "Use the Rupelian browser connector to connect your current account.");
    }
    let Ok(cookies) = std::str::from_utf8(&body) else { return response(StatusCode::BAD_REQUEST, "Invalid browser access format."); };
    match save_connected_access(&server, cookies) {
        Ok(()) => {
            // Never close or navigate the personal browser, or steal focus from it.
            if let Some(window) = server.app.get_webview_window("main") { let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational)); }
            response(StatusCode::OK, axum::Json(serde_json::json!({ "ok": true })))
        },
        Err(error) => response(StatusCode::CONFLICT, error),
    }
}

fn save_connected_access(server: &LinkServer, cookies: &str) -> Result<(), String> {
    // Serialized with Cancel: an old or cancelled request cannot save late.
    let mut current = CURRENT_LINK.lock().map_err(|_| "Connection is busy.".to_owned())?;
    let active = current.as_mut().filter(|active| active.public.attempt_id == server.attempt_id && active.public.status == "ready")
        .ok_or("This connection link has expired, was cancelled, or has already been used. Prepare a new link in Rupelian.")?;
    crate::youtube_session::save(&server.app, cookies, "Personal browser connector")?;
    active.public.status = "connected".into();
    active.public.url.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_loopback_host_and_extension_origins_can_submit_access() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:9876".parse().unwrap());
        assert!(trusted_host(&headers, 9876));
        assert!(!trusted_host(&headers, 9877));
        assert!(!extension_origin(&headers));
        for origin in ["https://youtube.com", "http://127.0.0.1:9876", "null", "chrome-extension://abc", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/evil"] {
            headers.insert("origin", origin.parse().unwrap());
            assert!(!extension_origin(&headers));
        }
        headers.insert("origin", "chrome-extension://abcdefghijklmnopabcdefghijklmnop".parse().unwrap());
        assert!(extension_origin(&headers));
        headers.insert("host", "attacker.invalid".parse().unwrap());
        assert!(!trusted_host(&headers, 9876));
        assert_eq!(random_token().len(), 43);
        assert_ne!(random_token(), random_token());
    }
}

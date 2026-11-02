use std::{
    collections::{BTreeMap, HashMap},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{Method, Request, Response, StatusCode},
    routing::any,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{path::BaseDirectory, AppHandle, Manager};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use crate::youtube_proxy::{self, RemoteSource};
use crate::youtube_session;

#[derive(Clone)]
pub struct YoutubeState {
    inner: Arc<YoutubeInner>,
    port: u16,
}

struct YoutubeInner {
    client: reqwest::Client,
    streams: RwLock<HashMap<String, RemoteSource>>,
    subtitles: RwLock<HashMap<String, SubtitleSource>>,
    next_token: AtomicU64,
}

#[derive(Clone)]
struct SubtitleSource {
    remote: RemoteSource,
    extension: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    url: String,
    browser: Option<String>,
    profile: Option<String>,
    cookie_file: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeMedia {
    video_id: String,
    title: String,
    channel: String,
    channel_id: String,
    webpage_url: String,
    thumbnail: String,
    duration: f64,
    preview_proxy_url: String,
    formats: Vec<YoutubeFormat>,
    audio_tracks: Vec<YoutubeAudioTrack>,
    subtitles: Vec<YoutubeSubtitle>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct YoutubeFormat {
    id: String,
    label: String,
    details: String,
    proxy_url: String,
    audio_proxy_url: String,
    width: u64,
    height: u64,
    fps: f64,
    extension: String,
    video_codec: String,
    has_embedded_audio: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct YoutubeAudioTrack {
    id: String,
    label: String,
    language: String,
    proxy_url: String,
    codec: String,
    details: String,
    is_default: bool,
    is_original: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeSubtitle {
    token: String,
    language: String,
    name: String,
    automatic: bool,
    label: String,
}

#[derive(Serialize)]
pub struct YoutubeCue {
    start: f64,
    end: f64,
    text: String,
}

impl YoutubeState {
    pub fn start() -> Result<Self, String> {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .map_err(|error| format!("Could not reserve a local streaming port: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure the local streaming port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not read the local streaming port: {error}"))?
            .port();
        let state = Self {
            inner: Arc::new(YoutubeInner {
                client: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(8))
                    .connect_timeout(std::time::Duration::from_secs(8))
                    .read_timeout(std::time::Duration::from_secs(10))
                    .build()
                    .map_err(|error| format!("Could not create the YouTube client: {error}"))?,
                streams: RwLock::new(HashMap::new()),
                subtitles: RwLock::new(HashMap::new()),
                next_token: AtomicU64::new(1),
            }),
            port,
        };
        let router = Router::new()
            .route("/youtube/{token}", any(proxy_stream))
            .with_state(state.clone());
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                return;
            };
            let _ = axum::serve(listener, router).await;
        });
        Ok(state)
    }

    fn token(&self) -> String {
        format!("{:x}", self.inner.next_token.fetch_add(1, Ordering::Relaxed))
    }

    fn register_stream(&self, source: RemoteSource) -> String {
        let token = self.token();
        self.inner.streams.write().expect("stream registry poisoned").insert(token.clone(), source);
        format!("http://127.0.0.1:{}/youtube/{token}", self.port)
    }

    fn register_subtitle(&self, source: SubtitleSource) -> String {
        let token = self.token();
        self.inner.subtitles.write().expect("subtitle registry poisoned").insert(token.clone(), source);
        token
    }
}

async fn proxy_stream(
    State(state): State<YoutubeState>,
    Path(token): Path<String>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::OPTIONS {
        return cors_response(Response::builder().status(StatusCode::NO_CONTENT), Body::empty());
    }
    let source = state.inner.streams.read().ok().and_then(|map| map.get(&token).cloned());
    let Some(source) = source else {
        return cors_response(Response::builder().status(StatusCode::NOT_FOUND), Body::from("Unknown or expired stream"));
    };
    youtube_proxy::serve(state.inner.client.clone(), source, request.method().clone(), request.headers()).await
}

fn cors_response(builder: axum::http::response::Builder, body: Body) -> Response<Body> {
    youtube_proxy::cors(builder, body)
}

#[tauri::command]
pub async fn resolve_youtube(
    app: AppHandle,
    state: tauri::State<'_, YoutubeState>,
    request: ResolveRequest,
) -> Result<YoutubeMedia, String> {
    validate_youtube_url(&request.url)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || resolve_blocking(&app, &state, request))
        .await
        .map_err(|error| format!("YouTube lookup task failed: {error}"))?
}

fn resolve_blocking(app: &AppHandle, state: &YoutubeState, request: ResolveRequest) -> Result<YoutubeMedia, String> {
    let mut request = request;
    let mut command = youtube_resolver_command(app, &request, false)?;
    let mut output = command
        .output()
        .map_err(|error| format!("Could not start the bundled YouTube resolver: {error}"))?;
    if !output.status.success() {
        // Keep public extraction first; use the durable session on every lookup/refresh.
        let cookies = youtube_session::resolver_cookies(app)?;
        if let Some(cookies) = &cookies { request.cookie_file = Some(cookies.0.to_string_lossy().into_owned()); }
        let has_session = request.cookie_file.as_deref().is_some_and(|value| !value.trim().is_empty())
            || request.browser.as_deref().is_some_and(|value| !value.trim().is_empty());
        if has_session {
            output = youtube_resolver_command(app, &request, true)?
                .output()
                .map_err(|error| format!("Could not start the bundled YouTube resolver: {error}"))?;
        }
    }
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(clean_ytdlp_error(&message));
    }
    let info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read YouTube video information: {error}"))?;
    media_from_info(state, &info, request.url.trim())
}

#[tauri::command]
pub async fn check_youtube_session(app: AppHandle, url: String) -> Result<String, String> {
    validate_youtube_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cookies = youtube_session::resolver_cookies(&app)?
            .ok_or_else(|| "Save a browser session or import cookies before checking.".to_owned())?;
        let request = ResolveRequest { url, browser: None, profile: None, cookie_file: Some(cookies.0.to_string_lossy().into_owned()) };
        // A check must actually use the session, even when the video is publicly accessible.
        let output = youtube_resolver_command(&app, &request, true)?.output()
            .map_err(|_| "Could not start the YouTube session check.".to_owned())?;
        if !output.status.success() { return Err(clean_ytdlp_error(&String::from_utf8_lossy(&output.stderr))); }
        let info: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Could not read the session check result.".to_owned())?;
        Ok(format!("This video is accessible using your saved session: {}", text(&info, "title")))
    }).await.map_err(|error| format!("Session check failed: {error}"))?
}

fn youtube_resolver_command(app: &AppHandle, request: &ResolveRequest, use_session: bool) -> Result<Command, String> {
    let ytdlp = binary_path(app, "yt-dlp.exe")?;
    let deno = binary_path(app, "deno.exe")?;
    let selector = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
    let mut command = Command::new(&ytdlp);
    command.args([
        "--no-config",
        "--quiet",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout",
        "25",
        "--format",
        selector,
        "--js-runtimes",
    ]);
    command.arg(format!("deno:{}", deno.display()));
    if use_session {
        if let Some(cookie_file) = request.cookie_file.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let path = PathBuf::from(cookie_file);
            if !path.is_file() {
                return Err("The saved YouTube access is missing. Sign in for this video again.".into());
            }
            command.arg("--cookies").arg(path);
        } else if let Some(browser) = request.browser.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let browser = validate_browser(browser)?;
            let cookie_source = match request.profile.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                Some(profile) => format!("{browser}:{profile}"),
                None => browser.to_owned(),
            };
            command.args(["--cookies-from-browser", &cookie_source]);
        }
    }
    command.arg("--").arg(request.url.trim());
    Ok(command)
}

fn binary_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Some(path) = crate::runtime_paths::resource(&format!("binaries/{name}")) { return Ok(path); }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name);
        if development.is_file() {
            return Ok(development);
        }
    }
    if let Ok(path) = app.path().resolve(format!("binaries/{name}"), BaseDirectory::Resource) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|directory| directory.join("binaries").join(name)));
    sibling.filter(|path| path.is_file()).ok_or_else(|| format!("Bundled component is missing: {name}"))
}

fn validate_youtube_url(value: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(value.trim()).map_err(|_| "Enter a valid YouTube video URL.".to_owned())?;
    let host = parsed.host_str().unwrap_or_default().trim_start_matches("www.");
    if parsed.scheme() != "https" || !matches!(host, "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be" | "youtube-nocookie.com") {
        return Err("Enter a valid YouTube video URL.".into());
    }
    Ok(())
}

fn validate_browser(value: &str) -> Result<&str, String> {
    match value.to_ascii_lowercase().as_str() {
        "edge" => Ok("edge"),
        "chrome" => Ok("chrome"),
        "chromium" => Ok("chromium"),
        "firefox" => Ok("firefox"),
        "brave" => Ok("brave"),
        "vivaldi" => Ok("vivaldi"),
        "safari" => Ok("safari"),
        _ => Err("Unsupported browser session.".into()),
    }
}

#[tauri::command]
pub fn default_youtube_browser() -> Option<String> {
    default_browser()
}

#[cfg(target_os = "windows")]
fn default_browser() -> Option<String> {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
            "/v",
            "ProgId",
        ])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    if value.contains("microsoftedge") || value.contains("msedge") { Some("edge".into()) }
    else if value.contains("brave") { Some("brave".into()) }
    else if value.contains("vivaldi") { Some("vivaldi".into()) }
    else if value.contains("firefox") { Some("firefox".into()) }
    else if value.contains("chrome") || value.contains("chromium") { Some("chrome".into()) }
    else { None }
}

#[cfg(target_os = "macos")]
fn default_browser() -> Option<String> {
    let output = Command::new("defaults")
        .args(["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    let https = value.rfind("lshandlerurlscheme = https")?;
    let group_start = value[..https].rfind('{').unwrap_or(0);
    let group_end = value[https..].find('}').map(|offset| https + offset + 1).unwrap_or(value.len());
    let nearby = &value[group_start..group_end];
    if nearby.contains("com.google.chrome") { Some("chrome".into()) }
    else if nearby.contains("com.microsoft.edgemac") { Some("edge".into()) }
    else if nearby.contains("com.brave.browser") { Some("brave".into()) }
    else if nearby.contains("com.vivaldi.vivaldi") { Some("vivaldi".into()) }
    else if nearby.contains("org.mozilla.firefox") { Some("firefox".into()) }
    else if nearby.contains("com.apple.safari") { Some("safari".into()) }
    else { None }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn default_browser() -> Option<String> {
    let output = Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    if value.contains("edge") { Some("edge".into()) }
    else if value.contains("brave") { Some("brave".into()) }
    else if value.contains("vivaldi") { Some("vivaldi".into()) }
    else if value.contains("firefox") { Some("firefox".into()) }
    else if value.contains("chromium") { Some("chromium".into()) }
    else if value.contains("chrome") { Some("chrome".into()) }
    else { None }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInSession {
    profile: String,
    pub(crate) debug_port: u16,
    pub(crate) browser: String,
}

static SIGN_IN_SESSION: Mutex<Option<SignInSession>> = Mutex::new(None);

#[tauri::command]
pub fn youtube_sign_in_browsers() -> Vec<Value> {
    ["edge", "chrome", "chromium", "brave", "vivaldi"].iter()
        .filter(|browser| browser_executable(browser).is_some())
        .map(|browser| serde_json::json!({ "id": browser, "name": browser_name(browser) })).collect()
}

#[tauri::command]
pub fn open_youtube_sign_in(app: AppHandle, browser: String) -> Result<SignInSession, String> {
    let browser = validate_browser(browser.trim())?;
    if matches!(browser, "firefox" | "safari") {
        return Err("The app-managed sign-in currently supports Edge, Chrome, Brave, and Vivaldi.".into());
    }
    let executable = browser_executable(browser)
        .ok_or_else(|| format!("Could not find {} on this computer.", browser_name(browser)))?;
    let mut current = SIGN_IN_SESSION.lock().map_err(|_| "Sign-in is busy.".to_owned())?;
    if let Some(session) = current.as_ref() {
        if std::net::TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, session.debug_port)), std::time::Duration::from_millis(300)).is_ok() {
            if session.browser != browser {
                return Err("Sign-in is already open in another browser. Cancel it in Rupelian before changing browsers.".into());
            }
            return Ok(session.clone());
        }
    }
    let session_root = app.path().app_data_dir()
        .map_err(|error| format!("Could not locate app data: {error}"))?
        .join("youtube-browser-sessions")
        .join(browser);
    let profile = session_root.join("Default");
    std::fs::create_dir_all(&profile)
        .map_err(|error| format!("Could not create the YouTube sign-in profile: {error}"))?;
    let debug_port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map_err(|error| format!("Could not reserve the sign-in connection: {error}"))?
        .port();
    Command::new(executable)
        .arg(format!("--user-data-dir={}", session_root.display()))
        .arg("--profile-directory=Default")
        .arg(format!("--remote-debugging-port={debug_port}"))
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("https://www.youtube.com/signin?next=%2F")
        .spawn()
        .map_err(|error| format!("Could not open the YouTube sign-in browser: {error}"))?;
    let session = SignInSession { profile: profile.to_string_lossy().into_owned(), debug_port, browser: browser.into() };
    *current = Some(session.clone());
    Ok(session)
}

#[tauri::command]
pub async fn capture_youtube_sign_in(app: AppHandle, debug_port: u16) -> Result<youtube_session::SessionStatus, String> {
    tokio::time::timeout(std::time::Duration::from_secs(20), capture_sign_in(&app, debug_port)).await
        .map_err(|_| "The sign-in browser did not respond. Keep it open while Rupelian checks again.".to_owned())?
}

/// Recovery/2FA may end on a Google page without returning to YouTube. Open a
/// separate tab only on the user's Continue click; never navigate their current tab.
#[tauri::command]
pub async fn continue_youtube_sign_in(debug_port: u16) -> Result<(), String> {
    let session = active_sign_in(debug_port)?;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut socket = sign_in_socket(&session).await?;
        socket.send(Message::Text(r#"{"id":3,"method":"Target.createTarget","params":{"url":"https://www.youtube.com/"}}"#.into())).await
            .map_err(|_| "Could not open YouTube. Keep the sign-in browser open and try again.".to_owned())?;
        while let Some(message) = socket.next().await {
            let message = message.map_err(|_| "The sign-in browser connection was interrupted.".to_owned())?;
            if let Message::Text(text) = message {
                let reply: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if reply.get("id").and_then(Value::as_u64) != Some(3) { continue; }
                return if reply.pointer("/result/targetId").and_then(Value::as_str).is_some() {
                    Ok(())
                } else {
                    Err("Could not open YouTube. Keep the sign-in browser open and try again.".into())
                };
            }
        }
        Err("The sign-in browser closed before opening YouTube.".into())
    }).await.map_err(|_| "The sign-in browser did not respond. Your recovery pages have been left open.".to_owned())?
}

#[tauri::command]
pub async fn close_youtube_sign_in(debug_port: u16) -> Result<(), String> {
    if debug_port < 1024 {
        return Err("Invalid sign-in connection.".into());
    }
    let session = {
        let mut current = SIGN_IN_SESSION.lock().map_err(|_| "Sign-in is busy.".to_owned())?;
        if current.as_ref().is_none_or(|session| session.debug_port != debug_port) {
            return Err("This sign-in window is not owned by Rupelian.".into());
        }
        // Invalidate before awaiting browser I/O so a concurrent poll cannot save
        // credentials after cancellation or consume a newer sign-in attempt.
        current.take().expect("The owned session was checked above")
    };
    let version_url = format!("http://127.0.0.1:{debug_port}/json/version");
    if let Ok(version) = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|_| "Could not prepare the sign-in connection.".to_owned())?
        .get(&version_url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
    {
        if let Ok(value) = version.json::<Value>().await {
            if let Some(websocket_url) = value
                .get("webSocketDebuggerUrl")
                .and_then(Value::as_str)
                .filter(|url| {
                    reqwest::Url::parse(url).is_ok_and(|url| {
                        url.scheme() == "ws"
                            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                            && url.port() == Some(debug_port)
                    })
                })
            {
                if let Ok((mut socket, _)) = connect_async(websocket_url).await {
                    let _ = socket
                        .send(Message::Text(
                            r#"{"id":1,"method":"Browser.close"}"#.into(),
                        ))
                        .await;
                }
            }
        }
    }
    let mut current = SIGN_IN_SESSION.lock().map_err(|_| "Sign-in is busy.".to_owned())?;
    if current.as_ref().is_some_and(|active| {
        active.debug_port == session.debug_port && active.profile == session.profile
    }) {
        *current = None;
    }
    Ok(())
}

async fn capture_sign_in(app: &AppHandle, debug_port: u16) -> Result<youtube_session::SessionStatus, String> {
    let session = active_sign_in(debug_port)?;
    let mut socket = sign_in_socket(&session).await?;
    socket.send(Message::Text(r#"{"id":1,"method":"Storage.getCookies"}"#.into())).await
        .map_err(|error| format!("Could not request browser cookies: {error}"))?;
    let payload = loop {
        let message = socket.next().await
            .ok_or_else(|| "The sign-in browser closed before sharing its session.".to_owned())?
            .map_err(|error| format!("Could not receive browser cookies: {error}"))?;
        if let Message::Text(text) = message {
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if value.get("id").and_then(Value::as_u64) == Some(1) { break value; }
        }
    };
    let cookies = payload.pointer("/result/cookies").and_then(Value::as_array)
        .ok_or_else(|| "The browser returned no readable session cookies.".to_owned())?;
    let output = sign_in_cookie_export(cookies)?;
    let status = {
        let mut current = SIGN_IN_SESSION.lock().map_err(|_| "Sign-in is busy.".to_owned())?;
        if current.as_ref().is_none_or(|active| active.debug_port != session.debug_port || active.profile != session.profile) {
            return Err("This sign-in attempt was cancelled. Previously saved access has not changed.".into());
        }
        let status = youtube_session::save(app, &output, browser_name(&session.browser))?;
        *current = None;
        status
    };
    // Cookies are read from the browser session, not a tab URL, so recovery,
    // account selection, new tabs and 2FA do not detach this connection.
    let _ = socket.send(Message::Text(r#"{"id":2,"method":"Browser.close"}"#.into())).await;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(status)
}

fn active_sign_in(debug_port: u16) -> Result<SignInSession, String> {
    if debug_port < 1024 { return Err("Invalid sign-in connection.".into()); }
    SIGN_IN_SESSION.lock().map_err(|_| "Sign-in is busy.".to_owned())?.clone()
        .filter(|session| session.debug_port == debug_port)
        .ok_or_else(|| "Open the sign-in browser from Settings > YouTube first.".to_owned())
}

async fn sign_in_socket(session: &SignInSession) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let debug_port = session.debug_port;
    let version_url = format!("http://127.0.0.1:{debug_port}/json/version");
    let version: Value = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build()
        .map_err(|_| "Could not prepare the sign-in connection.".to_owned())?.get(&version_url).send().await
        .map_err(|_| "The sign-in browser is not open. Open it again and finish signing in first.".to_owned())?
        .json().await
        .map_err(|_| "Could not connect to the sign-in browser.".to_owned())?;
    let websocket_url = version.get("webSocketDebuggerUrl").and_then(Value::as_str)
        .filter(|url| reqwest::Url::parse(url).is_ok_and(|url| url.scheme() == "ws" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(debug_port)))
        .ok_or_else(|| "The sign-in browser did not expose a safe local session.".to_owned())?;
    let (socket, _) = connect_async(websocket_url).await
        .map_err(|error| format!("Could not read the sign-in session: {error}"))?;
    Ok(socket)
}

fn sign_in_cookie_export(cookies: &[Value]) -> Result<String, String> {
    let youtube_cookies: Vec<&Value> = cookies.iter().filter(|cookie| {
        let domain = text(cookie, "domain");
        youtube_session::youtube_domain(&domain)
    }).collect();
    let mut output = String::from("# Netscape HTTP Cookie File\n# Generated locally by Rupelian\n\n");
    for cookie in youtube_cookies {
        let raw_domain = text(cookie, "domain");
        let http_only = cookie.get("httpOnly").and_then(Value::as_bool).unwrap_or(false);
        let domain = if http_only { format!("#HttpOnly_{raw_domain}") } else { raw_domain.clone() };
        let include_subdomains = if raw_domain.starts_with('.') { "TRUE" } else { "FALSE" };
        let path = fallback(text(cookie, "path"), "/");
        let secure = if cookie.get("secure").and_then(Value::as_bool).unwrap_or(false) { "TRUE" } else { "FALSE" };
        let expires = number(cookie, "expires").max(0.0).round() as u64;
        let name = text(cookie, "name").replace(['\t', '\n', '\r'], "");
        let value = text(cookie, "value").replace(['\t', '\n', '\r'], "");
        output.push_str(&format!("{domain}\t{include_subdomains}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n"));
    }
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    youtube_session::normalize_cookies(&output, timestamp)
        .map_err(|_| "No signed-in YouTube account was detected yet. Finish signing in; if Google leaves you on another page, click Continue connection in Rupelian.".to_owned())
}

fn browser_name(browser: &str) -> &str {
    match browser { "edge" => "Microsoft Edge", "chrome" => "Google Chrome", "chromium" => "Chromium", "brave" => "Brave", "vivaldi" => "Vivaldi", "firefox" => "Mozilla Firefox", "safari" => "Safari", _ => browser }
}

#[cfg(target_os = "windows")]
fn browser_executable(browser: &str) -> Option<PathBuf> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default());
    let program_files = PathBuf::from(std::env::var_os("PROGRAMFILES").unwrap_or_default());
    let program_files_x86 = PathBuf::from(std::env::var_os("PROGRAMFILES(X86)").unwrap_or_default());
    let candidates = match browser {
        "chrome" => vec![local.join("Google/Chrome/Application/chrome.exe"), program_files.join("Google/Chrome/Application/chrome.exe"), program_files_x86.join("Google/Chrome/Application/chrome.exe")],
        "chromium" => vec![local.join("Chromium/Application/chrome.exe"), program_files.join("Chromium/Application/chrome.exe")],
        "edge" => vec![program_files_x86.join("Microsoft/Edge/Application/msedge.exe"), program_files.join("Microsoft/Edge/Application/msedge.exe")],
        "brave" => vec![local.join("BraveSoftware/Brave-Browser/Application/brave.exe"), program_files.join("BraveSoftware/Brave-Browser/Application/brave.exe")],
        "vivaldi" => vec![local.join("Vivaldi/Application/vivaldi.exe"), program_files.join("Vivaldi/Application/vivaldi.exe")],
        "firefox" => vec![program_files.join("Mozilla Firefox/firefox.exe"), program_files_x86.join("Mozilla Firefox/firefox.exe")],
        _ => Vec::new(),
    };
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn browser_executable(browser: &str) -> Option<PathBuf> {
    let name = match browser { "chrome" => "Google Chrome", "chromium" => "Chromium", "edge" => "Microsoft Edge", "brave" => "Brave Browser", "vivaldi" => "Vivaldi", "firefox" => "Firefox", "safari" => "Safari", _ => return None };
    let path = PathBuf::from(format!("/Applications/{name}.app/Contents/MacOS/{name}"));
    path.is_file().then_some(path)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn browser_executable(browser: &str) -> Option<PathBuf> {
    let names: &[&str] = match browser { "chrome" => &["google-chrome"], "chromium" => &["chromium", "chromium-browser"], "edge" => &["microsoft-edge"], "brave" => &["brave-browser"], "vivaldi" => &["vivaldi"], "firefox" => &["firefox"], _ => &[] };
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).flat_map(|directory| names.iter().map(move |name| directory.join(name))).find(|path| path.is_file()))
}

fn clean_ytdlp_error(stderr: &str) -> String {
    let useful = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Could not read this YouTube video.")
        .trim()
        .trim_start_matches("ERROR:")
        .trim();
    if useful.is_empty() { "Could not read this YouTube video.".into() } else { useful.into() }
}

fn media_from_info(state: &YoutubeState, info: &Value, original_url: &str) -> Result<YoutubeMedia, String> {
    let info = info.get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| entries.iter().find(|entry| !entry.is_null()))
        .unwrap_or(info);
    let global_headers = headers_from(info.get("http_headers"));
    let mut candidates: BTreeMap<(u64, u64, String), (&Value, f64)> = BTreeMap::new();
    let audio_tracks = info.get("formats").and_then(Value::as_array)
        .map(|formats| youtube_audio_tracks(state, formats, &global_headers))
        .unwrap_or_default();
    let has_separate_audio = !audio_tracks.is_empty();
    if let Some(formats) = info.get("formats").and_then(Value::as_array) {
        for format in formats {
            let url = text(format, "url");
            let video_codec = text(format, "vcodec");
            let audio_codec = text(format, "acodec");
            let extension = text(format, "ext");
            let protocol = text(format, "protocol");
            if url.is_empty() || !protocol.starts_with("http") || protocol.contains("m3u8") {
                continue;
            }
            if matches!(video_codec.as_str(), "" | "none") && !matches!(audio_codec.as_str(), "" | "none") {
                continue;
            }
            if matches!(video_codec.as_str(), "" | "none") { continue; }
            let Some(codec_score) = webview_video_codec_score(&video_codec, &extension) else { continue; };
            if !matches!(audio_codec.as_str(), "" | "none") && !webview_audio_codec_compatible(&audio_codec) { continue; }
            let height = number(format, "height") as u64;
            let fps = number(format, "fps").round() as u64;
            let has_audio = !matches!(audio_codec.as_str(), "" | "none");
            let score = playback_delivery_score(has_audio, has_separate_audio) + codec_score + number(format, "tbr");
            let key = (height, fps, extension);
            if candidates.get(&key).is_none_or(|(_, old_score)| score > *old_score) {
                candidates.insert(key, (format, score));
            }
        }
    }
    let audio_source = audio_tracks.iter()
        .find(|track| track.is_default)
        .or_else(|| audio_tracks.iter().find(|track| track.is_original))
        .or_else(|| audio_tracks.first())
        .map(|track| track.proxy_url.as_str());
    let preview_proxy_url = candidates
        .values()
        .map(|(format, _)| *format)
        .min_by_key(|format| (number(format, "height") as i64 - 240).unsigned_abs())
        .map(|format| {
            let mut headers = global_headers.clone();
            headers.extend(headers_from(format.get("http_headers")));
            state.register_stream(RemoteSource { url: text(format, "url"), headers })
        })
        .unwrap_or_default();
    let mut formats: Vec<YoutubeFormat> = candidates
        .into_values()
        .filter_map(|(format, _)| format_from_info(state, format, &global_headers, audio_source.as_deref()))
        .collect();
    formats.sort_by(|left, right| right.height.cmp(&left.height).then_with(|| right.fps.total_cmp(&left.fps)));
    formats.truncate(10);
    if formats.is_empty() && !text(info, "url").is_empty() {
        if let Some(format) = format_from_info(state, info, &global_headers, audio_source.as_deref()) { formats.push(format); }
    }
    if formats.is_empty() {
        return Err("YouTube did not return a seekable audio/video stream for this video.".into());
    }
    let subtitles = subtitle_tracks(state, info, &global_headers);
    Ok(YoutubeMedia {
        video_id: text(info, "id"),
        title: fallback(text(info, "title"), "YouTube video"),
        channel: fallback(text(info, "channel"), &fallback(text(info, "uploader"), "YouTube")),
        channel_id: fallback(text(info, "channel_id"), &text(info, "uploader_id")),
        webpage_url: fallback(text(info, "webpage_url"), original_url),
        thumbnail: text(info, "thumbnail"),
        duration: number(info, "duration"),
        preview_proxy_url,
        formats,
        audio_tracks,
        subtitles,
    })
}

fn playback_delivery_score(has_embedded_audio: bool, has_separate_audio: bool) -> f64 {
    if has_embedded_audio {
        5_000_000.0
    } else if has_separate_audio {
        4_000_000.0
    } else {
        0.0
    }
}

fn youtube_audio_tracks(state: &YoutubeState, formats: &[Value], global_headers: &HashMap<String, String>) -> Vec<YoutubeAudioTrack> {
    let mut candidates: BTreeMap<String, (&Value, f64)> = BTreeMap::new();
    for format in formats {
        let url = text(format, "url");
        let video_codec = text(format, "vcodec");
        let audio_codec = text(format, "acodec");
        let protocol = text(format, "protocol");
        if url.is_empty()
            || !protocol.starts_with("http")
            || protocol.contains("m3u8")
            || !matches!(video_codec.as_str(), "" | "none")
            || matches!(audio_codec.as_str(), "" | "none")
            || !webview_audio_codec_compatible(&audio_codec)
        {
            continue;
        }
        let language = fallback(text(format, "language"), "und");
        let label = youtube_audio_label(format, &language);
        let key = format!("{}:{}", language.to_lowercase(), label.to_lowercase());
        let compatibility = if audio_codec.starts_with("mp4a") { 2_000_000.0 } else { 1_000_000.0 };
        let score = compatibility + number(format, "abr").max(number(format, "tbr"));
        if candidates.get(&key).is_none_or(|(_, old_score)| score > *old_score) {
            candidates.insert(key, (format, score));
        }
    }

    let mut tracks = candidates.into_values().map(|(format, _)| {
        let language = fallback(text(format, "language"), "und");
        let label = youtube_audio_label(format, &language);
        let note = text(format, "format_note").to_lowercase();
        let preference = number(format, "language_preference");
        let is_original = note.contains("original");
        let is_default = note.contains("default") || is_original || preference > 0.0;
        let mut headers = global_headers.clone();
        headers.extend(headers_from(format.get("http_headers")));
        YoutubeAudioTrack {
            id: text(format, "format_id"),
            label,
            language,
            proxy_url: state.register_stream(RemoteSource { url: text(format, "url"), headers }),
            codec: text(format, "acodec"),
            details: format!("{} kbps Â· {}", number(format, "abr").max(number(format, "tbr")).round(), text(format, "ext").to_uppercase()),
            is_default,
            is_original,
        }
    }).collect::<Vec<_>>();
    tracks.sort_by_key(|track| (!track.is_default, !track.is_original, track.label.to_lowercase()));
    if tracks.len() > 1 && tracks.iter().filter(|track| track.is_default).count() > 1 {
        let preferred = tracks.iter().position(|track| track.is_original).unwrap_or(0);
        for (index, track) in tracks.iter_mut().enumerate() {
            track.is_default = index == preferred;
        }
    }
    tracks
}

fn youtube_audio_label(format: &Value, language: &str) -> String {
    let note = text(format, "format_note");
    let leading = note.split(',').next().unwrap_or("").trim();
    if !leading.is_empty() && !matches!(leading.to_ascii_lowercase().as_str(), "low" | "medium" | "high" | "default") {
        leading.to_owned()
    } else if language.eq_ignore_ascii_case("und") {
        "Original audio".into()
    } else {
        language.to_uppercase()
    }
}

fn format_from_info(state: &YoutubeState, format: &Value, global_headers: &HashMap<String, String>, audio_source: Option<&str>) -> Option<YoutubeFormat> {
    let height = number(format, "height") as u64;
    let width = number(format, "width") as u64;
    let fps = number(format, "fps");
    let extension = fallback(text(format, "ext"), "video");
    let has_audio = !matches!(text(format, "acodec").as_str(), "" | "none");
    if !has_audio && audio_source.is_none() { return None; }
    let mut headers = global_headers.clone();
    headers.extend(headers_from(format.get("http_headers")));
    let proxy_url = state.register_stream(RemoteSource { url: text(format, "url"), headers });
    let label = if height >= 2160 { "2160p 4K".into() } else if height >= 1440 { "1440p QHD".into() } else if height >= 1080 { "1080p FHD".into() } else if height >= 720 { "720p HD".into() } else if height > 0 { format!("{height}p") } else { "Auto".into() };
    let fps_label = if fps >= 50.0 { format!(" · {}fps", fps.round()) } else { String::new() };
    let codec = text(format, "vcodec").split('.').next().unwrap_or("").to_uppercase();
    Some(YoutubeFormat {
        id: text(format, "format_id"),
        label: format!("{label}{fps_label}"),
        details: format!("{}×{} · {} · {}", width, height, extension.to_uppercase(), codec),
        proxy_url,
        audio_proxy_url: if has_audio { String::new() } else { audio_source.unwrap_or_default().to_owned() },
        width,
        height,
        fps,
        extension,
        video_codec: text(format, "vcodec"),
        has_embedded_audio: has_audio,
    })
}

fn webview_video_codec_score(codec: &str, extension: &str) -> Option<f64> {
    let codec = codec.to_ascii_lowercase();
    let extension = extension.to_ascii_lowercase();
    if (codec.starts_with("avc1") || codec.starts_with("h264")) && matches!(extension.as_str(), "mp4" | "m4v" | "mov") {
        Some(3_000_000.0)
    } else if (codec.starts_with("vp9") || codec.starts_with("vp09")) && extension == "webm" {
        Some(2_000_000.0)
    } else {
        None
    }
}

fn webview_audio_codec_compatible(codec: &str) -> bool {
    let codec = codec.to_ascii_lowercase();
    codec.starts_with("mp4a") || codec.starts_with("opus") || codec.starts_with("vorbis")
}

fn subtitle_tracks(state: &YoutubeState, info: &Value, global_headers: &HashMap<String, String>) -> Vec<YoutubeSubtitle> {
    let mut tracks = Vec::new();
    if let Some(manual) = info.get("subtitles").and_then(Value::as_object) {
        append_subtitle_tracks(state, &mut tracks, manual, false, global_headers);
    }
    if let Some(automatic) = info.get("automatic_captions").and_then(Value::as_object) {
        let originals: serde_json::Map<String, Value> = automatic.iter()
            .filter(|(language, _)| language.ends_with("-orig"))
            .map(|(language, variants)| (language.clone(), variants.clone()))
            .collect();
        if !originals.is_empty() {
            append_subtitle_tracks(state, &mut tracks, &originals, true, global_headers);
        } else if let Some(language) = info.get("language").and_then(Value::as_str) {
            if let Some(variants) = automatic.get(language) {
                let selected = serde_json::Map::from_iter([(language.to_owned(), variants.clone())]);
                append_subtitle_tracks(state, &mut tracks, &selected, true, global_headers);
            }
        } else {
            append_subtitle_tracks(state, &mut tracks, automatic, true, global_headers);
        }
    }
    tracks.sort_by_key(|track| (track.automatic, !track.language.starts_with("en"), track.name.to_lowercase()));
    tracks
}

fn append_subtitle_tracks(
    state: &YoutubeState,
    tracks: &mut Vec<YoutubeSubtitle>,
    collection: &serde_json::Map<String, Value>,
    automatic: bool,
    global_headers: &HashMap<String, String>,
) {
    for (language, variants) in collection {
        if language == "live_chat" { continue; }
        let Some(variants) = variants.as_array() else { continue };
        let preferred = if automatic { ["json3", "vtt", "srt"] } else { ["vtt", "srt", "json3"] };
        let selected = preferred
            .iter()
            .find_map(|extension| variants.iter().find(|variant| text(variant, "ext") == *extension && !text(variant, "url").is_empty()));
        let Some(selected) = selected else { continue };
        let language = language.trim_end_matches("-orig").to_owned();
        let name = fallback(text(selected, "name"), &language);
        let extension = fallback(text(selected, "ext"), "vtt");
        let token = state.register_subtitle(SubtitleSource {
            remote: RemoteSource { url: text(selected, "url"), headers: global_headers.clone() },
            extension,
        });
        let source = if automatic { "Auto-generated" } else { "Creator subtitles" };
        tracks.push(YoutubeSubtitle { token, language: language.clone(), name: name.clone(), automatic, label: format!("{name} · {source}") });
    }
}

#[tauri::command]
pub async fn load_youtube_subtitles(
    state: tauri::State<'_, YoutubeState>,
    token: String,
) -> Result<Vec<YoutubeCue>, String> {
    let source = state.inner.subtitles.read().ok().and_then(|map| map.get(&token).cloned())
        .ok_or_else(|| "This YouTube subtitle link has expired. Find the video again.".to_owned())?;
    let mut request = state.inner.client.get(&source.remote.url).header(reqwest::header::ACCEPT_ENCODING, "identity");
    for (name, value) in &source.remote.headers {
        request = request.header(name, value);
    }
    let bytes = request.send().await
        .map_err(|error| format!("Could not download YouTube subtitles: {error}"))?
        .error_for_status()
        .map_err(|error| format!("YouTube subtitle request failed: {error}"))?
        .bytes().await
        .map_err(|error| format!("Could not read YouTube subtitles: {error}"))?;
    if source.extension.eq_ignore_ascii_case("json3") {
        parse_json3(&bytes)
    } else {
        let content = String::from_utf8_lossy(&bytes);
        parse_timed_text(&content)
    }
}

fn parse_json3(bytes: &[u8]) -> Result<Vec<YoutubeCue>, String> {
    let payload: Value = serde_json::from_slice(bytes).map_err(|_| "YouTube returned invalid auto-generated captions.".to_owned())?;
    let mut cues: Vec<YoutubeCue> = Vec::new();
    for event in payload.get("events").and_then(Value::as_array).into_iter().flatten() {
        let text = event.get("segs").and_then(Value::as_array).into_iter().flatten()
            .map(|segment| text(segment, "utf8"))
            .collect::<String>();
        let text = clean_caption(&text);
        if text.is_empty() { continue; }
        let start = number(event, "tStartMs") / 1000.0;
        let duration = number(event, "dDurationMs").max(250.0) / 1000.0;
        let end = start + duration;
        if let Some(previous) = cues.last_mut() {
            if previous.text == text {
                previous.end = previous.end.max(end);
                continue;
            }
        }
        cues.push(YoutubeCue { start, end, text });
    }
    finish_cues(cues)
}

fn parse_timed_text(content: &str) -> Result<Vec<YoutubeCue>, String> {
    let mut cues = Vec::new();
    for block in content.replace('\r', "").trim().split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(index) = lines.iter().position(|line| line.contains("-->")) else { continue };
        let Some((start, end)) = lines[index].split_once("-->") else { continue };
        let (Some(start), Some(end)) = (timestamp(start), timestamp(end.split_whitespace().next().unwrap_or(""))) else { continue };
        let text = clean_caption(&lines[index + 1..].join(" "));
        if !text.is_empty() { cues.push(YoutubeCue { start, end, text }); }
    }
    finish_cues(cues)
}

fn finish_cues(mut cues: Vec<YoutubeCue>) -> Result<Vec<YoutubeCue>, String> {
    cues.sort_by(|left, right| left.start.total_cmp(&right.start));
    for index in 0..cues.len().saturating_sub(1) {
        if cues[index + 1].start > cues[index].start {
            cues[index].end = cues[index].end.min(cues[index + 1].start);
        }
        cues[index].end = cues[index].end.max(cues[index].start + 0.25);
    }
    if let Some(last) = cues.last_mut() {
        last.end = last.end.max(last.start + 0.25);
    }
    if cues.is_empty() { Err("No readable cues were found in this YouTube caption track.".into()) } else { Ok(cues) }
}

fn timestamp(value: &str) -> Option<f64> {
    let normalized = value.trim().replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    let seconds = parts.last()?.parse::<f64>().ok()?;
    match parts.len() {
        2 => Some(parts[0].parse::<f64>().ok()? * 60.0 + seconds),
        3 => Some(parts[0].parse::<f64>().ok()? * 3600.0 + parts[1].parse::<f64>().ok()? * 60.0 + seconds),
        _ => None,
    }
}

fn clean_caption(value: &str) -> String {
    let mut output = String::new();
    let mut tag = false;
    for character in value.replace("\\n", " ").replace("\u{200b}", "").chars() {
        match character { '<' => tag = true, '>' => tag = false, _ if !tag => output.push(character), _ => {} }
    }
    output
        .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
        .split_whitespace().collect::<Vec<_>>().join(" ")
}

fn headers_from(value: Option<&Value>) -> HashMap<String, String> {
    value.and_then(Value::as_object).into_iter().flatten()
        .filter_map(|(name, value)| value.as_str().map(|value| (name.clone(), value.to_owned())))
        .collect()
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn fallback(value: String, fallback: &str) -> String {
    if value.trim().is_empty() { fallback.to_owned() } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_sign_in_waits_for_valid_youtube_access_after_recovery() {
        let recovery_cookies = vec![serde_json::json!({"domain":".google.com", "name":"SAPISID", "value":"google-only", "path":"/", "secure":true, "expires":0})];
        assert!(sign_in_cookie_export(&recovery_cookies).is_err());
        let mut completed = recovery_cookies;
        completed.push(serde_json::json!({"domain":".youtube.com", "name":"__Secure-1PAPISID", "value":"youtube-test", "path":"/", "secure":true, "expires":0}));
        let exported = sign_in_cookie_export(&completed).unwrap();
        assert!(exported.contains("youtube-test"));
        assert!(!exported.contains("google-only"));
        completed[1]["expires"] = serde_json::json!(1);
        assert!(sign_in_cookie_export(&completed).is_err());
    }
    use serde_json::json;

    #[test]
    fn filters_formats_to_webview_decoders() {
        assert!(webview_video_codec_score("avc1.640028", "mp4").is_some());
        assert!(webview_video_codec_score("vp9", "webm").is_some());
        assert!(webview_video_codec_score("av01.0.08M.08", "mp4").is_none());
        assert!(webview_video_codec_score("hev1.1.6.L120", "mp4").is_none());
        assert!(webview_video_codec_score("vp9", "mp4").is_none());
        assert!(webview_audio_codec_compatible("mp4a.40.2"));
        assert!(webview_audio_codec_compatible("opus"));
        assert!(!webview_audio_codec_compatible("ac-3"));
    }

    #[test]
    fn prefers_single_muxed_delivery_when_the_same_quality_is_available() {
        assert!(playback_delivery_score(true, true) > playback_delivery_score(false, true));
        assert!(playback_delivery_score(true, false) > playback_delivery_score(false, false));
    }

    #[test]
    fn groups_multilingual_youtube_audio_and_preserves_default() {
        let state = YoutubeState::start().expect("test proxy should start");
        let formats = json!([
            { "format_id": "140-0", "url": "https://example.test/en-low", "protocol": "https", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "language": "en", "format_note": "English original (default), low", "abr": 64, "language_preference": 10 },
            { "format_id": "140-1", "url": "https://example.test/en", "protocol": "https", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "language": "en", "format_note": "English original (default), medium", "abr": 129, "language_preference": 10 },
            { "format_id": "251-2", "url": "https://example.test/es", "protocol": "https", "vcodec": "none", "acodec": "opus", "ext": "webm", "language": "es", "format_note": "Spanish, medium", "abr": 128, "language_preference": -1 },
            { "format_id": "251-3", "url": "https://example.test/en-description", "protocol": "https", "vcodec": "none", "acodec": "opus", "ext": "webm", "language": "en-desc", "format_note": "English descriptive, medium", "abr": 128, "language_preference": -10 }
        ]);
        let tracks = youtube_audio_tracks(&state, formats.as_array().expect("formats"), &HashMap::new());
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].id, "140-1");
        assert!(tracks[0].is_default);
        assert!(tracks[0].is_original);
        assert_eq!(tracks[1].language, "en-desc");
        assert_eq!(tracks[2].language, "es");
    }

    #[test]
    fn returns_creator_and_auto_generated_caption_groups() {
        let state = YoutubeState::start().expect("test proxy should start");
        let info = json!({
            "language": "en",
            "subtitles": {
                "en": [{ "ext": "vtt", "url": "https://example.test/manual", "name": "English" }]
            },
            "automatic_captions": {
                "en-orig": [{ "ext": "json3", "url": "https://example.test/auto", "name": "English" }],
                "fa": [{ "ext": "vtt", "url": "https://example.test/translated", "name": "Persian" }]
            }
        });
        let tracks = subtitle_tracks(&state, &info, &HashMap::new());
        assert_eq!(tracks.len(), 2);
        assert!(!tracks[0].automatic);
        assert!(tracks[1].automatic);
        assert_eq!(tracks[1].language, "en");
    }

    #[test]
    fn json3_captions_merge_duplicates_and_do_not_overlap() {
        let content = br#"{"events":[
            {"tStartMs":500,"dDurationMs":1800,"segs":[{"utf8":"Hello world"}]},
            {"tStartMs":800,"dDurationMs":1800,"segs":[{"utf8":"Hello world"}]},
            {"tStartMs":2000,"dDurationMs":900,"segs":[{"utf8":"Next line"}]}
        ]}"#;
        let cues = parse_json3(content).expect("captions should parse");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "Hello world");
        assert_eq!(cues[0].start, 0.5);
        assert_eq!(cues[0].end, 2.0);
        assert_eq!(cues[1].text, "Next line");
    }

}

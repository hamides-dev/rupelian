mod ai;
mod bootstrap_protocol;
mod library;
mod local_media;
mod persistence;
mod runtime_paths;
mod subtitle;
mod youtube;
mod youtube_proxy;
mod youtube_session;
mod youtube_browser_link;
mod player_window;
mod updater;

use serde::{Deserialize, Serialize};
use bootstrap_protocol::BootstrapInfo;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use subtitle::{parse_named_subtitle_bytes, SubtitleCue};

use tauri::{Emitter, Manager};

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv", "flv", "mpeg", "mpg", "m2ts", "ts", "vob",
    "ogv", "3gp", "3g2", "asf",
];
const SUBTITLE_EXTENSIONS: &[&str] = &[
    "srt", "vtt", "ass", "ssa", "sub", "sbv", "smi", "sami", "lrc", "mpl2", "mpsub", "pjs", "rt",
    "stl", "aqt", "jss",
];

struct StartupMediaPaths(Mutex<Vec<String>>);

struct StartupTiming {
    started: Instant,
    bootstrap: BootstrapInfo,
    runtime_started_unix_ms: u64,
    window_created_ms: Mutex<Option<u128>>,
    shell_ready_ms: Mutex<Option<u128>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupSnapshot {
    window_created_ms: Option<u128>,
    shell_ready_ms: u128,
    first_visible_unix_ms: Option<u64>,
    first_visible_after_entry_ms: Option<u64>,
    runtime_load_started_unix_ms: Option<u64>,
    runtime_started_unix_ms: u64,
}

impl StartupTiming {
    fn elapsed_ms(&self) -> u128 {
        let before_runtime = if self.bootstrap.entry_unix_ms > 0 {
            self.runtime_started_unix_ms.saturating_sub(self.bootstrap.entry_unix_ms)
        } else { 0 };
        before_runtime as u128 + self.started.elapsed().as_millis()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest {
    base_url: String,
    api_key: String,
    model: String,
    text: String,
}

#[derive(Deserialize)]
struct ChatCompletion {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

#[tauri::command]
async fn explain_subtitle(request: AiRequest) -> Result<String, String> {
    let base_url = request.base_url.trim_end_matches('/');
    if !base_url.starts_with("https://") && !base_url.starts_with("http://localhost") {
        return Err("Use an HTTPS endpoint (localhost is allowed for local models).".into());
    }
    if request.api_key.trim().is_empty()
        || request.model.trim().is_empty()
        || request.text.trim().is_empty()
    {
        return Err("Endpoint, model, API key, and subtitle text are required.".into());
    }
    let response = reqwest::Client::new()
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(request.api_key)
        .json(&serde_json::json!({
            "model": request.model,
            "temperature": 0.2,
            "messages": [
                { "role": "system", "content": "You are a concise language-learning tutor. Explain the subtitle in plain English, including key vocabulary or grammar. Keep the answer under 90 words." },
                { "role": "user", "content": request.text }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("AI request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AI provider returned an error: {error}"))?;
    let completion: ChatCompletion = response
        .json()
        .await
        .map_err(|error| format!("Could not read the AI response: {error}"))?;
    completion
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "The AI provider returned no text.".into())
}

fn has_supported_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

fn is_supported_media_path(path: &Path) -> bool {
    has_supported_extension(path, VIDEO_EXTENSIONS)
        || has_supported_extension(path, SUBTITLE_EXTENSIONS)
}

fn collect_launch_paths<I>(paths: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut found = Vec::new();
    for path in paths {
        let resolved = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if resolved.is_file() && is_supported_media_path(&resolved) {
            let value = resolved.to_string_lossy().into_owned();
            if !found.iter().any(|existing| existing == &value) {
                found.push(value);
            }
        }
    }
    found
}

#[tauri::command]
fn take_startup_media_paths(state: tauri::State<'_, StartupMediaPaths>) -> Vec<String> {
    let mut paths = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *paths)
}

#[tauri::command]
fn complete_startup_window(
    app: tauri::AppHandle,
    timing: tauri::State<'_, StartupTiming>,
) -> Result<StartupSnapshot, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "The main player window is unavailable.".to_string())?;
    // The native bootstrap is already visible. Release the WebView backing
    // only after the shell paints, then replace the bootstrap with the player.
    // Only the WebView is transparent. The HWND stays opaque, so a missing
    // or resizing mpv child can never reveal another application's window.
    main.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
        .map_err(|error| format!("Could not prepare the native video surface: {error}"))?;
    #[cfg(windows)]
    finish_native_bootstrap(&main, timing.bootstrap.window)?;
    #[cfg(not(windows))]
    main.show().map_err(|error| error.to_string())?;
    Ok(StartupSnapshot {
        window_created_ms: *timing.window_created_ms.lock().unwrap_or_else(|p| p.into_inner()),
        // Reloading the document must not turn process uptime into a new
        // cold-start measurement.
        shell_ready_ms: *timing.shell_ready_ms.lock().unwrap_or_else(|p| p.into_inner())
            .get_or_insert_with(|| timing.elapsed_ms()),
        first_visible_unix_ms: (timing.bootstrap.first_paint_unix_ms > 0).then_some(timing.bootstrap.first_paint_unix_ms),
        first_visible_after_entry_ms: (timing.bootstrap.first_paint_unix_ms > 0).then_some(timing.bootstrap.first_paint_elapsed_ms),
        runtime_load_started_unix_ms: (timing.bootstrap.runtime_load_started_unix_ms > 0).then_some(timing.bootstrap.runtime_load_started_unix_ms),
        runtime_started_unix_ms: timing.runtime_started_unix_ms,
    })
}

#[cfg(windows)]
fn finish_native_bootstrap(main: &tauri::WebviewWindow, native_window: usize) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{HWND, RECT, POINT}, Graphics::{Dwm::DwmFlush, Gdi::ClientToScreen}, UI::WindowsAndMessaging::*};
    unsafe {
        let cover = native_window as HWND;
        if IsWindow(cover) == 0 {
            main.show().map_err(|error| error.to_string())?;
            return Ok(());
        }
        let minimized = IsIconic(cover) != 0;
        let foreground = GetForegroundWindow() == cover;
        let player_hwnd = main.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        let mut bounds: RECT = std::mem::zeroed();
        let have_bounds = SendMessageW(cover, bootstrap_protocol::READ_BOOTSTRAP_BOUNDS, 0, &mut bounds as *mut RECT as isize) != 0;
        let align_player = || -> Result<(), String> {
            let mut player_client: RECT = std::mem::zeroed();
            let mut player_bounds: RECT = std::mem::zeroed();
            let mut client_origin = POINT { x: 0, y: 0 };
            GetClientRect(player_hwnd, &mut player_client);
            GetWindowRect(player_hwnd, &mut player_bounds);
            ClientToScreen(player_hwnd, &mut client_origin);
            if SetWindowPos(player_hwnd, std::ptr::null_mut(), bounds.left-(client_origin.x-player_bounds.left),
                bounds.top-(client_origin.y-player_bounds.top),
                player_bounds.right-player_bounds.left + (bounds.right-bounds.left)-player_client.right,
                player_bounds.bottom-player_bounds.top + (bounds.bottom-bounds.top)-player_client.bottom,
                SWP_NOZORDER | SWP_NOACTIVATE) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(())
        };
        if minimized {
            // Establish the restored position while the player is still
            // hidden, so click-away never flashes a visible player window.
            SetWindowPos(player_hwnd, std::ptr::null_mut(), 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            if have_bounds { align_player()?; }
            main.minimize().map_err(|error| error.to_string())?;
        }
        main.show().map_err(|error| error.to_string())?;
        // This synchronous getter also waits for any queued Tauri show/style
        // operation, keeping Tao's visibility flags and the HWND in agreement.
        let _ = main.inner_size().map_err(|error| error.to_string())?;
        // Preserve the cover's client rectangle. Windows finalizes the hidden
        // Tauri window's non-client frame on first show; measure those actual
        // insets instead of using the decorated-window size conversion.
        if !minimized && have_bounds { align_player()?; }
        if foreground && !minimized { let _ = main.set_focus(); }
        // Wait for compositor submission, not an arbitrary startup sleep.
        let _ = DwmFlush();
        PostMessageW(cover, bootstrap_protocol::FINISH_BOOTSTRAP, 0, 0);
    }
    Ok(())
}

#[tauri::command]
fn find_sidecar_subtitles(video_path: String) -> Result<Vec<String>, String> {
    let video = PathBuf::from(&video_path);
    let parent = video
        .parent()
        .ok_or_else(|| "The video has no parent directory.".to_string())?;
    let video_stem = video
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The video filename is invalid.".to_string())?
        .to_lowercase();
    let video_name = video
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let mut matches = std::fs::read_dir(parent)
        .map_err(|error| format!("Could not scan for matching subtitles: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && has_supported_extension(path, SUBTITLE_EXTENSIONS))
        .filter_map(|path| {
            let subtitle_stem = path.file_stem()?.to_str()?.to_lowercase();
            let exact = subtitle_stem == video_stem;
            let matches_video_name = subtitle_stem == video_name;
            let language_variant = subtitle_stem
                .strip_prefix(&video_stem)
                .is_some_and(|suffix| suffix.starts_with('.'));
            (exact || matches_video_name || language_variant).then_some((!exact, path))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        left.0.cmp(&right.0).then_with(|| {
            left.1
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right.1.to_string_lossy().to_lowercase())
        })
    });
    Ok(matches
        .into_iter()
        .map(|(_, path)| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
async fn load_subtitles(app: tauri::AppHandle, path: String) -> Result<Vec<SubtitleCue>, String> {
    local_media::load_external_subtitle(app, path).await
}

#[tauri::command]
fn parse_dropped_subtitle(name: String, bytes: Vec<u8>) -> Result<Vec<SubtitleCue>, String> {
    parse_named_subtitle_bytes(&name, &bytes)
}

#[cfg(test)]
mod local_file_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "rupelian-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn parses_ass_dialogue_and_removes_override_tags() {
        let subtitle = br#"[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.25,0:00:03.50,Default,,0,0,0,,{\i1}Hello, world!{\i0}\NSecond line
"#;
        let cues = parse_named_subtitle_bytes("sample.ass", subtitle).expect("ASS should parse");
        assert_eq!(cues.len(), 1);
        assert!((cues[0].start - 1.25).abs() < f64::EPSILON);
        assert!((cues[0].end - 3.5).abs() < f64::EPSILON);
        assert_eq!(cues[0].text, "Hello, world!\nSecond line");
    }

    #[test]
    fn finds_exact_language_and_full_filename_sidecars() {
        let directory = test_directory("sidecars");
        std::fs::create_dir_all(&directory).expect("test directory should be created");
        let video = directory.join("Movie.mkv");
        for name in [
            "Movie.mkv",
            "Movie.srt",
            "Movie.fa.ass",
            "Movie.mkv.vtt",
            "Movie2.srt",
            "Other.ssa",
        ] {
            std::fs::write(directory.join(name), b"fixture").expect("fixture should be written");
        }

        let matches = find_sidecar_subtitles(video.to_string_lossy().into_owned())
            .expect("sidecars should be discovered");
        let names = matches
            .iter()
            .filter_map(|path| Path::new(path).file_name()?.to_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Movie.srt", "Movie.fa.ass", "Movie.mkv.vtt"]);

        std::fs::remove_dir_all(&directory).expect("test directory should be removed");
    }

    #[test]
    fn resolves_supported_relative_launch_paths_only() {
        let directory = test_directory("launch");
        std::fs::create_dir_all(&directory).expect("test directory should be created");
        std::fs::write(directory.join("opened.mp4"), b"fixture")
            .expect("video fixture should be written");
        std::fs::write(directory.join("ignored.exe"), b"fixture")
            .expect("ignored fixture should be written");

        let matches = collect_launch_paths(
            [PathBuf::from("opened.mp4"), PathBuf::from("ignored.exe")],
            &directory,
        );
        assert_eq!(
            matches,
            vec![directory.join("opened.mp4").to_string_lossy()]
        );

        std::fs::remove_dir_all(&directory).expect("test directory should be removed");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_bootstrap(BootstrapInfo::default());
}

// The Windows EXE imports no Tauri symbols. Its first paint precedes LoadLibrary
// and this explicit C ABI call on the original process main thread.
#[cfg(windows)]
#[no_mangle]
pub unsafe extern "C" fn rupelian_run_v1(info: *const BootstrapInfo) -> i32 {
    if info.is_null() || (*info).abi_version != bootstrap_protocol::BOOTSTRAP_ABI { return 2; }
    let info = *info;
    match std::panic::catch_unwind(|| run_with_bootstrap(info)) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

fn run_with_bootstrap(bootstrap: BootstrapInfo) {
    let started = Instant::now();
    let runtime_started_unix_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let youtube_state =
        youtube::YoutubeState::start().expect("could not start the local YouTube streaming proxy");
    let cwd = std::env::current_dir().unwrap_or_default();
    let startup_paths = collect_launch_paths(std::env::args_os().skip(1).map(PathBuf::from), &cwd);
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let paths =
            collect_launch_paths(args.into_iter().skip(1).map(PathBuf::from), Path::new(&cwd));
        if !paths.is_empty() {
            let ready = app.state::<StartupTiming>().shell_ready_ms.lock().unwrap_or_else(|p| p.into_inner()).is_some();
            if ready { let _ = app.emit("open-media-paths", paths); }
            else {
                let queue = app.state::<StartupMediaPaths>();
                let mut queued = queue.0.lock().unwrap_or_else(|p| p.into_inner());
                for path in paths { if !queued.contains(&path) { queued.push(path); } }
            }
        }
        if let Some(window) = app.get_webview_window("main") {
            if window.is_visible().unwrap_or(false) {
                let _ = window.unminimize();
                let _ = window.set_focus();
                return;
            }
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
            let cover = app.state::<StartupTiming>().bootstrap.window as HWND;
            if IsWindow(cover) != 0 { ShowWindow(cover, SW_RESTORE); SetForegroundWindow(cover); }
        }
    }));
    builder
        .setup(|app| {
            let handle = app.handle();
            let _ = local_media::clear_timeline_previews_inner(&handle);
            let timing = app.state::<StartupTiming>();
            *timing.window_created_ms.lock().unwrap_or_else(|p| p.into_inner()) =
                Some(timing.elapsed_ms());
            if timing.bootstrap.window == 0 {
                if let Some(main) = app.get_webview_window("main") { main.show()?; }
            }
            Ok(())
        })
        .manage(StartupTiming {
            started,
            bootstrap,
            runtime_started_unix_ms,
            window_created_ms: Mutex::new(None),
            shell_ready_ms: Mutex::new(None),
        })
        .manage(StartupMediaPaths(Mutex::new(startup_paths)))
        .manage(youtube_state)
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_subtitles,
            parse_dropped_subtitle,
            find_sidecar_subtitles,
            take_startup_media_paths,
            complete_startup_window,
            player_window::set_player_fullscreen,
            explain_subtitle,
            ai::translate_subtitle_batch,
            ai::tutor_chat,
            ai::list_ai_models,
            local_media::prepare_compatible_video,
            local_media::discover_embedded_subtitles,
            local_media::load_embedded_subtitle,
            local_media::prepare_local_preview,
            local_media::clear_timeline_previews,
            local_media::prepare_native_end_frame_path,
            updater::check_for_updates,
            updater::download_and_apply_update,
            youtube::resolve_youtube,
            youtube::load_youtube_subtitles,
            youtube::open_youtube_sign_in,
            youtube_browser_link::prepare_youtube_sign_in_link,
            youtube_browser_link::youtube_sign_in_link_status,
            youtube_browser_link::open_youtube_sign_in_link,
            youtube_browser_link::cancel_youtube_sign_in_link,
            youtube_browser_link::reveal_youtube_browser_extension,
            youtube::capture_youtube_sign_in,
            youtube::continue_youtube_sign_in,
            youtube::close_youtube_sign_in,
            youtube::default_youtube_browser,
            youtube::youtube_sign_in_browsers,
            youtube::check_youtube_session,
            youtube_session::youtube_session_status,
            youtube_session::import_youtube_cookies,
            youtube_session::remove_youtube_session,
            library::save_phrase,
            library::list_phrases,
            library::delete_phrase,
            library::save_vocabulary,
            library::list_vocabulary,
            library::set_vocabulary_status,
            library::delete_vocabulary,
            persistence::load_user_settings,
            persistence::save_user_setting,
            persistence::load_ai_credentials,
            persistence::save_ai_credential,
            persistence::save_subtitle_translation,
            persistence::load_subtitle_translations
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rupelian");
}

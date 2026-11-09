use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::PathBuf,
    process::Command,
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::subtitle::{parse_named_subtitle_bytes, parse_subtitle_bytes, SubtitleCue};

const COMPATIBILITY_PROFILE_VERSION: u8 = 2;
const EMBEDDED_SUBTITLE_CACHE_VERSION: u8 = 1;
const PREVIEW_CACHE_VERSION: u8 = 1;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

#[derive(Debug, Deserialize)]
struct SubtitleProbe {
    #[serde(default)]
    streams: Vec<SubtitleProbeStream>,
}

#[derive(Debug, Deserialize)]
struct SubtitleProbeStream {
    index: u32,
    #[serde(default)]
    codec_name: String,
    #[serde(default)]
    tags: SubtitleProbeTags,
    #[serde(default)]
    disposition: SubtitleProbeDisposition,
}

#[derive(Debug, Default, Deserialize)]
struct SubtitleProbeTags {
    #[serde(default)]
    language: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    handler_name: String,
}

#[derive(Debug, Default, Deserialize)]
struct SubtitleProbeDisposition {
    #[serde(default)]
    default: u8,
    #[serde(default)]
    forced: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedSubtitleTrack {
    stream_index: u32,
    language: String,
    title: String,
    codec: String,
    is_default: bool,
    is_forced: bool,
    text_based: bool,
}

#[tauri::command]
pub async fn discover_embedded_subtitles(
    app: AppHandle,
    path: String,
) -> Result<Vec<EmbeddedSubtitleTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_embedded_subtitles(&app, &path))
        .await
        .map_err(|error| format!("Embedded subtitle scan failed: {error}"))?
}

#[tauri::command]
pub async fn load_embedded_subtitle(
    app: AppHandle,
    path: String,
    stream_index: u32,
) -> Result<Vec<SubtitleCue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        extract_embedded_subtitle(&app, &path, stream_index)
    })
    .await
    .map_err(|error| format!("Embedded subtitle extraction failed: {error}"))?
}

pub async fn load_external_subtitle(
    app: AppHandle,
    path: String,
) -> Result<Vec<SubtitleCue>, String> {
    tauri::async_runtime::spawn_blocking(move || decode_external_subtitle(&app, &path))
        .await
        .map_err(|error| format!("Subtitle decoding task failed: {error}"))?
}

#[tauri::command]
pub fn clear_timeline_previews(app: AppHandle) -> Result<(), String> {
    clear_timeline_previews_inner(&app)
}

pub fn clear_timeline_previews_inner(app: &AppHandle) -> Result<(), String> {
    if let Ok(cache) = app.path().app_cache_dir() {
        let dir = cache.join("timeline-previews");
        if dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        if let Some(parent) = cache.parent() {
            let legacy = parent.join("com.webler.lingocinema").join("timeline-previews");
            if legacy.is_dir() {
                let _ = std::fs::remove_dir_all(&legacy);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_local_preview(
    app: AppHandle,
    path: String,
    seconds: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || generate_local_preview(&app, &path, seconds))
        .await
        .map_err(|error| format!("Timeline preview task failed: {error}"))?
}

#[tauri::command]
pub fn prepare_native_end_frame_path(app: AppHandle, slot: String) -> Result<String, String> {
    let slot = match slot.as_str() {
        "fallback" => "fallback",
        "final" => "final",
        _ => return Err("Invalid native end-frame slot.".to_owned()),
    };
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate the native end-frame cache: {error}"))?
        .join("native-end-frame");
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("Could not create the native end-frame cache: {error}"))?;
    let output = cache.join(format!("{slot}-{}.png", std::process::id()));
    match std::fs::remove_file(&output) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not refresh the native end-frame cache: {error}"
            ))
        }
    }
    Ok(output.to_string_lossy().into_owned())
}

fn probe_embedded_subtitles(
    app: &AppHandle,
    path: &str,
) -> Result<Vec<EmbeddedSubtitleTrack>, String> {
    let input = PathBuf::from(path);
    if !input.is_file() {
        return Err("The selected local video is no longer available.".into());
    }
    let ffprobe = media_binary_path(
        app,
        if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        },
    )
    .ok_or_else(|| {
        "Embedded subtitles need FFprobe beside FFmpeg in the bundled binaries folder or on PATH."
            .to_owned()
    })?;
    let mut command = background_media_command(ffprobe);
    let output = command.args([
            "-v", "error",
            "-select_streams", "s",
            "-show_entries", "stream=index,codec_name:stream_tags=language,title,handler_name:stream_disposition=default,forced",
            "-of", "json",
        ])
        .arg(&input)
        .output()
        .map_err(|error| format!("Could not start FFprobe: {error}"))?;
    if !output.status.success() {
        return Err(command_error(
            &output.stderr,
            "FFprobe could not inspect subtitle tracks.",
        ));
    }
    parse_subtitle_probe(&output.stdout)
}

fn parse_subtitle_probe(json: &[u8]) -> Result<Vec<EmbeddedSubtitleTrack>, String> {
    let probe: SubtitleProbe = serde_json::from_slice(json)
        .map_err(|error| format!("Could not read FFprobe subtitle information: {error}"))?;
    Ok(probe
        .streams
        .into_iter()
        .enumerate()
        .map(|(position, stream)| {
            let language =
                normalized_track_text(&stream.tags.language).unwrap_or_else(|| "und".into());
            let title = normalized_track_text(&stream.tags.title)
                .or_else(|| normalized_track_text(&stream.tags.handler_name))
                .unwrap_or_else(|| format!("Subtitle {}", position + 1));
            let codec = stream.codec_name.to_lowercase();
            EmbeddedSubtitleTrack {
                stream_index: stream.index,
                language,
                title,
                text_based: is_text_subtitle_codec(&codec),
                codec,
                is_default: stream.disposition.default != 0,
                is_forced: stream.disposition.forced != 0,
            }
        })
        .collect())
}

fn normalized_track_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.eq_ignore_ascii_case("und")).then(|| value.to_owned())
}

fn is_text_subtitle_codec(codec: &str) -> bool {
    !matches!(
        codec,
        "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub"
    )
}

fn extract_embedded_subtitle(
    app: &AppHandle,
    path: &str,
    stream_index: u32,
) -> Result<Vec<SubtitleCue>, String> {
    let input = PathBuf::from(path);
    if !input.is_file() {
        return Err("The selected local video is no longer available.".into());
    }
    let cache_file = embedded_subtitle_cache_file(app, &input, stream_index)?;
    if let Ok(bytes) = std::fs::read(&cache_file) {
        if let Ok(cues) = parse_subtitle_bytes(&bytes) {
            return Ok(cues);
        }
        let _ = std::fs::remove_file(&cache_file);
    }
    let ffmpeg = media_binary_path(
        app,
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        },
    )
    .ok_or_else(|| {
        "Embedded subtitles need FFmpeg in the bundled binaries folder or on PATH.".to_owned()
    })?;
    let mut command = background_media_command(ffmpeg);
    let output = command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&input)
        .args([
            "-map",
            &format!("0:{stream_index}"),
            "-c:s",
            "srt",
            "-f",
            "srt",
            "pipe:1",
        ])
        .output()
        .map_err(|error| format!("Could not start FFmpeg: {error}"))?;
    if !output.status.success() {
        return Err(command_error(&output.stderr, "FFmpeg could not extract this subtitle track. Image-based PGS/DVD subtitles require OCR and are not text-selectable."));
    }
    let cues = parse_subtitle_bytes(&output.stdout).map_err(|error| {
        format!("The embedded subtitle track did not contain readable text: {error}")
    })?;
    if let Some(parent) = cache_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = cache_file.with_extension(format!("{}.part", std::process::id()));
    if std::fs::write(&temporary, &output.stdout).is_ok() {
        if std::fs::rename(&temporary, &cache_file).is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
    Ok(cues)
}

fn decode_external_subtitle(app: &AppHandle, path: &str) -> Result<Vec<SubtitleCue>, String> {
    let input = PathBuf::from(path);
    if !input.is_file() {
        return Err("The selected subtitle file is no longer available.".into());
    }
    let bytes =
        std::fs::read(&input).map_err(|error| format!("Could not read subtitle file: {error}"))?;
    if let Ok(cues) = parse_named_subtitle_bytes(path, &bytes) {
        return Ok(cues);
    }
    let ffmpeg = media_binary_path(
        app,
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        },
    )
    .ok_or_else(|| {
        "This subtitle format needs FFmpeg in the bundled binaries folder or on PATH.".to_owned()
    })?;
    let mut command = background_media_command(ffmpeg);
    let output = command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&input)
        .args(["-map", "0:s:0?", "-c:s", "srt", "-f", "srt", "pipe:1"])
        .output()
        .map_err(|error| format!("Could not start FFmpeg for subtitle conversion: {error}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(command_error(
            &output.stderr,
            "FFmpeg could not convert this subtitle. Bitmap PGS/VobSub subtitles require OCR before they can become selectable text.",
        ));
    }
    parse_subtitle_bytes(&output.stdout)
        .map_err(|error| format!("The converted subtitle did not contain readable text: {error}"))
}

fn embedded_subtitle_cache_file(
    app: &AppHandle,
    input: &std::path::Path,
    stream_index: u32,
) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(input)
        .map_err(|error| format!("Could not inspect the local video: {error}"))?;
    let mut hasher = DefaultHasher::new();
    EMBEDDED_SUBTITLE_CACHE_VERSION.hash(&mut hasher);
    input.to_string_lossy().to_lowercase().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    stream_index.hash(&mut hasher);
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate the subtitle cache: {error}"))?
        .join("embedded-subtitles");
    Ok(cache.join(format!("{:016x}.srt", hasher.finish())))
}

fn background_media_command(executable: PathBuf) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    command
}

fn prune_stale_previews(cache: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(cache) {
        let mut jpgs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.ends_with(".part.jpg") {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(mod_time) = meta.modified() {
                        if mod_time.elapsed().unwrap_or_default().as_secs() > 5 {
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
            } else if name.ends_with(".jpg") {
                if let Ok(meta) = entry.metadata() {
                    let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    jpgs.push((mtime, path));
                }
            }
        }
        if jpgs.len() > 60 {
            jpgs.sort_by_key(|(mtime, _)| *mtime);
            for (_, path) in jpgs.iter().take(jpgs.len().saturating_sub(50)) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn generate_local_preview(app: &AppHandle, path: &str, seconds: f64) -> Result<String, String> {
    let input = PathBuf::from(path);
    if !input.is_file() {
        return Err("The selected local video is no longer available.".into());
    }
    let metadata = std::fs::metadata(&input)
        .map_err(|error| format!("Could not inspect the local video: {error}"))?;
    let timestamp_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let mut hasher = DefaultHasher::new();
    PREVIEW_CACHE_VERSION.hash(&mut hasher);
    input.to_string_lossy().to_lowercase().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    timestamp_ms.hash(&mut hasher);
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate the timeline preview cache: {error}"))?
        .join("timeline-previews");
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("Could not create the timeline preview cache: {error}"))?;
    prune_stale_previews(&cache);
    let output = cache.join(format!("{:016x}.jpg", hasher.finish()));
    if std::fs::metadata(&output).is_ok_and(|value| value.len() > 256) {
        return Ok(output.to_string_lossy().into_owned());
    }
    let ffmpeg = media_binary_path(
        app,
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        },
    )
    .ok_or_else(|| {
        "Timeline thumbnails need FFmpeg in the bundled binaries folder or on PATH.".to_owned()
    })?;
    let temporary = cache.join(format!(
        "{:016x}.{}.part.jpg",
        hasher.finish(),
        std::process::id()
    ));
    let mut command = background_media_command(ffmpeg);
    let result = command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &format!("{:.3}", seconds.max(0.0)),
            "-i",
        ])
        .arg(&input)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=320:-2",
            "-q:v",
            "7",
            "-an",
            "-sn",
        ])
        .arg(&temporary)
        .output()
        .map_err(|error| format!("Could not start FFmpeg for timeline preview: {error}"))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&temporary);
        return Err(command_error(
            &result.stderr,
            "FFmpeg could not decode the requested preview frame.",
        ));
    }
    std::fs::rename(&temporary, &output)
        .map_err(|error| format!("Could not finalize the timeline preview: {error}"))?;
    Ok(output.to_string_lossy().into_owned())
}

fn command_error(stderr: &[u8], fallback: &str) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(fallback)
        .trim()
        .to_owned()
}

#[tauri::command]
pub async fn prepare_compatible_video(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || transcode_for_webview(&app, &path))
        .await
        .map_err(|error| format!("Video compatibility task failed: {error}"))?
}

fn transcode_for_webview(app: &AppHandle, input: &str) -> Result<String, String> {
    let input = PathBuf::from(input);
    if !input.is_file() {
        return Err("The selected local video is no longer available.".into());
    }

    let ffmpeg = media_binary_path(app, if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }).ok_or_else(|| {
        "This codec needs FFmpeg. Add the platform FFmpeg binary to the bundled binaries folder or install FFmpeg on this computer.".to_owned()
    })?;
    let metadata = std::fs::metadata(&input)
        .map_err(|error| format!("Could not inspect the local video: {error}"))?;
    let mut hasher = DefaultHasher::new();
    COMPATIBILITY_PROFILE_VERSION.hash(&mut hasher);
    input.to_string_lossy().to_lowercase().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate the media cache: {error}"))?
        .join("compatible-media");
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("Could not create the media cache: {error}"))?;
    let output = cache.join(format!("{key}.mp4"));
    if std::fs::metadata(&output).is_ok_and(|value| value.len() > 1024) {
        return Ok(output.to_string_lossy().into_owned());
    }

    let temporary = cache.join(format!("{key}.{}.part.mp4", std::process::id()));
    let result = Command::new(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&input)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-force_key_frames",
            "expr:gte(t,n_forced*1)",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
        ])
        .arg(&temporary)
        .output()
        .map_err(|error| format!("Could not start FFmpeg: {error}"))?;

    if !result.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let detail = String::from_utf8_lossy(&result.stderr)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("FFmpeg could not convert this video.")
            .trim()
            .to_owned();
        return Err(detail);
    }
    std::fs::rename(&temporary, &output)
        .map_err(|error| format!("Could not finalize the compatible video: {error}"))?;
    Ok(output.to_string_lossy().into_owned())
}

fn media_binary_path(app: &AppHandle, executable: &str) -> Option<PathBuf> {
    if let Some(path) = crate::runtime_paths::resource(&format!("binaries/{executable}")) { return Some(path); }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(executable);
        if development.is_file() {
            return Some(development);
        }
    }
    if let Ok(resource) = app
        .path()
        .resolve(format!("binaries/{executable}"), BaseDirectory::Resource)
    {
        if resource.is_file() {
            return Some(resource);
        }
    }
    if let Some(sibling) = std::env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|directory| directory.join("binaries").join(executable))
    }) {
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    #[cfg(debug_assertions)]
    {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|directory| directory.join(executable))
                .find(|path| path.is_file())
        })
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_inputs_change_with_file_metadata() {
        let mut first = DefaultHasher::new();
        ("video.mkv", 10_u64, 20_u128).hash(&mut first);
        let mut second = DefaultHasher::new();
        ("video.mkv", 11_u64, 20_u128).hash(&mut second);
        assert_ne!(first.finish(), second.finish());
    }

    #[test]
    fn parses_text_and_bitmap_embedded_subtitle_tracks() {
        let tracks = parse_subtitle_probe(br#"{
          "streams": [
            {"index": 2, "codec_name": "ass", "tags": {"language": "eng", "title": "English Signs"}, "disposition": {"default": 1, "forced": 0}},
            {"index": 4, "codec_name": "hdmv_pgs_subtitle", "tags": {"language": "jpn"}, "disposition": {"default": 0, "forced": 1}}
          ]
        }"#).expect("probe JSON should parse");
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].stream_index, 2);
        assert_eq!(tracks[0].title, "English Signs");
        assert!(tracks[0].text_based);
        assert!(tracks[0].is_default);
        assert!(!tracks[1].text_based);
        assert!(tracks[1].is_forced);
    }
}

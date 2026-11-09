use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

pub const MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/hamides-dev/rupelian/main/version.json";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub name: String,
    pub notes: String,
    pub pub_date: String,
    pub package_url: String,
    pub package_sha256: String,
    pub package_size: u64,
    pub is_patch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub percent: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct RemoteManifest {
    version: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: String,
    #[serde(default)]
    packages: HashMap<String, RemotePackage>,
}

#[derive(Debug, Deserialize)]
struct RemotePackage {
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    #[allow(dead_code)]
    description: String,
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .map(|part| part.split('-').next().unwrap_or("0"))
            .map(|s| s.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let latest_parts = parse(latest);
    let current_parts = parse(current);

    let max_len = latest_parts.len().max(current_parts.len());
    for i in 0..max_len {
        let l = *latest_parts.get(i).unwrap_or(&0);
        let c = *current_parts.get(i).unwrap_or(&0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    false
}

async fn query_manifest(manifest_url: &str) -> Result<RemoteManifest, String> {
    let client = reqwest::Client::builder()
        .user_agent("Rupelian-Player-Updater")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Could not initialize HTTP client: {e}"))?;

    let response = client
        .get(manifest_url)
        .send()
        .await
        .map_err(|e| format!("Could not reach update server: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Update server returned status {}", response.status()));
    }

    response
        .json::<RemoteManifest>()
        .await
        .map_err(|e| format!("Invalid update manifest format: {e}"))
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let manifest = query_manifest(MANIFEST_URL).await?;
    let has_update = is_newer_version(&manifest.version, CURRENT_VERSION);

    // Find the Windows installer package
    let (pkg_url, pkg_sha256, pkg_size, is_patch) = if let Some(pkg) = manifest
        .packages
        .get("windows-x64")
        .or_else(|| manifest.packages.get("windows-x64-installer"))
    {
        (pkg.url.clone(), pkg.sha256.clone(), pkg.size, false)
    } else {
        (String::new(), String::new(), 0, false)
    };

    Ok(UpdateInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version: manifest.version,
        has_update,
        name: manifest.name,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        package_url: pkg_url,
        package_sha256: pkg_sha256,
        package_size: pkg_size,
        is_patch,
    })
}

#[tauri::command]
pub async fn download_and_apply_update(
    app: AppHandle,
    url: String,
    sha256: String,
    _is_patch: bool,
) -> Result<(), String> {
    if url.is_empty() {
        return Err("No package URL provided for update".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("Rupelian-Player-Updater")
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let temp_dir = std::env::temp_dir().join("Rupelian-Update");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Could not create update temp dir: {e}"))?;

    let file_name = Path::new(&url)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("update.exe");
    let target_file = temp_dir.join(file_name);

    let mut dest = std::fs::File::create(&target_file)
        .map_err(|e| format!("Could not create destination file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|e| format!("Error while downloading: {e}"))?;
        dest.write_all(&data)
            .map_err(|e| format!("Error writing update file: {e}"))?;
        hasher.update(&data);
        downloaded += data.len() as u64;

        let percent = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };

        let _ = app.emit(
            "update-download-progress",
            DownloadProgress {
                percent,
                downloaded_bytes: downloaded,
                total_bytes: total_size,
            },
        );
    }
    dest.flush().map_err(|e| format!("Flush error: {e}"))?;
    drop(dest);

    // Verify SHA256 if provided
    let expected = sha256.trim().to_lowercase();
    if !expected.is_empty() {
        let computed = format!("{:064x}", hasher.finalize()).to_lowercase();
        if computed != expected {
            let _ = std::fs::remove_file(&target_file);
            return Err(format!(
                "Checksum mismatch: expected {}, got {}",
                expected, computed
            ));
        }
    }

    // Launch update executable
    if target_file.extension().and_then(|e| e.to_str()) == Some("exe") {
        std::process::Command::new(&target_file)
            .spawn()
            .map_err(|e| format!("Failed to launch updater: {e}"))?;
        std::process::exit(0);
    } else if target_file.extension().and_then(|e| e.to_str()) == Some("zip") {
        // Unzip with powershell and run installer / copy
        let ps_cmd = format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force; Start-Process (Get-ChildItem -Path '{}' -Filter '*.exe' | Select-Object -First 1).FullName",
            target_file.display(),
            temp_dir.display(),
            temp_dir.display()
        );
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .spawn()
            .map_err(|e| format!("Failed to apply zip patch: {e}"))?;
        std::process::exit(0);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_comparison() {
        assert!(is_newer_version("0.1.1", "0.1.0"));
        assert!(is_newer_version("0.2.0", "0.1.9"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(is_newer_version("v0.1.1", "0.1.0"));
        assert!(is_newer_version("0.1.1-beta", "0.1.0"));

        assert!(!is_newer_version("0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.1.0", "0.1.1"));
        assert!(!is_newer_version("0.0.9", "0.1.0"));
    }
}

//! Optional appended portable payload, prepared AFTER the native first paint.
//! Cache keys include the exact archive hash; a completed cache is reused.
use sha2::{Digest, Sha256};
use std::{fs::{self, File}, io::{Read, Seek, SeekFrom, Write}, os::windows::{process::CommandExt, io::AsRawHandle},
    path::{Path, PathBuf}, process::Command};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE}, System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject, INFINITE}};
use windows_sys::Win32::System::JobObjects::*;

const MAGIC: &[u8; 16] = b"LINGOCINEMAPKG01";
const FOOTER_SIZE: u64 = 104;

struct CacheLock(HANDLE);
impl Drop for CacheLock {
    fn drop(&mut self) { unsafe { ReleaseMutex(self.0); CloseHandle(self.0); } }
}

struct ExtractionJob(HANDLE);
impl Drop for ExtractionJob { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
impl ExtractionJob {
    fn new() -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err("Could not create extraction job".into()); }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == 0 {
                return Err("Could not configure extraction cancellation".into());
            }
            Ok(job)
        }
    }
}

pub fn runtime_path(executable: &Path) -> Result<PathBuf, String> {
    let mut source = File::open(executable).map_err(|e| e.to_string())?;
    let length = source.metadata().map_err(|e| e.to_string())?.len();
    if length < FOOTER_SIZE { return Ok(executable.with_file_name("rupelian_lib.dll")); }
    source.seek(SeekFrom::End(-(FOOTER_SIZE as i64))).map_err(|e| e.to_string())?;
    let mut footer = [0u8; FOOTER_SIZE as usize];
    source.read_exact(&mut footer).map_err(|e| e.to_string())?;
    if &footer[..16] != MAGIC { return Ok(executable.with_file_name("rupelian_lib.dll")); }
    let offset = u64::from_le_bytes(footer[16..24].try_into().unwrap());
    let helper_len = u64::from_le_bytes(footer[24..32].try_into().unwrap());
    let archive_len = u64::from_le_bytes(footer[32..40].try_into().unwrap());
    let hash = std::str::from_utf8(&footer[40..104]).map_err(|_| "Invalid package hash")?;
    if !hash.bytes().all(|value| value.is_ascii_hexdigit()) || helper_len > 5_000_000
        || offset.checked_add(helper_len).and_then(|n| n.checked_add(archive_len)) != Some(length-FOOTER_SIZE) {
        return Err("The portable package is incomplete".into());
    }
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Local App Data is unavailable")?)
        .join("Rupelian").join("portable-runtime").join(hash);
    // Serialize first extraction and crash recovery across simultaneous clicks.
    let name: Vec<u16> = format!("Local\\Rupelian-Payload-{hash}").encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() { return Err("Could not lock the portable cache".into()); }
    let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
    if wait != 0 && wait != 0x80 { unsafe { CloseHandle(handle); } return Err("Could not prepare the portable cache".into()); }
    let _lock = CacheLock(handle);
    let required = ["rupelian_lib.dll", "lib/libmpv-wrapper.dll", "lib/libmpv-2.dll",
        "binaries/yt-dlp.exe", "binaries/deno.exe", "binaries/ffmpeg.exe", "binaries/ffprobe.exe", "vcruntime140.dll", "vulkan-1.dll"];
    if root.join("complete").is_file() && required.iter().all(|name| root.join(name).is_file()) {
        return Ok(root.join("rupelian_lib.dll"));
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(root.join("complete"));
    let helper = root.join("unpack.exe");
    let archive = root.join("payload.7z");
    source.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut hash_state = Sha256::new();
    for (path, size) in [(&helper, helper_len), (&archive, archive_len)] {
        let mut output = File::create(path).map_err(|e| e.to_string())?;
        let mut remaining = size;
        let mut buffer = [0u8; 65536];
        while remaining > 0 {
            let count = remaining.min(buffer.len() as u64) as usize;
            source.read_exact(&mut buffer[..count]).map_err(|e| e.to_string())?;
            hash_state.update(&buffer[..count]);
            output.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
            remaining -= count as u64;
        }
    }
    if format!("{:x}", hash_state.finalize()) != hash {
        return Err("The portable package failed its integrity check".into());
    }
    let job = ExtractionJob::new()?;
    let mut child = Command::new(&helper).args(["x", "-y", "-aoa", "-bd"])
        .arg(format!("-o{}", root.display())).arg(&archive)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000).spawn().map_err(|e| e.to_string())?;
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as _) } == 0 {
        let _ = child.kill(); let _ = child.wait();
        return Err("Could not attach extraction cancellation".into());
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() || !required.iter().all(|name| root.join(name).is_file()) {
        return Err("Could not extract the player components".into());
    }
    // These two files belong exclusively to this cache preparation attempt.
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_file(&helper);
    fs::write(root.join("complete"), hash).map_err(|e| e.to_string())?;
    Ok(root.join("rupelian_lib.dll"))
}

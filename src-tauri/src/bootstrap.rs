//! Windows entry point: draw and pump a native window BEFORE loading Tauri.
//! This file must never import the runtime crate or any of its heavy services.
use crate::bootstrap_protocol::{BootstrapInfo, BOOTSTRAP_ABI, FINISH_BOOTSTRAP, READ_BOOTSTRAP_BOUNDS};
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr::null_mut, sync::{mpsc, Arc, atomic::{AtomicBool, Ordering}}, time::{Instant, SystemTime, UNIX_EPOCH}};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Gdi::*,
    System::LibraryLoader::*,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

struct Surface {
    started: Instant,
    ready: Option<mpsc::SyncSender<BootstrapInfo>>,
    entry_unix_ms: u64,
    phase: i32,
    font: HFONT,
    heading_font: HFONT,
    scale: f64,
    cancelled: Arc<AtomicBool>,
    normal_bounds: RECT,
}

impl Drop for Surface {
    fn drop(&mut self) { unsafe { DeleteObject(self.font); DeleteObject(self.heading_font); } }
}

unsafe fn fill(dc: HDC, rect: RECT, color: u32) {
    let brush = CreateSolidBrush(color);
    FillRect(dc, &rect, brush);
    DeleteObject(brush);
}

unsafe fn text(dc: HDC, font: HFONT, value: &str, mut rect: RECT, color: u32, flags: u32) {
    let previous = SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT as i32);
    SetTextColor(dc, color);
    DrawTextW(dc, wide(value).as_ptr(), -1, &mut rect, flags | DT_SINGLELINE | DT_VCENTER);
    SelectObject(dc, previous);
}

unsafe fn paint(window: HWND, surface: &mut Surface) {
    let mut ps: PAINTSTRUCT = std::mem::zeroed();
    let target = BeginPaint(window, &mut ps);
    let mut bounds: RECT = std::mem::zeroed();
    GetClientRect(window, &mut bounds);
    let dc = CreateCompatibleDC(target);
    let bitmap = CreateCompatibleBitmap(target, bounds.right, bounds.bottom);
    let previous_bitmap = SelectObject(dc, bitmap);
    let s = |value: i32| (value as f64 * surface.scale).round() as i32;
    let rect = |left, top, right, bottom| RECT { left, top, right, bottom };
    fill(dc, bounds, 0x000c0b0b);

    let cx = bounds.right / 2;
    let cy = bounds.bottom / 2 - s(20);
    let badge_brush = CreateSolidBrush(0x00141018);
    let old_brush = SelectObject(dc, badge_brush);
    let border_pen = CreatePen(PS_SOLID as i32, 1, 0x00352530);
    let old_pen = SelectObject(dc, border_pen);
    RoundRect(dc, cx-s(26), cy-s(56), cx+s(26), cy-s(6), s(16), s(16));
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(border_pen);
    DeleteObject(badge_brush);
    text(dc, surface.heading_font, "R", rect(cx-s(26), cy-s(56), cx+s(26), cy-s(6)), 0x003b3bff, DT_CENTER);
    text(dc, surface.heading_font, "RUPELIAN", rect(cx-s(160), cy, cx+s(160), cy+s(25)), 0x00ffffff, DT_CENTER);
    let status = if surface.started.elapsed().as_secs() < 20 { "Loading your player…" } else { "Taking longer than expected. Press Alt+F4 to close and retry." };
    text(dc, surface.font, status, rect(cx-s(250), cy+s(32), cx+s(250), cy+s(57)), 0x00a29b9b, DT_CENTER);
    fill(dc, rect(cx-s(155), cy+s(78), cx+s(155), cy+s(81)), 0x00292929);
    let offset = s(surface.phase % 230);
    fill(dc, rect(cx-s(155)+offset, cy+s(78), cx-s(75)+offset, cy+s(81)), 0x000000ff);
    BitBlt(target, 0, 0, bounds.right, bounds.bottom, dc, 0, 0, SRCCOPY);
    GdiFlush();
    SelectObject(dc, previous_bitmap);
    #[cfg(debug_assertions)]
    if surface.ready.is_some() {
        if let Some(path) = std::env::var_os("LINGO_BOOTSTRAP_TEST_IMAGE") {
            save_test_bitmap(dc, bitmap, bounds.right, bounds.bottom, path.into());
        }
    }
    DeleteObject(bitmap);
    DeleteDC(dc);
    EndPaint(window, &ps);
    if let Some(ready) = surface.ready.take() {
        let _ = windows_sys::Win32::Graphics::Dwm::DwmFlush();
        let info = BootstrapInfo {
            abi_version: BOOTSTRAP_ABI,
            window: window as usize,
            entry_unix_ms: surface.entry_unix_ms,
            first_paint_unix_ms: unix_ms(),
            first_paint_elapsed_ms: surface.started.elapsed().as_millis() as u64,
            runtime_load_started_unix_ms: 0,
        };
        #[cfg(debug_assertions)]
        if std::env::var_os("LINGO_BOOTSTRAP_TRACE").is_some() {
            eprintln!("LINGO_BOOTSTRAP_PAINT {{\"firstVisibleUnixMs\":{},\"firstVisibleAfterEntryMs\":{}}}", info.first_paint_unix_ms, info.first_paint_elapsed_ms);
        }
        let _ = ready.send(info);
    }
}

// Capture only our own rendered bitmap for native visual QA, never the desktop.
#[cfg(debug_assertions)]
unsafe fn save_test_bitmap(dc: HDC, bitmap: HBITMAP, width: i32, height: i32, path: std::path::PathBuf) {
    let size = (width * height * 4) as usize;
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
        biCompression: BI_RGB, ..std::mem::zeroed()
    };
    let mut bytes = vec![0u8; 54 + size];
    bytes[0..2].copy_from_slice(b"BM");
    bytes[2..6].copy_from_slice(&((54 + size) as u32).to_le_bytes());
    bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
    bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
    bytes[18..22].copy_from_slice(&width.to_le_bytes());
    bytes[22..26].copy_from_slice(&(-height).to_le_bytes());
    bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
    bytes[28..30].copy_from_slice(&32u16.to_le_bytes());
    if GetDIBits(dc, bitmap, 0, height as u32, bytes[54..].as_mut_ptr() as _, &mut info, DIB_RGB_COLORS) != 0 {
        let _ = std::fs::write(path, bytes);
    }
}

unsafe extern "system" fn window_proc(window: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lp as *const CREATESTRUCTW);
        SetWindowLongPtrW(window, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let state = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut Surface;
    if state.is_null() { return DefWindowProcW(window, message, wp, lp); }
    let surface = &mut *state;
    match message {
        WM_PAINT => { paint(window, surface); 0 }
        WM_ERASEBKGND => 1,
        WM_TIMER => {
            if surface.cancelled.load(Ordering::Relaxed) { DestroyWindow(window); return 0; }
            #[cfg(debug_assertions)]
            if let Ok(cancel_after) = std::env::var("LINGO_BOOTSTRAP_TEST_CANCEL_MS") {
                if surface.started.elapsed().as_millis() >= cancel_after.parse::<u128>().unwrap_or(u128::MAX) {
                    PostMessageW(window, WM_CLOSE, 0, 0);
                }
            }
            surface.phase += 5;
            #[cfg(debug_assertions)]
            if surface.phase % 150 == 0 && std::env::var_os("LINGO_BOOTSTRAP_TRACE").is_some() {
                eprintln!("LINGO_BOOTSTRAP_HEARTBEAT {}", unix_ms());
            }
            InvalidateRect(window, std::ptr::null(), 0);
            0
        }
        // Native caption dragging works over the entire loading surface,
        // including its logo/text, without a mouse hook or polling loop.
        WM_NCHITTEST => HTCAPTION as isize,
        WM_ACTIVATEAPP => {
            // Switching to another app minimizes only this temporary loader.
            // A handoff to the player or an app-owned error dialog stays in
            // this process and does not trigger application deactivation.
            if wp == 0 && IsIconic(window) == 0 { ShowWindow(window, SW_MINIMIZE); }
            0
        }
        WM_WINDOWPOSCHANGED => {
            if IsIconic(window) == 0 { GetWindowRect(window, &mut surface.normal_bounds); }
            DefWindowProcW(window, message, wp, lp)
        }
        READ_BOOTSTRAP_BOUNDS => {
            if lp == 0 || surface.normal_bounds.right <= surface.normal_bounds.left { return 0; }
            // Same-process synchronous message; the runtime owns this RECT.
            *(lp as *mut RECT) = surface.normal_bounds;
            1
        }
        WM_CLOSE => { std::process::exit(0); }
        FINISH_BOOTSTRAP => { DestroyWindow(window); 0 }
        WM_DESTROY => { PostQuitMessage(0); 0 }
        WM_NCDESTROY => {
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            DefWindowProcW(window, message, wp, lp)
        }
        _ => DefWindowProcW(window, message, wp, lp),
    }
}

unsafe fn show_surface(started: Instant, entry_unix_ms: u64, ready: mpsc::SyncSender<BootstrapInfo>, cancelled: Arc<AtomicBool>) {
    let instance = GetModuleHandleW(std::ptr::null());
    let class_name = wide(concat!(env!("LINGO_APP_IDENTIFIER"), "-bootstrap"));
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        hCursor: LoadCursorW(null_mut(), IDC_ARROW),
        lpszClassName: class_name.as_ptr(),
        ..std::mem::zeroed()
    };
    RegisterClassW(&class);
    let scale = GetDpiForSystem().max(96) as f64 / 96.0;
    let font = |size: i32, weight: i32| CreateFontW(-(size as f64 * scale).round() as i32, 0, 0, 0, weight, 0, 0, 0,
        DEFAULT_CHARSET as u32, OUT_DEFAULT_PRECIS as u32, CLIP_DEFAULT_PRECIS as u32, CLEARTYPE_QUALITY as u32,
        DEFAULT_PITCH as u32, wide("Segoe UI").as_ptr());
    let mut area: RECT = std::mem::zeroed();
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut area as *mut _ as _, 0);
    let width = ((1180.0 * scale) as i32).min(area.right - area.left);
    let height = ((720.0 * scale) as i32).min(area.bottom - area.top);
    let mut state = Box::new(Surface { started, ready: Some(ready), entry_unix_ms, phase: 0,
        font: font(12, 400), heading_font: font(15, 600), scale, cancelled, normal_bounds: std::mem::zeroed() });
    let window = CreateWindowExW(WS_EX_APPWINDOW, class_name.as_ptr(), wide("Rupelian Player").as_ptr(),
        WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX,
        area.left + (area.right-area.left-width)/2, area.top + (area.bottom-area.top-height)/2,
        width, height, null_mut(), null_mut(), instance, (&mut *state) as *mut Surface as _);
    if window.is_null() {
        return;
    }
    if state.cancelled.load(Ordering::Relaxed) { DestroyWindow(window); return; }
    ShowWindow(window, SW_SHOW);
    UpdateWindow(window); // A real WM_PAINT completes before the runtime is loaded.
    SetTimer(window, 1, 33, None);
    let mut message: MSG = std::mem::zeroed();
    while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

pub fn run() {
    let started = Instant::now();
    let entry_unix_ms = unix_ms();
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    // Do not flash another loading window when the single-instance plugin
    // already has an event target; the runtime forwards file-open arguments.
    let existing = unsafe { FindWindowW(wide(concat!(env!("LINGO_APP_IDENTIFIER"), "-sic")).as_ptr(), wide(concat!(env!("LINGO_APP_IDENTIFIER"), "-siw")).as_ptr()) };
    let mut info = BootstrapInfo { abi_version: BOOTSTRAP_ABI, entry_unix_ms, ..Default::default() };
    if existing.is_null() {
        let (ready, receiver) = mpsc::sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let thread_cancelled = cancelled.clone();
        std::thread::spawn(move || unsafe { show_surface(started, entry_unix_ms, ready, thread_cancelled); });
        // A failed native surface must not prevent the ordinary player opening.
        if let Ok(painted) = receiver.recv_timeout(std::time::Duration::from_secs(2)) { info = painted; }
        else { cancelled.store(true, Ordering::Relaxed); }
    }
    // Deterministic development-only proof that the native UI stays responsive
    // before the DLL/WebView/services exist. Never enabled by release builds.
    #[cfg(debug_assertions)]
    if let Ok(delay) = std::env::var("LINGO_BOOTSTRAP_TEST_DELAY_MS") {
        std::thread::sleep(std::time::Duration::from_millis(delay.parse::<u64>().unwrap_or(0).min(10000)));
    }
    info.runtime_load_started_unix_ms = unix_ms();
    if let Err(error) = unsafe { load_runtime(&info) } {
        eprintln!("{error}");
        unsafe {
            MessageBoxW(info.window as HWND, wide("The player components could not be opened. Please restore the complete application and try again.").as_ptr(), wide("Rupelian Player").as_ptr(), MB_OK | MB_ICONERROR);
            if info.window != 0 { PostMessageW(info.window as HWND, FINISH_BOOTSTRAP, 0, 0); }
        }
        std::process::exit(1);
    }
}

unsafe fn load_runtime(info: &BootstrapInfo) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let path = crate::portable_payload::runtime_path(&executable)?;
    if let Some(directory) = path.parent() {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        // Keep these search cookies alive for the process. The mpv plugin
        // loads its wrapper lazily, after the player shell is already usable.
        AddDllDirectory(wide(directory).as_ptr());
        AddDllDirectory(wide(directory.join("lib")).as_ptr());
    }
    // Use the absolute application path, never CWD/PATH DLL discovery.
    let module = LoadLibraryExW(wide(path).as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if module.is_null() { return Err(format!("Could not load the player runtime: {}", std::io::Error::last_os_error())); }
    let entry = GetProcAddress(module, c"rupelian_run_v1".as_ptr() as _).ok_or("The player runtime has an incompatible entry point")?;
    let run: unsafe extern "C" fn(*const BootstrapInfo) -> i32 = std::mem::transmute(entry);
    let result = run(info);
    // Retain the DLL until process exit: runtime worker threads may still own
    // code/data during shutdown. Unloading it here would be unsafe.
    if result == 0 { Ok(()) } else { Err(format!("The player runtime failed ({result})")) }
}

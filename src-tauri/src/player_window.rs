//! Keep the Win32 placement and Tao's fullscreen state in one UI-thread turn.
//! Restoring a maximized window before fullscreen exposes an intermediate
//! normal window and makes WebView2/mpv resize twice in each direction.

#[tauri::command]
pub async fn set_player_fullscreen(
    window: tauri::WebviewWindow,
    fullscreen: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let ui_window = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = send.send(unsafe { windows::set_fullscreen(&ui_window, fullscreen) });
            })
            .map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
mod windows {
    use std::sync::Mutex;
    use windows_sys::Win32::{
        Graphics::{
            Dwm::{
                DwmFlush, DwmGetWindowAttribute, DwmSetWindowAttribute,
                DWMWA_TRANSITIONS_FORCEDISABLED,
            },
            Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        UI::WindowsAndMessaging::*,
    };

    static RESTORE_PLACEMENT: Mutex<Option<WINDOWPLACEMENT>> = Mutex::new(None);

    pub unsafe fn set_fullscreen(
        window: &tauri::WebviewWindow,
        fullscreen: bool,
    ) -> Result<(), String> {
        if window.is_fullscreen().map_err(|e| e.to_string())? == fullscreen {
            return Ok(());
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
        let mut restore = RESTORE_PLACEMENT.lock().unwrap_or_else(|e| e.into_inner());
        let mut previous_transitions: i32 = 0;
        let attribute_size = std::mem::size_of::<i32>() as u32;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &mut previous_transitions as *mut _ as _,
            attribute_size,
        );
        let disabled: i32 = 1;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const _ as _,
            attribute_size,
        );
        let result = (|| {
            if fullscreen {
                let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
                placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                if GetWindowPlacement(hwnd, &mut placement) == 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut monitor: MONITORINFO = std::mem::zeroed();
                monitor.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(
                    MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
                    &mut monitor,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                *restore = Some(placement);
                // Clear the zoom style without ShowWindow(SW_RESTORE). Windows
                // otherwise constrains the fullscreen SetWindowPos to the work area.
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_MAXIMIZE as isize));
                if let Err(error) = window.set_fullscreen(true) {
                    SetWindowLongPtrW(hwnd, GWL_STYLE, style);
                    *restore = None;
                    return Err(error.to_string());
                }
                // Tao reapplies its cached maximized style while changing the
                // fullscreen flags. Clear that style again before the final size.
                let fullscreen_style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                SetWindowLongPtrW(hwnd, GWL_STYLE, fullscreen_style & !(WS_MAXIMIZE as isize));
                let bounds = monitor.rcMonitor;
                if SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    bounds.left,
                    bounds.top,
                    bounds.right - bounds.left,
                    bounds.bottom - bounds.top,
                    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                ) == 0
                {
                    let _ = window.set_fullscreen(false);
                    SetWindowPlacement(hwnd, &placement);
                    *restore = None;
                    return Err(std::io::Error::last_os_error().to_string());
                }
            } else {
                window
                    .set_fullscreen(false)
                    .map_err(|error| error.to_string())?;
                if let Some(placement) = restore.take() {
                    if SetWindowPlacement(hwnd, &placement) == 0 {
                        return Err(std::io::Error::last_os_error().to_string());
                    }
                }
            }
            let _ = DwmFlush();
            Ok(())
        })();
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &previous_transitions as *const _ as _,
            attribute_size,
        );
        result
    }
}

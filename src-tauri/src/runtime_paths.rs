use std::path::PathBuf;

/// The runtime DLL can live in the portable cache while the small EXE remains
/// wherever the user put it. Resolve tools relative to the loaded module.
#[cfg(windows)]
pub fn resource(name: &str) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::LibraryLoader::*;
    unsafe {
        let mut module = std::ptr::null_mut();
        if GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            resource as *const () as _, &mut module) == 0 { return None; }
        let mut path = vec![0u16; 32768];
        let size = GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32) as usize;
        if size == 0 || size >= path.len() { return None; }
        let module_path = PathBuf::from(std::ffi::OsString::from_wide(&path[..size]));
        let candidate = module_path.parent()?.join(name);
        candidate.is_file().then_some(candidate)
    }
}

#[cfg(not(windows))]
pub fn resource(_name: &str) -> Option<PathBuf> { None }
